// Codex 5h/weekly windows from the endpoint the Codex CLI reads, using the credential Pi already holds.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Windows } from "./state.ts";

export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const ACCOUNT_CLAIM = "https://api.openai.com/auth";
const TIMEOUT_MS = 5_000;

export function accountIdFromToken(token: string): string | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	try {
		const id = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))?.[ACCOUNT_CLAIM]?.chatgpt_account_id;
		return typeof id === "string" && id ? id : undefined;
	} catch { return undefined; }
}

/**
 * The Codex CLI login, read-only: access token plus account id.
 * Refused when group/others can read the file. Never refreshed and never written: renewing a rotating
 * refresh token behind the CLI's back could log it out.
 */
export function readCodexCliAuth(env: NodeJS.ProcessEnv): { token: string; accountId: string } | undefined {
	try {
		const file = join(env.CODEX_HOME ?? join(env.HOME ?? homedir(), ".codex"), "auth.json");
		if (statSync(file).mode & 0o077) return undefined;
		const tokens = JSON.parse(readFileSync(file, "utf8"))?.tokens;
		return typeof tokens?.access_token === "string" && tokens.access_token && typeof tokens?.account_id === "string" && tokens.account_id
			? { token: tokens.access_token, accountId: tokens.account_id } : undefined;
	} catch { return undefined; }
}

export function codexWindowsFromUsage(payload: any): Windows | undefined {
	const out: Windows = {};
	for (const w of [payload?.rate_limit?.primary_window, payload?.rate_limit?.secondary_window]) {
		const used = Number(w?.used_percent), seconds = Number(w?.limit_window_seconds);
		const resetsAt = typeof w?.reset_at === "number" ? w.reset_at * 1000
			: typeof w?.reset_after_seconds === "number" ? Date.now() + w.reset_after_seconds * 1000 : undefined;
		if (!Number.isFinite(used) || !Number.isFinite(seconds) || resetsAt === undefined) continue;
		out[seconds >= 432_000 && seconds > 18_000 ? "weekly" : "fiveHour"] = { usedPercent: used, resetsAt };
	}
	return out.fiveHour || out.weekly ? out : undefined;
}

/** Undefined on any failure (no token, no account id, HTTP error, timeout): callers fall through to other sources. */
export async function fetchCodexWindows(token: string | undefined, fetchFn: typeof fetch, knownAccountId?: string): Promise<Windows | undefined> {
	const accountId = knownAccountId ?? (token ? accountIdFromToken(token) : undefined);
	if (!token || !accountId) return undefined;
	try {
		const response = await fetchFn(CODEX_USAGE_URL, {
			headers: { Authorization: `Bearer ${token}`, "chatgpt-account-id": accountId, originator: "pi", "User-Agent": "usage-limit-resume" },
			redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		return response.ok ? codexWindowsFromUsage(await response.json()) : undefined;
	} catch { return undefined; }
}
