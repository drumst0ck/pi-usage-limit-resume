// Saves every provider's reset times and, when an exhausted plan resets, continues the task it was doing.
// It never chooses or switches models: that belongs to another plugin.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_CLI_TIMEOUT_MS, claudeCliWindows, runClaudeCli } from "./claude-cli.ts";
import { CODEXBAR_TIMEOUT_MS, codexbarReset, codexbarWindows, runCodexbar } from "./codexbar.ts";
import { fetchCodexWindows, readCodexCliAuth } from "./codex-usage.ts";
import { DEFAULT_CONFIG, familyResolver, mergeConfig, usesPlan, type Config } from "./families.ts";
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
const MAX_WAIT_MS = 8 * 24 * 3600_000;
const MAX_CONSECUTIVE = 12;
const MARGIN_MS = 90_000;
const PROBE_MS = [10, 20, 30, 60].map(m => m * 60_000);
const RESUME_PROMPT = "Provider capacity is available. Continue exactly where you stopped. " +
 "Reconcile any odd/tasks/<feature>.md document or open todo list with the next unfinished task. Do not redo completed work.";
const lastAssistant = (messages: any[]): any => [...messages].reverse().find(m => m?.role === "assistant");
function loadConfig(): Config {
 try {
  return mergeConfig(DEFAULT_CONFIG, JSON.parse(readFileSync(fileURLToPath(new URL("./config.json", import.meta.url)), "utf8")));
 } catch (e: any) { if (e.code === "ENOENT") return DEFAULT_CONFIG; throw e; }
}
export interface Options {
 env?: NodeJS.ProcessEnv; argv?: string[]; config?: Config; store?: SharedState; fetch?: typeof fetch;
 claudeCli?: () => Promise<string | undefined>; nativeSources?: Record<Family, NativeSource>; codexbar?: (id: string) => Promise<string | undefined>;
}

