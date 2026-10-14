// Gemini quota window from the Gemini CLI login, as CodexBar does (GeminiStatusProbe): loadCodeAssist for the
// project id, then retrieveUserQuota. Gemini's quota is a rolling/daily per-model bucket, so the most constrained
// bucket is mapped to the session-like `fiveHour` slot.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Windows } from "../state.ts";
import type { NativeSource } from "./types.ts";

const BASE = "https://cloudcode-pa.googleapis.com/v1internal";
export const GEMINI_LOAD_URL = `${BASE}:loadCodeAssist`;
export const GEMINI_QUOTA_URL = `${BASE}:retrieveUserQuota`;
const TIMEOUT_MS = 5_000;

/**
 * Pure: `retrieveUserQuota` body to windows. Per bucket usedPercent = (1 - remainingFraction) * 100; the bucket with
 * the lowest remainingFraction wins (ties: earliest reset). Like CodexBar, buckets without a modelId, a numeric fraction or a parseable reset are skipped.
 */
export function windowsFromPayload(payload: any): Windows | undefined {
	if (!Array.isArray(payload?.buckets)) return undefined;
	let best: { fraction: number; resetsAt: number } | undefined;
	for (const b of payload.buckets) {
		const fraction = b?.remainingFraction, resetsAt = typeof b?.resetTime === "string" ? Date.parse(b.resetTime) : NaN;
		if (typeof b?.modelId !== "string" || typeof fraction !== "number" || !Number.isFinite(fraction) || !Number.isFinite(resetsAt)) continue;
		if (!best || fraction < best.fraction || (fraction === best.fraction && resetsAt < best.resetsAt)) best = { fraction, resetsAt };
	}
	if (!best) return undefined;
	const usedPercent = Math.min(100, Math.max(0, (1 - best.fraction) * 100));
	return { fiveHour: { usedPercent, resetsAt: best.resetsAt } };
}

/** Access token from ~/.gemini/oauth_creds.json, read-only. Refused when group/others can read it, expired, or when settings select api-key / vertex-ai. */
function readToken(env: NodeJS.ProcessEnv, nowMs: number): string | undefined {
	try {
		if (!env.HOME) return undefined;
		const dir = join(env.HOME, ".gemini");
		try {
			const type = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))?.security?.auth?.selectedType;
			if (type === "gemini-api-key" || type === "api-key" || type === "vertex-ai") return undefined;
		} catch { /* no settings: CodexBar treats unknown as OAuth */ }
		const file = join(dir, "oauth_creds.json");
		if (statSync(file).mode & 0o077) return undefined;
		const c = JSON.parse(readFileSync(file, "utf8"));
		if (typeof c?.access_token !== "string" || !c.access_token) return undefined;
		// Never refreshed (needs the CLI's client secret): an expired token is "no credential".
		if (typeof c.expiry_date === "number" && c.expiry_date <= nowMs) return undefined;
		return c.access_token;
	} catch { return undefined; }
}

export const source: NativeSource = async (ctx) => {
	try {
		const token = readToken(ctx.env, ctx.nowMs);
		if (!token) return undefined;
		const post = (url: string, body: unknown) => ctx.fetch(url, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
			redirect: "error",
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		let project: string | undefined;
		try {
			const res = await post(GEMINI_LOAD_URL, { metadata: { ideType: "GEMINI_CLI", pluginType: "GEMINI" } });
			if (res.ok) {
				const p = (await res.json())?.cloudaicompanionProject;
				const id = typeof p === "string" ? p : p?.id ?? p?.projectId;
				if (typeof id === "string" && id.trim()) project = id.trim();
			}
		} catch { /* CodexBar falls back to an unscoped quota request */ }
		const res = await post(GEMINI_QUOTA_URL, project ? { project } : {});
		if (!res.ok) return undefined;
		return windowsFromPayload(await res.json());
	} catch { return undefined; }
};
