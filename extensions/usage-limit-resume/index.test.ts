import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extension from './index.ts';
import { SharedState } from './state.ts';
import { DEFAULT_CONFIG, mergeConfig, familyResolver } from './families.ts';
import { nativeSources as defaultSources } from './providers/index.ts';

const claude = { provider: 'anthropic', id: 'claude-opus-5-5' };
const codex = { provider: 'openai', id: 'gpt-6.1-sol' };
const zaiM = { provider: 'zai', id: 'glm-5' };
const kimiM = { provider: 'kimi-coding', id: 'kimi-k3' };
const cursorM = { provider: 'cursor-pro', id: 'composer-2' };
const limit = 'You have hit your usage limit';
const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 12; i++) await tick(); };
const sec = (ms: number) => Math.floor(ms / 1000);
const iso = (ms: number) => new Date(ms).toISOString();
const KNOWN = [...Object.keys(DEFAULT_CONFIG.families!), 'cursor-pro'];

/** A fake clock, fake timers and one or more extension instances sharing a state directory. */
function harness(t: any, o: any = {}) {
 const dir = mkdtempSync(join(tmpdir(), 'pi-quota-test-'));
 const original = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, now: Date.now };
 let clock = original.now();
 const timers: any[] = [];
 Date.now = () => clock;
 globalThis.setTimeout = ((fn: any, ms: number) => { const timer = { fn, at: clock + ms, ms, cancelled: false }; timers.push(timer); return timer; }) as any;
 globalThis.clearTimeout = ((timer: any) => { if (timer) timer.cancelled = true; }) as any;
 const store = o.store ?? new SharedState(dir, () => clock);
 if (!o.refresh) for (const f of KNOWN) store.touch(f);   // window refresh is opt-in per test
 const children: any[] = [];
 function child(opts: any = {}) {
  const handlers: any = {}, commands: any = {}, switched: any[] = [], statuses: any[] = [], sent: any[] = [], messages: any[] = [], notes: string[] = [];
  const controller = new AbortController();
  let abortCalls = 0;
  const ctx: any = {
   model: opts.current ?? claude, thinkingLevel: 'high', signal: controller.signal, abort: () => { abortCalls++; controller.abort(); }, isIdle: () => false,
   ui: { notify: (m: string) => notes.push(m), setStatus: (...a: any[]) => statuses.push(a) },
   modelRegistry: {
    getAvailable: () => [claude, codex, zaiM],
    isUsingOAuth: (m: any) => !(opts.apiOnly ?? []).includes(m.provider),
    getApiKeyForProvider: async (p: string) => opts.tokens?.[p],
   },
  };
  const env = { CODEX_HOME: join(dir, 'no-codex-home'), ...(opts.env ?? {}) };
  extension({
   on: (n: string, h: any) => handlers[n] = h, registerCommand: (n: string, c: any) => commands[n] = c,
   setModel: async (m: any) => { switched.push(m); return true; },
   sendUserMessage: (...a: any[]) => sent.push(a), sendMessage: (...a: any[]) => messages.push(a),
  } as any, {
   store, env, argv: opts.argv ?? ['node', 'pi'], config: opts.config ?? DEFAULT_CONFIG,
   claudeCli: opts.claudeCli ?? (async () => undefined),
   ...(opts.useDefaultSources ? {} : { nativeSources: opts.nativeSources ?? {} }), fetch: opts.fetch,
  });
  const c = {
   ctx, handlers, commands, switched, statuses, sent, messages, notes, controller, get abortCalls() { return abortCalls; },
   async error(msg = limit, outcome = 'error') {
    await handlers.agent_end({ messages: [{ role: 'assistant', stopReason: 'error', errorMessage: msg }] }, ctx);
    return handlers.agent_before_settle({ outcome, context: { canContinue: false } }, ctx);
   },
   /** A limit is hit and the extension is now waiting; returns a function that ends the wait. */
   async hit(msg = limit) { const p = c.error(msg); await settle(); return async () => { controller.abort(); await p; }; },
   async headers(seconds: number) { await handlers.after_provider_response({ status: 429, headers: { 'retry-after': String(seconds) } }, ctx); },
  };
  children.push(c); return c;
 }
 const c = child(o);
 t.after(async () => {
  for (const x of children) await x.handlers.session_shutdown({}, x.ctx);
  globalThis.setTimeout = original.setTimeout; globalThis.clearTimeout = original.clearTimeout; Date.now = original.now;
  rmSync(dir, { recursive: true, force: true });
 });
 const pending = () => timers.filter(x => !x.cancelled).length;
 return { ...c, get abortCalls() { return c.abortCalls; }, store, dir, timers, pending, waiting: () => timers.find(x => !x.cancelled), child, advance(ms: number) { clock += ms; for (const timer of [...timers]) if (!timer.cancelled && timer.at <= clock) { timer.cancelled = true; timer.fn(); } } };
}
const lastLimit = (h: any) => JSON.parse(readFileSync(join(h.dir, 'last-limit.json'), 'utf8'));