export default function (pi: ExtensionAPI, options: Options = {}) {
 const env = options.env ?? process.env;
 const config = options.config ?? loadConfig();
 const agentHome = env.PI_CODING_AGENT_DIR?.replace(/^~(?=\/|$)/, env.HOME ?? homedir()) ?? join(env.HOME ?? homedir(), ".pi", "agent");
 const store = options.store ?? new SharedState(env.PI_USAGE_LIMIT_STATE_DIR ?? join(agentHome, "usage-limit-resume-state"));
 const useClaudeCli = env.PI_USAGE_LIMIT_CLAUDE_CLI !== "0";
 const useCodexbar = env.PI_USAGE_LIMIT_CODEXBAR !== "0";

 // A Pi started with `--mode rpc` is driven by a host (a subagent runner, an IDE) that owns its own idle watchdog and
 // cannot be told that we are waiting. Holding its turn would get it killed as stalled, so such sessions only record
 // the reset and report; the host decides what to do. Set PI_USAGE_LIMIT_WAIT_IN_RPC=1 for a host that tolerates long silence.
 const argv = options.argv ?? process.argv;
 const rpcChild = argv.some((a, i) => a === "--mode" && argv[i + 1] === "rpc") && env.PI_USAGE_LIMIT_WAIT_IN_RPC !== "1";
 const familyOf = familyResolver(config);
 const plan = (ctx: any, model: any) => usesPlan(config, ctx, model, familyOf);
 const nativeSources = options.nativeSources ?? defaultNativeSources;
 const codexbarId = (f: Family) => config.families?.[f]?.codexbarId ?? f;
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
 let generation = 0;

 const stop = (ctx?: any) => {
  generation++;
  wake?.(false);
  ctx?.ui?.setStatus?.("usage-limit-resume", undefined);
 };
 const waitUntil = (ctx: any, at: number): Promise<boolean> => {
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
   const done = (resume: boolean) => {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", aborted);
    if (wake === done) wake = undefined;
    resumeAt = undefined;
    ctx.ui?.setStatus?.("usage-limit-resume", undefined);
    resolve(resume);
   };
   const aborted = () => done(false);
   wake = done;
   signal?.addEventListener("abort", aborted, { once: true });
   if (signal?.aborted) { done(false); return; }
   ctx.ui?.setStatus?.("usage-limit-resume", `⏳ resume ${new Date(at).toLocaleTimeString()}`);
   timer = setTimeout(() => done(true), ms);
  });
 };
 const announce = (f: Family, at: number) => {
  const time = new Date(at).toLocaleString([], at - Date.now() > 20 * 3600_000 ? { weekday: "short", hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" });
  try {
   pi.sendMessage?.({ customType: "usage-limit-resume", display: true,
    content: `⏳ ${f} usage limit reached. It resets at ${time}; Pi continues this task automatically then. /limit-resume now retries, /limit-resume cancel stops waiting.` });
  } catch { /* A missing chat notice must not break the wait. */ }
 };
 /** Holds on the same model until the provider's cooldown ends. False when cancelled, aborted or too far away. */
 const waitForReset = async (ctx: any, f: Family): Promise<boolean> => {
  const epoch = generation;
  while (epoch === generation && !ctx.signal?.aborted) {
   const at = store.cooldown(f);
   if (at <= Date.now()) return true;
   announce(f, at);
   if (!await waitUntil(ctx, at)) return false;
   if (forceRetry) { forceRetry = false; return true; }
   // Another process may have extended the account cooldown. Re-read before resuming.
  }
  return false;
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
 const codexbarRaw = (f: Family) => withTimeout<string | undefined>(Promise.resolve((options.codexbar ?? runCodexbar)(codexbarId(f))), undefined, CODEXBAR_TIMEOUT_MS);
 // Fire and forget: the user's message never waits on any of this.
 const refreshWindows = (ctx: any) => {
  for (const f of usedFamilies) {
   if (refreshing.has(f) || Date.now() - (store.windows(f).checkedAt ?? 0) < (f === "claude" ? CLAUDE_CLI_REFRESH_MS : REFRESH_MS)) continue;
   refreshing.add(f);
   void (async () => {
    try {
     const w = (await nativeWindows(f, ctx)) ?? (useCodexbar ? codexbarWindows(await codexbarRaw(f)) : undefined);
     w ? store.setWindows(f, w) : store.touch(f);
    } catch { /* Best effort. */ } finally { refreshing.delete(f); }
   })();
  }
 };
 // A saved window at 100% is a known cooldown: hold the message instead of wasting a request on that provider.
 const applySavedWindows = () => {
  for (const f of usedFamilies) {
   const w = store.windows(f);
   for (const win of [w.fiveHour, w.weekly, w.monthly]) {
    const until = (win?.resetsAt ?? 0) + MARGIN_MS;
    if (win && win.usedPercent >= 100 && win.resetsAt > Date.now() && store.cooldown(f) < until - 1000) store.limit(f, until);
   }
  }
 };

 pi.on("before_agent_start", async (_event: any, ctx: any) => {
  const f = familyOf(ctx.model);
  if (f) usedFamilies.add(f);
  try { applySavedWindows(); refreshWindows(ctx); } catch { /* Window tracking must never block a message. */ }
  if (!f || !plan(ctx, ctx.model) || rpcChild) return;
  if (store.cooldown(f) > Date.now() && !await waitForReset(ctx, f)) ctx.abort?.();
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
  if (last?.stopReason && !["error", "aborted"].includes(last.stopReason)) attempts = 0;
 });
 pi.on("agent_before_settle", async (event: any, ctx: any) => {
  if (event.outcome === "aborted" || ctx.signal?.aborted) return;
  const last = lastAssistant(event.context?.contextMessages ?? []);
  const err = pendingError ?? (last?.stopReason === "error" ? String(last.errorMessage ?? "") : undefined);
  if (!err || !isUsageLimitError(err)) return;
  const f = familyOf(ctx.model);
  if (!f || !plan(ctx, ctx.model)) return;
  usedFamilies.add(f);
  // Reset time: headers of this response, the error text, windows seen earlier, then the provider's own source, then CodexBar.
  const fromHeaders = parseResetHeaders(limitHeaders, new Date(Date.now()));
  const fromMessage = parseResetTime(err, new Date(Date.now()));
  const fromCache = fromHeaders || fromMessage ? undefined : parseResetHeaders(lastHeaders.get(f), new Date(Date.now()));
  let fromNative: number | undefined, fromBar: number | undefined;
  if (!fromHeaders && !fromMessage && !fromCache) {
   const w = await withTimeout<Windows | undefined>(nativeWindows(f, ctx), undefined, CODEXBAR_TIMEOUT_MS);
   if (w) { store.setWindows(f, w); fromNative = resetFromWindows(w, Date.now()); }
  }
  if (useCodexbar && !fromHeaders && !fromMessage && !fromCache && !fromNative) {
   const out = await codexbarRaw(f);
   fromBar = codexbarReset(out, Date.now());
   const w = codexbarWindows(out);
   if (w) store.setWindows(f, w);
  }
  const reset = fromHeaders ?? fromMessage ?? fromCache ?? fromNative ?? fromBar;
  const wait = Math.max(reset ? reset - Date.now() + MARGIN_MS : PROBE_MS[Math.min(attempts, PROBE_MS.length - 1)], 30_000);
  store.limit(f, Date.now() + wait);
  try {
   store.record({
    at: Date.now(), family: f, model: modelRef(ctx.model), resetAt: Date.now() + wait, error: err.slice(0, 500),
    source: fromHeaders ? "headers" : fromMessage ? "message" : fromCache ? "headers-cache"
     : fromNative ? (f === "claude" ? "claude-cli" : f === "codex" ? "usage-endpoint" : "native") : fromBar ? "codexbar" : "probe",
    headers: Object.fromEntries(Object.entries(limitHeaders ?? lastHeaders.get(f) ?? {}).filter(([k]) => /reset|retry|utiliz|used|status|limit/i.test(k))),
   });
  } catch { /* Diagnostics must never break the wait. */ }
  limitHeaders = undefined;
  if (rpcChild) {
   ctx.ui?.notify?.(`${f} usage limit reached; it resets at ${new Date(Date.now() + wait - MARGIN_MS).toLocaleString()}. Not waiting inside an RPC session: the host decides.`, "warning");
   return;
  }
  if (++attempts > MAX_CONSECUTIVE) {
   ctx.ui?.notify?.("Too many consecutive usage limits; stopped waiting. /limit-resume now to retry.", "warning"); return;
  }
  // Keep the boundary open during the wait: Gentle must NOT receive agent_settled yet.
  if (await waitForReset(ctx, f)) {
   pendingError = undefined;
   return { continue: true, entries: [{ type: "custom_message", customType: "usage-limit-resume", content: RESUME_PROMPT, display: false }] };
  }
 });
 pi.registerCommand("limit-resume", {
  description: "Usage-limit resume: status | now | cancel",
  handler: async (args: string, ctx: any) => {
   const action = args.trim().toLowerCase();
   if (action === "cancel") { const waiting = !!wake; stop(ctx); if (waiting) ctx.abort?.(); ctx.ui.notify("Auto-resume cancelled.", "info"); }
   else if (action === "now") {
    attempts = 0;
    if (wake) { forceRetry = true; wake(true); return; }
    pi.sendUserMessage(RESUME_PROMPT, ctx.isIdle?.() === false ? { deliverAs: "followUp" } : undefined);
   } else {
    const at = (ms: number) => new Date(ms).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
    const win = (label: string, w?: { usedPercent: number; resetsAt: number }) => w ? `${label} ${Math.round(w.usedPercent)}% resets ${at(w.resetsAt)}` : "";
    const shown = [...new Set([...usedFamilies, ...Object.keys(config.families ?? {})])];
    const lines = shown.map(f => { const w = store.windows(f); const parts = [win("5h", w.fiveHour), win("weekly", w.weekly), win("monthly", w.monthly)].filter(Boolean); return parts.length ? `${f}: ${parts.join(" · ")}` : ""; }).filter(Boolean);
    ctx.ui.notify([resumeAt ? `Waiting until ${new Date(resumeAt).toLocaleString()}` : "Watching usage limits.", ...lines].join("\n"), "info");
   }
  },
 });
 const resetSession = (ctx: any) => { stop(ctx); pendingError = undefined; limitHeaders = undefined; attempts = 0; forceRetry = false; };
 pi.on("session_shutdown", async (_event: any, ctx: any) => { resetSession(ctx); });
}
