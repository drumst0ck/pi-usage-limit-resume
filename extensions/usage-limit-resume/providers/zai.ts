// Native z.ai / GLM Coding Plan source, mirroring CodexBar's zai plugin: GET /api/monitor/usage/quota/limit.
import type { Window, Windows } from "../state.ts";
import type { NativeSource, SourceContext } from "./types.ts";

const GLOBAL_HOST = "api.z.ai";
const CN_HOST = "open.bigmodel.cn";
const QUOTA_PATH = "/api/monitor/usage/quota/limit";
const LIMIT_TYPES = new Set(["TOKENS_LIMIT", "CREDIT_LIMIT", "TIME_LIMIT"]);
/** z.ai window unit codes -> minutes (CodexBar: 1 day, 3 hour, 5 minute, 6 week). */
const UNIT_MINUTES: Record<number, number> = { 1: 1440, 3: 60, 5: 1, 6: 10080 };
const MINUTE = 60_000;
const CN_KEY_VARS = ["BIGMODEL_API_KEY", "ZHIPU_API_KEY", "ZHIPUAI_API_KEY", "GLM_API_KEY"];

const clamp = (n: number) => Math.max(0, Math.min(100, n));
const isInt = (v: unknown): v is number => Number.isInteger(v);

function usedPercent(raw: any): number {
	let percent = raw.percentage as number;
	const { usage, currentValue: current, remaining } = raw;
	if (isInt(usage) && usage > 0) {
		let used: number | undefined;
		if (isInt(remaining)) used = Math.max(usage - remaining, isInt(current) ? current : usage - remaining);
		else if (isInt(current)) used = current;
		if (used !== undefined) percent = (Math.max(0, Math.min(usage, used)) / usage) * 100;
	}
	return clamp(percent);
}

/** Slot by window length. TIME_LIMIT (MCP) always takes the monthly lane. */
function slot(raw: any): keyof Windows | undefined {
	// CodexBar keeps TIME_LIMIT in its own MCP lane, never in the Coding Plan session/weekly window.
	if (raw.type === "TIME_LIMIT") return "monthly";
	const unit = UNIT_MINUTES[raw.unit];
	const minutes = raw.number > 0 && unit ? raw.number * unit : undefined;
	if (minutes === undefined) return undefined;
	if (minutes <= 6 * 60) return "fiveHour";
	if (minutes <= 8 * 1440) return "weekly";
	return "monthly";
}

/** Pure parse of the quota response. Undefined when no usable window (empty limits are NOT 0% used). */
export function windowsFromPayload(payload: unknown, nowMs: number): Windows | undefined {
	const root = payload as any;
	if (!root || root.success !== true || root.code !== 200 || !Array.isArray(root.data?.limits)) return undefined;
	const out: Windows = {};
	for (const raw of root.data.limits) {
		if (!raw || typeof raw !== "object" || !LIMIT_TYPES.has(raw.type) || !isInt(raw.percentage)) continue;
		const key = slot(raw);
		if (!key || !isInt(raw.nextResetTime)) continue;
		// A five-hour reset cannot be further away than five hours (+1 min skew): never guess a timezone fix.
		if (key === "fiveHour" && raw.nextResetTime > nowMs + 5 * 60 * MINUTE + MINUTE) continue;
		const window: Window = { usedPercent: usedPercent(raw), resetsAt: raw.nextResetTime };
		if (!out[key] || window.usedPercent > out[key]!.usedPercent) out[key] = window;
	}
	return out.fiveHour || out.weekly || out.monthly ? out : undefined;
}

const clean = (v: string | undefined) => (v && !/[\r\n]/.test(v.trim()) ? v.trim() : undefined);

/** Explicit https URL, or a bare host/path normalized to https. Anything else (http, junk) is refused. */
function httpsUrl(input: string): URL | undefined {
	const text = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`;
	try {
		const url = new URL(text);
		return url.protocol === "https:" && !url.username && !url.password ? url : undefined;
	} catch { return undefined; }
}

function quotaUrl(env: NodeJS.ProcessEnv, china: boolean): URL | undefined {
	const canonical = china ? CN_HOST : GLOBAL_HOST;
	const other = china ? GLOBAL_HOST : CN_HOST;
	const quota = clean(env.Z_AI_QUOTA_URL);
	const host = clean(env.Z_AI_API_HOST);
	const override = quota ?? host;
	if (!override) return new URL(`https://${canonical}${QUOTA_PATH}`);
	const url = httpsUrl(override);
	// Canonical hosts are region-checked before the bearer is attached.
	if (!url || url.hostname.toLowerCase() === other) return undefined;
	if (quota === undefined && (url.pathname === "" || url.pathname === "/")) url.pathname = QUOTA_PATH;
	return url;
}

async function resolveKey(ctx: SourceContext, china: boolean): Promise<string | undefined> {
	const pi = clean(await ctx.apiKey("zai"));
	if (pi) return pi;
	const names = china ? ["Z_AI_API_KEY", ...CN_KEY_VARS] : ["Z_AI_API_KEY"];
	for (const name of names) { const v = clean(ctx.env[name]); if (v) return v; }
	return undefined;
}

export const source: NativeSource = async ctx => {
	try {
		const region = clean(ctx.env.Z_AI_REGION) ?? "global";
		if (region !== "global" && region !== "bigmodel-cn") return undefined;
		const scope = clean(ctx.env.Z_AI_USAGE_SCOPE) ?? "personal";
		if (scope !== "personal" && scope !== "team") return undefined;
		const headers: Record<string, string> = { accept: "application/json" };
		const url = quotaUrl(ctx.env, region === "bigmodel-cn");
		if (!url) return undefined;
		if (scope === "team") {
			const org = clean(ctx.env.Z_AI_ORGANIZATION), project = clean(ctx.env.Z_AI_PROJECT);
			if (!org || !project) return undefined; // the API silently returns empty limits without both selectors
			headers["Bigmodel-Organization"] = org;
			headers["Bigmodel-Project"] = project;
			url.searchParams.set("type", "2");
		}
		const key = await resolveKey(ctx, region === "bigmodel-cn");
		if (!key) return undefined;
		headers.authorization = `Bearer ${key}`;
		const res = await ctx.fetch(url.toString(), { method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(5000) });
		if (!res.ok) return undefined;
		return windowsFromPayload(await res.json(), ctx.nowMs);
	} catch { return undefined; }
};
