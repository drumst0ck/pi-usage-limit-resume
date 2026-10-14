import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { source, windowsFromPayload } from "./gemini.ts";

const NOW = Date.parse("2026-10-14T12:00:00Z");
const SECRET = "ya29.FAKE-ACCESS-TOKEN-xyz";
const QUOTA = {
	buckets: [
		{ modelId: "gemini-2.5-pro", tokenType: "REQUESTS", remainingFraction: 0.25, resetTime: "2026-10-15T00:00:00Z" },
		{ modelId: "gemini-2.5-flash", tokenType: "REQUESTS", remainingFraction: 0.9, resetTime: "2026-10-14T20:00:00Z" },
		{ modelId: "gemini-2.5-flash-lite", tokenType: "REQUESTS", remainingFraction: 0.25, resetTime: "2026-10-14T18:00:00Z" },
	],
};

function home(creds: unknown, mode = 0o600, settings?: unknown) {
	const dir = mkdtempSync(join(tmpdir(), "gemini-test-"));
	mkdirSync(join(dir, ".gemini"));
	const file = join(dir, ".gemini", "oauth_creds.json");
	writeFileSync(file, typeof creds === "string" ? creds : JSON.stringify(creds));
	chmodSync(file, mode);
	if (settings) writeFileSync(join(dir, ".gemini", "settings.json"), JSON.stringify(settings));
	return { dir, file };
}
const creds = (extra: object = {}) => ({ access_token: SECRET, refresh_token: "REFRESH-SECRET", expiry_date: NOW + 3600_000, ...extra });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function ctx(dir: string, fetchImpl: any, nowMs = NOW) {
	return { env: { HOME: dir }, fetch: fetchImpl, nowMs, apiKey: async () => undefined } as any;
}
function okFetch(calls: any[] = []) {
	return async (url: any, init: any) => {
		calls.push({ url: String(url), init });
		if (String(url).endsWith(":loadCodeAssist")) return json({ cloudaicompanionProject: "proj-123", currentTier: { id: "standard-tier" } });
		return json(QUOTA);
	};
}

test("windowsFromPayload picks the most constrained bucket (lowest fraction, ties by earliest reset)", () => {
	const w = windowsFromPayload(QUOTA);
	assert.deepEqual(w, { fiveHour: { usedPercent: 75, resetsAt: Date.parse("2026-10-14T18:00:00Z") } });
});

test("windowsFromPayload rejects empty or malformed payloads", () => {
	assert.equal(windowsFromPayload(undefined), undefined);
	assert.equal(windowsFromPayload({}), undefined);
	assert.equal(windowsFromPayload({ buckets: [] }), undefined);
	assert.equal(windowsFromPayload({ buckets: [{ modelId: "m", remainingFraction: 0.5 }] }), undefined);
	assert.equal(windowsFromPayload({ buckets: [{ modelId: "m", remainingFraction: "x", resetTime: "2026-10-14T18:00:00Z" }] }), undefined);
});

test("windowsFromPayload clamps usedPercent to 0..100", () => {
	const w = windowsFromPayload({ buckets: [{ modelId: "m", remainingFraction: 1.5, resetTime: "2026-10-14T18:00:00Z" }] });
	assert.equal(w?.fiveHour?.usedPercent, 0);
	const z = windowsFromPayload({ buckets: [{ modelId: "m", remainingFraction: -1, resetTime: "2026-10-14T18:00:00Z" }] });
	assert.equal(z?.fiveHour?.usedPercent, 100);
});