// ---------------------------------------------------------------- wait for the reset, then continue
test('a usage limit waits for the reset on the SAME model, then continues the task', async t => {
 const h = harness(t); await h.headers(3600);
 const p = h.error(); await settle();
 let settled = false; p.then(() => settled = true); await settle();
 assert.equal(settled, false); assert.equal(h.pending(), 1);
 h.advance(3600_000 + 91_000);
 const r = await p;
 assert.equal(r.continue, true); assert.equal(r.entries[0].type, 'custom_message'); assert.match(r.entries[0].content, /Continue exactly/);
 assert.equal(h.ctx.model, claude); assert.equal(h.switched.length, 0);
});
test('it never switches models, even when another provider has capacity', async t => {
 const h = harness(t); await h.headers(600);
 const p = h.error(); await settle(); h.advance(700_000); await p;
 assert.equal(h.switched.length, 0); assert.equal(h.ctx.model, claude); assert.equal(h.store.cooldown('codex'), 0);
});
test('with no reset known it probes after 10 minutes and continues', async t => {
 const h = harness(t); const p = h.error(); await settle();
 assert.ok(h.waiting().ms <= 60_000); h.advance(601_000); assert.equal((await p)?.continue, true);
});
test('a weekly reset days away is waited out', async t => {
 const h = harness(t); await h.headers(3 * 86400);
 const p = h.error(); await settle(); assert.equal(h.pending(), 1);
 h.advance(3 * 86400_000 + 91_000); assert.equal((await p)?.continue, true);
});
test('waits beyond 8 days stop instead of holding the session indefinitely', async t => {
 const h = harness(t); await h.headers(9 * 86400);
 assert.equal(await h.error(), undefined); assert.equal(h.timers.length, 0);
});
test('an aborted boundary neither waits nor continues', async t => {
 const h = harness(t); assert.equal(await h.error(limit, 'aborted'), undefined); assert.equal(h.timers.length, 0);
});
test('an API key on a pay-as-you-go provider never triggers a wait', async t => {
 const h = harness(t, { apiOnly: ['anthropic'] }); assert.equal(await h.error(), undefined); assert.equal(h.timers.length, 0);
});
test('overload, auth and network errors are not usage limits', async t => {
 const h = harness(t); for (const msg of ['503 overloaded', '401 unauthorized', 'network timeout']) assert.equal(await h.error(msg), undefined);
 assert.equal(h.timers.length, 0);
});
test('"model not supported" is not a quota event and is left alone', async t => {
 const h = harness(t); assert.equal(await h.error("OpenAI API error (400): The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account."), undefined);
 assert.equal(h.store.cooldown('claude'), 0); assert.equal(h.timers.length, 0);
});
test('a cooldown extended by another process is re-read before resuming', async t => {
 const h = harness(t); await h.headers(120);
 const p = h.error(); await settle(); h.store.limit('claude', Date.now() + 400_000);
 h.advance(211_000); await tick(); assert.equal(h.pending(), 1);
 h.advance(190_000); assert.equal((await p)?.continue, true);
});
test('abort while waiting releases the boundary and cancels the timer', async t => {
 const h = harness(t); const p = h.error(); await settle(); h.controller.abort();
 assert.equal(await p, undefined); assert.ok(h.timers.every(x => x.cancelled)); assert.equal(h.sent.length, 0);
});
test('cancel stops the wait AND drops the saved limit, so the next message is not held again', async t => {
 const h = harness(t); const p = h.error(); await settle(); await h.commands['limit-resume'].handler('cancel', h.ctx);
 assert.equal(await p, undefined); assert.equal(h.store.cooldown('claude'), 0); assert.ok(h.timers.every(x => x.cancelled));
 const c = h.child(); await c.handlers.before_agent_start({}, c.ctx);
 assert.equal(c.abortCalls, 0); assert.equal(c.messages.length, 0);
});
test('cancel is not undone by a saved exhausted window of the same reset, but a later limit waits again', async t => {
 const reset = Date.now() + 3 * 3600_000;
 const h = harness(t); h.store.setWindows('claude', { fiveHour: { usedPercent: 100, resetsAt: reset } });
 const p = h.handlers.before_agent_start({}, h.ctx); await settle();
 await h.commands['limit-resume'].handler('cancel', h.ctx); await p;
 await h.handlers.before_agent_start({}, h.ctx);
 assert.equal(h.store.cooldown('claude'), 0);
 const next = new AbortController(); h.ctx.signal = next.signal;
 await h.headers(3600); const q = h.error(); await settle();
 assert.ok(h.store.cooldown('claude') > Date.now()); next.abort(); await q;
});
test('now ends the wait once AND drops the saved limit, so the retry and the next message are not held again (S1)', async t => {
 const h = harness(t); const p = h.error(); await settle();
 await h.commands['limit-resume'].handler('now', h.ctx);
 assert.equal((await p)?.continue, true); assert.equal(h.store.cooldown('claude'), 0); assert.ok(h.timers.every(x => x.cancelled));
 await h.handlers.before_agent_start({}, h.ctx); assert.equal(h.abortCalls, 0); assert.equal(h.pending(), 0);
});
test('now while idle with a saved cooldown sends the resume prompt and it is not held (S1)', async t => {
 const h = harness(t); h.store.limit('claude', Date.now() + 3600_000); h.ctx.isIdle = () => true;
 await h.commands['limit-resume'].handler('now', h.ctx);
 assert.equal(h.sent.length, 1); assert.equal(h.store.cooldown('claude'), 0);
 await h.handlers.before_agent_start({}, h.ctx); assert.equal(h.pending(), 0);
});
test('shutdown resolves an active wait and clears the status line', async t => {
 const h = harness(t); const p = h.error(); await settle(); await h.handlers.session_shutdown({}, h.ctx);
 assert.equal(await p, undefined); assert.ok(h.statuses.some(([k, v]: any) => k === 'usage-limit-resume' && v === undefined));
});
test('it never publishes a wait status for any host: it does not depend on Gentle or any other harness', async t => {
 const h = harness(t); const done = await h.hit();
 assert.ok(!h.statuses.some(([k]: any) => k === 'usage-limit-resume-wait')); await done();
});

// ---------------------------------------------------------------- RPC child sessions (e.g. subagents) are driven by a host with its own watchdog
const rpc = ['node', 'pi', '--mode', 'rpc', '--session-dir', '/x'];
test('in an RPC child a usage limit is recorded and reported, but the turn is never held', async t => {
 const h = harness(t, { argv: rpc }); await h.headers(3600);
 assert.equal(await h.error(), undefined);
 assert.equal(h.pending(), 0); assert.ok(h.store.cooldown('claude') > Date.now()); assert.equal(lastLimit(h).source, 'headers');
 assert.match(h.notes.join('\n'), /claude.*resets/i);
});
test('in an RPC child a saved exhausted window neither holds nor aborts the message', async t => {
 const h = harness(t, { argv: rpc }); h.store.setWindows('claude', { fiveHour: { usedPercent: 100, resetsAt: Date.now() + 3600_000 } });
 await h.handlers.before_agent_start({}, h.ctx); assert.equal(h.pending(), 0); assert.equal(h.abortCalls, 0);
});
test('PI_USAGE_LIMIT_WAIT_IN_RPC=1 makes an RPC child wait like the main session', async t => {
 const h = harness(t, { argv: rpc, env: { PI_USAGE_LIMIT_WAIT_IN_RPC: '1' } }); await h.headers(3600);
 const p = h.error(); await settle(); assert.equal(h.pending(), 1); h.advance(3600_000 + 91_000); assert.equal((await p)?.continue, true);
});
test('the main interactive session is detected by the absence of --mode rpc, including print mode', async t => {
 for (const argv of [['node', 'pi'], ['node', 'pi', '-p', 'hi'], ['node', 'pi', '--mode', 'text'], ['node', 'pi', '--mode', 'json']]) {
  const h = harness(t, { argv }); await h.headers(600); const p = h.error(); await settle(); assert.equal(h.pending(), 1, argv.join(' ')); h.controller.abort(); await p;
 }
});
test('too many consecutive limit errors stop the automatic waiting', async t => {
 const h = harness(t); await h.headers(60);
 for (let i = 0; i < 12; i++) { const p = h.error(); await settle(); h.advance(200_000); assert.equal((await p)?.continue, true); await h.headers(60); }
 assert.equal(await h.error(), undefined);
 assert.match(h.notes.join('\n'), /Too many consecutive.*claude stays limited until .*\/limit-resume cancel clears it.*\/limit-resume now retries/s);
});
test('a successful response resets the consecutive counter and clears stale reset headers', async t => {
 const h = harness(t); await h.headers(18000); await h.handlers.after_provider_response({ status: 200, headers: {} }, h.ctx);
 const p = h.error(); await settle(); assert.ok(h.waiting().ms <= 600_000); h.controller.abort(); await p;
});

// ---------------------------------------------------------------- the chat notice
test('the chat says which provider is exhausted, when it resets and how to override', async t => {
 const h = harness(t); await h.headers(3600);
 const done = await h.hit();
 assert.equal(h.messages.length, 1); assert.equal(h.messages[0][0].display, true);
 assert.match(h.messages[0][0].content, /claude/); assert.match(h.messages[0][0].content, /\/limit-resume now/); assert.match(h.messages[0][0].content, /\d{1,2}:\d{2}/);
 await done();
});

