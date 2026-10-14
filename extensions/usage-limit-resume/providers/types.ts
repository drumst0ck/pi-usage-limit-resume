// Contract for native usage sources: a provider's 5h/weekly/monthly windows, read with plain HTTP and a credential the user already has.
import type { Windows } from "../state.ts";

export interface SourceContext {
	env: NodeJS.ProcessEnv;
	fetch: typeof fetch;
	nowMs: number;
	/** The credential Pi itself holds for a Pi provider id (API key or OAuth access token), or undefined. Already time-bounded. */
	apiKey(piProvider: string): Promise<string | undefined>;
}

/**
 * Resolves to the provider's windows, or undefined on ANY failure (no credential, HTTP error, bad payload, timeout).
 * Rules every source follows:
 * - Never throw; never log or return secrets, tokens or account ids.
 * - Credential FILES of other tools are read-only: never refresh, never write, refuse files readable by group/others,
 *   treat an expired token as "no credential".
 * - HTTPS only, `redirect: "error"`, bounded by an AbortSignal timeout (<= 5s).
 */
export type NativeSource = (ctx: SourceContext) => Promise<Windows | undefined>;
