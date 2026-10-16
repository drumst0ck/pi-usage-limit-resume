// Saves every provider's reset times and, when an exhausted plan resets, continues the task it was doing.
// It never chooses or switches models: that belongs to another plugin.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_CLI_TIMEOUT_MS, claudeCliWindows, runClaudeCli } from "./claude-cli.ts";
import { fetchCodexWindows, readCodexCliAuth } from "./codex-usage.ts";
import { familyResolver, loadConfig, usesPlan, type Config } from "./families.ts";
import { headerWindows, isUsageLimitError, parseResetHeaders, parseResetTime, resetFromWindows } from "./parse.ts";
import { nativeSources as defaultNativeSources } from "./providers/index.ts";
import type { NativeSource } from "./providers/types.ts";
import { modelRef, SharedState, type Family, type Windows } from "./state.ts";

const withTimeout = <T,>(p: Promise<T> | undefined, fallback: T, ms: number): Promise<T> => new Promise(resolve => {
 const timer = setTimeout(() => resolve(fallback), ms);
 (p ?? Promise.resolve(fallback)).then(v => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(fallback); });
});
const REFRESH_MS = 5 * 60_000;
const CLAUDE_CLI_REFRESH_MS = 15 * 60_000;
const HEADER_SAVE_MS = 30_000;
const LOOKUP_TIMEOUT_MS = 3_000;
const NATIVE_TIMEOUT_MS = 15_000;
const TICK_MS = 60_000;
const CHECK_MS = 3 * 60_000;
const MAX_WAIT_MS = 8 * 24 * 3600_000;
const MAX_CONSECUTIVE = 12;
const MARGIN_MS = 90_000;
const DISMISS_TOLERANCE_MS = 5 * 60_000;
const RELEASE_TRUST_MS = 15 * 60_000;
const RESUME_STALE_MS = 60 * 60_000;
const MODEL_LIMIT = /\b(opus|sonnet|haiku)\b[\w\s]{0,20}limit/i;
const PROBE_MS = [10, 20, 30, 60].map(m => m * 60_000);
const RESUME_PROMPT = "Provider capacity is available. Continue exactly where you stopped. " +
 "Reconcile any odd/tasks/<feature>.md document or open todo list with the next unfinished task. Do not redo completed work.";
const lastAssistant = (messages: any[]): any => [...messages].reverse().find(m => m?.role === "assistant");
export interface Options {
 env?: NodeJS.ProcessEnv; argv?: string[]; config?: Config; store?: SharedState; fetch?: typeof fetch;
 claudeCli?: () => Promise<string | undefined>; nativeSources?: Record<Family, NativeSource>;
}