// ---------------------------------------------------------------- preflight from saved windows
test('a saved exhausted window holds the next message until the reset, on the same model, with no failed request', async t => {
 const h = harness(t); const reset = Date.now() + 3 * 3600_000;
 h.store.setWindows('claude', { fiveHour: { usedPercent: 100, resetsAt: reset } });
 const p = h.handlers.before_agent_start({}, h.ctx); await settle();
 let settled = false; p.then(() => settled = true); await settle();
 assert.equal(settled, false); assert.equal(h.pending(), 1); assert.equal(h.messages.length, 1);
 h.advance(3 * 3600_000 + 91_000); await p;
 assert.equal(h.abortCalls, 0); assert.equal(h.ctx.model, claude); assert.equal(h.switched.length, 0);
});
test('a cancelled preflight wait aborts the message instead of sending it', async t => {
 const h = harness(t); h.store.setWindows('claude', { weekly: { usedPercent: 100, resetsAt: Date.now() + 86400_000 } });
 const p = h.handlers.before_agent_start({}, h.ctx); await settle(); h.controller.abort(); await p;
 assert.ok(h.abortCalls >= 1);
});
test('another provider is not held by the exhausted one', async t => {
 const h = harness(t, { current: codex }); h.store.setWindows('claude', { fiveHour: { usedPercent: 100, resetsAt: Date.now() + 3600_000 } });
 await h.handlers.before_agent_start({}, h.ctx); assert.equal(h.pending(), 0); assert.equal(h.abortCalls, 0);
});
test('Codex headers at 100% hold the next Codex message', async t => {
 const h = harness(t, { current: codex }); const n = Date.now();
 await h.handlers.after_provider_response({ status: 200, headers: { 'x-codex-primary-used-percent': '100', 'x-codex-primary-window-minutes': '300', 'x-codex-primary-reset-at': String(sec(n) + 7200) } }, h.ctx);
 const p = h.handlers.before_agent_start({}, h.ctx); await settle(); assert.equal(h.pending(), 1); h.controller.abort(); await p;
});
test('a weekly window at 100% blocks until the weekly reset; a saved monthly one never holds a message (S6)', async t => {
 const week = Date.now() + 4 * 86400_000, month = Date.now() + 20 * 86400_000;
 const a = harness(t); a.store.setWindows('claude', { fiveHour: { usedPercent: 10, resetsAt: Date.now() + 3600_000 }, weekly: { usedPercent: 100, resetsAt: week } });
 const pa = a.handlers.before_agent_start({}, a.ctx); await settle(); assert.ok(a.store.cooldown('claude') >= week); a.controller.abort(); await pa;
 const b = harness(t, { current: codex }); b.store.setWindows('codex', { monthly: { usedPercent: 100, resetsAt: month } });
 await b.handlers.before_agent_start({}, b.ctx); assert.equal(b.store.cooldown('codex'), 0); assert.equal(b.abortCalls, 0); assert.equal(b.pending(), 0);
});

// ---------------------------------------------------------------- families: any Pi provider
test('family ids sharing a prefix never share cooldowns', t => {
 const h = harness(t); h.store.limit('zai', Date.now() + 600_000);
 assert.ok(h.store.cooldown('zai') > 0); assert.equal(h.store.cooldown('zai-cn'), 0);
});
test('immutable shared cooldown records retain the longest concurrent reset', t => {
 const h = harness(t); const other = new SharedState(h.dir); h.store.limit('claude', Date.now() + 600_000); other.limit('claude', Date.now() + 30_000);
 assert.equal(h.store.cooldown('claude'), Date.now() + 600_000); h.advance(601_000); assert.equal(other.cooldown('claude'), 0);
});
test('any other OAuth provider is its own family, named after its Pi provider id', async t => {
 const h = harness(t, { current: cursorM });
 const done = await h.hit('429 usage limit reached');
 assert.equal(lastLimit(h).family, 'cursor-pro'); assert.equal(lastLimit(h).source, 'probe'); await done();
});
test('the default families cover the Pi providers whose plans report reset times', () => {
 const of = familyResolver(DEFAULT_CONFIG);
 const expect: Record<string, string> = { anthropic: 'claude', 'pi-claude-max': 'claude', openai: 'codex', 'openai-codex': 'codex', google: 'gemini', 'google-gemini-cli': 'gemini',
  zai: 'zai', 'zai-coding-cn': 'zai', 'kimi-coding': 'kimi', minimax: 'minimax', 'minimax-cn': 'minimax', 'github-copilot': 'copilot', 'opencode-go': 'opencodego' };
 for (const [provider, family] of Object.entries(expect)) assert.equal(of({ provider, id: provider === 'google' || provider === 'google-gemini-cli' ? 'gemini-3-pro' : provider === 'anthropic' || provider === 'pi-claude-max' ? 'claude-opus-5-5' : provider === 'openai' || provider === 'openai-codex' ? 'gpt-6' : 'x' }), family, provider);
 assert.equal(of({ provider: 'some-new-oauth', id: 'm' }), 'some-new-oauth'); assert.equal(of(undefined), undefined);
});
test('API-key plans (zai, kimi, minimax) are plans even though they are not OAuth', async t => {
 const h = harness(t, { current: zaiM, apiOnly: ['zai'] }); await h.headers(600);
 const p = h.error(); await settle(); assert.equal(h.pending(), 1); assert.ok(h.store.cooldown('zai') > Date.now()); h.controller.abort(); await p;
});
test('mergeConfig lets users add or override families and ignores the old failover keys', () => {
 const m = mergeConfig(DEFAULT_CONFIG, { families: { kimi: { piProviders: ['kimi'] }, mine: { piProviders: ['my-provider'], apiKey: true } }, tiers: { x: 1 }, order: ['a'] } as any);
 assert.deepEqual(m.families!.kimi.piProviders, ['kimi']); assert.ok(m.families!.mine && m.families!.claude && m.families!.codex);
 assert.deepEqual(Object.keys(m).sort(), ['families']);
});

// ---------------------------------------------------------------- how each cooldown was derived
test('records how each cooldown was derived, with the raw error', async t => {
 const h = harness(t); await h.headers(3600);
 const done = await h.hit('You have hit your usage limit. Try again in ~30 min.');
 const rec = lastLimit(h); assert.equal(rec.family, 'claude'); assert.equal(rec.source, 'headers'); assert.match(rec.error, /usage limit/); assert.ok(rec.resetAt > Date.now());
 await done();
});
test('the probe fallback is recorded as such', async t => {
 const h = harness(t); const done = await h.hit(); assert.equal(lastLimit(h).source, 'probe'); await done();
});
test('the reset comes from the error text when it has one', async t => {
 const h = harness(t); const done = await h.hit('usage limit reached, try again in 2h 13m');
 assert.equal(lastLimit(h).source, 'message'); assert.equal(lastLimit(h).resetAt, Date.now() + (2 * 60 + 13) * 60_000 + 90_000); await done();
});
test('the reset comes from the last windows seen on a successful response when the error has none', async t => {
 const h = harness(t); const reset = sec(Date.now()) + 3000;
 await h.handlers.after_provider_response({ status: 200, headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.97', 'anthropic-ratelimit-unified-5h-reset': String(reset),
  'anthropic-ratelimit-unified-7d-utilization': '0.2', 'anthropic-ratelimit-unified-7d-reset': String(reset + 400000) } }, h.ctx);
 await h.handlers.before_provider_request({}, h.ctx);
 const done = await h.hit(`429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account's rate limit. Please try again later."}}`);
 assert.equal(lastLimit(h).source, 'headers-cache'); assert.equal(lastLimit(h).resetAt, reset * 1000 + 90_000); await done();
});
test('cached windows from another family never leak into this limit', async t => {
 const h = harness(t); const reset = sec(Date.now()) + 3000;
 h.ctx.model = codex;
 await h.handlers.after_provider_response({ status: 200, headers: { 'x-codex-primary-used-percent': '99', 'x-codex-primary-reset-at': String(reset) } }, h.ctx);
 h.ctx.model = claude; const done = await h.hit(); assert.equal(lastLimit(h).source, 'probe'); await done();
});

