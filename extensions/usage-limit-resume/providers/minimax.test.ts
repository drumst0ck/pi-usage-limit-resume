import { test } from "node:test";
import assert from "node:assert/strict";
import { source, windowsFromPayload } from "./minimax.ts";

const NOW = Date.parse("2026-10-14T12:00:00Z");
const SECRET = "sk-cp-FAKE-SECRET-KEY-abc123";
const H = 3600_000;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ok = (model_remains: unknown[]) => ({ base_resp: { status_code: 0, status_msg: "success" }, data: { current_subscribe_title: "Token Plan Plus", model_remains } });

// Shape of CodexBar's token-plan fixtures: remaining percents as strings, epoch milliseconds.
const GENERAL = {
	model_name: "general",
	current_interval_total_count: 0,
	current_interval_usage_count: 0,
	current_interval_remaining_percent: "96",
	start_time: NOW - 4 * H,
	end_time: NOW + H,
	current_weekly_total_count: 0,
	current_weekly_usage_count: 0,
	current_weekly_remaining_percent: "99",
	weekly_start_time: NOW - 24 * H,
	weekly_end_time: NOW + 144 * H,
};

function ctx(keys: Record<string, string>, fetchImpl: any, env: NodeJS.ProcessEnv = {}) {
	return { env, fetch: fetchImpl, nowMs: NOW, apiKey: async (p: string) => keys[p] } as any;
}
function recorder(handler: (url: string) => Response | Promise<Response>) {
	const calls: { url: string; init: any }[] = [];
	const fetchImpl = async (url: any, init: any) => { calls.push({ url: String(url), init }); return handler(String(url)); };
	return { calls, fetchImpl };
}

test("windowsFromPayload maps interval to fiveHour and weekly to weekly (percent form)", () => {
	const w = windowsFromPayload(ok([GENERAL]), NOW);
	assert.deepEqual(w, {
		fiveHour: { usedPercent: 4, resetsAt: NOW + H },
		weekly: { usedPercent: 1, resetsAt: NOW + 144 * H },
	});
});

test("windowsFromPayload uses remaining COUNTS when no percent is given (usage_count is remaining)", () => {
	const w = windowsFromPayload(ok([{
		model_name: "MiniMax-M2", current_interval_total_count: 1500, current_interval_usage_count: 1125, end_time: NOW + 2 * H,
	}]), NOW);
	assert.deepEqual(w, { fiveHour: { usedPercent: 25, resetsAt: NOW + 2 * H } });
});

test("windowsFromPayload picks the most constrained text model per slot, ties by earliest reset", () => {
	const w = windowsFromPayload(ok([
		{ model_name: "MiniMax-M2", current_interval_remaining_percent: 80, end_time: NOW + 3 * H, current_weekly_remaining_percent: 50, weekly_end_time: NOW + 100 * H },
		{ model_name: "MiniMax-M2.1", current_interval_remaining_percent: 20, end_time: NOW + 4 * H, current_weekly_remaining_percent: 50, weekly_end_time: NOW + 90 * H },
		{ model_name: "MiniMax-M2.5", current_interval_remaining_percent: 20, end_time: NOW + 2 * H },
		// non-text lanes (speech, video) never drive the text-coding windows while a text lane exists
		{ model_name: "speech-hd", current_interval_remaining_percent: 0, end_time: NOW + 1 * H },
	]), NOW);
	assert.deepEqual(w, {
		fiveHour: { usedPercent: 80, resetsAt: NOW + 2 * H },
		weekly: { usedPercent: 50, resetsAt: NOW + 90 * H },
	});
});

test("windowsFromPayload falls back to non-text lanes when there is no text lane, and has no weekly for them", () => {
	const w = windowsFromPayload(ok([{ model_name: "image-01", current_interval_remaining_percent: 60, end_time: NOW + H, current_weekly_remaining_percent: 10, weekly_end_time: NOW + 5 * H }]), NOW);
	assert.deepEqual(w, { fiveHour: { usedPercent: 40, resetsAt: NOW + H } });
});

