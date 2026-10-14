import test from "node:test";
import assert from "node:assert/strict";
import { source, windowsFromPayload } from "./copilot.ts";

const NOW = 1_800_000_000_000;
const KEY = "gho_test_secret_123";
const RESET = Date.UTC(2025, 1, 1); // 2025-02-01T00:00:00Z

// Shape taken from the reference client's CopilotUsageModels: quota_snapshots.{premium_interactions,chat}, one quota_reset_date.
const snap = (percentRemaining: number, extra: Record<string, unknown> = {}) => ({ entitlement: 500, remaining: 450, percent_remaining: percentRemaining, quota_id: "x", ...extra });
const payload = (quotaSnapshots: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ copilot_plan: "free", assigned_date: "2025-01-01", quota_reset_date: "2025-02-01", quota_snapshots: quotaSnapshots, ...extra });
const sample = payload({ premium_interactions: snap(90), chat: snap(100, { entitlement: 0, remaining: 0, unlimited: true }) });

interface Call { url: string; init: any }
function ctx(opts: { body?: unknown; status?: number; key?: string | undefined; throws?: boolean } = {}) {
	const calls: Call[] = [];
	const fetchFn = (async (url: any, init: any) => {
		calls.push({ url: String(url), init });
		if (opts.throws) throw new Error("boom");
		const status = opts.status ?? 200;
		return { ok: status >= 200 && status < 300, status, json: async () => opts.body ?? sample };
	}) as unknown as typeof fetch;
	return {
		calls,
		ctx: {
			env: {},
			fetch: fetchFn,
			nowMs: NOW,
			apiKey: async (id: string) => (id === "github-copilot" ? opts.key : undefined),
		},
	};
}

test("windowsFromPayload maps the sample to the monthly window (used = 100 - percent_remaining)", () => {
	assert.deepEqual(windowsFromPayload(sample), { monthly: { usedPercent: 10, resetsAt: RESET } });
});

test("windowsFromPayload picks the most used of premium and chat", () => {
	const w = windowsFromPayload(payload({ premium_interactions: snap(90), chat: snap(30) }));
	assert.deepEqual(w, { monthly: { usedPercent: 70, resetsAt: RESET } });
	const w2 = windowsFromPayload(payload({ premium_interactions: snap(10), chat: snap(60) }));
	assert.equal(w2?.monthly?.usedPercent, 90);
});

test("windowsFromPayload ignores unlimited and placeholder snapshots", () => {
	assert.equal(windowsFromPayload(payload({ premium_interactions: snap(100, { unlimited: true }), chat: snap(100, { unlimited: true }) })), undefined);
	// explicit zero entitlement + zero remaining is a placeholder even with percent_remaining 100
	assert.equal(windowsFromPayload(payload({ premium_interactions: snap(100, { entitlement: 0, remaining: 0 }) })), undefined);
	// empty object carries no signal
	assert.equal(windowsFromPayload(payload({ premium_interactions: {}, chat: {} })), undefined);
	assert.equal(windowsFromPayload(payload({})), undefined);
});

test("windowsFromPayload derives percent from entitlement/remaining and clamps", () => {
	const derived = windowsFromPayload(payload({ chat: { entitlement: 200, remaining: 50 } }));
	assert.equal(derived?.monthly?.usedPercent, 75);
	const over = windowsFromPayload(payload({ premium_interactions: snap(-20) }));
	assert.equal(over?.monthly?.usedPercent, 100);
	const none = windowsFromPayload(payload({ premium_interactions: snap(130) }));
	assert.equal(none?.monthly?.usedPercent, 0);
});

test("windowsFromPayload parses date-only as UTC midnight and ISO 8601 as-is", () => {
	assert.equal(windowsFromPayload(payload({ chat: snap(50) }, { quota_reset_date: "2025-03-01" }))?.monthly?.resetsAt, Date.UTC(2025, 2, 1));
	assert.equal(windowsFromPayload(payload({ chat: snap(50) }, { quota_reset_date: "2025-03-01T12:30:00Z" }))?.monthly?.resetsAt, Date.UTC(2025, 2, 1, 12, 30));
	assert.equal(windowsFromPayload(payload({ chat: snap(50) }, { quota_reset_date: "2025-03-01T12:30:00.500+02:00" }))?.monthly?.resetsAt, Date.UTC(2025, 2, 1, 10, 30, 0, 500));
});

