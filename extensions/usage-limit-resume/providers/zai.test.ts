import test from "node:test";
import assert from "node:assert/strict";
import { source, windowsFromPayload } from "./zai.ts";

const NOW = 1_800_000_000_000;
const H = 3600_000;
const KEY = "sk-test-secret-123";

// Shape taken from the reference client's zai plugin: unit 3 = hours, 6 = weeks, 5 = minutes; nextResetTime in epoch ms.
const payload = (limits: unknown[], extra: Record<string, unknown> = {}) => ({ code: 200, success: true, msg: "ok", data: { limits, planName: "Pro", ...extra } });
const session = { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 12, nextResetTime: NOW + 2 * H };
const week = { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 40, nextResetTime: NOW + 100 * H };
const mcp = { type: "TIME_LIMIT", unit: 5, number: 1, usage: 1000, currentValue: 250, remaining: 750, percentage: 25, nextResetTime: NOW + 500 * H };

interface Call { url: string; init: any }
function ctx(opts: { body?: unknown; status?: number; env?: Record<string, string>; key?: string | undefined; throws?: boolean } = {}) {
	const calls: Call[] = [];
	const fetchFn = (async (url: any, init: any) => {
		calls.push({ url: String(url), init });
		if (opts.throws) throw new Error("boom");
		const status = opts.status ?? 200;
		return { ok: status >= 200 && status < 300, status, json: async () => opts.body ?? payload([session]) };
	}) as unknown as typeof fetch;
	return {
		calls,
		ctx: {
			env: opts.env ?? {},
			fetch: fetchFn,
			nowMs: NOW,
			apiKey: async (id: string) => (id === "zai" ? opts.key : undefined),
		},
	};
}

test("windowsFromPayload maps 5h/weekly/monthly by window length", () => {
	const w = windowsFromPayload(payload([session, week, mcp]), NOW);
	assert.deepEqual(w, {
		fiveHour: { usedPercent: 12, resetsAt: NOW + 2 * H },
		weekly: { usedPercent: 40, resetsAt: NOW + 100 * H },
		monthly: { usedPercent: 25, resetsAt: NOW + 500 * H },
	});
});

test("windowsFromPayload derives percent from counts and clamps", () => {
	const w = windowsFromPayload(payload([{ ...week, usage: 200, currentValue: 50, remaining: 150, percentage: 99 }, { ...session, percentage: 400 }]), NOW);
	assert.equal(w?.weekly?.usedPercent, 25);
	assert.equal(w?.fiveHour?.usedPercent, 100);
});

test("windowsFromPayload keeps the highest usedPercent when limits share a slot", () => {
	const w = windowsFromPayload(payload([session, { ...session, type: "CREDIT_LIMIT", percentage: 70, nextResetTime: NOW + H }]), NOW);
	assert.deepEqual(w?.fiveHour, { usedPercent: 70, resetsAt: NOW + H });
});

test("windowsFromPayload omits implausible 5h resets and entries without reset", () => {
	assert.equal(windowsFromPayload(payload([{ ...session, nextResetTime: NOW + 10 * H }]), NOW), undefined);
	assert.equal(windowsFromPayload(payload([{ ...session, nextResetTime: undefined }]), NOW), undefined);
});

test("windowsFromPayload ignores unknown types, bad entries, empty limits and bad envelopes", () => {
	assert.equal(windowsFromPayload(payload([]), NOW), undefined);
	assert.equal(windowsFromPayload({ code: 200, success: true, data: {} }, NOW), undefined);
	assert.equal(windowsFromPayload(payload([{ type: "OTHER_LIMIT", percentage: 5 }]), NOW), undefined);
	assert.equal(windowsFromPayload({ code: 401, success: false, msg: "no" }, NOW), undefined);
	assert.equal(windowsFromPayload(null, NOW), undefined);
	assert.deepEqual(windowsFromPayload(payload([week, "junk", { type: "TOKENS_LIMIT" }]), NOW), { weekly: { usedPercent: 40, resetsAt: NOW + 100 * H } });
});