test("windowsFromPayload rejects empty, errored or malformed payloads", () => {
	assert.equal(windowsFromPayload(undefined, NOW), undefined);
	assert.equal(windowsFromPayload({}, NOW), undefined);
	assert.equal(windowsFromPayload(ok([]), NOW), undefined);
	assert.equal(windowsFromPayload({ base_resp: { status_code: 1004, status_msg: "login fail" }, data: { model_remains: [GENERAL] } }, NOW), undefined);
	assert.equal(windowsFromPayload(ok([{ model_name: "general" }]), NOW), undefined);
	assert.equal(windowsFromPayload(ok([{ model_name: "general", current_interval_remaining_percent: "x", end_time: NOW + H }]), NOW), undefined);
});

test("windowsFromPayload skips excluded lanes (status 3, empty quota) and unlimited weekly text", () => {
	const w = windowsFromPayload(ok([
		{ model_name: "video", current_interval_status: 3, current_interval_total_count: 0, current_interval_usage_count: 0, current_interval_remaining_percent: 100, end_time: NOW + H },
		{ model_name: "MiniMax-M2", current_interval_remaining_percent: 70, end_time: NOW + H, current_weekly_status: 3, current_weekly_remaining_percent: 100, weekly_end_time: NOW + 9 * H },
	]), NOW);
	assert.deepEqual(w, { fiveHour: { usedPercent: 30, resetsAt: NOW + H } });
});

test("windowsFromPayload derives the reset from remains_time when end_time is missing or past; seconds and ms accepted", () => {
	const past = windowsFromPayload(ok([{ model_name: "general", current_interval_remaining_percent: 50, end_time: NOW - H, remains_time: 90 * 60_000 }]), NOW);
	assert.equal(past?.fiveHour?.resetsAt, NOW + 90 * 60_000);
	const secs = windowsFromPayload(ok([{ model_name: "general", current_interval_remaining_percent: 50, remains_time: 3600 }]), NOW);
	assert.equal(secs?.fiveHour?.resetsAt, NOW + H);
	const sec = windowsFromPayload(ok([{ model_name: "general", current_interval_remaining_percent: 50, end_time: Math.floor((NOW + H) / 1000) }]), NOW);
	assert.equal(sec?.fiveHour?.resetsAt, NOW + H);
	assert.equal(windowsFromPayload(ok([{ model_name: "general", current_interval_remaining_percent: 50, end_time: NOW - H }]), NOW), undefined);
});

test("windowsFromPayload clamps usedPercent to 0..100", () => {
	assert.equal(windowsFromPayload(ok([{ model_name: "general", current_interval_remaining_percent: 150, end_time: NOW + H }]), NOW)?.fiveHour?.usedPercent, 0);
	assert.equal(windowsFromPayload(ok([{ model_name: "general", current_interval_remaining_percent: -5, end_time: NOW + H }]), NOW)?.fiveHour?.usedPercent, 100);
});

test("source: no key anywhere resolves undefined without any request", async () => {
	const { calls, fetchImpl } = recorder(() => json(ok([GENERAL])));
	assert.equal(await source(ctx({}, fetchImpl)), undefined);
	assert.equal(calls.length, 0);
});