test("windowsFromPayload needs a valid reset date", () => {
	for (const quota_reset_date of [undefined, "", "   ", "garbage", "2025-13-45", 12345]) {
		assert.equal(windowsFromPayload(payload({ chat: snap(50) }, { quota_reset_date })), undefined, String(quota_reset_date));
	}
});

test("windowsFromPayload understands the legacy monthly_quotas / limited_user_quotas shape", () => {
	const legacy = { copilot_plan: "free", quota_reset_date: "2025-02-01", monthly_quotas: { chat: 50, completions: 2000 }, limited_user_quotas: { chat: 40, completions: 500 } };
	// completions -> premium: 75% used; chat: 20% used
	assert.deepEqual(windowsFromPayload(legacy), { monthly: { usedPercent: 75, resetsAt: RESET } });
	// incomplete legacy counts and zero denominators are dropped
	assert.equal(windowsFromPayload({ ...legacy, monthly_quotas: { chat: 0 }, limited_user_quotas: { chat: 0 } }), undefined);
	assert.equal(windowsFromPayload({ ...legacy, limited_user_quotas: undefined }), undefined);
});

test("windowsFromPayload falls back to legacy counts when the direct snapshot is unusable", () => {
	const w = windowsFromPayload({
		...payload({ premium_interactions: snap(100, { entitlement: 0, remaining: 0 }) }),
		monthly_quotas: { completions: 100 },
		limited_user_quotas: { completions: 25 },
	});
	assert.equal(w?.monthly?.usedPercent, 75);
});

test("windowsFromPayload rejects bad envelopes", () => {
	for (const bad of [null, undefined, "x", 5, [], {}]) assert.equal(windowsFromPayload(bad), undefined);
});

test("source: request shape (token scheme, no impersonated client headers)", async () => {
	const { ctx: c, calls } = ctx({ key: KEY });
	const w = await source(c);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "https://api.github.com/copilot_internal/user");
	assert.equal(calls[0].init.method, "GET");
	const h = calls[0].init.headers;
	assert.equal(h.authorization, `token ${KEY}`);
	assert.equal(h.accept, "application/json");
	assert.equal(h["x-github-api-version"], "2025-04-01");
	assert.equal(h["user-agent"], "usage-limit-resume");
	const sent = JSON.stringify(h).toLowerCase();
	assert.ok(!sent.includes("vscode") && !sent.includes("copilot-chat") && !sent.includes("editor-"));
	assert.equal(calls[0].init.redirect, "error");
	assert.ok(calls[0].init.signal);
	assert.deepEqual(w, { monthly: { usedPercent: 10, resetsAt: RESET } });
	assert.ok(!JSON.stringify(w).includes(KEY));
});

test("source: no key means no request and undefined", async () => {
	const { ctx: c, calls } = ctx({});
	assert.equal(await source(c), undefined);
	assert.equal(calls.length, 0);
	const blank = ctx({ key: "  \n" });
	assert.equal(await source(blank.ctx), undefined);
	assert.equal(blank.calls.length, 0);
});

test("source: a key with control characters is never sent", async () => {
	const t = ctx({ key: "abc\r\nX-Evil: 1" });
	assert.equal(await source(t.ctx), undefined);
	assert.equal(t.calls.length, 0);
});

test("source: 401/403 (e.g. a short-lived Copilot token), HTTP errors, thrown fetch and bad bodies resolve to undefined", async () => {
	for (const status of [401, 403, 404, 500]) assert.equal(await source(ctx({ key: KEY, status }).ctx), undefined, String(status));
	assert.equal(await source(ctx({ key: KEY, throws: true }).ctx), undefined);
	assert.equal(await source(ctx({ key: KEY, body: payload({}) }).ctx), undefined);
	const bad = ctx({ key: KEY });
	bad.ctx.apiKey = async () => { throw new Error("nope"); };
	assert.equal(await source(bad.ctx), undefined);
});

