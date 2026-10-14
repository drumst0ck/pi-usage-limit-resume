# pi-usage-limit-resume

A standalone [Pi](https://github.com/earendil-works/pi) package. It depends on nothing else and patches nothing: it works the same with or without gentle-pi, and no update of another package can overwrite it.

```
pi install <path-or-git-or-npm-source>
```

It does two things:

1. **Saves when each provider's plan resets** (5-hour, weekly and monthly windows).
2. **Continues the task you were doing when an exhausted limit resets.** It waits on the same model and
   then tells the agent to carry on where it stopped.

It never chooses or switches models, orchestrators or workers. That belongs to another plugin.
It needs no external app: [CodexBar](https://github.com/steipete/CodexBar) is optional and only widens coverage.

## What you see

- When a limit is hit, the chat says which provider is exhausted and when it resets.
- The turn is held until then (up to 8 days, so weekly limits are covered) and the task continues by itself.
- If a window is already saved at 100%, your next message is held **before** a request is wasted on that provider.
- In an RPC session (`pi --mode rpc`, which is how subagent runners drive a child) it does **not** hold the turn: it records the reset, tells the host, and lets the host decide. A host's idle watchdog cannot be told that we are waiting, so holding would get the child killed as stalled. Set `PI_USAGE_LIMIT_WAIT_IN_RPC=1` for a host that tolerates long silence.
- `/limit-resume status` shows the saved resets, `/limit-resume now` retries immediately, `/limit-resume cancel` stops waiting.

## How the reset time is found

For every limit the sources are tried in this order until one gives a time. Each is bounded by a timeout and
any failure falls through silently to the next. The last resort is a probe of 10 to 60 minutes.

1. Rate-limit headers of the failing response.
2. The error text ("try again in 2h 13m", "resets Oct 14 at 6:50pm (Europe/Madrid)").
3. The latest windows saved from the headers of earlier responses (Anthropic and Codex send them on every response).
4. The provider's own source (table below).
5. `codexbar usage --provider <id> --json`, if CodexBar is installed.
6. Probe fallback.

Windows of the providers you actually use are also refreshed in the background, never delaying your message.

## Providers

A provider is identified by its Pi provider id. **Any OAuth provider works** as its own family and is passed to
CodexBar under that same id, even if it is not in this table. Providers reached with an API key are only treated
as plans when flagged `apiKey: true` (a pay-as-you-go key has no reset to wait for).

| Family | Pi provider ids | Own source (no CodexBar needed) |
|---|---|---|
| `claude` | `anthropic`, `pi-claude-max`, `claude-max` | response headers; fallback `claude -p --no-session-persistence /usage` |
| `codex` | `openai`, `openai-codex` | response headers; `chatgpt.com/backend-api/wham/usage` with `~/.codex/auth.json` or Pi's token |
| `gemini` | `google`, `google-gemini-cli` | `~/.gemini/oauth_creds.json` |
| `zai` | `zai`, `zai-coding-cn` | Pi's API key |
| `kimi` | `kimi-coding` | Pi's API key |
| `minimax` | `minimax`, `minimax-cn` | Pi's API key |
| `opencodego` | `opencode-go` | Pi's API key |
| `copilot` | `github-copilot` | Pi's stored credential |
| `antigravity` | `google-antigravity` | CodexBar only |

> **Not verified live:** every source except Claude's headers and Codex's `auth.json` endpoint follows CodexBar's
> source code and docs and is tested with fixtures, not against the real APIs. Gemini: Google ended consumer-tier
> Gemini CLI OAuth on 2026-06-18, so most accounts will fall through to CodexBar. Copilot: it is unconfirmed that
> Pi's stored credential is the GitHub OAuth token the endpoint expects.

To add a provider, give it a family in `~/.pi/agent/usage-limit-resume.json` (or the file named by
`PI_USAGE_LIMIT_CONFIG`). This file lives outside the package, so updating or reinstalling the package never
overwrites it. The packaged `config.json` is read first and is replaced on every update.

```json
{
  "families": {
    "mycloud": { "piProviders": ["my-pi-provider"], "codexbarId": "poe", "apiKey": true }
  }
}
```

`piProviders` are Pi provider ids, `modelPattern` (optional regex on the model id) narrows the match,
`codexbarId` is the id given to CodexBar (defaults to the family id), `apiKey: true` marks an API-key plan.
A family with the same id as a default replaces it. Family ids must be lowercase letters, digits and dashes;
an invalid family (bad id, no `piProviders`, invalid regex) is ignored, and a file that is not valid JSON is skipped
so it can never stop Pi from starting. Old failover keys (`tiers`, `order`, `excludeModels`) are ignored.

## Environment switches

| Variable | Effect |
|---|---|
| `PI_USAGE_LIMIT_CODEXBAR=0` | Never run CodexBar. |
| `PI_USAGE_LIMIT_CLAUDE_CLI=0` | Never run the `claude` CLI. |
| `CODEX_HOME` | Where the Codex CLI keeps `auth.json` (default `~/.codex`). |
| `PI_USAGE_LIMIT_WAIT_IN_RPC=1` | Let an RPC child hold its turn like the main session. |
| `PI_USAGE_LIMIT_CONFIG` | User config file (default `~/.pi/agent/usage-limit-resume.json`). |
| `PI_USAGE_LIMIT_STATE_DIR` | Shared state directory (default `~/.pi/agent/usage-limit-resume-state`). |

## What it will not do

CodexBar also reads browser cookies, decrypts Chromium "Safe Storage" and reads other apps' macOS Keychain items.
This extension deliberately does none of that, because it is meant to be installed by other people. Providers that
only work through those (Cursor, Mistral, Windsurf, Perplexity, Qwen and Xiaomi token plans, and similar) are
reachable only if CodexBar is installed. Providers that expose only a balance or credits (DeepSeek, Moonshot,
OpenRouter, xAI, Fireworks, Vercel) have no reset time to wait for. It also does not impersonate other clients:
requests carry an honest `User-Agent`, so an endpoint that insists on a first-party client identity (Antigravity,
and possibly Copilot) is left to CodexBar.

Credential handling:

- Other tools' credential files are read-only. They are never refreshed or rewritten, because refresh tokens rotate
  and refreshing would log the owning CLI out.
- A file readable by group or others is refused. An expired token counts as "no credential".
- Requests are HTTPS only, with `redirect: "error"` and a timeout.
- Tokens and account ids are never logged or written to the state directory.

## State and diagnostics

Everything lives in the state directory as small JSON files: cooldowns, saved windows (`windows-<family>.json`) and
`last-limit.json`, the last limit event with **which source** produced its reset time (`headers`, `message`,
`headers-cache`, `usage-endpoint`, `claude-cli`, `native`, `codexbar` or `probe`). If a wait looks wrong, read that
file first.

## Tests

```
npm test
```
