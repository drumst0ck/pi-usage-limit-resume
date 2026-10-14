import assert from "node:assert/strict";
import { test } from "node:test";
import { OPENCODE_GO_USAGE_URL, source, windowsFromPayload } from "./opencodego.ts";

const NOW = Date.parse("2026-08-12T00:00:00Z");
const SECRET = "oc-go-secret-123";
const sample = {
	usage: {
		rolling: { percent: 12, resetsAt: "2026-08-12T02:00:00.000Z" },
		weekly: { percent: 8, resetsAt: "2026-08-18T00:00:00.000Z" },
		monthly: { percent: 35, resetsAt: "2026-09-01T00:00:00.000Z" },
	},
};

function ctx(over: Record<string, any> = {}, calls: any[] = []) {
	return {
		env: {}, nowMs: NOW,
		apiKey: async (id: string) => (id === "opencode-go" ? SECRET : undefined),
		fetch: (async (url: any, init: any) => {
			calls.push({ url, init });
			return new Response(JSON.stringify(sample), { status: 200 });
		}) as typeof fetch,
		...over,
	};
}

test("rolling/weekly/monthly map to fiveHour/weekly/monthly; percent is 0-100 used", () => {
	const w = windowsFromPayload(sample, NOW)!;
	assert.deepEqual(w.fiveHour, { usedPercent: 12, resetsAt: Date.parse("2026-08-12T02:00:00.000Z") });
	assert.deepEqual(w.weekly, { usedPercent: 8, resetsAt: Date.parse("2026-08-18T00:00:00.000Z") });
	assert.deepEqual(w.monthly, { usedPercent: 35, resetsAt: Date.parse("2026-09-01T00:00:00.000Z") });
});

test("a percent of 1 means 1%, not a fraction; values clamp to 0..100", () => {
	const w = windowsFromPayload({ usage: { rolling: { percent: 1, resetsAt: "2026-08-12T02:00:00Z" }, weekly: { percent: 250, resetsAt: "2026-08-18T00:00:00Z" } } }, NOW)!;
	assert.equal(w.fiveHour!.usedPercent, 1);
	assert.equal(w.weekly!.usedPercent, 100);
});

test("only rolling present leaves weekly and monthly absent", () => {
	const w = windowsFromPayload({ usage: { rolling: sample.usage.rolling } }, NOW)!;
	assert.ok(w.fiveHour);
	assert.equal(w.weekly, undefined);
	assert.equal(w.monthly, undefined);
});

test("rolling is required: weekly alone, garbage and missing reset give undefined", () => {
	assert.equal(windowsFromPayload({ usage: { weekly: sample.usage.weekly } }, NOW), undefined);
	assert.equal(windowsFromPayload({}, NOW), undefined);
	assert.equal(windowsFromPayload(null, NOW), undefined);
	assert.equal(windowsFromPayload({ usage: { rolling: { percent: 5 } } }, NOW), undefined);
	assert.equal(windowsFromPayload({ usage: { rolling: { resetsAt: "2026-08-12T02:00:00Z" } } }, NOW), undefined);
});

test("reset accepted under every spelling", () => {
	const iso = "2026-08-12T02:00:00.000Z", ms = Date.parse(iso);
	for (const key of ["resetsAt", "resetAt", "reset_at", "resets_at", "nextReset", "next_reset", "renewAt", "renew_at"]) {
		const w = windowsFromPayload({ usage: { rolling: { percent: 3, [key]: iso } } }, NOW)!;
		assert.equal(w.fiveHour!.resetsAt, ms, key);
	}
});

test("numeric reset: above 1e12 is ms, above 1e9 is seconds, numeric strings too", () => {
	const ms = Date.parse("2026-08-12T02:00:00Z");
	const at = (resetsAt: any) => windowsFromPayload({ usage: { rolling: { percent: 3, resetsAt } } }, NOW)?.fiveHour?.resetsAt;
	assert.equal(at(ms), ms);
	assert.equal(at(ms / 1000), ms);
	assert.equal(at(String(ms)), ms);
	assert.equal(at(String(ms / 1000)), ms);
	assert.equal(at(5000), undefined);
});