// ---- Provider response examples ----
// The reference client keeps windows without a reset date; we have nothing to save then, so the verbatim payloads that carry
// no quota_reset_date resolve to undefined, and `withReset` adds the one field the fixture lacks to compare values.
const FAKE_NOW = Date.UTC(2024, 0, 1);
const R = "2026-09-01";
const R_MS = Date.UTC(2026, 8, 1);
const withReset = (json: string, reset: string = R): any => ({ ...JSON.parse(json), quota_reset_date: reset });
const used = (json: string, reset?: string) => windowsFromPayload(withReset(json, reset))?.monthly?.usedPercent;

// Example payload for this provider's usage response.
test("ported: decodes quota snapshots payload (premium 90% remaining, chat 50%)", () => {
	const json = `{
	  "copilot_plan": "free",
	  "assigned_date": "2025-01-01",
	  "quota_reset_date": "2025-02-01",
	  "quota_snapshots": {
	    "premium_interactions": { "entitlement": 500, "remaining": 450, "percent_remaining": 90, "quota_id": "premium_interactions" },
	    "chat": { "entitlement": 300, "remaining": 150, "percent_remaining": 50, "quota_id": "chat" }
	  }
	}`;
	assert.deepEqual(windowsFromPayload(JSON.parse(json)), { monthly: { usedPercent: 50, resetsAt: RESET } });
});

// Example payload for this provider's usage response.
test("ported: chat-only payload without dates has no reset to save; with one it is 62.5% used", () => {
	const json = `{
	  "copilot_plan": "free",
	  "quota_snapshots": { "chat": { "entitlement": 200, "remaining": 75, "percent_remaining": 37.5, "quota_id": "chat" } }
	}`;
	assert.equal(windowsFromPayload(JSON.parse(json)), undefined);
	assert.equal(used(json), 62.5);
});

// Example payload for this provider's usage response.
test("ported: explicit empty date fields carry no reset", () => {
	const json = `{
	  "copilot_plan": "free", "assigned_date": "", "quota_reset_date": "",
	  "quota_snapshots": { "chat": { "entitlement": 200, "remaining": 75, "percent_remaining": 37.5, "quota_id": "chat" } }
	}`;
	assert.equal(windowsFromPayload(JSON.parse(json)), undefined);
});

// Example payload for this provider's usage response.
test("ported: monthly and limited quotas as strings-as-numbers (chat 125/500, completions 75/300 -> 75% used)", () => {
	const json = `{
	  "copilot_plan": "free",
	  "monthly_quotas": { "chat": "500", "completions": 300 },
	  "limited_user_quotas": { "chat": 125, "completions": "75" }
	}`;
	assert.equal(used(json), 75);
});

// Example payload for this provider's usage response.
test("ported: missing limited quotas are not assumed full; monthly only yields nothing", () => {
	const json = `{ "copilot_plan": "free", "monthly_quotas": { "chat": 500, "completions": 300 } }`;
	assert.equal(used(json), undefined);
});

// Example payload for this provider's usage response.
test("ported: monthly fallback is per quota, only when the limited value exists (completions 60/300 = 80% used)", () => {
	const json = `{
	  "copilot_plan": "free",
	  "monthly_quotas": { "chat": 500, "completions": 300 },
	  "limited_user_quotas": { "completions": 60 }
	}`;
	assert.equal(used(json), 80);
});

// Example payload for this provider's usage response.
test("ported: partial direct chat (62.5% used) merged with monthly completions (80% used) -> most used", () => {
	const json = `{
	  "copilot_plan": "free",
	  "quota_snapshots": { "chat": { "entitlement": 200, "remaining": 75, "percent_remaining": 37.5, "quota_id": "chat" } },
	  "monthly_quotas": { "chat": 500, "completions": 300 },
	  "limited_user_quotas": { "chat": 125, "completions": 60 }
	}`;
	assert.equal(used(json), 80);
});

// Example payload for this provider's usage response.
test("ported: unknown quota snapshot key is used as the chat fallback (40% remaining -> 60% used)", () => {
	const json = `{
	  "copilot_plan": "free",
	  "quota_snapshots": { "mystery_bucket": { "entitlement": 100, "remaining": 40, "percent_remaining": 40, "quota_id": "mystery_bucket" } }
	}`;
	assert.equal(used(json), 60);
});

