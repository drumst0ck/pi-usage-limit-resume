// OpenCode Go rolling/weekly/monthly windows, as the reference client reads them: GET /zen/go/v1/usage with the OpenCode API key.
// The reference client's web path (browser cookies) and local-SQLite estimate are intentionally not implemented.
import type { Window, Windows } from "../state.ts";
import type { NativeSource } from "./types.ts";

export const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const TIMEOUT_MS = 5_000;

// Example payload or rule for this provider's usage response.
const PERCENT_KEYS = ["usagePercent", "usedPercent", "percentUsed", "percent", "usage_percent", "used_percent", "utilization", "utilizationPercent", "utilization_percent", "usage"];
const RESET_IN_KEYS = ["resetInSec", "resetInSeconds", "resetSeconds", "reset_sec", "reset_in_sec", "resetsInSec", "resetsInSeconds", "resetIn", "resetSec"];
const RESET_AT_KEYS = ["resetAt", "resetsAt", "reset_at", "resets_at", "nextReset", "next_reset", "renewAt", "renew_at"];

function number(value: unknown): number | undefined {
	const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value.trim()) : NaN;
	return Number.isFinite(n) ? n : undefined;
}

function firstNumber(dict: any, keys: string[]): number | undefined {
	for (const key of keys) {
		const n = number(dict?.[key]);
		if (n !== undefined) return n;
	}
	return undefined;
}

/** Above 1e12 epoch milliseconds, above 1e9 epoch seconds, otherwise an ISO 8601 string. */
function dateMs(value: unknown): number | undefined {
	const n = number(value);
	if (n !== undefined) return n > 1e12 ? n : n > 1e9 ? n * 1000 : undefined;
	if (typeof value !== "string") return undefined;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : undefined;
}

function toWindow(dict: any, nowMs: number): Window | undefined {
	if (!dict || typeof dict !== "object") return undefined;
	let used = firstNumber(dict, PERCENT_KEYS);
	if (used === undefined) {
		const amount = firstNumber(dict, ["used", "consumed", "count", "usedTokens"]), limit = firstNumber(dict, ["limit", "total", "quota", "max", "cap", "tokenLimit"]);
		if (amount !== undefined && limit !== undefined && limit > 0) used = (amount / limit) * 100;
	}
	if (used === undefined) return undefined;
	let resetsAt: number | undefined;
	const inSec = firstNumber(dict, RESET_IN_KEYS);
	if (inSec !== undefined) resetsAt = nowMs + Math.max(0, inSec) * 1000;
	else for (const key of RESET_AT_KEYS) if ((resetsAt = dateMs(dict[key])) !== undefined) break;
	if (resetsAt === undefined) return undefined;
	return { usedPercent: Math.min(100, Math.max(0, used)), resetsAt };
}

/** rolling => fiveHour (required, as in the reference client), weekly => weekly, monthly => monthly; percent is 0-100 USED. */
export function windowsFromPayload(payload: any, nowMs: number): Windows | undefined {
	const usage = payload?.usage;
	const fiveHour = toWindow(usage?.rolling, nowMs);
	if (!fiveHour) return undefined;
	const out: Windows = { fiveHour };
	const weekly = toWindow(usage.weekly, nowMs), monthly = toWindow(usage.monthly, nowMs);
	if (weekly) out.weekly = weekly;
	if (monthly) out.monthly = monthly;
	return out;
}

/** Pi's own credential for the `opencode-go` provider first, then the reference client's documented OPENCODE_API_KEY. */
export const source: NativeSource = async (ctx) => {
	try {
		const key = (await ctx.apiKey("opencode-go"))?.trim() || ctx.env.OPENCODE_API_KEY?.trim();
		if (!key) return undefined;
		const response = await ctx.fetch(OPENCODE_GO_USAGE_URL, {
			method: "GET",
			headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "User-Agent": "usage-limit-resume" },
			redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		return response.ok ? windowsFromPayload(await response.json(), ctx.nowMs) : undefined;
	} catch { return undefined; }
};