test("source: fetches project then quota, with the documented request shape", async () => {
	const { dir } = home(creds());
	try {
		const calls: any[] = [];
		const w = await source(ctx(dir, okFetch(calls)));
		assert.deepEqual(w, { fiveHour: { usedPercent: 75, resetsAt: Date.parse("2026-10-14T18:00:00Z") } });
		assert.equal(calls.length, 2);
		assert.equal(calls[0].url, "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist");
		assert.deepEqual(JSON.parse(calls[0].init.body), { metadata: { ideType: "GEMINI_CLI", pluginType: "GEMINI" } });
		assert.equal(calls[1].url, "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota");
		assert.deepEqual(JSON.parse(calls[1].init.body), { project: "proj-123" });
		for (const c of calls) {
			assert.equal(c.init.method, "POST");
			assert.equal(c.init.headers.Authorization, `Bearer ${SECRET}`);
			assert.equal(c.init.headers["Content-Type"], "application/json");
			assert.equal(c.init.redirect, "error");
			assert.ok(c.init.signal instanceof AbortSignal);
		}
		assert.ok(!JSON.stringify(w).includes(SECRET));
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("source: project as object, and quota still asked with {} when loadCodeAssist fails", async () => {
	const { dir } = home(creds());
	try {
		const bodies: string[] = [];
		const f = async (url: any, init: any) => {
			if (String(url).endsWith(":loadCodeAssist")) return json({}, 500);
			bodies.push(init.body);
			return json(QUOTA);
		};
		assert.ok(await source(ctx(dir, f)));
		assert.deepEqual(JSON.parse(bodies[0]), {});
		const g = async (url: any, init: any) => String(url).endsWith(":loadCodeAssist") ? json({ cloudaicompanionProject: { id: "p-obj" } }) : (bodies.push(init.body), json(QUOTA));
		await source(ctx(dir, g));
		assert.deepEqual(JSON.parse(bodies[1]), { project: "p-obj" });
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("source: expired token => undefined, no network", async () => {
	const { dir } = home(creds({ expiry_date: NOW - 1 }));
	try {
		let n = 0;
		assert.equal(await source(ctx(dir, async () => { n++; return json(QUOTA); })), undefined);
		assert.equal(n, 0);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("source: group/other-readable file refused", async () => {
	const { dir } = home(creds(), 0o644);
	try {
		let n = 0;
		assert.equal(await source(ctx(dir, async () => { n++; return json(QUOTA); })), undefined);
		assert.equal(n, 0);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("source: missing file, malformed JSON, missing token", async () => {
	const empty = mkdtempSync(join(tmpdir(), "gemini-test-"));
	const bad = home("{not json");
	const none = home({ refresh_token: "x", expiry_date: NOW + 1000 });
	try {
		const f = async () => json(QUOTA);
		assert.equal(await source(ctx(empty, f)), undefined);
		assert.equal(await source(ctx(bad.dir, f)), undefined);
		assert.equal(await source(ctx(none.dir, f)), undefined);
		assert.equal(await source({ env: {}, fetch: f, nowMs: NOW, apiKey: async () => undefined } as any), undefined);
	} finally { for (const d of [empty, bad.dir, none.dir]) rmSync(d, { recursive: true, force: true }); }
});

test("source: api-key and vertex-ai auth types unsupported", async () => {
	for (const selectedType of ["api-key", "vertex-ai"]) {
		const { dir } = home(creds(), 0o600, { security: { auth: { selectedType } } });
		try {
			let n = 0;
			assert.equal(await source(ctx(dir, async () => { n++; return json(QUOTA); })), undefined);
			assert.equal(n, 0);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	}
	const { dir } = home(creds(), 0o600, { security: { auth: { selectedType: "oauth-personal" } } });
	try { assert.ok(await source(ctx(dir, okFetch()))); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("source: HTTP error, fetch throws, bad body => undefined", async () => {
	const { dir } = home(creds());
	try {
		const loadOk = (q: () => any) => async (url: any) => String(url).endsWith(":loadCodeAssist") ? json({ cloudaicompanionProject: "p" }) : q();
		assert.equal(await source(ctx(dir, loadOk(() => json({ error: "x" }, 403)))), undefined);
		assert.equal(await source(ctx(dir, loadOk(() => { throw new Error("net"); }))), undefined);
		assert.equal(await source(ctx(dir, async () => { throw new Error("net"); })), undefined);
		assert.equal(await source(ctx(dir, loadOk(() => new Response("not json", { status: 200 })))), undefined);
		assert.equal(await source(ctx(dir, loadOk(() => json({ buckets: [] })))), undefined);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("source: credential file is never modified", async () => {
	const { dir, file } = home(creds());
	try {
		const before = { body: readFileSync(file, "utf8"), mtime: statSync(file).mtimeMs, mode: statSync(file).mode };
		await source(ctx(dir, okFetch()));
		await new Promise(r => setTimeout(r, 15));
		const after = { body: readFileSync(file, "utf8"), mtime: statSync(file).mtimeMs, mode: statSync(file).mode };
		assert.deepEqual(after, before);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- Ported from CodexBar fixtures. nowMs is fixed BEFORE every payload date so no reset can look "past". ----
const EARLY = Date.parse("2024-12-31T00:00:00Z");
const near = (a: number | undefined, b: number) => assert.ok(a !== undefined && Math.abs(a - b) < 1e-9, `${a} !~ ${b}`);

// Payload from CodexBar Tests/CodexBarTests/GeminiAPITestHelpers.swift sampleQuotaResponse (MIT, (c) Peter Steinberger)
// CodexBar: pro 60% left, flash 90%, flash-lite 80%, lowest overall = 60% left => 40% used.
const SAMPLE_QUOTA = { buckets: [
	{ modelId: "gemini-2.5-pro", remainingFraction: 0.6, resetTime: "2025-01-01T00:00:00Z" },
	{ modelId: "gemini-2.5-flash", remainingFraction: 0.9, resetTime: "2025-01-01T00:00:00Z" },
	{ modelId: "gemini-2.5-flash-lite", remainingFraction: 0.8, resetTime: "2025-01-01T00:00:00Z" },
] };
test("CodexBar sampleQuotaResponse: lowest model wins, reset parsed", () => {
	const w = windowsFromPayload(SAMPLE_QUOTA);
	near(w?.fiveHour?.usedPercent, 40);
	assert.equal(w?.fiveHour?.resetsAt, Date.parse("2025-01-01T00:00:00Z"));
});

// Payload from CodexBar Tests/CodexBarTests/GeminiAPITestHelpers.swift sampleFlashQuotaResponse (MIT, (c) Peter Steinberger)
// CodexBar keeps the lowest fraction per model (0.4) => 60% used.
test("CodexBar sampleFlashQuotaResponse: same model twice keeps the lowest fraction", () => {
	const w = windowsFromPayload({ buckets: [
		{ modelId: "gemini-2.5-flash", remainingFraction: 0.9, resetTime: "2025-01-01T00:00:00Z" },
		{ modelId: "gemini-2.5-flash", remainingFraction: 0.4, resetTime: "2025-01-01T00:00:00Z" },
	] });
	near(w?.fiveHour?.usedPercent, 60);
});

// Payload from CodexBar Tests/CodexBarTests/GeminiMenuBarWindowTests.swift (MIT, (c) Peter Steinberger)
// CodexBar: flash-lite only, usedPercent == (1 - remainingFraction) * 100, including the exhausted 0.0 case.
test("CodexBar Flash Lite-only quota (0.6 and 0.0)", () => {
	for (const f of [0.6, 0.0]) {
		const w = windowsFromPayload({ buckets: [{ modelId: "gemini-2.5-flash-lite", remainingFraction: f, resetTime: "2030-01-01T00:00:00Z" }] });
		assert.equal(w?.fiveHour?.usedPercent, (1 - f) * 100);
		assert.equal(w?.fiveHour?.resetsAt, Date.parse("2030-01-01T00:00:00Z"));
	}
});

// Payload from CodexBar Tests/CodexBarTests/GeminiStatusProbeAPITests.swift (MIT, (c) Peter Steinberger)
// CodexBar: {"buckets": []} is a parse failure ("Could not parse Gemini usage").
test("CodexBar empty buckets => no windows", () => {
	assert.equal(windowsFromPayload({ buckets: [] }), undefined);
});

// Parser behavior from CodexBar GeminiStatusProbe.parseAPIResponse (MIT, (c) Peter Steinberger): buckets without a
// modelId are skipped. shape inferred, no CodexBar fixture
test("bucket without modelId is ignored like CodexBar", () => {
	assert.equal(windowsFromPayload({ buckets: [{ remainingFraction: 0.1, resetTime: "2025-01-01T00:00:00Z" }] }), undefined);
	const w = windowsFromPayload({ buckets: [
		{ remainingFraction: 0.0, resetTime: "2025-01-01T00:00:00Z" },
		{ modelId: "gemini-2.5-pro", remainingFraction: 0.5, resetTime: "2025-01-02T00:00:00Z" },
	] });
	assert.deepEqual(w, { fiveHour: { usedPercent: 50, resetsAt: Date.parse("2025-01-02T00:00:00Z") } });
});

// CodexBar ISO8601DateParser accepts fractional seconds and plain internet date-time. shape inferred, no CodexBar fixture
test("resetTime with fractional seconds parses", () => {
	const w = windowsFromPayload({ buckets: [{ modelId: "m", remainingFraction: 0.5, resetTime: "2025-01-01T00:00:00.123456Z" }] });
	assert.equal(w?.fiveHour?.resetsAt, Date.parse("2025-01-01T00:00:00.123Z"));
});

const LOAD_UNSUPPORTED = {
	allowedTiers: [{ id: "standard-tier", name: "Gemini Code Assist", userDefinedCloudaicompanionProject: true, isDefault: true }],
	ineligibleTiers: [{
		reasonCode: "UNSUPPORTED_CLIENT",
		reasonMessage: "This client is no longer supported for Gemini Code Assist for individuals. To continue using Gemini, please migrate to the Antigravity suite of products: https://antigravity.google",
		tierId: "free-tier",
		tierName: "Gemini Code Assist for individuals",
	}],
};

// Payloads from CodexBar Tests/CodexBarTests/GeminiAPITestHelpers.swift loadCodeAssist* helpers (MIT, (c) Peter Steinberger)
test("CodexBar loadCodeAssist bodies: project taken from cloudaicompanionProject, {} when absent", async () => {
	for (const [load, expected] of [
		[{ currentTier: { id: "free-tier", name: "free" }, cloudaicompanionProject: "cloudaicompanion-123", paidTier: { name: "Plus" } }, { project: "cloudaicompanion-123" }],
		[{ currentTier: { id: "standard-tier", name: "standard" } }, {}],
		[{ currentTier: { id: "legacy-tier", name: "legacy" } }, {}],
		[LOAD_UNSUPPORTED, {}],
	] as const) {
		const { dir } = home(creds());
		try {
			const bodies: string[] = [];
			const f = async (url: any, init: any) => String(url).endsWith(":loadCodeAssist") ? json(load) : (bodies.push(init.body), json(SAMPLE_QUOTA));
			const w = await source(ctx(dir, f, EARLY));
			assert.deepEqual(JSON.parse(bodies[0]), expected);
			near(w?.fiveHour?.usedPercent, 40);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	}
});

// Payloads from CodexBar Tests/CodexBarTests/GeminiAPITestHelpers.swift consumerTierDeprecationResponse and
// quotaSubscriptionRequiredResponse (MIT, (c) Peter Steinberger). CodexBar throws; we fall through silently.
test("CodexBar error bodies on quota (403 deprecation, 403 SUBSCRIPTION_REQUIRED, 401) => undefined", async () => {
	const bodies: Array<[unknown, number]> = [
		[{ error: { code: 403, message: "IneligibleTierError / UNSUPPORTED_CLIENT: This client is no longer supported for Gemini Code Assist for individuals. To continue using Gemini, please migrate to the Antigravity suite of products.", status: "PERMISSION_DENIED" } }, 403],
		[{ error: { code: 403, message: "You do not have a valid license of this product. Please contact your administrator to request a license. (#3501)", status: "PERMISSION_DENIED", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SUBSCRIPTION_REQUIRED", domain: "cloudaicompanion.googleapis.com" }] } }, 403],
		[{}, 401],
	];
	for (const [body, status] of bodies) {
		const { dir } = home(creds());
		try {
			const f = async (url: any) => String(url).endsWith(":loadCodeAssist") ? json(LOAD_UNSUPPORTED) : json(body, status);
			assert.equal(await source(ctx(dir, f, EARLY)), undefined);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	}
});

// Credential shape from CodexBar Tests/CodexBarTests/GeminiTestEnvironment.swift writeCredentials (MIT, (c) Peter Steinberger):
// expiry_date is epoch ms written as a non-integer double; id_token is present; token valid at EARLY.
test("credential file with fractional expiry_date and id_token is accepted and token not leaked", async () => {
	const { dir } = home(JSON.stringify({ access_token: SECRET, refresh_token: "r", id_token: "header.e30.sig", expiry_date: 1735689600000.123 }));
	try {
		const w = await source(ctx(dir, okFetch(), Date.parse("2025-01-01T00:00:00Z") - 1000));
		assert.ok(w);
		assert.ok(!JSON.stringify(w).includes(SECRET));
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

// CodexBar refreshes an access-token-less credential file; we never refresh. shape inferred, no CodexBar fixture
test("refresh-token-only credential file => undefined, no network", async () => {
	const { dir } = home({ refresh_token: "refresh-token", expiry_date: NOW + 3600_000 });
	try {
		let n = 0;
		assert.equal(await source(ctx(dir, async () => { n++; return json(SAMPLE_QUOTA); })), undefined);
		assert.equal(n, 0);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

// Settings values from CodexBar GeminiStatusProbeAPITests `rejects api key auth types` (arguments "gemini-api-key", "api-key")
test("gemini-api-key auth type unsupported", async () => {
	const { dir } = home(creds(), 0o600, { security: { auth: { selectedType: "gemini-api-key" } } });
	try {
		let n = 0;
		assert.equal(await source(ctx(dir, async () => { n++; return json(SAMPLE_QUOTA); })), undefined);
		assert.equal(n, 0);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