export default function (pi: ExtensionAPI, options: Options = {}) {
 const env = options.env ?? process.env;
 const agentHome = env.PI_CODING_AGENT_DIR?.replace(/^~(?=\/|$)/, env.HOME ?? homedir()) ?? join(env.HOME ?? homedir(), ".pi", "agent");
 // The packaged config.json is replaced on every package update; the user's own file lives outside the package.
 const config = options.config ?? loadConfig([
  fileURLToPath(new URL("./config.json", import.meta.url)),
  env.PI_USAGE_LIMIT_CONFIG ?? join(agentHome, "usage-limit-resume.json"),
 ]);
 const store = options.store ?? new SharedState(env.PI_USAGE_LIMIT_STATE_DIR ?? join(agentHome, "usage-limit-resume-state"));
 const useClaudeCli = env.PI_USAGE_LIMIT_CLAUDE_CLI !== "0";

 // A Pi started with `--mode rpc` is driven by a host (a subagent runner, an IDE) that owns its own idle watchdog and
 // cannot be told that we are waiting. Holding its turn would get it killed as stalled, so such sessions only record
 // the reset and report; the host decides what to do. Set PI_USAGE_LIMIT_WAIT_IN_RPC=1 for a host that tolerates long silence.
 const argv = options.argv ?? process.argv;
 const rpcChild = argv.some((a, i) => a === "--mode" && argv[i + 1] === "rpc") && env.PI_USAGE_LIMIT_WAIT_IN_RPC !== "1";
 const familyOf = familyResolver(config);
 const plan = (ctx: any, model: any) => usesPlan(config, ctx, model, familyOf);
 const nativeSources = options.nativeSources ?? defaultNativeSources;
 const fetchFn = () => options.fetch ?? fetch;
 // Providers actually used in this session: the only ones whose windows are refreshed and shown.
 const usedFamilies = new Set<Family>();
 // Last raw rate-limit headers seen per family: limit errors carry no reset time, these headers do.
 const lastHeaders = new Map<Family, Record<string, string>>();
 const lastHeaderSave = new Map<Family, number>();
 const refreshing = new Set<Family>();
 let pendingError: string | undefined;
 let limitHeaders: Record<string, string> | undefined;
 let attempts = 0;
 let resumeAt: number | undefined;
 let wake: ((resume: boolean) => void) | undefined;
 let forceRetry = false;
 // Family the active wait is holding; when this process last released each family on fresh windows;
 // the cooldown instant of each family whose reset time is unknown (probe).
 let waitingFamily: Family | undefined;
 const released = new Map<Family, number>();
 const probeAt = new Map<Family, number>();
 let generation = 0;

 const stop = (ctx?: any) => {
  generation++;
  wake?.(false);
  announced.clear();
  ctx?.ui?.setStatus?.("usage-limit-resume", undefined);
 };
 const when = (at: number) => new Date(at).toLocaleString([], at - Date.now() > 20 * 3600_000 ? { weekday: "short", hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" });
 /** Sleeps in short ticks compared with the wall clock (a long timer stalls while the machine sleeps) and runs `check` now and then. */
 const waitUntil = (ctx: any, at: number, label: string, check?: () => Promise<boolean>, changed?: () => boolean): Promise<boolean> => {
  const ms = at - Date.now();
  if (ms <= 0) return Promise.resolve(!ctx.signal?.aborted);
  if (ms > MAX_WAIT_MS) {
   ctx.ui?.notify?.("Reset is more than 8 days away; automatic waiting stopped.", "warning");
   return Promise.resolve(false);
  }
  resumeAt = at;
  const signal: AbortSignal | undefined = ctx.signal;
  return new Promise(resolve => {
   let timer: ReturnType<typeof setTimeout> | undefined;
   let finished = false;
   let lastCheck = Date.now();
   const done = (resume: boolean) => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", aborted);
    if (wake === done) wake = undefined;
    resumeAt = undefined;
    ctx.ui?.setStatus?.("usage-limit-resume", undefined);
    resolve(resume);
   };
   const aborted = () => done(false);
   const tick = async () => {
    if (finished) return;
    if (Date.now() >= at) return done(true);
    // Another process cleared or shortened the cooldown (cancel, now, success, release): stop sleeping and re-read.
    try { if (changed?.()) return done(true); } catch { /* Keep waiting on our own instant. */ }
    if (check && Date.now() - lastCheck >= CHECK_MS) {
     lastCheck = Date.now();
     if (await check().catch(() => false)) return done(true);
     if (finished) return;
    }
    timer = setTimeout(tick, Math.max(1, Math.min(at - Date.now(), TICK_MS)));
   };
   wake = done;
   signal?.addEventListener("abort", aborted, { once: true });
   if (signal?.aborted) { done(false); return; }
   ctx.ui?.setStatus?.("usage-limit-resume", `⏳ ${label} limit · resumes ${when(at)} · /limit-resume cancel`);
   timer = setTimeout(tick, Math.min(ms, TICK_MS));
  });
 };
 const announce = (ctx: any, f: Family, at: number) => {
  const time = when(at);
  const head = Math.abs((probeAt.get(f) ?? -Infinity) - at) < 1000 ? `${f} usage limit reached; next retry at ${time} (reset time unknown).` : `${f} usage limit reached. It resets at ${time}.`;
  try {
   // triggerTurn:false: while a run is active Pi would otherwise queue this as a steering message, and a queued
   // message makes the boundary continue on the limited provider even when the wait ends without a resume.
   pi.sendMessage?.({ customType: "usage-limit-resume", display: true,
    content: `⏳ ${head} Pi continues this task automatically then. /limit-resume now retries, /limit-resume cancel stops waiting.` }, { triggerTurn: false });
  } catch { /* A missing chat notice must not break the wait. */ }
  ctx?.ui?.notify?.(`${head} /limit-resume cancel stops waiting (Esc cannot).`, "info");
 };
 const announced = new Set<number>();
 // The provider's fresh windows beat a saved cooldown: with no exhausted window the plan has capacity again.
 // Never for a model-specific limit or one hit again soon after a release: the account windows cannot see those.
 const releaseIfHealthy = async (ctx: any, f: Family, epoch: number, periodic = false): Promise<boolean> => {
  if (store.cooldownInfo(f).noRelease) return false;
  // The periodic check during a wait shares the refresh throttle with every process: a weekly wait must not spawn
  // the Claude CLI every 3 minutes. The preflight check is one per user message and always runs.
  if (periodic) {
   if (Date.now() - (store.windows(f).checkedAt ?? 0) < (f === "claude" ? CLAUDE_CLI_REFRESH_MS : REFRESH_MS)) return false;
   try { store.touch(f); } catch { /* Best effort. */ }
  }
  const w = await withTimeout<Windows | undefined>(nativeWindows(f, ctx), undefined, NATIVE_TIMEOUT_MS);
  if (!w) return false;
  store.setWindows(f, w);
  // Cancelled, aborted or superseded while the provider answered: the answer must not change anything.
  if (epoch !== generation || ctx.signal?.aborted || store.cooldownInfo(f).noRelease) return false;
  const now = Date.now();
  const list = [w.fiveHour, w.weekly].filter(Boolean);   // monthly windows gate one lane only: no veto
  if (!list.length || list.some(x => x!.usedPercent >= 100 && x!.resetsAt > now)) return false;
  store.clearCooldown(f);
  released.set(f, Date.now());
  ctx.ui?.notify?.(`${f} has capacity again (plan changed or window reset early); continuing.`, "info");
  return true;
 };
 /** Holds on the same model until the provider's cooldown ends. False when cancelled, aborted or too far away. */
 const waitForReset = async (ctx: any, f: Family, preflight = false): Promise<boolean> => {
  const epoch = generation;
  waitingFamily = f;
  try {
   // "now" during the preflight provider check (no timer yet) still means "retry at once".
   forceRetry = false;
  let first = preflight;
  if (preflight) announced.clear();   // every held message is announced
  while (epoch === generation && !ctx.signal?.aborted) {
   const at = store.cooldownInfo(f, modelRef(ctx.model)).at;
   if (at <= Date.now()) {
    // Cleared by cancel/now in another process: that user wanted the waiting to stop, not a resume prompt here.
    if (!preflight && store.dismissedUntil(f) > Date.now()) return false;
    return true;
   }
   // A saved cooldown can be stale (plan upgraded, window reset early): ask the provider before holding the message.
   if (first) {
    first = false;
    const healthy = await releaseIfHealthy(ctx, f, epoch);
    if (forceRetry) { forceRetry = false; return true; }
    if (healthy) return true;
    continue;
   }
   if (!announced.has(at)) { announced.clear(); announced.add(at); announce(ctx, f, at); }
   if (!await waitUntil(ctx, at, f, () => releaseIfHealthy(ctx, f, epoch, true), () => store.cooldown(f) < at - 1000)) return false;
   if (forceRetry) { forceRetry = false; return true; }
   // Another process may have extended the account cooldown. Re-read before resuming.
  }
  return false;
  } finally { if (waitingFamily === f) waitingFamily = undefined; }
 };

 // ----- where reset times come from -----
 /** The provider's own source, never another provider's: Codex endpoint, Claude CLI, or a registered native source. */
 const nativeWindows = async (f: Family, ctx: any): Promise<Windows | undefined> => {
  const native = nativeSources[f];
  if (native) {
   try {
    return await native({
     env, fetch: fetchFn(), nowMs: Date.now(),
     apiKey: p => withTimeout<string | undefined>(Promise.resolve(ctx?.modelRegistry?.getApiKeyForProvider?.(p)), undefined, LOOKUP_TIMEOUT_MS),
    });
   } catch { return undefined; }
  }
  if (f === "claude") {
   if (!useClaudeCli) return undefined;
   return claudeCliWindows(await withTimeout<string | undefined>(Promise.resolve((options.claudeCli ?? runClaudeCli)()), undefined, CLAUDE_CLI_TIMEOUT_MS), Date.now());
  }
  if (f === "codex") {
   const cli = readCodexCliAuth(env);
   const fromCli = cli ? await fetchCodexWindows(cli.token, fetchFn(), cli.accountId) : undefined;
   if (fromCli) return fromCli;
   for (const provider of [...new Set([ctx?.model?.provider, "openai-codex"].filter(Boolean))]) {
    const token = await withTimeout<string | undefined>(Promise.resolve(ctx?.modelRegistry?.getApiKeyForProvider?.(provider)), undefined, LOOKUP_TIMEOUT_MS);
    const w = await fetchCodexWindows(token, fetchFn());
    if (w) return w;
   }
  }
  return undefined;
 };
 // Fire and forget: the user's message never waits on any of this.
 const refreshWindows = (ctx: any) => {
  for (const f of usedFamilies) {
   if (refreshing.has(f) || Date.now() - (store.windows(f).checkedAt ?? 0) < (f === "claude" ? CLAUDE_CLI_REFRESH_MS : REFRESH_MS)) continue;
   refreshing.add(f);
   void (async () => {
    try {
     const w = await nativeWindows(f, ctx);
     w ? store.setWindows(f, w) : store.touch(f);
    } catch { /* Best effort. */ } finally { refreshing.delete(f); }
   })();
  }
 };
 // A saved window at 100% is a known cooldown: hold the message instead of wasting a request on that provider.
 const applySavedWindows = () => {
  // Monthly windows are left out: they often gate one lane only (Z.ai MCP, Copilot premium) while the model still works.
  for (const f of usedFamilies) {
   const w = store.windows(f);
   const dismissedUntil = store.dismissedUntil(f);
   for (const win of [w.fiveHour, w.weekly]) {
    const until = (win?.resetsAt ?? 0) + MARGIN_MS;
    if (win && win.usedPercent >= 100 && win.resetsAt > Date.now() && until > dismissedUntil + DISMISS_TOLERANCE_MS && store.cooldown(f) < until - 1000) store.limit(f, until);
   }
  }
 };

 // ----- resume after closing Pi -----
 let shuttingDown = false;
 let resumeTimer: ReturnType<typeof setTimeout> | undefined;
 let resumeSession: string | undefined;
 const sessionIdOf = (ctx: any): string | undefined => { try { return ctx?.sessionManager?.getSessionId?.() || undefined; } catch { return undefined; } };
 /** Forgets a resume scheduled after a restart: on disk and its timer. */
 const dropResume = () => {
  if (resumeTimer) clearTimeout(resumeTimer);
  resumeTimer = undefined;
  if (resumeSession) try { store.clearPendingResume(resumeSession); } catch { /* Best effort. */ }
  resumeSession = undefined;
 };
 const scheduleResume = (ctx: any, sid: string, pending: { family: Family; at: number }) => {
  resumeSession = sid;
  const fire = () => {
   if (resumeSession !== sid) return;
   // Cancelled or retried from another process meanwhile: that decision wins.
   if (store.dismissedUntil(pending.family) >= pending.at) { dropResume(); return; }
   const at = Math.max(pending.at, store.cooldown(pending.family));
   if (Date.now() < at) { resumeTimer = setTimeout(fire, Math.max(1, Math.min(at - Date.now(), TICK_MS))); return; }
   dropResume();
   try { pi.sendUserMessage(RESUME_PROMPT, ctx.isIdle?.() === false ? { deliverAs: "followUp" } : undefined); } catch { /* Session gone. */ }
  };
  const at = Math.max(pending.at, store.cooldown(pending.family));
  if (store.dismissedUntil(pending.family) >= pending.at) { dropResume(); return; }
  // Long past: the task may no longer be wanted; never start a run by itself.
  if (at <= Date.now() - RESUME_STALE_MS) {
   dropResume();
   ctx.ui?.notify?.(`${pending.family} usage limit was being waited on when Pi closed; it reset ${when(at)}. /limit-resume now continues that task.`, "info");
   return;
  }
  if (at <= Date.now()) { fire(); return; }
  ctx.ui?.notify?.(`${pending.family} usage limit was being waited on when Pi closed. Pi continues this task automatically at ${when(at)}; type anything to skip it, /limit-resume cancel to drop it.`, "info");
  resumeTimer = setTimeout(fire, Math.min(at - Date.now(), TICK_MS));
 };
 let stateWarned = false;
 const warnState = (ctx: any) => {
  if (!store.failed || stateWarned) return;
  stateWarned = true;
  ctx?.ui?.notify?.(`Usage-limit state directory ${store.directory} is not usable (${store.failed.message}); limits are kept in memory for this Pi only.`, "warning");
 };
 pi.on("session_start", async (_event: any, ctx: any) => {
  shuttingDown = false;
  try { store.gc(); } catch { /* Best effort. */ }
  warnState(ctx);
  const sid = sessionIdOf(ctx);
  if (!sid || rpcChild) return;
  try { const pending = store.pendingResume(sid); if (pending) scheduleResume(ctx, sid, pending); } catch { /* Best effort. */ }
 });
 pi.on("before_agent_start", async (_event: any, ctx: any) => {
  warnState(ctx);
  // The user typed something before the scheduled resume: their message wins.
  if (resumeSession) dropResume();
  const f = familyOf(ctx.model);
  if (f) usedFamilies.add(f);
  try { applySavedWindows(); refreshWindows(ctx); } catch { /* Window tracking must never block a message. */ }
  if (!f || !plan(ctx, ctx.model) || rpcChild) return;
  let at = 0;
  try { at = store.cooldownInfo(f, modelRef(ctx.model)).at; } catch { return; /* An unreadable state dir must never block a message. */ }
  if (at <= Date.now()) return;
  if (at - Date.now() > MAX_WAIT_MS) {
   ctx.ui?.notify?.(`${f} limit resets ${new Date(at).toLocaleString()}, more than 8 days away: messages are not held. /limit-resume cancel clears it.`, "warning");
   return;
  }
  if (!await waitForReset(ctx, f, true)) ctx.abort?.();
 });
 pi.on("before_provider_request", async () => { limitHeaders = undefined; });
 pi.on("after_provider_response", async (event: any, ctx: any) => {
  limitHeaders = event?.status === 429 ? event.headers : undefined;
  const f = familyOf(ctx?.model);
  if (!f || !event?.headers) return;
  if (Object.keys(event.headers).some(k => /ratelimit|x-codex-/i.test(k))) lastHeaders.set(f, event.headers);
  const seen = headerWindows(event.headers, Date.now());
  if (!seen) return;
  const exhausted = [seen.fiveHour, seen.weekly, seen.monthly].some(w => w && w.usedPercent >= 100);
  if (exhausted || Date.now() - (lastHeaderSave.get(f) ?? 0) >= HEADER_SAVE_MS) {
   lastHeaderSave.set(f, Date.now());
   try { const { checkedAt: _, ...previous } = store.windows(f); store.setWindows(f, { ...previous, ...seen }); } catch { /* Best effort. */ }
  }
 });
 pi.on("agent_end", async (event: any, ctx: any) => {
  try { refreshWindows(ctx); } catch { /* see before_agent_start */ }
  const last = lastAssistant(event.messages ?? []);
  pendingError = last?.stopReason === "error" ? String(last.errorMessage ?? "") : undefined;
  if (last?.stopReason && !["error", "aborted"].includes(last.stopReason)) {
   attempts = 0;
   // A successful answer on a plan model proves capacity: drop this family's cooldown for every process.
   // A pay-as-you-go key of the same provider says nothing about the plan.
   const f = familyOf(ctx?.model);
   // A model-specific cooldown (noRelease) stays: a success on another model of the family proves nothing about it.
   if (f && plan(ctx, ctx.model)) try { if (!store.cooldownInfo(f).noRelease) store.clearCooldown(f); } catch { /* Best effort. */ }
  }
 });
 pi.on("agent_before_settle", async (event: any, ctx: any) => {
  if (event.outcome === "aborted" || ctx.signal?.aborted) return;
  const last = lastAssistant(event.context?.contextMessages ?? []);
  const err = pendingError ?? (last?.stopReason === "error" ? String(last.errorMessage ?? "") : undefined);
  if (!err || !isUsageLimitError(err)) return;
  const f = familyOf(ctx.model);
  if (!f || !plan(ctx, ctx.model)) return;
  usedFamilies.add(f);
  // Reset time: headers of this response, the error text, windows seen earlier, then the provider's own source.
  const fromHeaders = parseResetHeaders(limitHeaders, new Date(Date.now()));
  const fromMessage = parseResetTime(err, new Date(Date.now()));
  const fromCache = fromHeaders || fromMessage ? undefined : parseResetHeaders(lastHeaders.get(f), new Date(Date.now()));
  let fromNative: number | undefined;
  if (!fromHeaders && !fromMessage && !fromCache) {
   const w = await withTimeout<Windows | undefined>(nativeWindows(f, ctx), undefined, NATIVE_TIMEOUT_MS);
   if (w) { store.setWindows(f, w); fromNative = resetFromWindows(w, Date.now()); }
  }
  const reset = fromHeaders ?? fromMessage ?? fromCache ?? fromNative;
  const wait = Math.max(reset ? reset - Date.now() + MARGIN_MS : PROBE_MS[Math.min(attempts, PROBE_MS.length - 1)], 30_000);
  // A real new limit overrides any earlier dismissal. It is kept until its reset when model-specific, or when it
  // follows a release on fresh windows within 15 minutes (those windows evidently did not see this limit).
  const noRelease = MODEL_LIMIT.test(err) || Date.now() - (released.get(f) ?? -Infinity) < RELEASE_TRUST_MS;
  try { store.clearDismiss(f); } catch { /* Best effort. */ }
  store.limit(f, Date.now() + wait, { noRelease, model: MODEL_LIMIT.test(err) ? modelRef(ctx.model) : undefined });
  warnState(ctx);
  if (reset) probeAt.delete(f); else probeAt.set(f, Date.now() + wait);
  try {
   store.record({
    at: Date.now(), family: f, model: modelRef(ctx.model), resetAt: Date.now() + wait, error: err.slice(0, 500),
    source: fromHeaders ? "headers" : fromMessage ? "message" : fromCache ? "headers-cache"
     : fromNative ? (f === "claude" ? "claude-cli" : f === "codex" ? "usage-endpoint" : "native") : "probe",
    headers: Object.fromEntries(Object.entries(limitHeaders ?? lastHeaders.get(f) ?? {}).filter(([k]) => /reset|retry|utiliz|used|status|limit/i.test(k))),
   });
  } catch { /* Diagnostics must never break the wait. */ }
  limitHeaders = undefined;
  if (rpcChild) {
   ctx.ui?.notify?.(`${f} usage limit reached; ${reset ? `it resets at ${new Date(reset).toLocaleString()}` : `reset time unknown, next retry at ${new Date(Date.now() + wait).toLocaleString()}`}. Not waiting inside an RPC session: the host decides.`, "warning");
   return;
  }
  if (++attempts > MAX_CONSECUTIVE) {
   ctx.ui?.notify?.(`Too many consecutive usage limits; stopped waiting. ${f} stays limited until ${new Date(store.cooldown(f)).toLocaleString()}: your next ${f} message waits for it. /limit-resume cancel clears it, /limit-resume now retries.`, "warning"); return;
  }
  // Remember the wait so reopening this session after closing Pi can continue the task.
  const sid = sessionIdOf(ctx);
  if (sid) try { store.setPendingResume(sid, { family: f, at: store.cooldown(f) }); } catch { /* Best effort. */ }
  // Keep the boundary open during the wait: Gentle must NOT receive agent_settled yet.
  const resumed = await waitForReset(ctx, f);
  // An abort is also how /new, /resume and quit end the wait (the shutdown comes after): keep the record then.
  if (sid && !shuttingDown && !ctx.signal?.aborted) try { store.clearPendingResume(sid); } catch { /* Best effort. */ }
  if (resumed) {
   pendingError = undefined;
   return { continue: true, entries: [{ type: "custom_message", customType: "usage-limit-resume", content: RESUME_PROMPT, display: false }] };
  }
 });
 /** Drops the family's cooldown and remembers, for every process, the saved windows it covered. */
 const dismiss = (f: Family) => {
  try {
   const w = store.windows(f);
   const windows = [w.fiveHour, w.weekly].filter(x => x && x.usedPercent >= 100).map(x => x!.resetsAt + MARGIN_MS);
   store.dismiss(f, Math.max(store.cooldown(f), Date.now() + MARGIN_MS + 1, ...windows));
   store.clearCooldown(f);
  } catch { /* State dir unavailable: the wait still stops. */ }
 };
 pi.registerCommand("limit-resume", {
  description: "Usage-limit resume: status | now | cancel",
  handler: async (args: string, ctx: any) => {
   const action = args.trim().toLowerCase();
   if (action === "cancel") {
    const waiting = !!wake;
    // Cancel means "stop holding me": drop the saved cooldown too, or the very next message would wait again.
    const f = waitingFamily ?? familyOf(ctx.model);
    if (f) dismiss(f);
    dropResume();
    stop(ctx); if (waiting) ctx.abort?.();
    ctx.ui.notify(`Auto-resume cancelled${f ? ` for ${f}; the next message is sent normally` : ""}.`, "info");
   }
   else if (action === "now") {
    attempts = 0;
    // Like cancel, "now" overrides the saved limit; otherwise the retry itself would be held again.
    const f = waitingFamily ?? familyOf(ctx.model);
    if (f) dismiss(f);
    dropResume();
    if (wake) { forceRetry = true; wake(true); return; }
    if (waitingFamily) { forceRetry = true; return; }   // preflight check in flight: the held message goes through
    pi.sendUserMessage(RESUME_PROMPT, ctx.isIdle?.() === false ? { deliverAs: "followUp" } : undefined);
   } else {
    const at = (ms: number) => new Date(ms).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
    const win = (label: string, w?: { usedPercent: number; resetsAt: number }) => w ? `${label} ${Math.round(w.usedPercent)}% resets ${at(w.resetsAt)}` : "";
    const shown = [...new Set([...usedFamilies, ...Object.keys(config.families ?? {})])];
    const lines = shown.map(f => {
     const w = store.windows(f); const hold = store.cooldown(f);
     const parts = [hold ? `cooldown until ${at(hold)}` : "", win("5h", w.fiveHour), win("weekly", w.weekly), win("monthly", w.monthly)].filter(Boolean);
     return parts.length ? `${f}: ${parts.join(" · ")}` : "";
    }).filter(Boolean);
    ctx.ui.notify([resumeAt ? `Waiting until ${new Date(resumeAt).toLocaleString()}` : "Watching usage limits.", ...lines].join("\n"), "info");
   }
  },
 });
 const resetSession = (ctx: any) => { stop(ctx); released.clear(); probeAt.clear(); pendingError = undefined; limitHeaders = undefined; attempts = 0; forceRetry = false; };
 pi.on("session_shutdown", async (_event: any, ctx: any) => {
  // A wait cut short by closing Pi stays on disk for the next start of this session.
  shuttingDown = true;
  if (resumeTimer) clearTimeout(resumeTimer);
  resumeTimer = undefined; resumeSession = undefined;
  resetSession(ctx);
 });
}
