import type { Windows } from "./state.ts";
// Pure helpers: detect provider usage-limit errors and compute the reset instant.

const STRONG =
	/hit your[\w\s]{0,20}limit|usage limit|rate_limit_error|exceed your account'?s rate limit|\b(session|weekly|opus|sonnet) limit|insufficient[_\s-]*quota|quota (exceeded|reached)|limit will reset|out of extra usage/i;
const WEAK = /rate.?limit|\b429\b/i;
const TRANSIENT = /not your usage limit|temporarily limiting|overloaded|\b5\d\d\b/i;
const RESET_HINT = /resets?\b|try again at|regain access/i;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export function isUsageLimitError(msg: string | undefined): boolean {
	if (!msg) return false;
	if (/not your usage limit|temporarily limiting/i.test(msg)) return false;
	if (TRANSIENT.test(msg) && !/hit your[\w\s]{0,20}limit|usage limit/i.test(msg)) return false;
	if (STRONG.test(msg)) return true;
	return WEAK.test(msg) && RESET_HINT.test(msg) && parseResetTime(msg, new Date()) !== undefined;
}

function zoneOffsetMs(zone: string | undefined, at: number): number {
	if (!zone) return -new Date(at).getTimezoneOffset() * 60000;
	const p = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", {
			timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
			hour: "numeric", minute: "numeric", second: "numeric",
		}).formatToParts(new Date(at)).map((x) => [x.type, x.value]),
	);
	return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(at / 1000) * 1000;
}

function wallToInstant(y: number, mo: number, d: number, h: number, mi: number, zone?: string): number {
	const wall = Date.UTC(y, mo, d, h, mi);
	let t = wall - zoneOffsetMs(zone, wall);
	t = wall - zoneOffsetMs(zone, t);
	return t;
}

