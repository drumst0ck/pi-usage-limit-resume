// MiniMax Coding/Token Plan windows, read the way the reference client does (API-token path only; no web-cookie fallback).
import type { Window, Windows } from "../state.ts";
import type { NativeSource, SourceContext } from "./types.ts";

type Region = "global" | "cn";
const API_HOST: Record<Region, string> = { global: "https://api.minimax.io", cn: "https://api.minimaxi.com" };
/** The reference client tries the token-plan endpoint first and the legacy coding-plan endpoint second. */
const REMAINS_PATHS = ["/v1/token_plan/remains", "/v1/api/openplatform/coding_plan/remains"];
/** The reference client order: a coding-plan `sk-cp-*` key wins over a standard `sk-api-*` key. */
const ENV_KEYS = ["MINIMAX_CODING_API_KEY", "MINIMAX_API_KEY"];
const TIMEOUT_MS = 5_000;

const num = (v: unknown): number | undefined => {
	const n = typeof v === "string" ? (v.trim() === "" ? NaN : Number(v)) : typeof v === "number" ? v : NaN;
	return Number.isFinite(n) ? n : undefined;
};
/** The reference client's dateFromEpoch: epoch milliseconds, or seconds when the value is below 1e12. */
const epochMs = (v: unknown): number | undefined => {
	const n = num(v);
	return n === undefined ? undefined : n > 1e12 ? n : n > 1e9 ? n * 1000 : undefined;
};
const isTextModel = (name: string) => {
	const lower = name.trim().toLowerCase();
	return lower === "general" || lower.includes("minimax-m") || lower.startsWith("m2.");
};

/** One quota lane (interval or weekly) of a model_remains entry. Note `*_usage_count` is the REMAINING quota. */
function lane(entry: any, kind: "interval" | "weekly", nowMs: number): Window | undefined {
	const p = kind === "interval" ? "current_interval_" : "current_weekly_";
	const pct = num(entry[`${p}remaining_percent`]);
	const total = num(entry[`${p}total_count`]);
	const remaining = num(entry[`${p}usage_count`]);
	const status = num(entry[`${p}status`]);
	// Status 3 with a full percent is an excluded lane (interval) or unlimited text (weekly): no reset to wait for.
	if (status === 3 && (pct ?? 0) >= 100 && (kind === "weekly" || ((total ?? 0) === 0 && (remaining ?? 0) === 0))) return undefined;
	const used = pct !== undefined ? 100 - pct : total !== undefined && total > 0 && remaining !== undefined ? ((total - remaining) / total) * 100 : undefined;
	if (used === undefined) return undefined;
	const end = epochMs(entry[kind === "interval" ? "end_time" : "weekly_end_time"]);
	const left = num(entry[kind === "interval" ? "remains_time" : "weekly_remains_time"]);
	const resetsAt = end !== undefined && end > nowMs ? end : left !== undefined && left > 0 ? nowMs + (left > 1_000_000 ? left : left * 1000) : undefined;
	if (resetsAt === undefined) return undefined;
	return { usedPercent: Math.min(100, Math.max(0, used)), resetsAt };
}

/** The most constrained window: highest used percent, ties by earliest reset. */
const mostConstrained = (windows: Window[]): Window | undefined =>
	windows.reduce<Window | undefined>((best, w) => !best || w.usedPercent > best.usedPercent || (w.usedPercent === best.usedPercent && w.resetsAt < best.resetsAt) ? w : best, undefined);

/**
 * Pure mapping of a `remains` payload. The primary text lane (`general`, MiniMax-M*) is what the reference client shows first,
 * so text models drive both slots and other lanes (speech, video, image...) only matter when no text lane exists.
 * Per slot the most constrained model wins. Interval window => fiveHour; weekly (text models only) => weekly.
 */
export function windowsFromPayload(payload: any, nowMs: number): Windows | undefined {
	const status = num(payload?.data?.base_resp?.status_code ?? payload?.base_resp?.status_code);
	if (status !== undefined && status !== 0) return undefined;
	const list = payload?.data?.model_remains ?? payload?.model_remains;
	// Legacy coding-plan entries carry no model_name (the reference client fixture); they count as non-text lanes (interval only).
	const entries: any[] = Array.isArray(list) ? list.filter(e => e && typeof e === "object").map(e => (typeof e.model_name === "string" ? e : { ...e, model_name: "" })) : [];
	const pick = (pool: any[]): Windows | undefined => {
		const fiveHour = mostConstrained(pool.flatMap(e => lane(e, "interval", nowMs) ?? []));
		const weekly = mostConstrained(pool.filter(e => isTextModel(e.model_name)).flatMap(e => lane(e, "weekly", nowMs) ?? []));
		return fiveHour || weekly ? { ...(fiveHour && { fiveHour }), ...(weekly && { weekly }) } : undefined;
	};
	return pick(entries.filter(e => isTextModel(e.model_name))) ?? pick(entries);
}

async function fetchRemains(ctx: SourceContext, key: string, region: Region, signal: AbortSignal): Promise<Windows | undefined> {
	for (const path of REMAINS_PATHS) {
		try {
			const response = await ctx.fetch(`${API_HOST[region]}${path}`, {
				method: "GET",
				headers: { Authorization: `Bearer ${key}`, accept: "application/json", "Content-Type": "application/json", "MM-API-Source": "usage-limit-resume" },
				redirect: "error", signal,
			});
			if (!response.ok) continue;
			const windows = windowsFromPayload(await response.json(), ctx.nowMs);
			if (windows) return windows;
		} catch { /* try the next endpoint */ }
	}
	return undefined;
}

const piKey = async (ctx: SourceContext, id: string): Promise<string | undefined> => {
	try { return (await ctx.apiKey(id))?.trim() || undefined; } catch { return undefined; }
};

/** Undefined on any failure (no key, HTTP error, bad payload, timeout): callers fall through to other sources. */
export const source: NativeSource = async ctx => {
	const envKey = ENV_KEYS.map(k => ctx.env[k]?.trim()).find(Boolean);
	// Pi's own keys name their region; an env key has none, so try global first, then China mainland.
	const attempts: [string | undefined, Region[]][] = [[await piKey(ctx, "minimax"), ["global"]], [await piKey(ctx, "minimax-cn"), ["cn"]], [envKey, ["global", "cn"]]];
	const signal = AbortSignal.timeout(TIMEOUT_MS);
	const seen = new Set<string>();
	for (const [key, regions] of attempts) {
		if (!key) continue;
		for (const region of regions) {
			const id = `${region}:${key}`;
			if (seen.has(id)) continue;
			seen.add(id);
			const windows = await fetchRemains(ctx, key, region, signal);
			if (windows) return windows;
		}
	}
	return undefined;
};
