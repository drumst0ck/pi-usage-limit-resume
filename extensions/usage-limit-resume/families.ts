// Which usage family a Pi model belongs to. A family is one plan with its own reset times; its id is also the
// `--provider` id passed to CodexBar. The plugin only tracks and waits: it never picks or switches models.
import { readFileSync } from "node:fs";
import type { Family } from "./state.ts";

export interface FamilyConfig {
 /** Pi provider ids whose models belong to this family. */
 piProviders: string[];
 /** Case-insensitive regex tested against the model id; omit to accept every model of those providers. */
 modelPattern?: string;
 /** Provider id passed to `codexbar usage --provider`; defaults to the family id. */
 codexbarId?: string;
 /** The plan is reached with an API key instead of OAuth (Z.ai, Kimi, MiniMax...). A plain API key elsewhere is pay-as-you-go, not a plan. */
 apiKey?: boolean;
}
export interface Config { families?: Record<Family, FamilyConfig> }

export const DEFAULT_CONFIG: Config = {
 families: {
  claude: { piProviders: ["anthropic", "pi-claude-max", "claude-max"], modelPattern: "claude", codexbarId: "claude" },
  codex: { piProviders: ["openai", "openai-codex"], modelPattern: "gpt|codex", codexbarId: "codex" },
  gemini: { piProviders: ["google", "google-gemini-cli"], modelPattern: "gemini", codexbarId: "gemini" },
  zai: { piProviders: ["zai", "zai-coding-cn"], codexbarId: "zai", apiKey: true },
  kimi: { piProviders: ["kimi-coding"], codexbarId: "kimi", apiKey: true },
  minimax: { piProviders: ["minimax", "minimax-cn"], codexbarId: "minimax", apiKey: true },
  copilot: { piProviders: ["github-copilot"], codexbarId: "copilot" },
  opencodego: { piProviders: ["opencode-go"], codexbarId: "opencodego", apiKey: true },
  // No native source: its endpoint wants the Google "Hub" client identity. Reachable through CodexBar only.
  antigravity: { piProviders: ["google-antigravity"], codexbarId: "antigravity" },
 },
};

/** Family ids become state file names, so only lowercase letters, digits and dashes are accepted. */
const FAMILY_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
function validFamily(id: string, f: any): f is FamilyConfig {
 if (!FAMILY_ID.test(id) || !f || !Array.isArray(f.piProviders) || !f.piProviders.length) return false;
 if (!f.piProviders.every((p: unknown) => typeof p === "string" && p)) return false;
 if (f.modelPattern !== undefined) {
  if (typeof f.modelPattern !== "string") return false;
  try { new RegExp(f.modelPattern, "i"); } catch { return false; }
 }
 return f.codexbarId === undefined || typeof f.codexbarId === "string";
}

/** User config adds to the defaults; a family with the same id replaces the default one. Invalid families are dropped. */
export function mergeConfig(base: Config, data: Partial<Config> = {}): Config {
 const extra = Object.entries(data?.families ?? {}).filter(([id, f]) => validFamily(id, f));
 return { families: { ...base.families, ...Object.fromEntries(extra) } };
}

/**
 * Defaults, then each JSON file in order (later wins). A missing or broken file is skipped: a typo in a user
 * config must never stop Pi from starting.
 */
export function loadConfig(paths: string[]): Config {
 let config = DEFAULT_CONFIG;
 for (const path of paths) {
  try { config = mergeConfig(config, JSON.parse(readFileSync(path, "utf8"))); }
  catch { /* Missing or invalid: keep what we have. */ }
 }
 return config;
}

/**
 * Configured families first. Any other model becomes a family named after its Pi provider id, so every OAuth
 * provider is covered (and reaches CodexBar under its own id) without being listed anywhere.
 */
export function familyResolver(config: Config): (model: any) => Family | undefined {
 const entries = Object.entries(config.families ?? DEFAULT_CONFIG.families!).map(([id, f]) =>
  [id, f.piProviders, f.modelPattern ? new RegExp(f.modelPattern, "i") : undefined] as const);
 return model => {
  if (!model?.provider) return undefined;
  const hit = entries.find(([, providers, re]) => providers.includes(model.provider) && (!re || re.test(model.id ?? "")));
  return hit ? hit[0] : String(model.provider).replace(/[^a-z0-9-]/gi, "").toLowerCase() || undefined;
 };
}

/** A subscription plan: OAuth login, or a family flagged as an API-key plan. */
export function usesPlan(config: Config, ctx: any, model: any, familyOf: (model: any) => Family | undefined): boolean {
 const f = model ? familyOf(model) : undefined;
 return !!f && (!!config.families?.[f]?.apiKey || !!ctx.modelRegistry?.isUsingOAuth?.(model));
}