// Example payload for this provider's usage response.
test("ported: an empty known snapshot does not block the unknown-key fallback", () => {
	const json = `{
	  "copilot_plan": "free",
	  "quota_snapshots": {
	    "premium_interactions": {},
	    "mystery_bucket": { "entitlement": 100, "remaining": 40, "percent_remaining": 40, "quota_id": "mystery_bucket" }
	  }
	}`;
	assert.equal(used(json), 60);
});

// Example payload for this provider's usage response.
test("ported: percent derived from entitlement/remaining when percent_remaining is missing (30/120 -> 75% used)", () => {
	const json = `{ "copilot_plan": "free", "quota_snapshots": { "chat": { "entitlement": 120, "remaining": 30, "quota_id": "chat" } } }`;
	assert.equal(used(json), 75);
});

// Example payload for this provider's usage response.
test("ported: over-quota snapshots  are clamped to 100 by our Windows contract", () => {
	const pct = `{ "copilot_plan": "paid", "quota_snapshots": { "premium_interactions": { "entitlement": 500, "remaining": -75, "percent_remaining": -15, "quota_id": "premium_interactions" } } }`;
	const derived = `{ "copilot_plan": "paid", "quota_snapshots": { "chat": { "entitlement": 500, "remaining": -75, "quota_id": "chat" } } }`;
	assert.equal(used(pct), 100);
	assert.equal(used(derived), 100);
});

// Example payload for this provider's usage response.
test("ported: underdetermined percent (remaining only, or entitlement only) yields no window", () => {
	const remainingOnly = `{ "copilot_plan": "free", "quota_snapshots": { "chat": { "remaining": 30, "quota_id": "chat" } } }`;
	const entitlementOnly = `{ "copilot_plan": "free", "quota_snapshots": { "chat": { "entitlement": 120, "quota_id": "chat" } } }`;
	assert.equal(used(remainingOnly), undefined);
	assert.equal(used(entitlementOnly), undefined);
});

// Example payload for this provider's usage response.
test("ported: unusable direct snapshot falls back to monthly counts (100/400 -> 75% used)", () => {
	const noRemaining = `{
	  "copilot_plan": "free",
	  "quota_snapshots": { "chat": { "entitlement": 120, "quota_id": "chat" } },
	  "monthly_quotas": { "chat": 400 }, "limited_user_quotas": { "chat": 100 }
	}`;
	const noEntitlement = `{
	  "copilot_plan": "free",
	  "quota_snapshots": { "chat": { "remaining": 30, "quota_id": "chat" } },
	  "monthly_quotas": { "chat": 400 }, "limited_user_quotas": { "chat": 100 }
	}`;
	assert.equal(used(noRemaining), 75);
	assert.equal(used(noEntitlement), 75);
});

// Example payload for this provider's usage response.
test("ported: zero monthly denominator is skipped", () => {
	const json = `{ "copilot_plan": "free", "monthly_quotas": { "chat": 0 }, "limited_user_quotas": { "chat": 0 } }`;
	assert.equal(used(json), undefined);
});

// Example payload for this provider's usage response.
test("ported: business token-based billing zero-entitlement placeholders are not usage", () => {
	const json = `{
	  "copilot_plan": "business", "token_based_billing": true,
	  "quota_snapshots": {
	    "premium_interactions": { "entitlement": 0, "remaining": 0, "percent_remaining": 100, "quota_id": "premium_interactions" },
	    "chat": { "entitlement": 0, "remaining": 0, "percent_remaining": 100, "quota_id": "chat" },
	    "completions": { "entitlement": 0, "remaining": 0, "percent_remaining": 100, "quota_id": "completions" }
	  }
	}`;
	assert.equal(used(json), undefined);
});

// Example payload for this provider's usage response.
test("ported: finite premium plus unlimited chat_messages (no percent) -> only premium counts (4.5% used)", () => {
	const json = `{
	  "copilot_plan": "individual",
	  "quota_snapshots": {
	    "premium_interactions": { "entitlement": 200, "remaining": 191, "percent_remaining": 95.5, "quota_id": "premium_interactions" },
	    "chat_messages": { "entitlement": 0, "remaining": 0, "quota_id": "chat_messages", "unlimited": true }
	  }
	}`;
	assert.equal(used(json), 4.5);
});