// ---------------------------------------------------------------- the reset time is not in the error
test('a limit with no reset anywhere falls back to probing, even when the provider source is missing, failing or hung', async t => {
 for (const claude of [undefined, async () => { throw new Error('boom'); }, () => new Promise<any>(() => {})]) {
  const h = harness(t, { nativeSources: claude ? { claude } : {} }); const p = h.error(); await tick(); h.advance(20_000); await settle();
  assert.equal(lastLimit(h).source, 'probe'); h.controller.abort(); await p;
 }
});
test('a reset found in headers or the message never queries the provider source', async t => {
 let n = 0; const h = harness(t, { nativeSources: { claude: async () => { n++; return undefined; } } });
 await h.headers(3600); const done = await h.hit(); assert.equal(n, 0); await done();
});

// ---------------------------------------------------------------- saving the resets (background refresh and headers)
test('a normal message saves the resets of the provider in use without delaying the message', async t => {
 const calls: string[] = [];
 const h = harness(t, { refresh: true, nativeSources: { claude: async () => { calls.push('claude'); return { fiveHour: { usedPercent: 48, resetsAt: Date.now() + 3600_000 }, weekly: { usedPercent: 37, resetsAt: Date.now() + 86400_000 } }; } } });
 await h.handlers.before_agent_start({}, h.ctx); await settle();
 assert.deepEqual(calls, ['claude']);
 const w = h.store.windows('claude'); assert.equal(w.fiveHour!.usedPercent, 48); assert.equal(w.weekly!.usedPercent, 37); assert.ok(w.weekly!.resetsAt > w.fiveHour!.resetsAt);
});
test('a hung provider source never holds the message', async t => {
 const h = harness(t, { refresh: true, nativeSources: { claude: () => new Promise<any>(() => {}) } });
 await h.handlers.before_agent_start({}, h.ctx); assert.equal(h.abortCalls, 0);
});
test('only the providers actually used are refreshed', async t => {
 const seen: string[] = []; const h = harness(t, { refresh: true, current: zaiM, apiOnly: ['zai'], nativeSources: { zai: async () => { seen.push('zai'); return undefined; }, codex: async () => { seen.push('codex'); return undefined; } } });
 await h.handlers.before_agent_start({}, h.ctx); await settle(); assert.deepEqual([...new Set(seen)], ['zai']);
 h.ctx.model = codex; h.advance(6 * 60_000); await h.handlers.before_agent_start({}, h.ctx); await settle(); assert.deepEqual([...new Set(seen)].sort(), ['codex', 'zai']);
});
test('refresh is throttled across messages and runs again after 5 minutes', async t => {
 let n = 0; const h = harness(t, { refresh: true, current: codex, nativeSources: { codex: async () => { n++; return { fiveHour: { usedPercent: 10, resetsAt: Date.now() + 3600_000 } }; } } });
 await h.handlers.before_agent_start({}, h.ctx); await settle(); const first = n;
 await h.handlers.before_agent_start({}, h.ctx); await settle(); assert.equal(n, first);
 h.advance(6 * 60_000); await h.handlers.before_agent_start({}, h.ctx); await settle(); assert.equal(n, first * 2);
});
test('another process refreshing recently also throttles this one', async t => {
 let n = 0; const h = harness(t, { refresh: true, nativeSources: { claude: async () => { n++; return undefined; } } });
 h.store.setWindows('claude', { fiveHour: { usedPercent: 5, resetsAt: Date.now() + 3600_000 } });
 await h.handlers.before_agent_start({}, h.ctx); await settle(); assert.equal(n, 0);
});
test('every response saves the windows its headers carry, no external app needed', async t => {
 const h = harness(t); const n = Date.now();
 await h.handlers.after_provider_response({ status: 200, headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.48', 'anthropic-ratelimit-unified-5h-reset': String(sec(n) + 3600),
  'anthropic-ratelimit-unified-7d-utilization': '0.37', 'anthropic-ratelimit-unified-7d-reset': String(sec(n) + 86400) } }, h.ctx);
 const w = h.store.windows('claude'); assert.equal(w.fiveHour!.usedPercent, 48); assert.equal(w.weekly!.usedPercent, 37);
});
test('header saves are throttled, but an exhausted window is saved at once', async t => {
 const h = harness(t); const n = Date.now();
 const anth = (five: number) => ({ 'anthropic-ratelimit-unified-5h-utilization': String(five), 'anthropic-ratelimit-unified-5h-reset': String(sec(n) + 3600), 'anthropic-ratelimit-unified-7d-utilization': '0.1', 'anthropic-ratelimit-unified-7d-reset': String(sec(n) + 86400) });
 await h.handlers.after_provider_response({ status: 200, headers: anth(0.2) }, h.ctx);
 await h.handlers.after_provider_response({ status: 200, headers: anth(0.3) }, h.ctx);
 assert.equal(h.store.windows('claude').fiveHour!.usedPercent, 20);
 await h.handlers.after_provider_response({ status: 200, headers: anth(1) }, h.ctx);
 assert.equal(h.store.windows('claude').fiveHour!.usedPercent, 100);
});
test('/limit-resume status shows both resets of every provider in use', async t => {
 const h = harness(t); h.store.setWindows('claude', { fiveHour: { usedPercent: 48, resetsAt: Date.now() + 3600_000 }, weekly: { usedPercent: 37, resetsAt: Date.now() + 86400_000 } });
 await h.handlers.before_agent_start({}, h.ctx); await h.commands['limit-resume'].handler('status', h.ctx);
 assert.match(h.notes.join('\n'), /claude.*5h.*48%.*weekly.*37%/s);
});

// ---------------------------------------------------------------- native sources, keyed by family
const wham = (pct: number, reset: number) => ({ rate_limit: { primary_window: { used_percent: pct, limit_window_seconds: 18000, reset_at: reset }, secondary_window: { used_percent: 18, limit_window_seconds: 604800, reset_at: reset + 500000 } } });
const jwt = (claims: any) => ['x', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'y'].join('.');
const token = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_1' } });
function codexHome(h: any, auth: any, mode = 0o600) {
 const home = join(h.dir, 'codex-home'); mkdirSync(home, { recursive: true }); const f = join(home, 'auth.json');
 writeFileSync(f, typeof auth === 'string' ? auth : JSON.stringify(auth)); chmodSync(f, mode); return { home, file: f };
}
const cliAuth = { auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: 'i', access_token: 'cli-access', refresh_token: 'cli-refresh', account_id: 'acct_cli' }, last_refresh: 'x' };