const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 };
const REL_UNITS = "days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s";
const REL = new RegExp(`(?:try again|retry|resets?|available again)\\s+in\\s+~?\\s*((?:\\d+(?:\\.\\d+)?\\s*(?:${REL_UNITS})\\b[\\s,]*(?:and\\s+)?)+)`, "i");
const REL_TOKEN = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${REL_UNITS})\\b`, "gi");

/** "in ~236 min", "in 2h 13m", "in 45 minutes" -> epoch ms. */
function parseRelativeReset(msg: string, nowMs: number): number | undefined {
	const m = msg.match(REL);
	if (!m) return undefined;
	let total = 0;
	for (const [, n, unit] of m[1].matchAll(REL_TOKEN)) total += parseFloat(n) * UNIT_MS[unit[0].toLowerCase()];
	return total > 0 ? nowMs + total : undefined;
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const WEEKDAY_RESET = /(?:resets?(?: at)?|try again at|reset at)\s+(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?,?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)(?:\s*\(([A-Za-z_]+\/[A-Za-z_\-+0-9/]+|UTC)\))?/i;

/** "resets Mon 7pm (Europe/Madrid)": the next time that weekday reaches that wall-clock time in the stated zone. */
function parseWeekdayReset(msg: string, nowMs: number): number | undefined {
	const m = msg.match(WEEKDAY_RESET);
	if (!m) return undefined;
	const [, day, hh, mm, ap, zoneRaw] = m;
	const zone = zoneRaw && zoneRaw.toUpperCase() !== "UTC" ? zoneRaw : zoneRaw ? "UTC" : undefined;
	const h = (+hh % 12) + (/^p/i.test(ap) ? 12 : 0);
	try {
		const z = new Date(nowMs + zoneOffsetMs(zone, nowMs));
		const ahead = (WEEKDAYS.indexOf(day.toLowerCase()) - z.getUTCDay() + 7) % 7;
		let t = wallToInstant(z.getUTCFullYear(), z.getUTCMonth(), z.getUTCDate() + ahead, h, mm ? +mm : 0, zone);
		if (t <= nowMs) t = wallToInstant(z.getUTCFullYear(), z.getUTCMonth(), z.getUTCDate() + ahead + 7, h, mm ? +mm : 0, zone);
		return t;
	} catch {
		return undefined;
	}
}

/** Returns the next reset instant (epoch ms) found in the message, or undefined. */
export function parseResetTime(msg: string, now: Date): number | undefined {
	const relative = parseRelativeReset(msg, now.getTime());
	if (relative !== undefined) return relative;
	const weekday = parseWeekdayReset(msg, now.getTime());
	if (weekday !== undefined) return weekday;
	const m = msg.match(
		/(?:resets?(?: at)?|try again at|reset at)\s+(?:(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?)(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)(?:\s*\(([A-Za-z_]+\/[A-Za-z_\-+0-9/]+|UTC)\))?/i,
	);
	if (!m) return undefined;
	const [, mon, day, hh, mm, ap, zoneRaw] = m;
	const zone = zoneRaw && zoneRaw.toUpperCase() !== "UTC" ? zoneRaw : zoneRaw ? "UTC" : undefined;
	let h = +hh % 12;
	if (/^p/i.test(ap)) h += 12;
	const min = mm ? +mm : 0;
	const nowMs = now.getTime();
	// "today" in the target zone
	const off = zoneOffsetMs(zone, nowMs);
	const z = new Date(nowMs + off);
	let y = z.getUTCFullYear();
	let mo = z.getUTCMonth();
	let d = z.getUTCDate();
	try {
		if (mon && day && MONTHS.includes(mon.toLowerCase())) {
			mo = MONTHS.indexOf(mon.toLowerCase());
			d = +day;
			let t = wallToInstant(y, mo, d, h, min, zone);
			if (t <= nowMs) t = wallToInstant(y + 1, mo, d, h, min, zone);
			return t;
		}
		let t = wallToInstant(y, mo, d, h, min, zone);
		if (t <= nowMs) t = wallToInstant(y, mo, d + 1, h, min, zone);
		return t;
	} catch {
		return undefined; // invalid IANA zone
	}
}

const RESET_KEY = /(ratelimit.*reset|-reset-at$|-reset-after-seconds$)/;

function resetInstant(key: string, v: string, nowMs: number): number | undefined {
	if (key === "retry-after") return /^\d+(\.\d+)?$/.test(v) ? nowMs + parseFloat(v) * 1000 : Date.parse(v);
	if (!RESET_KEY.test(key)) return undefined;
	if (!/^\d+(\.\d+)?$/.test(v)) return Date.parse(v);
	const n = parseFloat(v);
	if (key.endsWith("reset-after-seconds")) return nowMs + n * 1000;
	return n > 1e12 ? n : n > 1e9 ? n * 1000 : nowMs + n * 1000; // epoch ms | epoch s | seconds from now
}

/** Fraction (0..1) used by the window a reset header belongs to, or undefined when the headers say nothing. */
function windowUsage(headers: Record<string, string>, key: string): number | undefined {
	const prefix = key.replace(/reset(-at|-after-seconds)?$/, "");
	if (prefix === key) return undefined;
	if (/^(rejected|exceeded|blocked)$/i.test(headers[`${prefix}status`] ?? "")) return 1;
	const util = parseFloat(headers[`${prefix}utilization`] ?? "");
	if (Number.isFinite(util)) return util;
	const pct = parseFloat(headers[`${prefix}used-percent`] ?? "");
	return Number.isFinite(pct) ? pct / 100 : undefined;
}

/**
 * Reset instant (epoch ms) from provider response headers: Anthropic
 * `anthropic-ratelimit-unified-5h-reset`, Codex `x-codex-primary-reset-at`, or `retry-after`.
 * Picks the window that explains the limit: an exhausted one, else an explicit retry-after,
 * else the most used one at 90% or more. Healthy windows never set the wait, so a weekly reset
 * cannot stretch a 5h limit and a burst limit falls back to probing. Headers that carry no
 * usage information at all keep the older rule: the latest future reset.
 */
export function parseResetHeaders(headers: Record<string, string> | undefined, now: Date): number | undefined {
	if (!headers) return undefined;
	const nowMs = now.getTime();
	const lower: Record<string, string> = {};
	for (const [k, raw] of Object.entries(headers)) lower[k.toLowerCase()] = String(raw ?? "").trim();
	let latest: number | undefined, retry: number | undefined, exhausted: number | undefined;
	let hot: { usage: number; t: number } | undefined, sawUsage = false;
	for (const [key, v] of Object.entries(lower)) {
		if (!v) continue;
		const t = resetInstant(key, v, nowMs);
		if (t === undefined || !Number.isFinite(t) || t <= nowMs) continue;
		if (latest === undefined || t > latest) latest = t;
		if (key === "retry-after") { retry = Math.max(retry ?? 0, t); continue; }
		const usage = windowUsage(lower, key);
		if (usage === undefined) continue;
		sawUsage = true;
		if (usage >= 1) { if (exhausted === undefined || t > exhausted) exhausted = t; }
		else if (usage >= 0.9 && (!hot || usage > hot.usage)) hot = { usage, t };
	}
	return exhausted ?? retry ?? hot?.t ?? (sawUsage ? undefined : latest);
}

/**
 * 5h and weekly windows carried by response headers, so no external tool is needed.
 * Anthropic: `anthropic-ratelimit-unified-{5h,7d}-{utilization (0..1),reset (epoch s)}` on every response.
 * Codex (ChatGPT OAuth): `x-codex-{primary,secondary}-{used-percent,window-minutes,reset-at|reset-after-seconds}`.
 */
export function headerWindows(headers: Record<string, string> | undefined, nowMs: number): Windows | undefined {
	if (!headers) return undefined;
	const h: Record<string, string> = {};
	for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = String(v ?? "").trim();
	const out: Windows = {};
	for (const [key, slot] of [["5h", "fiveHour"], ["7d", "weekly"]] as const) {
		const used = parseFloat(h[`anthropic-ratelimit-unified-${key}-utilization`] ?? "");
		const reset = parseInt(h[`anthropic-ratelimit-unified-${key}-reset`] ?? "", 10);
		if (Number.isFinite(used) && Number.isFinite(reset)) out[slot] = { usedPercent: used * 100, resetsAt: reset * 1000 };
	}
	for (const kind of ["primary", "secondary"]) {
		const used = parseFloat(h[`x-codex-${kind}-used-percent`] ?? "");
		const minutes = parseFloat(h[`x-codex-${kind}-window-minutes`] ?? "");
		const at = parseInt(h[`x-codex-${kind}-reset-at`] ?? "", 10);
		const after = parseFloat(h[`x-codex-${kind}-reset-after-seconds`] ?? "");
		const resetsAt = Number.isFinite(at) ? at * 1000 : Number.isFinite(after) ? nowMs + after * 1000 : undefined;
		if (!Number.isFinite(used) || !Number.isFinite(minutes) || resetsAt === undefined) continue;
		out[minutes >= 7200 ? "weekly" : "fiveHour"] = { usedPercent: used, resetsAt };
	}
	return out.fiveHour || out.weekly ? out : undefined;
}

/** Reset (epoch ms) of the window that explains a limit: an exhausted one, else the most used at 90%+. */
export function resetFromWindows(w: Windows | undefined, nowMs: number): number | undefined {
	let exhausted: number | undefined, hot: { used: number; t: number } | undefined;
	for (const win of [w?.fiveHour, w?.weekly, w?.monthly]) {
		if (!win || win.resetsAt <= nowMs) continue;
		if (win.usedPercent >= 100) { if (exhausted === undefined || win.resetsAt > exhausted) exhausted = win.resetsAt; }
		else if (win.usedPercent >= 90 && (!hot || win.usedPercent > hot.used)) hot = { used: win.usedPercent, t: win.resetsAt };
	}
	return exhausted ?? hot?.t;
}