// Example payload for this provider's usage response.
test("ported: unlimited with a placeholder percent_remaining of 0 is not a limit", () => {
	const json = `{
	  "copilot_plan": "individual",
	  "quota_snapshots": { "chat": { "entitlement": 0, "remaining": 0, "percent_remaining": 0, "quota_id": "chat", "unlimited": true } }
	}`;
	assert.equal(used(json), undefined);
});

// Example payload for this provider's usage response.
test("ported: token-billed business payload with credits_used and unlimited snapshots has no window", () => {
	const json = `{
	  "copilot_plan": "business", "token_based_billing": true, "quota_reset_date": "2026-09-01",
	  "quota_snapshots": {
	    "premium_interactions": { "unlimited": true, "entitlement": 0, "remaining": 0, "percent_remaining": 100.0, "quota_id": "premium_interactions", "credits_used": 31 },
	    "chat": { "unlimited": true, "entitlement": 0, "remaining": 0, "percent_remaining": 100.0, "quota_id": "chat", "credits_used": 0 }
	  }
	}`;
	assert.equal(windowsFromPayload(JSON.parse(json)), undefined);
});

// Example payload for this provider's usage response.
test("ported: zero-entitlement/unlimited direct premium with credits_used falls back to monthly completions (75 remaining of 300 -> 75% used)", () => {
	const zero = `{
	  "copilot_plan": "business", "token_based_billing": true, "quota_reset_date": "2026-09-01",
	  "monthly_quotas": { "completions": 300 }, "limited_user_quotas": { "completions": 75 },
	  "quota_snapshots": { "premium_interactions": { "entitlement": 0, "remaining": 0, "percent_remaining": 100, "quota_id": "premium_interactions", "credits_used": 31 } }
	}`;
	const unlimited = `{
	  "copilot_plan": "business", "token_based_billing": true, "quota_reset_date": "2026-09-01",
	  "monthly_quotas": { "completions": 300 }, "limited_user_quotas": { "completions": 75 },
	  "quota_snapshots": { "premium_interactions": { "unlimited": true, "entitlement": 0, "remaining": 0, "percent_remaining": 100, "quota_id": "premium_interactions", "credits_used": 31 } }
	}`;
	assert.deepEqual(windowsFromPayload(JSON.parse(zero)), { monthly: { usedPercent: 75, resetsAt: R_MS } });
	assert.deepEqual(windowsFromPayload(JSON.parse(unlimited)), { monthly: { usedPercent: 75, resetsAt: R_MS } });
});

// Example payload for this provider's usage response.
test("ported: percent-only snapshot (no entitlement/remaining) is a real window (40% remaining -> 60% used)", () => {
	const json = `{ "copilot_plan": "business", "quota_snapshots": { "chat": { "percent_remaining": 40, "quota_id": "chat" } } }`;
	assert.equal(used(json), 60);
});

// Example payload for this provider's usage response.
test("ported: fetcher fixture, premium 25% remaining + chat 80% remaining, reset 2026-07-01 -> 75% used", () => {
	const json = `{
	  "copilot_plan": "individual", "quota_reset_date": "2026-07-01",
	  "quota_snapshots": {
	    "premium_interactions": { "entitlement": 500, "remaining": 125, "percent_remaining": 25, "quota_id": "premium_interactions" },
	    "chat": { "entitlement": 300, "remaining": 240, "percent_remaining": 80, "quota_id": "chat" }
	  }
	}`;
	assert.deepEqual(windowsFromPayload(JSON.parse(json)), { monthly: { usedPercent: 75, resetsAt: Date.UTC(2026, 6, 1) } });
});

// Example payload for this provider's usage response.
test("ported: fetcher fixture with fractional percent and ISO reset (78.1% remaining -> 21.9% used)", () => {
	const json = `{
	  "copilot_plan": "individual", "quota_reset_date": "2026-08-01T00:00:00Z",
	  "quota_snapshots": {
	    "premium_interactions": { "entitlement": 200, "remaining": 156.2, "percent_remaining": 78.1, "quota_id": "premium_interactions" },
	    "chat_messages": { "entitlement": 0, "remaining": 0, "quota_id": "chat_messages", "unlimited": true }
	  }
	}`;
	const w = windowsFromPayload(JSON.parse(json));
	assert.ok(Math.abs(w!.monthly!.usedPercent - 21.9) < 1e-9);
	assert.equal(w!.monthly!.resetsAt, Date.UTC(2026, 7, 1));
});