test('a native source supplies windows with Pi\'s own credential', async t => {
 const calls: any[] = []; const reset = Date.now() + 3600_000;
 const h = harness(t, { refresh: true, current: zaiM, apiOnly: ['zai'], tokens: { zai: 'zai-key' },
  nativeSources: { zai: async (c: any) => { calls.push([await c.apiKey('zai'), typeof c.fetch, typeof c.nowMs, c.env === undefined]); return { fiveHour: { usedPercent: 100, resetsAt: reset } }; } } });
 await h.handlers.before_agent_start({}, h.ctx); await settle();
 assert.deepEqual(calls[0], ['zai-key', 'function', 'number', false]);
 // the saved 100% window now holds the next message
 const p = h.handlers.before_agent_start({}, h.ctx); await settle(); assert.ok(h.store.cooldown('zai') >= reset); h.controller.abort(); await p;
});
test('a failing or throwing native source saves nothing and never borrows another provider\'s source', async t => {
 let codexAuthTouched = 0;
 const h = harness(t, { refresh: true, current: kimiM, apiOnly: ['kimi-coding'], fetch: async () => { codexAuthTouched++; return { ok: false }; },
  nativeSources: { kimi: async () => { throw new Error('boom'); } } });
 await h.handlers.before_agent_start({}, h.ctx); await settle();
 assert.equal(h.store.windows('kimi').fiveHour, undefined); assert.equal(codexAuthTouched, 0);
});
test('a native source that finds nothing does not borrow Codex\'s windows', async t => {
 const home = harness(t); const { home: codexDir } = codexHome(home, cliAuth); let fetched = 0;
 const h = harness(t, { refresh: true, current: { provider: 'google', id: 'gemini-3-pro' }, env: { CODEX_HOME: codexDir }, nativeSources: { gemini: async () => undefined },
  fetch: async () => { fetched++; return { ok: true, json: async () => wham(100, sec(Date.now()) + 3600) }; } });
 await h.handlers.before_agent_start({}, h.ctx); await settle();
 assert.equal(fetched, 0); assert.equal(h.store.windows('gemini').fiveHour, undefined);
});
test('the first limit of a native-source family reads the reset from that source', async t => {
 const reset = Date.now() + 5 * 3600_000;
 const h = harness(t, { current: zaiM, apiOnly: ['zai'], nativeSources: { zai: async () => ({ fiveHour: { usedPercent: 100, resetsAt: reset } }) } });
 const done = await h.hit('429 usage limit reached for this plan');
 assert.equal(lastLimit(h).family, 'zai'); assert.equal(lastLimit(h).source, 'native'); assert.equal(lastLimit(h).resetAt, reset + 90_000); await done();
});
test('the default registry has a native source for every plain-HTTP provider with reset times, and a default family for each', () => {
 assert.deepEqual(Object.keys(defaultSources).sort(), ['copilot', 'gemini', 'kimi', 'minimax', 'opencodego', 'zai']);
 for (const id of Object.keys(defaultSources)) assert.ok(DEFAULT_CONFIG.families![id], `${id} has a default family`);
});
test('without overrides the extension reaches the real zai source through Pi\'s own key, over HTTPS only', async t => {
 const calls: any[] = [];
 const h = harness(t, { refresh: true, useDefaultSources: true, current: zaiM, apiOnly: ['zai'], tokens: { zai: 'pi-held-zai-key' },
  fetch: async (u: string, i: any) => { calls.push([u, i]); return { ok: false, status: 401, json: async () => ({}) }; } });
 await h.handlers.before_agent_start({}, h.ctx); await settle();
 const z = calls.find(c => /z\.ai|bigmodel/.test(c[0]));
 assert.ok(z, 'zai endpoint was called'); assert.match(z[0], /^https:\/\//); assert.equal(z[1].headers.authorization ?? z[1].headers.Authorization, 'Bearer pi-held-zai-key'); assert.equal(z[1].redirect, 'error');
});

// ---------------------------------------------------------------- Codex: the CLI login, read-only
test('Codex windows come from the usage endpoint with Pi\'s own credential', async t => {
 const r = sec(Date.now()) + 3 * 3600; const calls: any[] = [];
 const h = harness(t, { refresh: true, current: codex, tokens: { 'openai-codex': token },
  fetch: async (u: string, i: any) => { calls.push([u, i]); return { ok: true, json: async () => wham(100, r) }; } });
 await h.handlers.before_agent_start({}, h.ctx); await settle();
 assert.equal(h.store.windows('codex').fiveHour!.usedPercent, 100);
 assert.match(calls[0][0], /chatgpt\.com\/backend-api\/wham\/usage/); assert.equal(calls[0][1].headers['chatgpt-account-id'], 'acct_1');
});
test('without a usable Codex credential the refresh finds nothing but is still throttled', async t => {
 const h = harness(t, { refresh: true, current: codex, tokens: { openai: 'opaque' }, fetch: async () => { throw new Error('no'); } });
 await h.handlers.before_agent_start({}, h.ctx); await settle(); assert.equal(h.store.windows('codex').fiveHour, undefined);
 const h2 = harness(t, { refresh: true, current: codex }); await h2.handlers.before_agent_start({}, h2.ctx); await settle();
 assert.equal(h2.store.windows('codex').fiveHour, undefined); assert.ok(h2.store.windows('codex').checkedAt);
});
test('Codex CLI login (auth.json) feeds the usage endpoint, read-only', async t => {
 const r = sec(Date.now()) + 3 * 3600; const calls: any[] = [];
 const base = harness(t); const { home, file } = codexHome(base, cliAuth); const before = readFileSync(file, 'utf8'), mtime = statSync(file).mtimeMs;
 const h = harness(t, { refresh: true, current: codex, env: { CODEX_HOME: home }, fetch: async (u: string, i: any) => { calls.push([u, i]); return { ok: true, json: async () => wham(100, r) }; } });
 await h.handlers.before_agent_start({}, h.ctx); await settle();
 assert.equal(calls[0][1].headers.Authorization, 'Bearer cli-access'); assert.equal(calls[0][1].headers['chatgpt-account-id'], 'acct_cli');
 assert.equal(h.store.windows('codex').fiveHour!.usedPercent, 100); assert.equal(readFileSync(file, 'utf8'), before); assert.equal(statSync(file).mtimeMs, mtime);
});
test('auth.json readable by group or others is refused, never used', async t => {
 const calls: any[] = []; const base = harness(t); const { home } = codexHome(base, cliAuth, 0o644);
 const h = harness(t, { refresh: true, current: codex, env: { CODEX_HOME: home }, fetch: async (u: string, i: any) => { calls.push(i); return { ok: false }; } });
 await h.handlers.before_agent_start({}, h.ctx); await settle(); assert.equal(calls.length, 0);
});
test('missing, malformed or token-less auth.json falls through quietly', async t => {
 for (const body of ['not json', '{}', '{"tokens":{"access_token":"a"}}']) {
  const calls: any[] = []; const base = harness(t); const { home } = codexHome(base, body);
  const h = harness(t, { refresh: true, current: codex, env: { CODEX_HOME: home }, fetch: async (u: string, i: any) => { calls.push(i); return { ok: false }; } });
  await h.handlers.before_agent_start({}, h.ctx); await settle(); assert.equal(calls.length, 0);
 }
});
test('an expired CLI token (401) finds nothing and renews nothing', async t => {
 const calls: string[] = []; const base = harness(t); const { home, file } = codexHome(base, cliAuth); const before = readFileSync(file, 'utf8');
 const h = harness(t, { refresh: true, current: codex, env: { CODEX_HOME: home }, fetch: async (u: string) => { calls.push(u); return { ok: false, status: 401 }; } });
 await h.handlers.before_agent_start({}, h.ctx); await settle();
 assert.deepEqual(calls.filter(u => !/wham\/usage/.test(u)), []); assert.equal(h.store.windows('codex').fiveHour, undefined); assert.equal(readFileSync(file, 'utf8'), before);
});
test('the first Codex limit ever, with nothing saved, asks the usage endpoint for the reset', async t => {
 const r = sec(Date.now()) + 4 * 3600; const base = harness(t); const { home } = codexHome(base, cliAuth);
 const h = harness(t, { current: codex, env: { CODEX_HOME: home }, fetch: async () => ({ ok: true, json: async () => wham(100, r) }) });
 const done = await h.hit('The ChatGPT user has reached their Subscription Sharing usage limit.');
 assert.equal(lastLimit(h).source, 'usage-endpoint'); assert.equal(lastLimit(h).resetAt, r * 1000 + 90_000);
 assert.doesNotMatch(readFileSync(join(h.dir, 'last-limit.json'), 'utf8'), /cli-access|acct_cli|cli-refresh/); await done();
});

// ---------------------------------------------------------------- Claude: headers first, the CLI as the second option
const cliText = `Current session: 56% used · resets Oct 14 at 6:50pm (Europe/Madrid)\nCurrent week (all models): 38% used · resets Oct 20 at 6pm (Europe/Madrid)`;
test('Claude windows fall back to the claude CLI when headers have not provided them', async t => {
 const h = harness(t, { refresh: true, claudeCli: async () => cliText });
 await h.handlers.before_agent_start({}, h.ctx); await settle(); assert.equal(h.store.windows('claude').fiveHour!.usedPercent, 56);
});
test('claude CLI missing or failing saves nothing and never breaks the message', async t => {
 const h = harness(t, { refresh: true, claudeCli: async () => { throw new Error('ENOENT'); } });
 await h.handlers.before_agent_start({}, h.ctx); await settle(); assert.equal(h.store.windows('claude').fiveHour, undefined); assert.equal(h.abortCalls, 0);
});
test('the claude CLI is refreshed more rarely than the 5 minute cycle, since each run is a process', async t => {
 let n = 0; const h = harness(t, { refresh: true, claudeCli: async () => { n++; return cliText; } });
 await h.handlers.before_agent_start({}, h.ctx); await settle(); const first = n;
 h.advance(6 * 60_000); await h.handlers.before_agent_start({}, h.ctx); await settle(); assert.equal(n, first);
 h.advance(11 * 60_000); await h.handlers.before_agent_start({}, h.ctx); await settle(); assert.equal(n, first + 1);
});
test('the first Claude limit with nothing saved reads /usage from the CLI', async t => {
 const soon = new Date(Date.now() + 2 * 86400_000); const md = `${soon.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${soon.getUTCDate()}`;
 const h = harness(t, { claudeCli: async () => cliText.replace('56%', '100%').replace('Oct 14 at 6:50pm (Europe/Madrid)', `${md} at 6pm (UTC)`) });
 const done = await h.hit(`429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account's rate limit. Please try again later."}}`);
 assert.equal(lastLimit(h).source, 'claude-cli'); await done();
});
test('PI_USAGE_LIMIT_CLAUDE_CLI=0 never runs the claude CLI', async t => {
 let n = 0; const h = harness(t, { refresh: true, env: { PI_USAGE_LIMIT_CLAUDE_CLI: '0' }, claudeCli: async () => { n++; return cliText; } });
 await h.handlers.before_agent_start({}, h.ctx); await settle(); const done = await h.hit(); await settle(); assert.equal(n, 0); await done();
});

// ---------------------------------------------------------------- stale cooldown after a plan upgrade
const healthy = () => ({ fiveHour: { usedPercent: 0, resetsAt: Date.now() + 5 * 3600_000 }, weekly: { usedPercent: 0, resetsAt: Date.now() + 86400_000 } });
test('a saved cooldown is released at once when the provider now reports capacity (plan upgrade)', async t => {
 const h = harness(t, { nativeSources: { claude: async () => healthy() } });
 h.store.limit('claude', Date.now() + 3600_000);
 await h.handlers.before_agent_start({}, h.ctx);
 assert.equal(h.store.cooldown('claude'), 0); assert.equal(h.abortCalls, 0); assert.equal(h.messages.length, 0);
});
test('a saved cooldown still holds when the provider reports the window exhausted', async t => {
 const reset = Date.now() + 3600_000;
 const h = harness(t, { nativeSources: { claude: async () => ({ fiveHour: { usedPercent: 100, resetsAt: reset } }) } });
 h.store.limit('claude', reset);
 const p = h.handlers.before_agent_start({}, h.ctx); await settle();
 let settled = false; p.then(() => settled = true); await settle();
 assert.equal(settled, false); assert.ok(h.store.cooldown('claude') > Date.now()); assert.equal(h.messages.length, 1);
});
test('a saved cooldown still holds when the provider gives no windows at all', async t => {
 const h = harness(t); h.store.limit('claude', Date.now() + 3600_000);
 const p = h.handlers.before_agent_start({}, h.ctx); await settle();
 let settled = false; p.then(() => settled = true); await settle();
 assert.equal(settled, false); assert.ok(h.store.cooldown('claude') > Date.now());
});
test('while waiting, a plan upgrade is noticed and the task continues without waiting for the old reset', async t => {
 let up = false;
 const h = harness(t, { nativeSources: { claude: async () => up ? healthy() : { fiveHour: { usedPercent: 100, resetsAt: Date.now() + 3 * 3600_000 } } } });
 await h.headers(3 * 3600); const p = h.error(); await settle();
 up = true; h.advance(60_000); await settle(); h.advance(60_000); await settle(); h.advance(120_000); await settle();
 const r = await p;
 assert.equal(r.continue, true); assert.equal(h.store.cooldown('claude'), 0);
});
test('the wait ticks against the wall clock, so a machine that slept past the reset resumes at the next tick', async t => {
 const h = harness(t); await h.headers(3600); const p = h.error(); await settle();
 assert.ok(h.waiting().ms <= 60_000);
 h.advance(3600_000 + 91_000); assert.equal((await p).continue, true);
});
test('the wait is announced once per reset, not at every tick', async t => {
 const h = harness(t); await h.headers(3600); const p = h.error(); await settle();
 for (let i = 0; i < 5; i++) { h.advance(60_000); await settle(); }
 assert.equal(h.messages.length, 1); h.controller.abort(); await p;
});

// ---------------------------------------------------------------- history and status
test('every limit event is appended to a capped history, not only the last one', async t => {
 const h = harness(t);
 for (let i = 0; i < 3; i++) { const c = new AbortController(); h.ctx.signal = c.signal; await h.headers(600 + i); const p = h.error(); await settle(); c.abort(); await p; }
 const lines = readFileSync(join(h.dir, 'limit-history.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
 assert.equal(lines.length, 3); assert.ok(lines.every(l => l.family === 'claude')); assert.equal(lastLimit(h).family, 'claude');
});
test('the history is appended and rotated past 100 lines without losing any event (S10, S16)', t => {
 const dir = mkdtempSync(join(tmpdir(), 'pi-quota-hist-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
 const s = new SharedState(dir);
 const read = (n: string) => { try { return readFileSync(join(dir, n), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
 for (let i = 0; i < 60; i++) s.record({ n: i });
 assert.equal(read('limit-history.jsonl').length, 60);
 for (let i = 60; i < 250; i++) s.record({ n: i });
 const cur = read('limit-history.jsonl'), old = read('limit-history.1.jsonl');
 assert.ok(cur.length <= 100); assert.ok(old.length <= 101); assert.ok(old.length + cur.length >= 100);
 assert.equal(cur.at(-1).n, 249); assert.deepEqual([...old, ...cur].map(e => e.n), [...old, ...cur].map((_, i) => 250 - old.length - cur.length + i));
});
test('/limit-resume status lists active cooldowns, even for a family with no windows', async t => {
 const h = harness(t); h.store.limit('claude', Date.now() + 3600_000);
 await h.commands['limit-resume'].handler('status', h.ctx);
 assert.match(h.notes.join('\n'), /claude: cooldown until/);
});

// ---------------------------------------------------------------- review hardening (odd/tasks/review-hardening.md)
test('a dismissal persists across processes and tolerates a slightly later reset from another source (S2)', async t => {
 const reset = Date.now() + 3 * 3600_000;
 const h = harness(t); await h.headers(3 * 3600); const p = h.error(); await settle();
 await h.commands['limit-resume'].handler('cancel', h.ctx); await p;
 h.store.setWindows('claude', { fiveHour: { usedPercent: 100, resetsAt: reset + 60_000 } });
 const other = h.child(); await other.handlers.before_agent_start({}, other.ctx);
 assert.equal(h.store.cooldown('claude'), 0); assert.equal(other.abortCalls, 0); assert.equal(h.pending(), 0);
});
test('a new real limit overrides an earlier dismissal (S2)', async t => {
 const h = harness(t); h.store.limit('claude', Date.now() + 3600_000);
 await h.commands['limit-resume'].handler('cancel', h.ctx);
 const c = h.child(); await c.headers(1800); const p = c.error(); await settle();
 assert.ok(h.store.cooldown('claude') > Date.now()); c.controller.abort(); await p;
});
const healthy2 = () => ({ fiveHour: { usedPercent: 5, resetsAt: Date.now() + 5 * 3600_000 }, weekly: { usedPercent: 5, resetsAt: Date.now() + 86400_000 } });
test('a model-specific limit is not released by healthy account windows (S3)', async t => {
 const h = harness(t, { nativeSources: { claude: async () => healthy2() } });
 await h.headers(3600); const p = h.error('You have reached your Opus limit'); await settle();
 h.advance(240_000); await settle();
 assert.ok(h.store.cooldown('claude') > Date.now()); assert.equal(h.pending(), 1); h.controller.abort(); await p;
});
test('a limit hit again soon after a release is not released a second time (S3)', async t => {
 const h = harness(t, { nativeSources: { claude: async () => healthy2() } });
 h.store.limit('claude', Date.now() + 3600_000);
 await h.handlers.before_agent_start({}, h.ctx); assert.equal(h.store.cooldown('claude'), 0);
 await h.headers(3600); const p = h.error(); await settle(); h.advance(240_000); await settle();
 assert.ok(h.store.cooldown('claude') > Date.now()); assert.equal(h.pending(), 1); h.controller.abort(); await p;
});
test('a release check that finishes after cancel neither clears nor announces (S4)', async t => {
 let finish: any; const h = harness(t, { nativeSources: { claude: () => new Promise(r => finish = r) } });
 h.store.limit('claude', Date.now() + 3600_000);
 const p = h.handlers.before_agent_start({}, h.ctx); await settle();
 h.controller.abort(); h.store.limit('claude', Date.now() + 7200_000); finish(healthy2()); await p; await settle();
 assert.ok(h.store.cooldown('claude') > Date.now()); assert.ok(!h.notes.some(n => /capacity again/.test(n)));
});
test('a waiting process resumes within one tick when another process clears the cooldown (S5)', async t => {
 const h = harness(t); await h.headers(3 * 3600); const p = h.error(); await settle();
 h.store.clearCooldown('claude'); h.advance(60_000);
 assert.equal((await p)?.continue, true);
});
test('a successful response clears the family cooldown (S7)', async t => {
 const h = harness(t); h.store.limit('claude', Date.now() + 3600_000);
 await h.handlers.agent_end({ messages: [{ role: 'assistant', stopReason: 'stop' }] }, h.ctx);
 assert.equal(h.store.cooldown('claude'), 0);
});
test('a cooldown more than 8 days away never aborts messages; it is reported with its date (S6)', async t => {
 const h = harness(t); h.store.limit('claude', Date.now() + 20 * 86400_000);
 await h.handlers.before_agent_start({}, h.ctx);
 assert.equal(h.abortCalls, 0); assert.equal(h.pending(), 0); assert.match(h.notes.join('\n'), /claude.*more than 8 days/);
});
test('a probe wait says the reset time is unknown (S9)', async t => {
 const h = harness(t); const p = h.error(); await settle();
 assert.match(h.messages[0][0].content, /next retry at .*reset time unknown/); h.controller.abort(); await p;
});
test('the status line names the family and how to cancel; each held message is announced (S9)', async t => {
 const h = harness(t); h.store.limit('claude', Date.now() + 3600_000);
 const p1 = h.handlers.before_agent_start({}, h.ctx); await settle();
 assert.match(String(h.statuses.at(-1)[1]), /claude.*\/limit-resume cancel/);
 h.controller.abort(); await p1;
 const c = h.child(); const p2 = c.handlers.before_agent_start({}, c.ctx); await settle();
 assert.equal(c.messages.length, 1); c.controller.abort(); await p2;
});
test('a success on another model of the family does not clear a model-specific cooldown (S3, S7)', async t => {
 const h = harness(t); h.store.limit('claude', Date.now() + 3600_000, { noRelease: true });
 await h.handlers.agent_end({ messages: [{ role: 'assistant', stopReason: 'stop' }] }, h.ctx);
 assert.ok(h.store.cooldown('claude') > Date.now());
});

test('session start removes expired and corrupt cooldown files of every family (S13)', async t => {
 const h = harness(t);
 const id = '00000000-0000-4000-8000-000000000000';
 writeFileSync(join(h.dir, `cooldown-zai-${id}.json`), JSON.stringify({ at: Date.now() - 1000 }));
 writeFileSync(join(h.dir, `cooldown-kimi-${id}.json`), '{broken');
 h.store.limit('codex', Date.now() + 3600_000);
 await h.handlers.session_start({ reason: 'startup' }, h.ctx);
 const left = readdirSync(h.dir).filter(n => n.startsWith('cooldown-'));
 assert.equal(left.length, 1); assert.match(left[0], /^cooldown-codex-/); assert.ok(h.store.cooldown('codex') > Date.now());
});
test('an unusable state directory never breaks a message or a wait; the user is told once (S14)', async t => {
 const base = mkdtempSync(join(tmpdir(), 'pi-quota-bad-')); t.after(() => rmSync(base, { recursive: true, force: true }));
 writeFileSync(join(base, 'file'), 'x');
 const h = harness(t, { store: new SharedState(join(base, 'file', 'state')) });
 await h.handlers.before_agent_start({}, h.ctx); assert.equal(h.abortCalls, 0);
 await h.headers(3600); const p = h.error(); await settle();
 assert.equal(h.pending(), 1);
 h.advance(3600_000 + 91_000); assert.equal((await p)?.continue, true);
 assert.equal(h.notes.filter(n => /state directory/i.test(n)).length, 1);
});

// ---------------------------------------------------------------- resume after closing Pi (S11)
const reopen = (h: any, sid = 'sess-1') => { const c = h.child(); c.ctx.sessionManager = { getSessionId: () => sid }; c.ctx.isIdle = () => true; return c; };
async function closedWhileWaiting(t: any, seconds = 3600) {
 const h = harness(t); h.ctx.sessionManager = { getSessionId: () => 'sess-1' };
 await h.headers(seconds); const p = h.error(); await settle();
 await h.handlers.session_shutdown({}, h.ctx); assert.equal(await p, undefined);
 return h;
}
test('a wait interrupted by closing Pi resumes when that session is reopened, at the reset (S11)', async t => {
 const h = await closedWhileWaiting(t);
 const c = reopen(h); await c.handlers.session_start({ reason: 'resume' }, c.ctx);
 assert.match(c.notes.join('\n'), /claude.*continues .*automatically/i); assert.equal(c.sent.length, 0);
 h.advance(3600_000 + 91_000); await settle();
 assert.equal(c.sent.length, 1); assert.match(c.sent[0][0], /Continue exactly/);
 const again = reopen(h); await again.handlers.session_start({ reason: 'resume' }, again.ctx); h.advance(3600_000); await settle();
 assert.equal(again.sent.length, 0);
});
test('reopening after the reset already passed resumes at once (S11)', async t => {
 const h = await closedWhileWaiting(t, 60); h.advance(10 * 60_000);
 const c = reopen(h); await c.handlers.session_start({ reason: 'resume' }, c.ctx); await settle();
 assert.equal(c.sent.length, 1);
});
test('another session, or a message typed before the reset, does not get the resume prompt (S11)', async t => {
 const h = await closedWhileWaiting(t);
 const other = reopen(h, 'sess-2'); await other.handlers.session_start({ reason: 'startup' }, other.ctx);
 const c = reopen(h); await c.handlers.session_start({ reason: 'resume' }, c.ctx);
 c.ctx.model = codex; await c.handlers.before_agent_start({ prompt: 'something else' }, c.ctx);
 h.advance(3600_000 + 91_000); await settle();
 assert.equal(other.sent.length, 0); assert.equal(c.sent.length, 0);
});
test('cancel after reopening drops the pending resume; now sends it at once (S11)', async t => {
 const h = await closedWhileWaiting(t);
 const c = reopen(h); await c.handlers.session_start({ reason: 'resume' }, c.ctx);
 await c.commands['limit-resume'].handler('cancel', c.ctx); h.advance(3600_000 + 91_000); await settle();
 assert.equal(c.sent.length, 0);
 const h2 = await closedWhileWaiting(t);
 const d = reopen(h2); await d.handlers.session_start({ reason: 'resume' }, d.ctx);
 await d.commands['limit-resume'].handler('now', d.ctx); await settle();
 assert.equal(d.sent.length, 1); h2.advance(3600_000 + 91_000); await settle(); assert.equal(d.sent.length, 1);
});
test('a wait that ends normally leaves nothing to resume after a restart (S11)', async t => {
 const h = harness(t); h.ctx.sessionManager = { getSessionId: () => 'sess-1' };
 await h.headers(60); const p = h.error(); await settle(); h.advance(200_000); assert.equal((await p)?.continue, true);
 const c = reopen(h); await c.handlers.session_start({ reason: 'resume' }, c.ctx); await settle();
 assert.equal(c.sent.length, 0);
});
test('an RPC child never schedules a resume after a restart (S11)', async t => {
 const h = await closedWhileWaiting(t);
 const c = h.child({ argv: ['node', 'pi', '--mode', 'rpc'] }); c.ctx.sessionManager = { getSessionId: () => 'sess-1' };
 await c.handlers.session_start({ reason: 'resume' }, c.ctx); h.advance(3600_000 + 91_000); await settle();
 assert.equal(c.sent.length, 0);
});
test('resume files of sessions never reopened are dropped a week after their reset (S11, S13)', async t => {
 const h = harness(t);
 h.store.setPendingResume('old', { family: 'claude', at: Date.now() - 8 * 86400_000 });
 h.store.setPendingResume('recent', { family: 'claude', at: Date.now() - 86400_000 });
 await h.handlers.session_start({ reason: 'startup' }, h.ctx);
 assert.equal(h.store.pendingResume('old'), undefined); assert.ok(h.store.pendingResume('recent'));
});
test('a read-only state dir: what was written in memory wins over stale files, and no spurious warning (S14)', async t => {
 const dir = mkdtempSync(join(tmpdir(), 'pi-quota-ro-'));
 t.after(() => { chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }); });
 const s = new SharedState(dir);
 s.setWindows('claude', { fiveHour: { usedPercent: 100, resetsAt: Date.now() + 3600_000 } });
 s.limit('claude', Date.now() + 3600_000);
 chmodSync(dir, 0o500);
 s.setWindows('claude', { fiveHour: { usedPercent: 5, resetsAt: Date.now() + 3600_000 } });
 s.dismiss('claude', Date.now() + 7200_000);
 assert.equal(s.windows('claude').fiveHour!.usedPercent, 5); assert.ok(s.dismissedUntil('claude') > Date.now());
 const fresh = mkdtempSync(join(tmpdir(), 'pi-quota-ok-')); t.after(() => rmSync(fresh, { recursive: true, force: true }));
 const ok = new SharedState(fresh); ok.record({ n: 1 }); assert.equal(ok.failed, undefined);
});

// ---------------------------------------------------------------- round 2 (S17-S28)
test('chat notices never trigger a turn: they are sent with triggerTurn:false and shown as a notification (S18)', async t => {
 const h = harness(t); await h.headers(3600); const p = h.error(); await settle();
 assert.equal(h.messages.length, 1); assert.equal(h.messages[0][1]?.triggerTurn, false);
 assert.match(h.notes.join('\n'), /claude usage limit reached/); h.controller.abort(); await p;
});
test('now during the preflight provider check forces the retry without a second resume prompt (S27)', async t => {
 let finish: any; const h = harness(t, { nativeSources: { claude: () => new Promise(r => finish = r) } });
 h.store.limit('claude', Date.now() + 3600_000);
 const p = h.handlers.before_agent_start({}, h.ctx); await settle();
 await h.commands['limit-resume'].handler('now', h.ctx);
 finish(undefined); await p;
 assert.equal(h.sent.length, 0); assert.equal(h.abortCalls, 0); assert.equal(h.store.cooldown('claude'), 0); assert.equal(h.pending(), 0);
 await h.headers(3600); const q = h.error(); await settle(); assert.equal(h.pending(), 1); h.controller.abort(); await q;
});
