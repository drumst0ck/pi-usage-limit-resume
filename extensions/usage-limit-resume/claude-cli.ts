// Fallback for Claude windows when response headers have not provided them: the Claude Code CLI prints /usage as text.
import { execFile } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseResetTime } from "./parse.ts";
import type { Windows } from "./state.ts";

export const CLAUDE_CLI_TIMEOUT_MS = 30_000;
const BINARIES = ["claude", join(homedir(), ".local", "bin", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
const LINE = /^\s*Current (session|week \(all models\)):\s*(\d+(?:\.\d+)?)%\s*used\s*[·•|-]\s*resets?\s+(.+?)\s*$/i;

/** "Current session: 56% used · resets Oct 14 at 6:50pm (Europe/Madrid)" -> windows. Anything else is ignored. */
export function claudeCliWindows(text: string | undefined, nowMs: number): Windows | undefined {
	const out: Windows = {};
	for (const line of (text ?? "").split("\n")) {
		const m = line.match(LINE);
		if (!m) continue;
		const resetsAt = parseResetTime(`resets ${m[3]}`, new Date(nowMs));
		if (resetsAt === undefined) continue;
		out[m[1].toLowerCase() === "session" ? "fiveHour" : "weekly"] = { usedPercent: parseFloat(m[2]), resetsAt };
	}
	return out.fiveHour || out.weekly ? out : undefined;
}

const run = (bin: string): Promise<string | undefined> => new Promise(resolve => {
	// /usage is a local command: no model call. Do not persist a session, and run outside any project.
	const child = execFile(bin, ["-p", "--no-session-persistence", "/usage"],
		{ cwd: tmpdir(), timeout: CLAUDE_CLI_TIMEOUT_MS - 2000, maxBuffer: 2 ** 20 }, (err, stdout) => resolve(err ? undefined : stdout));
	child.stdin?.end();
});

export async function runClaudeCli(): Promise<string | undefined> {
	for (const bin of BINARIES) {
		const out = await run(bin);
		if (out) return out;
	}
	return undefined;
}