test("source: request shape for the global region with the Pi key", async () => {
	const { ctx: c, calls } = ctx({ key: KEY, body: payload([session, week, mcp]) });
	const w = await source(c);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "https://api.z.ai/api/monitor/usage/quota/limit");
	assert.equal(calls[0].init.headers.authorization, `Bearer ${KEY}`);
	assert.equal(calls[0].init.headers.accept, "application/json");
	assert.equal(calls[0].init.redirect, "error");
	assert.ok(calls[0].init.signal);
	assert.equal(w?.weekly?.usedPercent, 40);
	assert.ok(!JSON.stringify(w).includes(KEY));
});

test("source: key from Z_AI_API_KEY when Pi has none", async () => {
	const { ctx: c, calls } = ctx({ env: { Z_AI_API_KEY: KEY } });
	assert.ok(await source(c));
	assert.equal(calls[0].init.headers.authorization, `Bearer ${KEY}`);
});

test("source: no key means no request and undefined", async () => {
	const { ctx: c, calls } = ctx({});
	assert.equal(await source(c), undefined);
	assert.equal(calls.length, 0);
});

test("source: BigModel aliases only count for the China region", async () => {
	const g = ctx({ env: { BIGMODEL_API_KEY: KEY } });
	assert.equal(await source(g.ctx), undefined);
	assert.equal(g.calls.length, 0);
	const cn = ctx({ env: { Z_AI_REGION: "bigmodel-cn", BIGMODEL_API_KEY: KEY } });
	assert.ok(await source(cn.ctx));
	assert.equal(cn.calls[0].url, "https://open.bigmodel.cn/api/monitor/usage/quota/limit");
});

test("source: team scope adds selectors and type=2, and needs both ids", async () => {
	const env = { Z_AI_REGION: "bigmodel-cn", Z_AI_USAGE_SCOPE: "team", Z_AI_ORGANIZATION: "org_1", Z_AI_PROJECT: "proj_1" };
	const ok = ctx({ key: KEY, env });
	assert.ok(await source(ok.ctx));
	assert.equal(ok.calls[0].url, "https://open.bigmodel.cn/api/monitor/usage/quota/limit?type=2");
	assert.equal(ok.calls[0].init.headers["Bigmodel-Organization"], "org_1");
	assert.equal(ok.calls[0].init.headers["Bigmodel-Project"], "proj_1");
	const missing = ctx({ key: KEY, env: { ...env, Z_AI_PROJECT: "" } });
	assert.equal(await source(missing.ctx), undefined);
	assert.equal(missing.calls.length, 0);
});

test("source: never sends the bearer to http or mismatched canonical hosts", async () => {
	for (const env of [
		{ Z_AI_QUOTA_URL: "http://evil.example/api" },
		{ Z_AI_API_HOST: "http://api.z.ai" },
		{ Z_AI_API_HOST: "open.bigmodel.cn" }, // canonical CN host cannot override the global region
		{ Z_AI_REGION: "mars" },
	] as Record<string, string>[]) {
		const t = ctx({ key: KEY, env });
		assert.equal(await source(t.ctx), undefined, JSON.stringify(env));
		assert.equal(t.calls.length, 0, JSON.stringify(env));
	}
});

test("source: explicit https quota URL and host overrides", async () => {
	const a = ctx({ key: KEY, env: { Z_AI_QUOTA_URL: "https://proxy.example/q" } });
	await source(a.ctx);
	assert.equal(a.calls[0].url, "https://proxy.example/q");
	const b = ctx({ key: KEY, env: { Z_AI_API_HOST: "proxy.example" } });
	await source(b.ctx);
	assert.equal(b.calls[0].url, "https://proxy.example/api/monitor/usage/quota/limit");
});

