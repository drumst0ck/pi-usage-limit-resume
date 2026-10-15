import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A subscription family id, e.g. "claude", "codex", "gemini". Filename-safe: lowercase letters, digits and dashes. */
export type Family = string;
export interface Window { usedPercent: number; resetsAt: number }
/** fiveHour is the session-like (shortest) window, weekly the middle one, monthly the billing-period quota. */
export interface Windows { fiveHour?: Window; weekly?: Window; monthly?: Window }
export const modelRef = (model: any): string => `${model.provider}/${model.id}`;

/** Only public model ids and cooldown instants, never credentials or prompts.
 * Immutable cooldown records avoid lost updates between independent Pi processes.
 */
export class SharedState {
 readonly directory: string;
 readonly now: () => number;
 /** Set when the directory cannot be used; state then lives in memory for this process only. */
 failed?: Error;
 private readonly memory = new Map<string, string>();
 /** Names removed while the directory refused it: hidden even though the stale file remains on disk. */
 private readonly deleted = new Set<string>();
 constructor(directory: string, now = Date.now) { this.directory = directory; this.now = now; }
 private read(name: string): any {
  if (this.deleted.has(name)) return undefined;
  // What this process wrote in memory is newer than any file the directory refused to replace.
  let text = this.memory.get(name);
  if (text === undefined) {
   try { text = readFileSync(join(this.directory, name), "utf8"); }
   catch (e: any) { if (e.code !== "ENOENT") this.failed ??= e; }
  }
  if (text === undefined) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
 }
 /** Entry names on disk plus those kept in memory after a failed write. */
 private names(): string[] {
  let files: string[] = [];
  try { files = readdirSync(this.directory); }
  catch (e: any) { if (e.code !== "ENOENT") this.failed ??= e; }
  return [...new Set([...files, ...this.memory.keys()])].filter(n => !this.deleted.has(n));
 }
 private remove(name: string): void {
  this.memory.delete(name);
  try { rmSync(join(this.directory, name), { force: true }); this.deleted.delete(name); }
  catch (e: any) { this.failed ??= e; this.deleted.add(name); }
 }
 private write(name: string, data: unknown): void { this.writeText(name, JSON.stringify(data)); }
 private writeText(name: string, text: string): void {
  const temp = join(this.directory, `.${randomUUID()}.tmp`);
  try {
   mkdirSync(this.directory, { recursive: true, mode: 0o700 });
   writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
   renameSync(temp, join(this.directory, name));
   this.memory.delete(name);
   this.deleted.delete(name);
  } catch (e: any) {
   // An unusable state directory must never break a message or a wait: keep the data in memory.
   this.failed ??= e;
   this.memory.set(name, text);
   this.deleted.delete(name);
  } finally { try { rmSync(temp, { force: true }); } catch { /* Nothing was written. */ } }
 }
 cooldown(f: Family): number { return this.cooldownInfo(f).at; }
 /** Latest active cooldown of a family, and whether any active one must not be released by fresh windows. */
 cooldownInfo(f: Family): { at: number; noRelease: boolean } {
  const files = this.names();
  let at = 0, noRelease = false;
  const own = new RegExp(`^cooldown-${f.replace(/[^a-z0-9-]/gi, "")}-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\\.json$`);
  for (const name of files.filter(n => own.test(n))) {
   const entry = this.read(name);
   if (!Number.isFinite(entry?.at)) continue;
   if (entry.at <= this.now()) { this.remove(name); continue; }
   at = Math.max(at, entry.at);
   if (entry.noRelease) noRelease = true;
  }
  return { at, noRelease };
 }
 /** Drops every saved cooldown of a family, e.g. when fresh windows show capacity again. */
 clearCooldown(f: Family): void {
  const own = new RegExp(`^cooldown-${f.replace(/[^a-z0-9-]/gi, "")}-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\\.json$`);
  for (const name of this.names().filter(n => own.test(n))) this.remove(name);
 }
 /** Removes expired and unreadable cooldown files of every family, including families no longer used. */
 gc(): void {
  for (const name of this.names().filter(n => /^cooldown-.+\.json$/.test(n))) {
   const entry = this.read(name);
   if (!Number.isFinite(entry?.at) || entry.at <= this.now()) this.remove(name);
  }
  // Resumes of sessions never reopened: dropped a week after their reset.
  for (const name of this.names().filter(n => /^resume-.+\.json$/.test(n))) {
   const entry = this.read(name);
   if (!Number.isFinite(entry?.at) || entry.at < this.now() - 7 * 86400_000) this.remove(name);
  }
 }
 limit(f: Family, at: number, meta: { noRelease?: boolean } = {}): void {
  if (!Number.isFinite(at)) throw new Error("Invalid quota reset instant");
  this.write(`cooldown-${f}-${randomUUID()}.json`, meta.noRelease ? { at, noRelease: true } : { at });
 }
 /** The user dismissed this family's limit until `until` (cancel/now): shared by every process, survives restarts. */
 dismiss(f: Family, until: number): void { this.write(`dismissed-${f}.json`, { until }); }
 dismissedUntil(f: Family): number { const d = this.read(`dismissed-${f}.json`); return Number.isFinite(d?.until) ? d.until : 0; }
 clearDismiss(f: Family): void { this.remove(`dismissed-${f}.json`); }
 /** A wait interrupted by closing Pi, keyed by session, so reopening that session can continue the task. */
 private resumeName(sessionId: string): string { return `resume-${sessionId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 128)}.json`; }
 setPendingResume(sessionId: string, data: { family: Family; at: number }): void { this.write(this.resumeName(sessionId), data); }
 pendingResume(sessionId: string): { family: Family; at: number } | undefined {
  const d = this.read(this.resumeName(sessionId));
  return d && typeof d.family === "string" && Number.isFinite(d.at) ? d : undefined;
 }
 clearPendingResume(sessionId: string): void { this.remove(this.resumeName(sessionId)); }
 /** Last 5h/weekly windows seen for a family, and when any process last tried to refresh them. */
 windows(f: Family): Windows & { checkedAt?: number } { return this.read(`windows-${f}.json`) ?? {}; }
 setWindows(f: Family, w: Windows): void { this.write(`windows-${f}.json`, { ...w, checkedAt: this.now() }); }
 /** A refresh was attempted and found nothing: keep the old windows, but throttle the next attempt. */
 touch(f: Family): void { this.write(`windows-${f}.json`, { ...this.windows(f), checkedAt: this.now() }); }
 /** Last limit event: how the reset was derived, so a wrong cooldown can be diagnosed afterwards. */
 record(entry: Record<string, unknown>): void {
  this.write("last-limit.json", entry);
  // Appended (O_APPEND) so concurrent processes never overwrite each other. Past 100 lines the file is renamed, not
  // rewritten: an event appended during the rename lands in one of the two files instead of being lost.
  const file = join(this.directory, "limit-history.jsonl");
  try { appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 }); }
  catch (e: any) { this.failed ??= e; return; }
  // Another process may rotate at the same moment: its rename leaves nothing to do here, which is not a failure.
  try {
   if (readFileSync(file, "utf8").split("\n").filter(Boolean).length > 100) renameSync(file, join(this.directory, "limit-history.1.jsonl"));
  } catch (e: any) { if (e.code !== "ENOENT") this.failed ??= e; }
 }
}