test("source: Pi global key hits api.minimax.io with the documented request shape", async () => {
	const { calls, fetchImpl } = recorder(() => json(ok([GENERAL])));
	const w = await source(ctx({ minimax: SECRET }, fetchImpl));
	assert.equal(w?.fiveHour?.usedPercent, 4);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "https://api.minimax.io/v1/token_plan/remains");
	assert.equal(calls[0].init.method ?? "GET", "GET");
	assert.equal(calls[0].init.headers.Authorization, `Bearer ${SECRET}`);
	assert.equal(calls[0].init.headers.accept, "application/json");
	assert.equal(calls[0].init.redirect, "error");
	assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test("source: Pi minimax-cn key uses the China host", async () => {
	const { calls, fetchImpl } = recorder(() => json(ok([GENERAL])));
	const w = await source(ctx({ "minimax-cn": SECRET }, fetchImpl));
	assert.ok(w?.fiveHour);
	assert.equal(calls[0].url, "https://api.minimaxi.com/v1/token_plan/remains");
	assert.ok(calls.every(c => new URL(c.url).host === "api.minimaxi.com"));
});

test("source: falls back to the legacy coding_plan/remains endpoint when token_plan fails", async () => {
	const { calls, fetchImpl } = recorder(url => url.includes("token_plan") ? json({}, 404) : json(ok([GENERAL])));
	const w = await source(ctx({ minimax: SECRET }, fetchImpl));
	assert.ok(w?.weekly);
	assert.deepEqual(calls.map(c => c.url), [
		"https://api.minimax.io/v1/token_plan/remains",
		"https://api.minimax.io/v1/api/openplatform/coding_plan/remains",
	]);
});

test("source: key from env, MINIMAX_CODING_API_KEY wins over MINIMAX_API_KEY", async () => {
	const { calls, fetchImpl } = recorder(() => json(ok([GENERAL])));
	const w = await source(ctx({}, fetchImpl, { MINIMAX_API_KEY: "sk-api-OTHER", MINIMAX_CODING_API_KEY: SECRET }));
	assert.ok(w?.fiveHour);
	assert.equal(calls[0].init.headers.Authorization, `Bearer ${SECRET}`);
	const second = recorder(() => json(ok([GENERAL])));
	assert.ok(await source(ctx({}, second.fetchImpl, { MINIMAX_API_KEY: SECRET })));
	assert.equal(second.calls[0].init.headers.Authorization, `Bearer ${SECRET}`);
});

test("source: an env key rejected by the global host is retried on the China host (as CodexBar does)", async () => {
	const { calls, fetchImpl } = recorder(url => url.includes("api.minimaxi.com") ? json(ok([GENERAL])) : json({}, 401));
	const w = await source(ctx({}, fetchImpl, { MINIMAX_CODING_API_KEY: SECRET }));
	assert.ok(w?.fiveHour);
	assert.ok(calls.some(c => c.url.startsWith("https://api.minimaxi.com/")));
});

test("source: HTTP 401 on every endpoint resolves undefined", async () => {
	const { fetchImpl } = recorder(() => json({ base_resp: { status_code: 1004 } }, 401));
	assert.equal(await source(ctx({ minimax: SECRET }, fetchImpl)), undefined);
});

test("source: a thrown fetch, a non-JSON body and an empty model_remains all resolve undefined", async () => {
	assert.equal(await source(ctx({ minimax: SECRET }, async () => { throw new Error(`boom ${SECRET}`); })), undefined);
	assert.equal(await source(ctx({ minimax: SECRET }, async () => new Response("<html>", { status: 200 }))), undefined);
	assert.equal(await source(ctx({ minimax: SECRET }, async () => json(ok([])))), undefined);
});

test("source: a throwing apiKey lookup never propagates", async () => {
	const c = { env: {}, fetch: async () => json(ok([GENERAL])), nowMs: NOW, apiKey: async () => { throw new Error("nope"); } } as any;
	assert.equal(await source(c), undefined);
});

test("source: the returned value contains no secret", async () => {
	const { fetchImpl } = recorder(() => json(ok([GENERAL])));
	const w = await source(ctx({ minimax: SECRET }, fetchImpl));
	assert.ok(!JSON.stringify(w).includes("sk-cp"));
	assert.deepEqual(Object.keys(w!).sort(), ["fiveHour", "weekly"]);
});

// ---------------------------------------------------------------------------------------------------------------
// Real CodexBar fixtures, copied VERBATIM (quirks kept: strings-as-numbers, no model_name, epoch seconds, top-level
// model_remains, extra fields). CodexBar treats current_*_usage_count as REMAINING quota
// (Sources/CodexBarCore/Providers/MiniMax/MiniMaxUsageFetcher.swift:815,877-885; Tests/CodexBarTests/MiniMaxProviderTests.swift:529-532:
// total 1000 + usage_count 250 => remainingPrompts 250, usedPercent 75). Our source agrees.
// ---------------------------------------------------------------------------------------------------------------
const CB_NOW_S = 1_780_282_340;
const CB_NOW = CB_NOW_S * 1000;

// Payload from CodexBar Tests/CodexBarTests/Fixtures/Providers/MiniMax/token-plan-normal.json (MIT, (c) Peter Steinberger)
const FIXTURE_NORMAL = `{
  "base_resp": { "status_code": 0, "status_msg": "success" },
  "data": {
    "current_subscribe_title": "Token Plan Plus",
    "points_balance": "14000",
    "model_remains": [
      {
        "model_name": "general",
        "current_interval_total_count": 0,
        "current_interval_usage_count": 0,
        "current_interval_remaining_percent": "96",
        "start_time": 1780279200000,
        "end_time": 1780297200000,
        "current_weekly_total_count": 0,
        "current_weekly_usage_count": 0,
        "current_weekly_remaining_percent": "99",
        "weekly_start_time": 1780243200000,
        "weekly_end_time": 1780848000000
      }
    ]
  }
}`;

// Payload from CodexBar Tests/CodexBarTests/ProviderQuotaFixtureContractTests.swift:8-22 + Fixtures/Providers/MiniMax/token-plan-normal.json (MIT, (c) Peter Steinberger)
test("CodexBar fixture token-plan-normal: 96%/99% remaining => 4%/1%, resets at end_time and weekly_end_time", () => {
	assert.deepEqual(windowsFromPayload(JSON.parse(FIXTURE_NORMAL), CB_NOW), {
		fiveHour: { usedPercent: 4, resetsAt: 1_780_297_200_000 },
		weekly: { usedPercent: 1, resetsAt: 1_780_848_000_000 },
	});
});

// Payload from CodexBar Tests/CodexBarTests/Fixtures/Providers/MiniMax/token-plan-missing-reset.json (MIT, (c) Peter Steinberger)
// CodexBar keeps the 25%/40% windows with resetsAt nil; our Windows need a reset to wait for, so there is nothing to save.
test("CodexBar fixture token-plan-missing-reset: windows without any reset timestamp yield nothing to wait for", () => {
	const payload = JSON.parse(`{
  "base_resp": { "status_code": 0, "status_msg": "success" },
  "data": {
    "current_subscribe_title": "Token Plan Plus",
    "model_remains": [
      {
        "model_name": "general",
        "current_interval_total_count": 100,
        "current_interval_usage_count": 25,
        "current_interval_remaining_percent": 75,
        "current_weekly_total_count": 100,
        "current_weekly_usage_count": 40,
        "current_weekly_remaining_percent": 60
      }
    ]
  }
}`);
	assert.equal(windowsFromPayload(payload, CB_NOW), undefined);
});

// Payload from CodexBar Tests/CodexBarTests/MiniMaxTokenPlanChangeTests.swift:753-780 percentBasedRemainsJSON (MIT, (c) Peter Steinberger)
test("CodexBar percentBasedRemainsJSON (top-level model_remains, remains_time, status fields) => 4% / 1%", () => {
	const payload = JSON.parse(`{
      "model_remains": [
        {
          "start_time": 1780279200000,
          "end_time": 1780297200000,
          "remains_time": 16659830,
          "current_interval_total_count": 0,
          "current_interval_usage_count": 0,
          "model_name": "general",
          "current_weekly_total_count": 0,
          "current_weekly_usage_count": 0,
          "weekly_start_time": 1780243200000,
          "weekly_end_time": 1780848000000,
          "weekly_remains_time": 567459830,
          "current_interval_status": 1,
          "current_interval_remaining_percent": 96,
          "current_weekly_status": 1,
          "current_weekly_remaining_percent": 99
        }
      ],
      "base_resp": { "status_code": 0, "status_msg": "success" }
    }`);
	assert.deepEqual(windowsFromPayload(payload, CB_NOW), {
		fiveHour: { usedPercent: 4, resetsAt: 1_780_297_200_000 },
		weekly: { usedPercent: 1, resetsAt: 1_780_848_000_000 },
	});
});

// Payload from CodexBar Tests/CodexBarTests/MiniMaxWebResponseTests.swift:116-121 usageJSON (MIT, (c) Peter Steinberger)
test("CodexBar usageJSON (interval only, no weekly fields) => fiveHour 4%, no weekly", () => {
	const payload = JSON.parse(`{"model_remains":[{"start_time":1780279200000,"end_time":1780297200000,
    "remains_time":16659830,"model_name":"general","current_interval_total_count":0,
    "current_interval_usage_count":0,"current_interval_status":1,"current_interval_remaining_percent":96}],
    "base_resp":{"status_code":0,"status_msg":"success"}}`);
	assert.deepEqual(windowsFromPayload(payload, CB_NOW), { fiveHour: { usedPercent: 4, resetsAt: 1_780_297_200_000 } });
});

// Payload from CodexBar Tests/CodexBarTests/MiniMaxCurrentTokenPlanResponseTests.swift:164-203 currentTokenPlanRemainsJSON (MIT, (c) Peter Steinberger)
test("CodexBar currentTokenPlanRemainsJSON (boosted weekly, excluded video lane) => 0% / 30%", () => {
	const payload = JSON.parse(`{
      "model_remains": [
        {
          "start_time": 1782043200000,
          "end_time": 1782057600000,
          "remains_time": 7003536,
          "current_interval_total_count": 0,
          "current_interval_usage_count": 0,
          "model_name": "general",
          "current_weekly_total_count": 0,
          "current_weekly_usage_count": 0,
          "weekly_start_time": 1781452800000,
          "weekly_end_time": 1782057600000,
          "weekly_remains_time": 7003536,
          "current_interval_status": 1,
          "current_interval_remaining_percent": 100,
          "current_weekly_status": 1,
          "current_weekly_remaining_percent": 70,
          "weekly_boost_permille": 1500
        },
        {
          "start_time": 1781971200000,
          "end_time": 1782057600000,
          "remains_time": 7003536,
          "current_interval_total_count": 0,
          "current_interval_usage_count": 0,
          "model_name": "video",
          "current_weekly_total_count": 0,
          "current_weekly_usage_count": 0,
          "weekly_start_time": 1781452800000,
          "weekly_end_time": 1782057600000,
          "weekly_remains_time": 7003536,
          "current_interval_status": 3,
          "current_interval_remaining_percent": 100,
          "current_weekly_status": 3,
          "current_weekly_remaining_percent": 100
        }
      ],
      "base_resp": { "status_code": 0, "status_msg": "success" }
    }`);
	assert.deepEqual(windowsFromPayload(payload, 1_782_050_596 * 1000), {
		fiveHour: { usedPercent: 0, resetsAt: 1_782_057_600_000 },
		weekly: { usedPercent: 30, resetsAt: 1_782_057_600_000 },
	});
});

// Payload from CodexBar Tests/CodexBarTests/MiniMaxTokenPlanChangeTests.swift:62-110 (video first) (MIT, (c) Peter Steinberger)
test("CodexBar video-first payload: the general text lane drives fiveHour/weekly, not the first (video) entry", () => {
	const payload = JSON.parse(`{
          "base_resp": { "status_code": "0" },
          "model_remains": [
            {
              "model_name": "video",
              "current_interval_total_count": 100,
              "current_interval_usage_count": 70,
              "current_interval_remaining_percent": 30,
              "start_time": 1780243200000,
              "end_time": 1780329600000
            },
            {
              "model_name": "general",
              "current_interval_total_count": 0,
              "current_interval_usage_count": 0,
              "current_interval_remaining_percent": 96,
              "start_time": 1780279200000,
              "end_time": 1780297200000,
              "current_weekly_total_count": 0,
              "current_weekly_usage_count": 0,
              "current_weekly_remaining_percent": 99,
              "weekly_start_time": 1780243200000,
              "weekly_end_time": 1780848000000
            }
          ]
        }`);
	assert.deepEqual(windowsFromPayload(payload, CB_NOW), {
		fiveHour: { usedPercent: 4, resetsAt: 1_780_297_200_000 },
		weekly: { usedPercent: 1, resetsAt: 1_780_848_000_000 },
	});
});

// Payload from CodexBar Tests/CodexBarTests/MiniMaxTokenPlanChangeTests.swift:117-161 (plus plan, unavailable video lane) (MIT, (c) Peter Steinberger)
test("CodexBar plus plan payload: unavailable video lane (status 3, 100%) is ignored", () => {
	const payload = JSON.parse(`{
          "base_resp": { "status_code": 0, "status_msg": "success" },
          "model_remains": [
            {
              "start_time": 1780279200000,
              "end_time": 1780297200000,
              "remains_time": 16659830,
              "current_interval_total_count": 0,
              "current_interval_usage_count": 0,
              "model_name": "general",
              "current_weekly_total_count": 0,
              "current_weekly_usage_count": 0,
              "weekly_start_time": 1780243200000,
              "weekly_end_time": 1780848000000,
              "weekly_remains_time": 567459830,
              "current_interval_status": 1,
              "current_interval_remaining_percent": 96,
              "current_weekly_status": 1,
              "current_weekly_remaining_percent": 99
            },
            {
              "start_time": 1780243200000,
              "end_time": 1780329600000,
              "remains_time": 49059830,
              "current_interval_total_count": 0,
              "current_interval_usage_count": 0,
              "model_name": "video",
              "current_weekly_total_count": 0,
              "current_weekly_usage_count": 0,
              "weekly_start_time": 1780243200000,
              "weekly_end_time": 1780848000000,
              "weekly_remains_time": 567459830,
              "current_interval_status": 3,
              "current_interval_remaining_percent": 100,
              "current_weekly_status": 3,
              "current_weekly_remaining_percent": 100
            }
          ]
        }`);
	assert.deepEqual(windowsFromPayload(payload, CB_NOW), {
		fiveHour: { usedPercent: 4, resetsAt: 1_780_297_200_000 },
		weekly: { usedPercent: 1, resetsAt: 1_780_848_000_000 },
	});
});

// Payload from CodexBar Tests/CodexBarTests/MiniMaxTokenPlanChangeTests.swift:171-232 (boosted interval, unlimited weekly) (MIT, (c) Peter Steinberger)
test("CodexBar boosted-interval payload with unlimited weekly: only fiveHour (1%), no weekly to wait for", () => {
	const payload = JSON.parse(`{
          "model_remains": [
            {
              "start_time": 1780347600000,
              "end_time": 1780365600000,
              "remains_time": 4650822,
              "current_interval_total_count": 0,
              "current_interval_usage_count": 0,
              "model_name": "general",
              "current_weekly_total_count": 0,
              "current_weekly_usage_count": 0,
              "weekly_start_time": 1780243200000,
              "weekly_end_time": 1780848000000,
              "weekly_remains_time": 487050822,
              "current_interval_status": 1,
              "current_interval_remaining_percent": 99,
              "current_weekly_status": 3,
              "current_weekly_remaining_percent": 100,
              "interval_boost_permill": 2000,
              "weekly_boost_permill": 2000
            },
            {
              "start_time": 1780329600000,
              "end_time": 1780416000000,
              "remains_time": 55050822,
              "current_interval_total_count": 0,
              "current_interval_usage_count": 0,
              "model_name": "video",
              "current_weekly_total_count": 0,
              "current_weekly_usage_count": 0,
              "weekly_start_time": 1780243200000,
              "weekly_end_time": 1780848000000,
              "weekly_remains_time": 487050822,
              "current_interval_status": 3,
              "current_interval_remaining_percent": 100,
              "current_weekly_status": 3,
              "current_weekly_remaining_percent": 100
            }
          ],
          "base_resp": { "status_code": 0, "status_msg": "success" }
        }`);
	assert.deepEqual(windowsFromPayload(payload, 1_780_347_620 * 1000), { fiveHour: { usedPercent: 1, resetsAt: 1_780_365_600_000 } });
});

// Payload from CodexBar Tests/CodexBarTests/MiniMaxProviderTests.swift:505-533 (MIT, (c) Peter Steinberger)
// Entries WITHOUT model_name are real (legacy coding plan); CodexBar's snapshot still reads the first entry.
test("CodexBar coding plan remains: nameless entry, usage_count 250 of 1000 is REMAINING => 75% used, reset end_time (not remains_time)", () => {
	const start = 1_700_000_000_000;
	const end = start + 5 * 60 * 60 * 1000;
	const payload = JSON.parse(`{
          "base_resp": { "status_code": 0 },
          "current_subscribe_title": "Max",
          "model_remains": [
            {
              "current_interval_total_count": 1000,
              "current_interval_usage_count": 250,
              "start_time": ${start},
              "end_time": ${end},
              "remains_time": 240000
            }
          ]
        }`);
	assert.deepEqual(windowsFromPayload(payload, start), { fiveHour: { usedPercent: 75, resetsAt: end } });
});

// Payload from CodexBar Tests/CodexBarTests/MiniMaxProviderTests.swift:536-566 (MIT, (c) Peter Steinberger)
test("CodexBar M2.7-highspeed: usage_count is remaining quota (250/1000 => 75% used)", () => {
	const start = 1_700_000_000_000;
	const end = start + 5 * 60 * 60 * 1000;
	const payload = JSON.parse(`{
          "base_resp": { "status_code": 0 },
          "current_subscribe_title": "Max",
          "model_remains": [
            {
              "model_name": "M2.7-highspeed",
              "current_interval_total_count": 1000,
              "current_interval_usage_count": 250,
              "start_time": ${start},
              "end_time": ${end},
              "remains_time": 240000
            }
          ]
        }`);
	assert.deepEqual(windowsFromPayload(payload, start), { fiveHour: { usedPercent: 75, resetsAt: end } });
});

// Payload from CodexBar Tests/CodexBarTests/MiniMaxProviderTests.swift:568-606 (MIT, (c) Peter Steinberger)
test("CodexBar MiniMax-M1 with weekly counts: weekly 5376 remaining of 6000 => 10.4% used, resets at weekly_end_time", () => {
	const start = 1_700_000_000_000;
	const end = start + 5 * 60 * 60 * 1000;
	const weekStart = start - 2 * 24 * 60 * 60 * 1000;
	const weekEnd = weekStart + 7 * 24 * 60 * 60 * 1000;
	const payload = JSON.parse(`{
          "base_resp": { "status_code": 0 },
          "model_remains": [
            {
              "model_name": "MiniMax-M1",
              "current_interval_total_count": 1000,
              "current_interval_usage_count": 250,
              "start_time": ${start},
              "end_time": ${end},
              "current_weekly_total_count": 6000,
              "current_weekly_usage_count": 5376,
              "weekly_start_time": ${weekStart},
              "weekly_end_time": ${weekEnd}
            }
          ]
        }`);
	const w = windowsFromPayload(payload, start)!;
	assert.deepEqual(w.fiveHour, { usedPercent: 75, resetsAt: end });
	assert.ok(Math.abs(w.weekly!.usedPercent - 10.4) < 1e-9);
	assert.equal(w.weekly!.resetsAt, weekEnd);
});

// Payload from CodexBar Tests/CodexBarTests/MiniMaxProviderTests.swift:608-632 (MIT, (c) Peter Steinberger)
test("CodexBar legacy plan with weekly total 0 / usage 0 and no percent: no weekly window", () => {
	const start = 1_700_000_000_000;
	const end = start + 5 * 60 * 60 * 1000;
	const payload = JSON.parse(`{
          "base_resp": { "status_code": 0 },
          "model_remains": [
            {
              "model_name": "MiniMax-M1",
              "current_interval_total_count": 1000,
              "current_interval_usage_count": 250,
              "start_time": ${start},
              "end_time": ${end},
              "current_weekly_total_count": 0,
              "current_weekly_usage_count": 0
            }
          ]
        }`);
	assert.deepEqual(windowsFromPayload(payload, start), { fiveHour: { usedPercent: 75, resetsAt: end } });
});

// Payload from CodexBar Tests/CodexBarTests/MiniMaxProviderTests.swift:687-710 (MIT, (c) Peter Steinberger)
test("CodexBar data wrapper with string counts and string status_code: 14989 of 15000 remaining => 11/15000 used", () => {
	const start = 1_700_000_000_000;
	const end = start + 5 * 60 * 60 * 1000;
	const payload = JSON.parse(`{
          "base_resp": { "status_code": "0" },
          "data": {
            "current_subscribe_title": "Max",
            "model_remains": [
              {
                "current_interval_total_count": "15000",
                "current_interval_usage_count": "14989",
                "start_time": ${start},
                "end_time": ${end},
                "remains_time": 8941292
              }
            ]
          }
        }`);
	const w = windowsFromPayload(payload, 1_700_000_100_000)!;
	assert.ok(Math.abs(w.fiveHour!.usedPercent - (11 / 15000) * 100) < 0.01);
	assert.equal(w.fiveHour!.resetsAt, end);
	assert.equal(w.weekly, undefined);
});

// Payload from CodexBar Tests/CodexBarTests/MiniMaxProviderTests.swift:1179-1196 codingPlanJSON (MIT, (c) Peter Steinberger)
test("CodexBar codingPlanJSON: epoch SECONDS for start/end, remains_time in seconds, 8 of 10 remaining => 20% used", () => {
	const payload = JSON.parse(`{
      "base_resp": { "status_code": 0 },
      "data": {
        "plan_name": "Max",
        "model_remains": [
          {
            "model_name": "MiniMax-M1",
            "current_interval_total_count": 10,
            "current_interval_usage_count": 8,
            "start_time": 1779019200,
            "end_time": 1779037200,
            "remains_time": 3600
          }
        ]
      }
    }`);
	assert.deepEqual(windowsFromPayload(payload, 1_779_019_300_000), { fiveHour: { usedPercent: 20, resetsAt: 1_779_037_200_000 } });
});

// Payload from CodexBar Tests/CodexBarTests/MiniMaxProviderTests.swift:795-830 (MIT, (c) Peter Steinberger)
test("CodexBar logged-out bodies (status 1004 plain, string \"1004\", inside data wrapper) yield nothing", () => {
	for (const body of [
		`{ "base_resp": { "status_code": 1004, "status_msg": "cookie is missing, log in again" } }`,
		`{ "base_resp": { "status_code": "1004", "status_msg": "login required" } }`,
		`{ "data": { "base_resp": { "status_code": 1004, "status_msg": "unauthorized" } } }`,
	]) assert.equal(windowsFromPayload(JSON.parse(body), CB_NOW), undefined);
});

// Payload from CodexBar Tests/CodexBarTests/MiniMaxAPITokenFetchTests.swift:79-96 and MiniMaxProviderTests.swift:397-402 (MIT, (c) Peter Steinberger)
test("CodexBar partial/empty bodies: {}, bare model_name without quota fields, empty model_remains => nothing", () => {
	assert.equal(windowsFromPayload(JSON.parse(`{}`), CB_NOW), undefined);
	assert.equal(windowsFromPayload(JSON.parse(`{ "base_resp": { "status_code": 0 }, "plan_name": "MiniMax Star", "model_remains": [{"model_name": "abab6.5"}] }`), CB_NOW), undefined);
	assert.equal(windowsFromPayload(JSON.parse(`{ "data": { "model_remains": [] }, "base_resp": { "status_code": 0 } }`), CB_NOW), undefined);
});

// Payload from CodexBar Tests/CodexBarTests/MiniMaxAPITokenFetchTests.swift:61-96 (MIT, (c) Peter Steinberger)
test("CodexBar API-token flow: 401 {} from the global host then the nameless payload on the China host => 75% used", async () => {
	const start = 1_700_000_000_000;
	const end = start + 5 * 60 * 60 * 1000;
	const body = `{
                  "base_resp": { "status_code": 0 },
                  "current_subscribe_title": "Max",
                  "model_remains": [
                    {
                      "current_interval_total_count": 1000,
                      "current_interval_usage_count": 250,
                      "start_time": ${start},
                      "end_time": ${end},
                      "remains_time": 240000
                    }
                  ]
                }`;
	const { calls, fetchImpl } = recorder(url => url.includes("api.minimaxi.com") && url.includes("token_plan") ? new Response(body, { status: 200 }) : json({}, 401));
	const c = { env: { MINIMAX_CODING_API_KEY: SECRET }, fetch: fetchImpl, nowMs: start, apiKey: async () => undefined } as any;
	assert.deepEqual(await source(c), { fiveHour: { usedPercent: 75, resetsAt: end } });
	assert.deepEqual(calls.map(x => new URL(x.url).host + new URL(x.url).pathname), [
		"api.minimax.io/v1/token_plan/remains",
		"api.minimax.io/v1/api/openplatform/coding_plan/remains",
		"api.minimaxi.com/v1/token_plan/remains",
	]);
});

// shape inferred, no CodexBar fixture: the 401-on-every-endpoint, thrown-fetch and non-JSON cases above, and the
// epoch-ms remains_time fallback with a past end_time. CodexBar's rule (MiniMaxUsageFetcher.swift:908-915) is the same.