test("source: HTTP errors, thrown fetch and bad bodies resolve to undefined", async () => {
	assert.equal(await source(ctx({ key: KEY, status: 401 }).ctx), undefined);
	assert.equal(await source(ctx({ key: KEY, status: 500 }).ctx), undefined);
	assert.equal(await source(ctx({ key: KEY, throws: true }).ctx), undefined);
	assert.equal(await source(ctx({ key: KEY, body: payload([]) }).ctx), undefined);
	const bad = ctx({ key: KEY });
	bad.ctx.apiKey = async () => { throw new Error("nope"); };
	assert.equal(await source(bad.ctx), undefined);
});

// ---- Provider response examples ----
const json = (s: string) => JSON.parse(s);

// Example payload for this provider's usage response.
test("reported August payload keeps the 5h cadence and exact epoch, MCP lane is monthly", () => {
	const body = `
        {"code":200,"success":true,"data":{"level":"pro","limits":[
          {"type":"TIME_LIMIT","unit":5,"number":1,"usage":1000,"currentValue":0,"remaining":1000,
           "percentage":0,"nextResetTime":1786489348996,"usageDetails":[
             {"modelCode":"search-prime","usage":0},{"modelCode":"web-reader","usage":0},
             {"modelCode":"zread","usage":0}]},
          {"type":"TOKENS_LIMIT","unit":3,"number":5,"percentage":42,"nextResetTime":1786493397235}
        ]}}`;
	const now = Date.parse("2026-08-11T22:39:00Z");
	assert.deepEqual(windowsFromPayload(json(body), now), {
		fiveHour: { usedPercent: 42, resetsAt: 1786493397235 },
		monthly: { usedPercent: 0, resetsAt: 1786489348996 },
	});
});

// Example payload for this provider's usage response.
for (const type of ["TOKENS_LIMIT", "CREDIT_LIMIT"]) {
	const NOW_S = 1_800_000_000;
	const lim = (offsetS: number) => json(`
        {"code":200,"success":true,"data":{"limits":[
          {"type":"${type}","unit":3,"number":5,"percentage":25,"nextResetTime":${Math.round((NOW_S + offsetS) * 1000)}},
          {"type":"${type}","unit":6,"number":1,"percentage":9,"nextResetTime":${(NOW_S + 6 * 86400) * 1000}},
          {"type":"TIME_LIMIT","unit":5,"number":1,"percentage":22,"nextResetTime":${(NOW_S + 20 * 86400) * 1000}}
        ]}}`);
	test(`${type} five-hour resets beyond 5h+1min are omitted, other lanes kept`, () => {
		for (const off of [36000, 18060.001]) {
			assert.deepEqual(windowsFromPayload(lim(off), NOW_S * 1000), {
				weekly: { usedPercent: 9, resetsAt: (NOW_S + 6 * 86400) * 1000 },
				monthly: { usedPercent: 22, resetsAt: (NOW_S + 20 * 86400) * 1000 },
			});
		}
	});
	test(`${type} valid five-hour resets keep their exact timestamp`, () => {
		for (const off of [-60, 0, 3600, 18000, 18060]) {
			const w = windowsFromPayload(lim(off), NOW_S * 1000);
			assert.deepEqual(w?.fiveHour, { usedPercent: 25, resetsAt: (NOW_S + off) * 1000 }, String(off));
		}
	});
}

// Example payload for this provider's usage response.
test("zaiQuota golden (5h, weekly, MCP counts; MCP has no reset)", () => {
	const body = `
    {"code":200,"msg":"success","success":true,"data":{"planName":"Pro","limits":[
      {"type":"TOKENS_LIMIT","unit":3,"number":5,"percentage":25,"nextResetTime":1785816000000},
      {"type":"TOKENS_LIMIT","unit":6,"number":1,"percentage":9,"nextResetTime":1786291200000},
      {"type":"TIME_LIMIT","unit":5,"number":1,"usage":1000,"currentValue":224,"remaining":776,
       "percentage":22,"usageDetails":[{"modelCode":"search-prime","usage":210},
       {"modelCode":"web-reader","usage":14}]}
    ]}}`;
	// the reference client also reports the MCP lane (22.4%) without a reset; our Windows need resetsAt, so that lane is dropped.
	assert.deepEqual(windowsFromPayload(json(body), 1_785_816_000_000 - H), {
		fiveHour: { usedPercent: 25, resetsAt: 1785816000000 },
		weekly: { usedPercent: 9, resetsAt: 1786291200000 },
	});
	// Same MCP entry with a reset: counts win over percentage (224/1000 = 22.4, the reference client asserts 22.400000000000002).
	const withReset = json(body);
	withReset.data.limits[2].nextResetTime = 1788000000000;
	assert.equal(windowsFromPayload(withReset, 1_785_816_000_000 - H)?.monthly?.usedPercent, 22.400000000000002);
});