test("resetInSec is relative to now and wins over absolute spellings", () => {
	for (const key of ["resetInSec", "resetInSeconds", "reset_in_sec", "resetIn"]) {
		const w = windowsFromPayload({ usage: { rolling: { percent: 3, [key]: 7200, resetsAt: "2030-01-01T00:00:00Z" } } }, NOW)!;
		assert.equal(w.fiveHour!.resetsAt, NOW + 7_200_000, key);
	}
});

test("alternate percent spellings and used/limit are understood", () => {
	for (const key of ["usagePercent", "usedPercent", "percentUsed", "used_percent"]) {
		assert.equal(windowsFromPayload({ usage: { rolling: { [key]: 40, resetsAt: "2026-08-12T02:00:00Z" } } }, NOW)!.fiveHour!.usedPercent, key && 40);
	}
	assert.equal(windowsFromPayload({ usage: { rolling: { used: 25, limit: 100, resetsAt: "2026-08-12T02:00:00Z" } } }, NOW)!.fiveHour!.usedPercent, 25);
});

test("request shape: GET opencode.ai/zen/go/v1/usage with Bearer key, no redirects, timeout", async () => {
	const calls: any[] = [];
	const w = await source(ctx({}, calls));
	assert.ok(w!.fiveHour);
	assert.equal(calls.length, 1);
	assert.equal(String(calls[0].url), "https://opencode.ai/zen/go/v1/usage");
	assert.equal(OPENCODE_GO_USAGE_URL, "https://opencode.ai/zen/go/v1/usage");
	assert.ok(String(calls[0].url).startsWith("https://"));
	assert.equal(calls[0].init.method ?? "GET", "GET");
	assert.equal(calls[0].init.headers.Authorization, `Bearer ${SECRET}`);
	assert.equal(calls[0].init.headers.Accept, "application/json");
	assert.equal(calls[0].init.headers["User-Agent"], "usage-limit-resume");
	assert.equal(calls[0].init.redirect, "error");
	assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test("key from OPENCODE_API_KEY when Pi holds none; Pi key wins when both exist", async () => {
	const calls: any[] = [];
	await source(ctx({ apiKey: async () => undefined, env: { OPENCODE_API_KEY: " env-key " } }, calls));
	assert.equal(calls[0].init.headers.Authorization, "Bearer env-key");
	const both: any[] = [];
	await source(ctx({ env: { OPENCODE_API_KEY: "env-key" } }, both));
	assert.equal(both[0].init.headers.Authorization, `Bearer ${SECRET}`);
});

test("no key: undefined and no request; throwing apiKey is a silent miss", async () => {
	const calls: any[] = [];
	assert.equal(await source(ctx({ apiKey: async () => undefined }, calls)), undefined);
	assert.equal(calls.length, 0);
	assert.equal(await source(ctx({ apiKey: async () => { throw new Error("boom"); } })), undefined);
});

test("HTTP 401/403/500, bad JSON and fetch errors resolve to undefined", async () => {
	for (const status of [401, 403, 500]) {
		assert.equal(await source(ctx({ fetch: async () => new Response("{}", { status }) })), undefined);
	}
	assert.equal(await source(ctx({ fetch: async () => new Response("not json", { status: 200 }) })), undefined);
	assert.equal(await source(ctx({ fetch: async () => { throw new Error(`down ${SECRET}`); } })), undefined);
});

test("the returned value never contains the key", async () => {
	const w = await source(ctx());
	assert.ok(!JSON.stringify(w).includes(SECRET));
});

// ---- Provider response examples ----

// Example payload for this provider's usage response.
// The reference client asserts primary 3, secondary 1, tertiary 0 (resetInSec 18100 / 266500 / 1539100 relative to its `now`).
test("resetInSec payload maps to rolling/weekly/monthly relative to now", () => {
	const payload = JSON.parse(`{"usage": {
	  "rolling": {"percent": 3, "resetInSec": 18100},
	  "weekly": {"percent": 1, "resetInSec": 266500},
	  "monthly": {"percent": 0, "resetInSec": 1539100}
	}}`);
	const w = windowsFromPayload(payload, NOW)!;
	assert.deepEqual(w.fiveHour, { usedPercent: 3, resetsAt: NOW + 18_100_000 });
	assert.deepEqual(w.weekly, { usedPercent: 1, resetsAt: NOW + 266_500_000 });
	assert.deepEqual(w.monthly, { usedPercent: 0, resetsAt: NOW + 1_539_100_000 });
});

// Example payload or rule for this provider's usage response.
// (`public usage API sends bearer token and preserves percent units`; the test serializes this dict with JSONSerialization.)
// The reference client asserts the percent is preserved as-is (0.5 stays 0.5, 1 stays 1) and absent windows stay absent.
const WINDOW_MATRIX: Array<[number, number | null, number | null]> = [
	[12, 8, 35], [3, 1, 0], [1, 1, 1], [0, 0, 0], [100, 100, 100], [0.5, 0.5, 0.5], [1, null, null], [1, 1, null], [1, null, 1],
];
for (const [rolling, weekly, monthly] of WINDOW_MATRIX) {
	test(`the reference client fixture: percent units preserved for ${rolling}/${weekly}/${monthly}`, async () => {
		const dates = ["2026-08-12T02:00:00.000Z", "2026-08-18T00:00:00.000Z", "2026-09-01T00:00:00.000Z"];
		const usage: Record<string, any> = { rolling: { percent: rolling, resetsAt: dates[0] } };
		if (weekly !== null) usage.weekly = { percent: weekly, resetsAt: dates[1] };
		if (monthly !== null) usage.monthly = { percent: monthly, resetsAt: dates[2] };
		const calls: any[] = [];
		const w = await source(ctx({ fetch: (async (u: any, i: any) => { calls.push({ url: u, init: i }); return new Response(JSON.stringify({ usage }), { status: 200 }); }) as typeof fetch }));
		assert.equal(new URL(String(calls[0].url)).pathname, "/zen/go/v1/usage");
		assert.equal(calls[0].init.headers.Authorization, `Bearer ${SECRET}`);
		assert.deepEqual(w!.fiveHour, { usedPercent: rolling, resetsAt: Date.parse(dates[0]) });
		assert.deepEqual(w!.weekly, weekly === null ? undefined : { usedPercent: weekly, resetsAt: Date.parse(dates[1]) });
		assert.deepEqual(w!.monthly, monthly === null ? undefined : { usedPercent: monthly, resetsAt: Date.parse(dates[2]) });
	});
}

// Example payload for this provider's usage response.
// The reference client maps HTTP 401 `{"error":"unauthorized"}` to invalidCredentials; we fall through silently (undefined).
test("401 {\"error\":\"unauthorized\"} and 403 fall through without throwing", async () => {
	for (const status of [401, 403]) {
		assert.equal(await source(ctx({ fetch: async () => new Response('{"error":"unauthorized"}', { status }) })), undefined);
	}
});

// Example payload or rule for this provider's usage response.
// and OpenCodeGoUsageFetcher.parseAPIUsage (`usage.rolling` required, no `usage` object => "Missing usage fields.").
test("missing usage / missing rolling is a parse failure, omitted weekly stays absent", () => {
	assert.equal(windowsFromPayload({ usage: {} }, NOW), undefined);
	assert.equal(windowsFromPayload({ rolling: { percent: 3, resetInSec: 60 } }, NOW), undefined);
	assert.equal(windowsFromPayload({ usage: { weekly: { percent: 1, resetInSec: 60 } } }, NOW), undefined);
	const w = windowsFromPayload({ usage: { rolling: { percent: 3, resetInSec: 60 } } }, NOW)!;
	assert.equal(w.weekly, undefined);
});

// Example payload or rule for this provider's usage response.
// strings-as-numbers for percent/reset, and the API path never rescales a percent <= 1.
test("shape inferred, no sample payload: numeric strings for percent and resetInSec", () => {
	const w = windowsFromPayload({ usage: { rolling: { percent: " 0.5 ", resetInSec: "600" } } }, NOW)!;
	assert.deepEqual(w.fiveHour, { usedPercent: 0.5, resetsAt: NOW + 600_000 });
});
