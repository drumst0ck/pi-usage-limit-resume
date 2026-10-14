import assert from "node:assert/strict";
import { test } from "node:test";
import { KIMI_USAGE_URL, source, windowsFromPayload } from "./kimi.ts";

const NOW = Date.parse("2026-01-06T10:00:00Z");
const SECRET = "sk-kimi-secret-123";
const pools = {
	usages: {
		limit_5h: { used_ratio: 0.25, reset_time: "2026-01-06T13:33:02.717479433Z" },
		limit_7d: { used_ratio: 0.5, reset_time: "2026-01-09T15:23:13Z" },
		limit_month_total: { used_ratio: 1.4, reset_time: "2026-02-01T00:00:00Z" },
	},
};
const legacy = {
	usage: { limit: "2048", used: "214", remaining: "1834", resetTime: "2026-01-09T15:23:13.716839300Z" },
	limits: [{ window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "200", used: "139", remaining: "61", resetTime: "2026-01-06T13:33:02.717479433Z" } }],
};

function ctx(over: Record<string, any> = {}, calls: any[] = []) {
	return {
		env: {}, nowMs: NOW,
		apiKey: async (id: string) => (id === "kimi-coding" ? SECRET : undefined),
		fetch: (async (url: any, init: any) => {
			calls.push({ url, init });
			return new Response(JSON.stringify(pools), { status: 200 });
		}) as typeof fetch,
		...over,
	};
}

test("ratio pools map to fiveHour/weekly/monthly, clamped to 100", () => {
	const w = windowsFromPayload(pools)!;
	assert.deepEqual(w.fiveHour, { usedPercent: 25, resetsAt: Date.parse("2026-01-06T13:33:02.717Z") });
	assert.deepEqual(w.weekly, { usedPercent: 50, resetsAt: Date.parse("2026-01-09T15:23:13Z") });
	assert.deepEqual(w.monthly, { usedPercent: 100, resetsAt: Date.parse("2026-02-01T00:00:00Z") });
});

test("legacy count payload maps usage to weekly and limits[0] to fiveHour", () => {
	const w = windowsFromPayload(legacy)!;
	assert.equal(w.weekly!.usedPercent, (214 / 2048) * 100);
	assert.equal(w.weekly!.resetsAt, Date.parse("2026-01-09T15:23:13.716Z"));
	assert.equal(w.fiveHour!.usedPercent, (139 / 200) * 100);
	assert.equal(w.monthly, undefined);
});

test("legacy counts win only when more exhausted and same reset (within 2s)", () => {
	const payload = {
		usages: { limit_5h: { used_ratio: 0.1, reset_time: "2026-01-06T13:33:02Z" } },
		limits: legacy.limits,
	};
	assert.equal(windowsFromPayload(payload)!.fiveHour!.usedPercent, (139 / 200) * 100);
	const other = { ...payload, limits: [{ ...legacy.limits[0], detail: { ...legacy.limits[0].detail, resetTime: "2026-01-06T18:00:00Z" } }] };
	assert.equal(windowsFromPayload(other)!.fiveHour!.usedPercent, 10);
});

test("missing pools stay absent; garbage gives undefined", () => {
	const w = windowsFromPayload({ usages: { limit_7d: pools.usages.limit_7d } })!;
	assert.equal(w.fiveHour, undefined);
	assert.equal(w.monthly, undefined);
	assert.ok(w.weekly);
	assert.equal(windowsFromPayload({}), undefined);
	assert.equal(windowsFromPayload(null), undefined);
	assert.equal(windowsFromPayload({ usages: { limit_5h: { used_ratio: 0.2 } } }), undefined);
	assert.equal(windowsFromPayload({ usages: { limit_5h: { used_ratio: -1, reset_time: "2026-01-06T13:00:00Z" } } }), undefined);
});

