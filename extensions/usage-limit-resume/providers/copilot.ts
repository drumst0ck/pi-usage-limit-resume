// Native GitHub Copilot source, mirroring the reference client's copilot plugin: GET https://api.github.com/copilot_internal/user.
import type { Window, Windows } from "../state.ts";
import type { NativeSource } from "./types.ts";

const USAGE_URL = "https://api.github.com/copilot_internal/user";
const API_VERSION = "2025-04-01";

interface Snapshot { usedPercent: number }

const clamp = (n: number) => Math.max(0, Math.min(100, n));
/** The reference client decodes numbers as Double, Int or numeric String ("500"). */
const num = (v: unknown): number | undefined => {
	if (typeof v === "string" && v.trim() !== "") v = Number(v.trim());
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
};

/** The reference client's QuotaSnapshot: unlimited, placeholder (zero entitlement + zero remaining) or percent-less snapshots carry no limit. */
function snapshot(raw: any): Snapshot | undefined {
	if (!raw || typeof raw !== "object" || raw.unlimited === true) return undefined;
	const entitlement = num(raw.entitlement), remaining = num(raw.remaining);
	if (entitlement === 0 && remaining === 0) return undefined;
	let percentRemaining = num(raw.percent_remaining);
	if (percentRemaining === undefined && entitlement !== undefined && entitlement > 0 && remaining !== undefined) {
		percentRemaining = (remaining / entitlement) * 100;
	}
	if (percentRemaining === undefined) return undefined;
	return { usedPercent: clamp(100 - percentRemaining) };
}

/** The reference client's isPlaceholder: an empty or explicit zero-entitlement/zero-remaining snapshot (not unlimited). */
function isPlaceholder(raw: any): boolean {
	if (!raw || typeof raw !== "object") return true;
	if (raw.unlimited === true) return false;
	const entitlement = num(raw.entitlement), remaining = num(raw.remaining);
	if (entitlement === 0 && remaining === 0) return true;
	return entitlement === undefined && remaining === undefined && num(raw.percent_remaining) === undefined;
}

/**
 * The reference client's QuotaSnapshots decoding: the known keys win; when one is missing or a placeholder, any other key is
 * scanned in order (name has "chat" -> chat; "premium"/"completion"/"code" -> premium); with neither found the
 * first usable unknown key stands in as chat.
 */
function directSnapshots(map: any): { premium: any; chat: any } {
	const obj = map && typeof map === "object" ? map : {};
	const keep = (raw: any) => (raw && typeof raw === "object" && !isPlaceholder(raw) ? raw : undefined);
	let premium = keep(obj.premium_interactions), chat = keep(obj.chat);
	if (!premium || !chat) {
		let fbPremium: any, fbChat: any, first: any;
		for (const [key, raw] of Object.entries(obj)) {
			const value = keep(raw);
			if (!value) continue;
			const name = key.toLowerCase();
			first ??= value;
			if (!fbChat && name.includes("chat")) { fbChat = value; continue; }
			if (!fbPremium && (name.includes("premium") || name.includes("completion") || name.includes("code"))) fbPremium = value;
		}
		premium ??= fbPremium;
		chat ??= fbChat;
		if (!premium && !chat) chat = first;
	}
	return { premium, chat };
}

/** Legacy shape: monthly_quotas = denominator, limited_user_quotas = remaining. Both are required, denominator > 0. */
function legacySnapshot(monthly: unknown, limited: unknown): Snapshot | undefined {
	const total = num(monthly), left = num(limited);
	if (total === undefined || left === undefined || total <= 0) return undefined;
	return { usedPercent: clamp(100 - (Math.max(0, left) / total) * 100) };
}

/** The reference client's parseQuotaResetDate: ISO 8601, or `YYYY-MM-DD` as UTC midnight. A zone-less timestamp is read as UTC too. */
function parseReset(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const raw = value.trim();
	if (!/^\d{4}-\d{2}-\d{2}(?:[T ].+)?$/.test(raw)) return undefined;
	const hasTime = raw.length > 10;
	const text = hasTime && !/(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(raw) ? `${raw.replace(" ", "T")}Z` : raw.replace(" ", "T");
	const ms = Date.parse(text);
	return Number.isFinite(ms) ? ms : undefined;
}

/** Pure parse of the usage response. The single reset date is the MONTHLY window; the most used of premium/chat wins. */
export function windowsFromPayload(payload: unknown): Windows | undefined {
	const root = payload as any;
	if (!root || typeof root !== "object") return undefined;
	const resetsAt = parseReset(root.quota_reset_date);
	if (resetsAt === undefined) return undefined;
	const direct = directSnapshots(root.quota_snapshots);
	const monthly = root.monthly_quotas ?? {}, limited = root.limited_user_quotas ?? {};
	// Like the reference client: a usable direct snapshot wins, the legacy counts (completions = premium) only fill the gaps.
	const premium = snapshot(direct.premium) ?? legacySnapshot(monthly.completions, limited.completions);
	const chat = snapshot(direct.chat) ?? legacySnapshot(monthly.chat, limited.chat);
	const used = [premium, chat].filter((s): s is Snapshot => !!s).map(s => s.usedPercent);
	if (!used.length) return undefined;
	const window: Window = { usedPercent: Math.max(...used), resetsAt };
	return { monthly: window };
}

const clean = (v: string | undefined) => (v && !/[\r\n\0]/.test(v.trim()) ? v.trim() : undefined);

/**
 * UNVERIFIED: the reference client sends the GitHub OAuth token (`token <oauth>`), not the short-lived Copilot token. Whether
 * Pi's stored "github-copilot" credential is the OAuth token or the Copilot token is not confirmed; if it is the
 * Copilot token the endpoint answers 401/403, we return undefined and the extension falls back to the probe.
 * No VS Code / copilot-chat identity headers are sent (we do not impersonate another client). github.com only.
 */
export const source: NativeSource = async ctx => {
	try {
		const key = clean(await ctx.apiKey("github-copilot"));
		if (!key) return undefined;
		const headers = {
			authorization: `token ${key}`,
			accept: "application/json",
			"x-github-api-version": API_VERSION,
			"user-agent": "usage-limit-resume",
		};
		const res = await ctx.fetch(USAGE_URL, { method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(5000) });
		if (!res.ok) return undefined;
		return windowsFromPayload(await res.json());
	} catch { return undefined; }
};