// Example payload for this provider's usage response.
test("zaiCreditQuota golden (CREDIT_LIMIT with ms-precision resets)", () => {
	const body = `
    {"code":200,"msg":"success","success":true,"data":{"level":"lite","limits":[
      {"type":"CREDIT_LIMIT","unit":3,"number":5,"usage":2000,"currentValue":100,"remaining":1900,
       "percentage":5,"nextResetTime":1786073946574},
      {"type":"CREDIT_LIMIT","unit":6,"number":1,"usage":10000,"currentValue":1000,"remaining":9000,
       "percentage":10,"nextResetTime":1786660486998}
    ]}}`;
	assert.deepEqual(windowsFromPayload(json(body), 1_786_073_946_000), {
		fiveHour: { usedPercent: 5, resetsAt: 1786073946574 },
		weekly: { usedPercent: 10, resetsAt: 1786660486998 },
	});
});

// Example payload for this provider's usage response.
for (const type of ["TOKENS_LIMIT", "CREDIT_LIMIT"]) {
	test(`${type} rolling 30-day limit is the monthly lane`, () => {
		const body = `
        {"code":200,"msg":"success","success":true,"data":{"limits":[
          {"type":"${type}","unit":1,"number":30,"percentage":50,"nextResetTime":1787112000000}
        ]}}`;
		assert.deepEqual(windowsFromPayload(json(body), 1_785_816_000_000), { monthly: { usedPercent: 50, resetsAt: 1787112000000 } });
	});
}

// Example payload for this provider's usage response.
test("TIME_LIMIT with an explicit 5h duration stays the MCP lane, never the session lane", () => {
	const body = `
    {"code":200,"msg":"success","success":true,"data":{"limits":[
      {"type":"TOKENS_LIMIT","unit":3,"number":5,"percentage":25,"nextResetTime":1785816000000},
      {"type":"TIME_LIMIT","unit":3,"number":5,"percentage":22,"nextResetTime":1785816000000}
    ]}}`;
	const now = 1_785_816_000_000 - H;
	assert.deepEqual(windowsFromPayload(json(body), now), {
		fiveHour: { usedPercent: 25, resetsAt: 1785816000000 },
		monthly: { usedPercent: 22, resetsAt: 1785816000000 },
	});
	// shape inferred, no sample payload: a busier MCP lane must not override the session percentage
	const busy = json(body);
	busy.data.limits[1].percentage = 99;
	assert.equal(windowsFromPayload(busy, now)?.fiveHour?.usedPercent, 25);
});

// Example payload for this provider's usage response.
test("TIME_LIMIT with unknown unit (0) keeps the session lane and puts MCP in monthly", () => {
	const body = `
    {"code":200,"msg":"success","success":true,"data":{"limits":[
      {"type":"TOKENS_LIMIT","unit":3,"number":5,"percentage":25,"nextResetTime":1785816000000},
      {"type":"TIME_LIMIT","unit":0,"number":1,"percentage":22,"nextResetTime":1785816000000}
    ]}}`;
	assert.deepEqual(windowsFromPayload(json(body), 1_785_816_000_000 - H), {
		fiveHour: { usedPercent: 25, resetsAt: 1785816000000 },
		monthly: { usedPercent: 22, resetsAt: 1785816000000 },
	});
});