// Example payload for this provider's usage response.
test("ported: only an unlimited chat_messages quota is not a failure but has no window", () => {
	const json = `{
	  "copilot_plan": "individual", "quota_reset_date": "2026-07-01",
	  "quota_snapshots": { "chat_messages": { "entitlement": 0, "remaining": 0, "quota_id": "chat_messages", "unlimited": true } }
	}`;
	assert.equal(windowsFromPayload(JSON.parse(json)), undefined);
});

// Example payload for this provider's usage response.
test("ported: unlimited chat_messages unknown key plus finite monthly chat (60/100 remaining) -> 40% used", () => {
	const json = `{
	  "copilot_plan": "individual",
	  "quota_snapshots": { "chat_messages": { "entitlement": 0, "remaining": 0, "quota_id": "chat_messages", "unlimited": true } },
	  "monthly_quotas": { "chat": 100 }, "limited_user_quotas": { "chat": 60 }
	}`;
	assert.equal(used(json), 40);
});

// Example payload for this provider's usage response.
test("ported: metered account with credits_used 0 and full remaining is a real 0% window", () => {
	const json = `{
	  "copilot_plan": "business", "token_based_billing": false,
	  "quota_snapshots": { "premium_interactions": { "entitlement": 300, "remaining": 300, "percent_remaining": 100, "quota_id": "premium_interactions", "credits_used": 0 } }
	}`;
	assert.equal(used(json), 0);
	const credits = `{
	  "copilot_plan": "business", "token_based_billing": false,
	  "quota_snapshots": { "premium_interactions": { "entitlement": 300, "remaining": 275, "percent_remaining": 91.67, "quota_id": "premium_interactions", "credits_used": 25 } }
	}`;
	assert.ok(Math.abs(used(credits)! - 8.33) < 1e-9);
});

// Example payload for this provider's usage response.
test("ported: token-billed business placeholders with credits_used only (no seat entitlement) have no window", () => {
	const json = `{
	  "copilot_plan": "business", "token_based_billing": true,
	  "quota_snapshots": { "premium_interactions": { "entitlement": 0, "remaining": 0, "percent_remaining": 100, "quota_id": "premium_interactions", "credits_used": 0 } }
	}`;
	assert.equal(used(json), undefined);
});

// Example payload for this provider's usage response.
test("ported: parseQuotaResetDate fixtures (date-only, ISO, fractional seconds, blank)", () => {
	const at = (reset: string) => windowsFromPayload({ quota_reset_date: reset, quota_snapshots: { chat: { percent_remaining: 50 } } })?.monthly?.resetsAt;
	assert.equal(at("2026-07-01"), Date.UTC(2026, 6, 1));
	assert.equal(at("2026-07-01T08:30:45Z"), Date.UTC(2026, 6, 1, 8, 30, 45));
	assert.equal(at("2026-07-01T08:30:45.123Z"), Date.UTC(2026, 6, 1, 8, 30, 45, 123));
	assert.equal(at(" "), undefined);
});

// shape inferred, no sample payload: the reference client's tests never feed a past reset date; we do not filter it here either.
test("windowsFromPayload does not depend on nowMs (past-reset filtering is the caller's job)", () => {
	const w = windowsFromPayload(withReset(`{ "quota_snapshots": { "chat": { "percent_remaining": 10 } } }`, "2020-01-01"));
	assert.equal(w?.monthly?.usedPercent, 90);
	assert.ok(w!.monthly!.resetsAt < FAKE_NOW);
});

// shape inferred, no sample payload for HTTP statuses: the reference client maps 401/403 to unauthorized and other non-200 to bad response (both errors).
test("source: ported payload through the HTTP path, and 401/403 mapped to undefined", async () => {
	const body = withReset(`{ "copilot_plan": "individual", "quota_snapshots": { "premium_interactions": { "entitlement": 500, "remaining": 125, "percent_remaining": 25, "quota_id": "premium_interactions" } } }`, "2026-07-01");
	const ok = await source(ctx({ key: KEY, body }).ctx);
	assert.deepEqual(ok, { monthly: { usedPercent: 75, resetsAt: Date.UTC(2026, 6, 1) } });
	for (const status of [401, 403]) assert.equal(await source(ctx({ key: KEY, body, status }).ctx), undefined);
});
