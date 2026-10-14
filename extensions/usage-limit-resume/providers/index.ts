// Native usage sources, keyed by family id. Each reads a provider's reset times.
// Any other provider still gets reset times from response headers or the error text, then the probe fallback.
import type { Family } from "../state.ts";
import { source as copilot } from "./copilot.ts";
import { source as gemini } from "./gemini.ts";
import { source as kimi } from "./kimi.ts";
import { source as minimax } from "./minimax.ts";
import { source as opencodego } from "./opencodego.ts";
import type { NativeSource } from "./types.ts";
import { source as zai } from "./zai.ts";

export const nativeSources: Record<Family, NativeSource> = { copilot, gemini, kimi, minimax, opencodego, zai };
