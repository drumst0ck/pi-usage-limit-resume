import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
 constructor(directory: string, now = Date.now) { this.directory = directory; this.now = now; }
 private read(name: string): any {
  try { return JSON.parse(readFileSync(join(this.directory, name), "utf8")); }
  catch (e: any) { if (e.code === "ENOENT" || e instanceof SyntaxError) return undefined; throw e; }
 }
 private write(name: string, data: unknown): void { this.writeText(name, JSON.stringify(data)); }
 private writeText(name: string, text: string): void {
  mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  const temp = join(this.directory, `.${randomUUID()}.tmp`);
  try {
   writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
   renameSync(temp, join(this.directory, name));
  } finally { rmSync(temp, { force: true }); }
 }
 cooldown(f: Family): number {
  let files: string[];
  try { files = readdirSync(this.directory); }
  catch (e: any) { if (e.code === "ENOENT") return 0; throw e; }
  let at = 0;
  const own = new RegExp(`^cooldown-${f.replace(/[^a-z0-9-]/gi, "")}-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\\.json$`);
  for (const name of files.filter(n => own.test(n))) {
   const entry = this.read(name);
   if (!Number.isFinite(entry?.at)) continue;
   if (entry.at <= this.now()) { rmSync(join(this.directory, name), { force: true }); continue; }
   at = Math.max(at, entry.at);
  }
  return at;
 }
 /** Drops every saved cooldown of a family, e.g. when fresh windows show capacity again. */
 clearCooldown(f: Family): void {
  const own = new RegExp(`^cooldown-${f.replace(/[^a-z0-9-]/gi, "")}-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\\.json$`);
  let files: string[];
  try { files = readdirSync(this.directory); } catch (e: any) { if (e.code === "ENOENT") return; throw e; }
  for (const name of files.filter(n => own.test(n))) rmSync(join(this.directory, name), { force: true });
 }
 limit(f: Family, at: number): void {
  if (!Number.isFinite(at)) throw new Error("Invalid quota reset instant");
  this.write(`cooldown-${f}-${randomUUID()}.json`, { at });
 }
 /** Last 5h/weekly windows seen for a family, and when any process last tried to refresh them. */
 windows(f: Family): Windows & { checkedAt?: number } { return this.read(`windows-${f}.json`) ?? {}; }
 setWindows(f: Family, w: Windows): void { this.write(`windows-${f}.json`, { ...w, checkedAt: this.now() }); }
 /** A refresh was attempted and found nothing: keep the old windows, but throttle the next attempt. */
 touch(f: Family): void { this.write(`windows-${f}.json`, { ...this.windows(f), checkedAt: this.now() }); }
 /** Last limit event: how the reset was derived, so a wrong cooldown can be diagnosed afterwards. */
 record(entry: Record<string, unknown>): void {
  this.write("last-limit.json", entry);
  // Capped history: a later event of another provider must not erase the evidence of an earlier one.
  let lines: string[] = [];
  try { lines = readFileSync(join(this.directory, "limit-history.jsonl"), "utf8").split("\n").filter(Boolean); } catch { /* First event. */ }
  this.writeText("limit-history.jsonl", [...lines, JSON.stringify(entry)].slice(-50).join("\n") + "\n");
 }
}
