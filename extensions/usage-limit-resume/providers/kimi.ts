// Kimi Code 5h/weekly/monthly windows, as CodexBar reads them: GET /coding/v1/usages with the Kimi Code API key.
// The Kimi CLI credential file (~/.kimi-code/credentials/kimi-code.json) is intentionally not used: CodexBar sends
// device-identity headers with it, it is China-region only and its tokens are short-lived and rotate on refresh.
import type { Window, Windows } from "../state.ts";
import type { NativeSource } from "./types.ts";

export const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const TIMEOUT_MS = 5_000;
const SAME_RESET_MS = 2_000;

/** Kimi sends nanosecond fractions ("...02.717479433Z"); keep millisecond precision. */
function parseTime(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const ms = Date.parse(value.replace(/(\.\d{3})\d+/, "$1"));
	return Number.isFinite(ms) ? ms : undefined;
}

const percent = (value: number) => Math.min(100, Math.max(0, value));

function ratioWindow(pool: any): Window | undefined {
	const ratio = Number(pool?.used_ratio), resetsAt = parseTime(pool?.reset_time);
	if (pool?.used_ratio == null || !Number.isFinite(ratio) || ratio < 0 || resetsAt === undefined) return undefined;
	return { usedPercent: percent(ratio * 100), resetsAt };
}

/** Legacy count detail {limit, used|remaining, resetTime}: used is authoritative, remaining is the fallback. */
function countWindow(detail: any): Window | undefined {
	const limit = Number(detail?.limit), resetsAt = parseTime(detail?.resetTime ?? detail?.resetAt ?? detail?.reset_time ?? detail?.reset_at);
	if (!Number.isInteger(limit) || limit <= 0 || resetsAt === undefined) return undefined;
	const used = detail.used != null && Number.isInteger(Number(detail.used)) && Number(detail.used) >= 0 ? Number(detail.used)
		: detail.remaining != null && Number.isInteger(Number(detail.remaining)) && Number(detail.remaining) >= 0 && Number(detail.remaining) <= limit ? limit - Number(detail.remaining)
		: undefined;
	return used === undefined ? undefined : { usedPercent: percent((used / limit) * 100), resetsAt };
}

/** Ratio pool preferred; counts for the same period (reset within 2s) win only when more exhausted. Counts alone are the fallback. */
function resolve(pool: Window | undefined, counts: Window | undefined, sameDuration = true): Window | undefined {
	if (!pool) return counts;
	return sameDuration && counts && counts.usedPercent > pool.usedPercent && Math.abs(counts.resetsAt - pool.resetsAt) <= SAME_RESET_MS ? counts : pool;
}

const UNIT_MINUTES: Record<string, number> = { TIME_UNIT_MINUTE: 1, TIME_UNIT_HOUR: 60, TIME_UNIT_DAY: 1440 };

/** CodexBar lets counts override the 5h ratio only when their window is 300 minutes (an absent window is assumed 300). */
function isFiveHourWindow(window: any): boolean {
	if (window == null) return true;
	const unit = UNIT_MINUTES[window.timeUnit], duration = Number(window.duration);
	return unit !== undefined && Number.isInteger(duration) && duration > 0 && duration * unit === 300;
}

/** 5h => fiveHour, 7d => weekly, month total => monthly. Undefined when no window has both a usage and a reset time. */
export function windowsFromPayload(payload: any): Windows | undefined {
	const pools = payload?.usages;
	const out: Windows = {};
	const fiveHour = resolve(ratioWindow(pools?.limit_5h), countWindow(payload?.limits?.[0]?.detail), isFiveHourWindow(payload?.limits?.[0]?.window));
	const weekly = resolve(ratioWindow(pools?.limit_7d), countWindow(payload?.usage));
	const monthly = ratioWindow(pools?.limit_month_total);
	if (fiveHour) out.fiveHour = fiveHour;
	if (weekly) out.weekly = weekly;
	if (monthly) out.monthly = monthly;
	return out.fiveHour || out.weekly || out.monthly ? out : undefined;
}

/** Pi's own credential for the `kimi-coding` provider first, then CodexBar's documented KIMI_CODE_API_KEY. */
export const source: NativeSource = async (ctx) => {
	try {
		const key = (await ctx.apiKey("kimi-coding"))?.trim() || ctx.env.KIMI_CODE_API_KEY?.trim();
		if (!key) return undefined;
		const response = await ctx.fetch(KIMI_USAGE_URL, {
			method: "GET",
			headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
			redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		return response.ok ? windowsFromPayload(await response.json()) : undefined;
	} catch { return undefined; }
};