test("request shape: GET api.kimi.com/coding/v1/usages with Bearer key, no redirects, timeout", async () => {
	const calls: any[] = [];
	const w = await source(ctx({}, calls));
	assert.ok(w!.fiveHour);
	assert.equal(calls.length, 1);
	assert.equal(String(calls[0].url), "https://api.kimi.com/coding/v1/usages");
	assert.equal(KIMI_USAGE_URL, "https://api.kimi.com/coding/v1/usages");
	assert.equal(calls[0].init.method ?? "GET", "GET");
	assert.equal(calls[0].init.headers.Authorization, `Bearer ${SECRET}`);
	assert.equal(calls[0].init.headers.Accept, "application/json");
	assert.equal(calls[0].init.redirect, "error");
	assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test("key from KIMI_CODE_API_KEY when Pi holds none; Pi key wins when both exist", async () => {
	const calls: any[] = [];
	await source(ctx({ apiKey: async () => undefined, env: { KIMI_CODE_API_KEY: " env-key " } }, calls));
	assert.equal(calls[0].init.headers.Authorization, "Bearer env-key");
	const both: any[] = [];
	await source(ctx({ env: { KIMI_CODE_API_KEY: "env-key" } }, both));
	assert.equal(both[0].init.headers.Authorization, `Bearer ${SECRET}`);
});

test("no key: undefined and no request", async () => {
	const calls: any[] = [];
	assert.equal(await source(ctx({ apiKey: async () => undefined }, calls)), undefined);
	assert.equal(calls.length, 0);
});

test("apiKey lookup that throws is a silent miss", async () => {
	assert.equal(await source(ctx({ apiKey: async () => { throw new Error("boom"); } })), undefined);
});

test("HTTP 401/500, bad JSON and fetch errors resolve to undefined", async () => {
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
const T0 = Date.parse("2026-01-01T00:00:00Z");
const ms = (iso: string) => Date.parse(iso.replace(/(\.\d{3})\d+/, "$1"));
const near = (actual: number | undefined, expected: number) => assert.ok(Math.abs(actual! - expected) < 1e-5, `${actual} != ${expected}`);

const mixedInternational = `
{
  "usage": {
    "limit": "100",
    "used": "19",
    "remaining": "81",
    "resetTime": "2026-09-19T16:45:59.449979Z"
  },
  "limits": [
    {
      "window": {
        "duration": 300,
        "timeUnit": "TIME_UNIT_MINUTE"
      },
      "detail": {
        "limit": "100",
        "used": "1",
        "remaining": "99",
        "resetTime": "2026-09-19T14:45:59.449979Z"
      }
    }
  ],
  "usages": {
    "limit_5h": {
      "used_ratio": 0,
      "reset_time": "2026-09-19T14:45:58Z"
    },
    "limit_7d": {
      "used_ratio": 0,
      "reset_time": "2026-09-19T16:45:58Z"
    }
  }
}`;

// Example payload for this provider's usage response.
test("ported: ratio pools keep the 5h identity and monthly total; counts without reset are ignored", () => {
	const w = windowsFromPayload(JSON.parse(`
	{
	  "limits": [{
	    "window": {"duration": 300, "timeUnit": "TIME_UNIT_MINUTE"},
	    "detail": {"limit": "100", "used": "25", "remaining": "75"}
	  }],
	  "usages": {
	    "limit_5h": {"used_ratio": 0, "reset_time": "2026-09-16T20:15:44Z"},
	    "limit_month_total": {"used_ratio": 0.0056, "reset_time": "2026-10-17T00:00:00Z"},
	    "limit_month_code": {"used_ratio": 0, "reset_time": "2026-10-17T00:00:00Z"}
	  }
	}`))!;
	assert.equal(w.weekly, undefined);
	assert.deepEqual(w.fiveHour, { usedPercent: 0, resetsAt: ms("2026-09-16T20:15:44Z") });
	near(w.monthly!.usedPercent, 0.56);
	assert.equal(w.monthly!.resetsAt, ms("2026-10-17T00:00:00Z"));
});

// Example payload for this provider's usage response.
test("ported: ratio without reset_time cannot become a window (the reference client keeps it with a null reset; we need resetsAt)", () => {
	const w = windowsFromPayload(JSON.parse(`
	{"usages": {
	  "limit_7d": {"used_ratio": 0.125, "reset_time": "2026-09-20T00:00:00Z"},
	  "limit_5h": {"used_ratio": 0.625}
	}}`))!;
	assert.deepEqual(w.weekly, { usedPercent: 12.5, resetsAt: ms("2026-09-20T00:00:00Z") });
	assert.equal(w.fiveHour, undefined);
});

// Example payload for this provider's usage response.
test("ported: resetless count-only and monthly-only payloads give no window", () => {
	assert.equal(windowsFromPayload(JSON.parse(`{"limits": [{
	  "window": {"duration": 300, "timeUnit": "TIME_UNIT_MINUTE"},
	  "detail": {"limit": "100", "used": "25", "remaining": "75"}
	}]}`)), undefined);
	assert.equal(windowsFromPayload(JSON.parse(`{"usages": {"limit_month_total": {"used_ratio": 1.05}}}`)), undefined);
	assert.equal(windowsFromPayload(JSON.parse(`{"usage": {"limit": "100", "used": "25"},
	 "usages": {"limit_7d": {"used_ratio": -0.5}}}`)), undefined);
	// Example payload for this provider's usage response.
	assert.equal(windowsFromPayload(JSON.parse(`{"usage":{"limit":"100","used":"25","remaining":"75"},"limits":[]}`)), undefined);
});

// Example payload for this provider's usage response.
test("ported: invalid/empty quota bodies do not succeed as unused", () => {
	for (const json of ["{}", '{"usages":{}}', '{"usages":{"limit_5h":{}}}']) {
		assert.equal(windowsFromPayload(JSON.parse(json)), undefined, json);
	}
});

// Example payload for this provider's usage response.
test("ported: zero-ratio placeholder does not hide matching nonzero counts", () => {
	for (const reset of ["2026-09-19T16:45:58Z", "2026-09-19T16:45:59Z"]) {
		const w = windowsFromPayload(JSON.parse(`
		{"usage":{"limit":"100","used":"19","remaining":"81",
		          "resetTime":"2026-09-19T16:45:59.449979Z"},
		 "usages":{"limit_7d":{"used_ratio":0,"reset_time":"${reset}"}}}`))!;
		assert.equal(w.weekly!.usedPercent, 19, reset);
		assert.equal(w.weekly!.resetsAt, ms("2026-09-19T16:45:59.449979Z"));
	}
});

// Example payload for this provider's usage response.
test("ported: zero ratio after a different reset stays authoritative", () => {
	const w = windowsFromPayload(JSON.parse(`
	{"usage":{"limit":"100","used":"19","remaining":"81",
	          "resetTime":"2026-09-19T16:45:59Z"},
	 "usages":{"limit_7d":{"used_ratio":0,"reset_time":"2026-09-26T16:45:59Z"}}}`))!;
	assert.equal(w.weekly!.usedPercent, 0);
	assert.equal(w.weekly!.resetsAt, ms("2026-09-26T16:45:59Z"));
});

// Example payload for this provider's usage response.
test("ported: mixed international response keeps the used weekly and session quotas", () => {
	const w = windowsFromPayload(JSON.parse(mixedInternational))!;
	assert.equal(w.weekly!.usedPercent, 19);
	assert.equal(w.fiveHour!.usedPercent, 1);
	assert.equal(w.weekly!.resetsAt, ms("2026-09-19T16:45:59.449979Z"));
	assert.equal(w.fiveHour!.resetsAt, ms("2026-09-19T14:45:59.449979Z"));
	assert.equal(w.monthly, undefined);
});

// Example payload for this provider's usage response.
test("ported: a count window of a different duration cannot override the session ratio", () => {
	const w = windowsFromPayload(JSON.parse(mixedInternational.replace('"duration": 300', '"duration": 120')))!;
	assert.equal(w.weekly!.usedPercent, 19);
	assert.equal(w.fiveHour!.usedPercent, 0);
	assert.equal(w.fiveHour!.resetsAt, ms("2026-09-19T14:45:58Z"));
});

// Example payload for this provider's usage response.
test("ported: matching nonzero ratios and counts use the more exhausted reading", () => {
	for (const ratio of ["0.1869", "0.19", "0.5"]) {
		const w = windowsFromPayload(JSON.parse(`
		{"usage":{"limit":"100","used":"19","resetTime":"2026-09-19T16:45:59Z"},
		 "usages":{"limit_7d":{"used_ratio":${ratio},"reset_time":"2026-09-19T16:45:59Z"}}}`))!;
		near(w.weekly!.usedPercent, Math.max(19, Number(ratio) * 100));
	}
});

// Example payload for this provider's usage response.
test("ported: weekly counters reconcile even when a monthly ratio (no reset) is present", () => {
	const w = windowsFromPayload(JSON.parse(`
	{"usage":{"limit":"100","used":"19","resetTime":"2026-09-19T16:45:59Z"},
	 "usages":{"limit_7d":{"used_ratio":0,"reset_time":"2026-09-19T16:45:59Z"},
	           "limit_month_total":{"used_ratio":0.0313}}}`))!;
	assert.equal(w.weekly!.usedPercent, 19);
	assert.equal(w.monthly, undefined); // the reference client shows 3.13% with a null reset
});

// Example payload for this provider's usage response.
test("ported: unmatched count resets (null, invalid, 3s off) cannot override a zero ratio", () => {
	for (const reset of ["null", '"invalid"', '"2026-09-19T16:46:02Z"']) {
		const w = windowsFromPayload(JSON.parse(`
		{"usage":{"limit":"100","used":"19","resetTime":${reset}},
		 "usages":{"limit_7d":{"used_ratio":0,"reset_time":"2026-09-19T16:45:59Z"}}}`))!;
		assert.equal(w.weekly!.usedPercent, 0, reset);
	}
});

// Example payload for this provider's usage response.
test("ported: invalid or empty counts (0, -1, invalid) cannot override a zero ratio", () => {
	for (const used of ["0", "-1", "invalid"]) {
		const w = windowsFromPayload(JSON.parse(`
		{"usage":{"limit":"100","used":"${used}","resetTime":"2026-09-19T16:45:59Z"},
		 "usages":{"limit_7d":{"used_ratio":0,"reset_time":"2026-09-19T16:45:59Z"}}}`))!;
		assert.equal(w.weekly!.usedPercent, 0, used);
	}
});

// Example payload for this provider's usage response.
test("ported: exhausted session counts beat its zero ratio; monthly total kept; limit_month_code ignored", () => {
	const w = windowsFromPayload(JSON.parse(`
	{
	    "limits": [{ "window": { "duration": 300, "timeUnit": "TIME_UNIT_MINUTE" },
	        "detail": { "limit": "100", "used": "100", "resetTime": "2026-10-06T13:23:46.915474Z" } }],
	    "usages": {
	        "limit_5h": { "used_ratio": 0, "reset_time": "2026-10-06T13:23:46Z" },
	        "limit_month_total": { "used_ratio": 0.5531, "reset_time": "2026-10-22T14:26:29Z" },
	        "limit_month_code": { "used_ratio": 0, "reset_time": "2026-10-22T14:26:29Z" }
	    }
	}`))!;
	assert.deepEqual(w.fiveHour, { usedPercent: 100, resetsAt: ms("2026-10-06T13:23:46.915474Z") });
	near(w.monthly!.usedPercent, 55.31);
	assert.equal(w.monthly!.resetsAt, ms("2026-10-22T14:26:29Z"));
	assert.equal(w.weekly, undefined);
});

// Example payload for this provider's usage response.
test("ported: code API legacy counts 375/2048 weekly and 19/200 session", () => {
	const w = windowsFromPayload(JSON.parse(`
	{
	  "usage": {
	    "limit": "2048",
	    "used": "375",
	    "remaining": "1673",
	    "resetTime": "2026-01-09T15:23:13.373329235Z"
	  },
	  "limits": [
	    {
	      "window": {
	        "duration": 300,
	        "timeUnit": "TIME_UNIT_MINUTE"
	      },
	      "detail": {
	        "limit": "200",
	        "used": "19",
	        "remaining": "181",
	        "resetTime": "2026-01-06T15:05:24.374187075Z"
	      }
	    }
	  ]
	}`))!;
	near(w.weekly!.usedPercent, 18.310546875);
	assert.equal(w.weekly!.resetsAt, ms("2026-01-09T15:23:13.373329235Z"));
	near(w.fiveHour!.usedPercent, 9.5);
	assert.equal(w.fiveHour!.resetsAt, ms("2026-01-06T15:05:24.374187075Z"));
});

// Example payload for this provider's usage response.
test("ported: weekly-only counts fill only the weekly slot", () => {
	const w = windowsFromPayload({ usage: { limit: "2048", used: "512", remaining: "1536", resetTime: "2026-01-09T15:23:13Z" } })!;
	assert.deepEqual(w.weekly, { usedPercent: 25, resetsAt: ms("2026-01-09T15:23:13Z") });
	assert.equal(w.fiveHour, undefined);
});

// Example payload for this provider's usage response.
test("ported: numeric limits, resetAt/reset_at keys, remaining-only session", () => {
	const w = windowsFromPayload(JSON.parse(`
	{
	  "usage": {
	    "limit": 1000,
	    "used": 40,
	    "remaining": 960,
	    "resetAt": "2026-01-09T15:23:13Z"
	  },
	  "limits": [
	    {
	      "window": {
	        "duration": 300,
	        "timeUnit": "TIME_UNIT_MINUTE"
	      },
	      "detail": {
	        "limit": 100,
	        "remaining": 99,
	        "reset_at": "2026-01-06T13:33:02Z"
	      }
	    }
	  ]
	}`))!;
	assert.deepEqual(w.weekly, { usedPercent: 4, resetsAt: ms("2026-01-09T15:23:13Z") });
	assert.deepEqual(w.fiveHour, { usedPercent: 1, resetsAt: ms("2026-01-06T13:33:02Z") });
});

// Example payload for this provider's usage response.
test("ported: legacy FEATURE_CODING usages array is not a Code API body and gives no window", () => {
	assert.equal(windowsFromPayload(JSON.parse(`
	{
	  "usages": [
	    {
	      "scope": "FEATURE_CODING",
	      "detail": {
	        "limit": "2048",
	        "used": "375",
	        "remaining": "1673",
	        "resetTime": "2026-01-09T15:23:13.373329235Z"
	      },
	      "limits": null
	    }
	  ]
	}`)), undefined);
});

test("ported payloads flow through source() with a pre-reset fake clock", async () => {
	const w = await source(ctx({ nowMs: T0, fetch: async () => new Response(mixedInternational, { status: 200 }) }));
	assert.equal(w!.fiveHour!.usedPercent, 1);
	assert.equal(w!.weekly!.usedPercent, 19);
});

// shape inferred, no sample payload
test("inferred: ratio above 1 with count window of unknown unit does not override", () => {
	const w = windowsFromPayload({
		limits: [{ window: { duration: 5, timeUnit: "TIME_UNIT_FORTNIGHT" }, detail: { limit: "100", used: "90", resetTime: "2026-09-19T14:45:59Z" } }],
		usages: { limit_5h: { used_ratio: 0.1, reset_time: "2026-09-19T14:45:59Z" } },
	})!;
	assert.equal(w.fiveHour!.usedPercent, 10);
});
