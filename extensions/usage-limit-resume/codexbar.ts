// Limit errors carry no reset time. CodexBar's CLI reads the real 5h/weekly windows of each subscription.
import { execFile } from "node:child_process";
import type { Family, Windows } from "./state.ts";

const BINARIES = ["codexbar", "/opt/homebrew/bin/codexbar", "/Applications/CodexBar.app/Contents/Helpers/CodexBarCLI"];
export const CODEXBAR_TIMEOUT_MS = 15_000;
const HOT = 90;

/** Reset (epoch ms) of the window that explains the limit: an exhausted one, else the most used at 90%+. */
export function codexbarReset(output: string | undefined, nowMs: number): number | undefined {
	let rows: any;
	try { rows = JSON.parse(output ?? ""); } catch { return undefined; }
	let exhausted: number | undefined, hot: { used: number; t: number } | undefined;
	for (const row of Array.isArray(rows) ? rows : [rows]) {
		for (const w of [row?.usage?.primary, row?.usage?.secondary, row?.usage?.tertiary]) {
			const used = Number(w?.usedPercent), t = Date.parse(w?.resetsAt);
			if (!Number.isFinite(used) || !Number.isFinite(t) || t <= nowMs) continue;
			if (used >= 100) { if (exhausted === undefined || t > exhausted) exhausted = t; }
			else if (used >= HOT && (!hot || used > hot.used)) hot = { used, t };
		}
	}
	return exhausted ?? hot?.t;
}

/**
 * Session, weekly and monthly windows with usage and reset instant. With window lengths, a row lands by length
 * (up to a day: session, up to two weeks: weekly, longer: monthly); without them primary/secondary/tertiary
 * map to session/weekly/monthly. The most used row wins a slot.
 */
export function codexbarWindows(output: string | undefined, _nowMs?: number): Windows | undefined {
	let rows: any;
	try { rows = JSON.parse(output ?? ""); } catch { return undefined; }
	const usage = (Array.isArray(rows) ? rows[0] : rows)?.usage;
	const out: Windows = {};
	for (const [index, w] of [usage?.primary, usage?.secondary, usage?.tertiary].entries()) {
		const used = Number(w?.usedPercent), t = Date.parse(w?.resetsAt), minutes = Number(w?.windowMinutes);
		if (!Number.isFinite(used) || !Number.isFinite(t)) continue;
		const slot = Number.isFinite(minutes) && minutes > 0
			? (minutes <= 1440 ? "fiveHour" : minutes <= 20160 ? "weekly" : "monthly")
			: (["fiveHour", "weekly", "monthly"] as const)[index];
		if (!out[slot] || used > out[slot]!.usedPercent) out[slot] = { usedPercent: used, resetsAt: t };
	}
	return out.fiveHour || out.weekly || out.monthly ? out : undefined;
}

const run = (bin: string, family: Family): Promise<string | undefined> => new Promise(resolve => {
	const child = execFile(bin, ["usage", "--provider", family, "--json", "--no-credits"],
		{ timeout: CODEXBAR_TIMEOUT_MS - 1000, maxBuffer: 2 ** 20 }, (err, stdout) => resolve(err ? undefined : stdout));
	child.stdin?.end();
});

/** Raw JSON from the first CodexBar binary that answers; undefined when none does. */
export async function runCodexbar(family: Family): Promise<string | undefined> {
	for (const bin of BINARIES) {
		const out = await run(bin, family);
		if (out) return out;
	}
	return undefined;
}