// Example payload for this provider's usage response.
test("empty and unrecognized limits never fabricate unused quota", () => {
	for (const limits of ["", `{"type":"FUTURE_LIMIT","unit":3,"number":5,"percentage":40}`, `{"type":"FUTURE_POINTS_POOL","pointsRemaining":800}`]) {
		const body = `{"code":200,"success":true,"data":{"planName":"Pro","limits":[${limits}]}}`;
		assert.equal(windowsFromPayload(json(body), 1_785_816_000_000), undefined, limits);
	}
});

// Example payload for this provider's usage response.
test("explicit zero usage without a reset cannot be scheduled ", () => {
	for (const type of ["TOKENS_LIMIT", "CREDIT_LIMIT", "TIME_LIMIT"]) {
		const body = `{"code":200,"success":true,"data":{"limits":[{"type":"${type}","unit":3,"number":5,"percentage":0}]}}`;
		assert.equal(windowsFromPayload(json(body), 1_785_816_000_000), undefined, type);
		const timed = json(body);
		timed.data.limits[0].nextResetTime = 1785816000000 + H;
		assert.equal(windowsFromPayload(timed, 1_785_816_000_000)?.[type === "TIME_LIMIT" ? "monthly" : "fiveHour"]?.usedPercent, 0, type);
	}
});

// Example payload for this provider's usage response.
test("unknown extra limit does not hide the recognized one; pool-only plus MCP without reset is empty", () => {
	const mixed = `
        {"code":200,"success":true,"data":{"limits":[
          {"type":"TOKENS_LIMIT","unit":3,"number":5,"percentage":25,"nextResetTime":1785819600000},
          {"type":"FUTURE_POINTS_POOL","pointsRemaining":800}
        ]}}`;
	assert.deepEqual(windowsFromPayload(json(mixed), 1_785_816_000_000), { fiveHour: { usedPercent: 25, resetsAt: 1785819600000 } });
	const poolPlusMcp = `
        {"code":200,"success":true,"data":{"limits":[
          {"type":"FUTURE_POINTS_POOL","pointsRemaining":800},
          {"type":"TIME_LIMIT","unit":5,"number":1,"percentage":25}
        ]}}`;
	assert.equal(windowsFromPayload(json(poolPlusMcp), 1_785_816_000_000), undefined); // the reference client shows MCP 25%, no reset to schedule
});

// Example payload for this provider's usage response.
test("unsupported quota shapes yield no windows (the reference client throws with Usage Dashboard guidance)", () => {
	for (const data of [
		`{"pointsPool":{"remaining":800}}`,
		`{"limits":[{"unit":3,"number":5,"percentage":25}]}`,
		`{"limits":[{"type":null,"unit":3,"number":5,"percentage":25}]}`,
		`{"limits":[{"type":42,"unit":3,"number":5,"percentage":25}]}`,
	]) {
		assert.equal(windowsFromPayload(json(`{"code":200,"success":true,"data":${data}}`), 1_785_816_000_000), undefined, data);
	}
});

// Example payload for this provider's usage response.
test("quota fixture plus HTTP failure bodies through source() never throw and expose no key", async () => {
	const quota = `{"code":200,"msg":"success","success":true,"data":{"planName":"Pro","limits":[
      {"type":"TOKENS_LIMIT","unit":3,"number":5,"percentage":25,"nextResetTime":${NOW + H}},
      {"type":"TOKENS_LIMIT","unit":6,"number":1,"percentage":9,"nextResetTime":${NOW + 100 * H}}]}}`;
	const t = ctx({ key: KEY, body: json(quota) });
	const w = await source(t.ctx);
	assert.deepEqual(w, { fiveHour: { usedPercent: 25, resetsAt: NOW + H }, weekly: { usedPercent: 9, resetsAt: NOW + 100 * H } });
	assert.ok(!JSON.stringify(w).includes(KEY));
	// shape inferred, no sample payload: error envelope {code:401,...} with HTTP 200
	assert.equal(await source(ctx({ key: KEY, body: json(`{"code":401,"msg":"token expired","success":false}`) }).ctx), undefined);
});
