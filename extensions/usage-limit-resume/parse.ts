import type { Windows } from "./state.ts";
// Pure helpers: detect provider usage-limit errors and compute the reset instant.

const STRONG =
	/hit your[\w\s]{0,20}limit|usage limit|rate_limit_error|exceed your account'?s rate limit|\b(session|weekly|opus|sonnet) limit|insufficient[_\s-]*quota|quota (exceeded|reached)|limit will reset|out of extra usage/i;
const WEAK = /rate.?limit|\b429\b/i;
const TRANSIENT = /not your usage limit|temporarily limiting|overloaded|(?:^|\b(?:http|status|error|code)\W{0,3})5\d\d\b/i;
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
/** Common zone abbreviations, in hours from UTC. Ambiguous ones use their most frequent meaning. */
const ZONE_ABBR: Record<string, number> = {
	UTC: 0, GMT: 0, WET: 0, WEST: 1, BST: 1, CET: 1, CEST: 2, EET: 2, EEST: 3, MSK: 3, IST: 5.5, JST: 9, KST: 9,
	AEST: 10, AEDT: 11, NZST: 12, NZDT: 13, HST: -10, AKST: -9, AKDT: -8, PST: -8, PDT: -7, MST: -7, MDT: -6,
	CST: -6, CDT: -5, EST: -5, EDT: -4,
};
type Offset = (at: number) => number;

/**
 * Offset function for a zone token: IANA name, abbreviation or UTC/GMT±hh[:mm]. No token means the machine's zone.
 * Null when a token in parentheses is not a zone: a wrong zone would be off by hours, so no reset is better.
 */
function zoneOffset(raw: string | undefined, strict: boolean): Offset | null {
	const local: Offset = at => -new Date(at).getTimezoneOffset() * 60000;
	if (!raw) return local;
	const token = raw.trim();
	const fixed = (hours: number): Offset => () => hours * 3600_000;
	const off = token.match(/^(?:UTC|GMT)\s*([+-])(\d{1,2})(?::?(\d{2}))?$/i);
	if (off) return fixed((off[1] === "-" ? -1 : 1) * (+off[2] + (off[3] ? +off[3] / 60 : 0)));
	if (ZONE_ABBR[token.toUpperCase()] !== undefined) return fixed(ZONE_ABBR[token.toUpperCase()]);
	if (token.includes("/")) {
		try { new Intl.DateTimeFormat("en-US", { timeZone: token }); return at => zoneOffsetMs(token, at); }
		catch { return null; }
	}
	return strict ? null : local;
}

function wallAt(y: number, mo: number, d: number, h: number, mi: number, off: Offset): number {
	const wall = Date.UTC(y, mo, d, h, mi);
	const t = wall - off(wall);
	return wall - off(t);
}

const ABSOLUTE = new RegExp(
	String.raw`(?:resets?(?:\s+at)?|try again at|reset at)\s+` +
	String.raw`(?:(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?,?\s+)?` +
	String.raw`(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+)?` +
	String.raw`(?:at\s+)?(\d{1,2})(?::(\d{2}))?(?:\s*([ap]\.?m\.?))?` +
	String.raw`(?:\s*\(([^)]{1,40})\)|\s+((?:UTC|GMT)\s*[+-]\d{1,2}(?::?\d{2})?|[A-Z]{2,5})\b)?`,
	"i",
);

/** Returns the next reset instant (epoch ms) found in the message, or undefined. */
export function parseResetTime(msg: string, now: Date): number | undefined {
	const nowMs = now.getTime();
	const relative = parseRelativeReset(msg, nowMs);
	if (relative !== undefined) return relative;
	const m = msg.match(ABSOLUTE);
	if (!m) return undefined;
	const [, weekday, mon, day, hh, mm, ap, paren, bare] = m;
	// 12-hour times need am/pm; 24-hour times need minutes ("19:00"), so "resets 3 times a day" is not a time.
	let h = +hh;
	if (ap) { if (h < 1 || h > 12) return undefined; h = (h % 12) + (/^p/i.test(ap) ? 12 : 0); }
	else if (mm === undefined || h > 23) return undefined;
	const min = mm ? +mm : 0;
	if (min > 59) return undefined;
	// A bare word is a zone only as an uppercase abbreviation or a UTC/GMT offset: "resets 7pm west" is not WEST.
	const bareZone = bare && (/^(?:UTC|GMT)\s*[+-]/i.test(bare) || bare === bare.toUpperCase()) ? bare : undefined;
	const off = zoneOffset(paren ?? bareZone, paren !== undefined || bareZone !== undefined);
	if (!off) return undefined;
	const z = new Date(nowMs + off(nowMs)); // "today" in the target zone
	const [y, mo0, d0] = [z.getUTCFullYear(), z.getUTCMonth(), z.getUTCDate()];
	if (mon) {
		const mo = MONTHS.indexOf(mon.toLowerCase());
		if (mo < 0) return undefined;
		let t = wallAt(y, mo, +day, h, min, off);
		// Just passed (old error, clock skew): it is the reset that elapsed, not next year's.
		if (t <= nowMs && nowMs - t > 36 * 3600_000) t = wallAt(y + 1, mo, +day, h, min, off);
		return t;
	}
	if (weekday) {
		const ahead = (WEEKDAYS.indexOf(weekday.toLowerCase()) - z.getUTCDay() + 7) % 7;
		const t = wallAt(y, mo0, d0 + ahead, h, min, off);
		return t > nowMs ? t : wallAt(y, mo0, d0 + ahead + 7, h, min, off);
	}
	const t = wallAt(y, mo0, d0, h, min, off);
	return t > nowMs ? t : wallAt(y, mo0, d0 + 1, h, min, off);
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
