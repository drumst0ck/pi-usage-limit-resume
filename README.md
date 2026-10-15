# pi-usage-limit-resume

A [Pi](https://github.com/earendil-works/pi) extension that remembers when each provider's usage window resets and
**continues your task by itself when an exhausted limit resets**.

- Standalone: it depends on no other package and patches nothing. It works the same with or without gentle-pi.
- No external app needed. Everything is read from response headers, error messages, or the provider's own usage endpoint.
- It never chooses or switches models, orchestrators or workers. That belongs to another plugin.

## Contents

- [Install](#install)
- [What it does](#what-it-does)
- [Commands](#commands)
- [How the reset time is found](#how-the-reset-time-is-found)
- [Supported providers](#supported-providers)
- [Configuration](#configuration)
- [Environment variables](#environment-variables)
- [RPC and subagent sessions](#rpc-and-subagent-sessions)
- [Security and privacy](#security-and-privacy)
- [State files and troubleshooting](#state-files-and-troubleshooting)
- [Development](#development)
- [License](#license)

## Install

Requires Pi `>= 1.2.0`. Node `>= 22.18` is only needed to run the tests.

```bash
# from npm
pi install npm:pi-usage-limit-resume

# from git
pi install git:github.com/drumst0ck/pi-usage-limit-resume

# from a local clone (changes apply on /reload)
pi install /path/to/pi-usage-limit-resume
```

Then restart Pi or run `/reload`. Check it is loaded with `pi list`. Remove it with `pi remove pi-usage-limit-resume`.

## What it does

1. **Saves when each plan resets** (5-hour, weekly and monthly windows) for the providers you actually use. The data is
   refreshed in the background and never delays your message.
2. **Holds the turn when a limit is hit** and tells you in the chat which provider is exhausted and when it resets.
   When the time comes it tells the agent to carry on exactly where it stopped. It waits on the same model.
3. **Holds your next message before wasting a request** if a saved 5-hour or weekly window is already at 100%. Monthly windows are shown but never hold a message: they often gate one lane only (Z.ai MCP, Copilot premium requests).
4. **Releases a stale cooldown by itself.** Before holding a message, and every 3 minutes while waiting, it asks the provider for fresh windows; if none is exhausted (for example you upgraded your plan, or a window reset early) it clears the cooldown and continues. It does this at most once per limit: a model-specific limit ("Opus limit") or a limit hit again within 15 minutes of a release is kept until its reset. Any successful answer from that provider also clears its cooldown, in every Pi process.

Details:

- The wait can last up to 8 days, so weekly limits are covered. A cooldown further away is reported but never holds or drops your messages. When no reset time is known, the notice says "next retry at … (reset time unknown)". A margin of 90 seconds is added to the reset time.
- With no reset time at all, it probes after 10, 20, 30 and then 60 minutes.
- After 12 limits in a row without a successful response it stops waiting and tells you.
- Only subscription plans are tracked: OAuth logins, and the API-key plans marked `apiKey: true`. A pay-as-you-go API key
  has no reset to wait for.
- The status bar shows `⏳ resume HH:MM` while it waits.

## Commands

| Command | Effect |
|---|---|
| `/limit-resume status` | Shows whether it is waiting, every active cooldown, and the saved 5h, weekly and monthly usage and reset time of each provider. |
| `/limit-resume now` | Stops waiting, drops the saved cooldown and retries immediately. When nothing is being waited on, it sends the resume prompt. |
| `/limit-resume cancel` | Stops waiting, aborts the held turn and drops the saved cooldown, so your next message is sent normally. The dismissal is shared by every Pi process and survives restarts; a new limit error waits again. |

## How the reset time is found

For every limit the sources are tried in this order until one gives a time. Each is bounded by a timeout and any
failure falls through silently to the next.

1. Rate-limit headers of the failing response.
2. The error text (`try again in 2h 13m`, `resets Oct 14 at 6:50pm (Europe/Madrid)`).
3. The latest windows saved from the headers of earlier responses (Anthropic and Codex send them on every response).
4. The provider's own source (table below).
5. Probe fallback: 10 to 60 minutes.

## Supported providers

A provider is identified by its Pi provider id. **Any OAuth provider works** as its own family, named after its Pi
provider id, even if it is not in this table. For those, the reset time comes from headers or the error text (steps 1 to
3), then the probe.

| Family | Pi provider ids | Own source (step 4) |
|---|---|---|
| `claude` | `anthropic`, `pi-claude-max`, `claude-max` | response headers; fallback `claude -p --no-session-persistence /usage` |
| `codex` | `openai`, `openai-codex` | response headers; `chatgpt.com/backend-api/wham/usage` with `~/.codex/auth.json` or Pi's token |
| `gemini` | `google`, `google-gemini-cli` | `~/.gemini/oauth_creds.json` |
| `zai` | `zai`, `zai-coding-cn` | Pi's API key |
| `kimi` | `kimi-coding` | Pi's API key |
| `minimax` | `minimax`, `minimax-cn` | Pi's API key |
| `opencodego` | `opencode-go` | Pi's API key |
| `copilot` | `github-copilot` | Pi's stored credential |

**Verification status**

- Verified against real accounts (2026-10-14): Claude (`/usage` CLI) and Codex (`wham/usage` endpoint).
- Tested with fixtures only: Gemini, Z.ai, Kimi, MiniMax, OpenCode Go and Copilot. Reports from real accounts are welcome.
- Gemini: Google ended consumer-tier Gemini CLI OAuth on 2026-06-18, so most accounts will not get a Gemini window.
- Copilot: it is unconfirmed that Pi's stored credential is the GitHub OAuth token the endpoint expects.

## Configuration

The packaged `config.json` is replaced on every package update. Put your own settings in a file **outside** the package,
so updates and reinstalls never overwrite it:

```
~/.pi/agent/usage-limit-resume.json
```

(or the file named by `PI_USAGE_LIMIT_CONFIG`). It is merged over the defaults, and a family with the same id as a default
replaces it. Example:

```json
{
  "families": {
    "mycloud": { "piProviders": ["my-pi-provider"], "modelPattern": "^mycloud-", "apiKey": true }
  }
}
```

| Field | Meaning |
|---|---|
| `piProviders` | Required. Pi provider ids whose models belong to this family. |
| `modelPattern` | Optional regex (case-insensitive) on the model id, to narrow the match. |
| `apiKey` | `true` marks an API-key plan. Without it, only OAuth logins count as a plan. |

Rules: family ids are lowercase letters, digits and dashes (they become state file names). An invalid family (bad id,
no `piProviders`, invalid regex) is ignored, and a file that is not valid JSON is skipped, so a typo can never stop Pi
from starting.

## Environment variables

| Variable | Effect |
|---|---|
| `PI_USAGE_LIMIT_CONFIG` | User config file (default `~/.pi/agent/usage-limit-resume.json`). |
| `PI_USAGE_LIMIT_STATE_DIR` | State directory (default `~/.pi/agent/usage-limit-resume-state`). |
| `PI_USAGE_LIMIT_CLAUDE_CLI=0` | Never run the `claude` CLI. |
| `PI_USAGE_LIMIT_WAIT_IN_RPC=1` | Let an RPC session hold its turn like the main session. |
| `CODEX_HOME` | Where the Codex CLI keeps `auth.json` (default `~/.codex`). |
| `PI_CODING_AGENT_DIR` | Pi's agent directory, used for the default config and state paths. |

## RPC and subagent sessions

In a session started with `pi --mode rpc`, which is how subagent runners drive a child, the extension does **not** hold
the turn. It records the reset, tells the host, and lets the host decide. A host's idle watchdog cannot be told that we are
waiting, so holding would get the child killed as stalled. Set `PI_USAGE_LIMIT_WAIT_IN_RPC=1` for a host that tolerates
long silence.

## Security and privacy

It deliberately does not read browser cookies, decrypt Chromium "Safe Storage" or read other apps' Keychain items,
because it is meant to be installed by other people. Providers that can only be read that way have no native source and
fall back to headers, the error text and the probe. Providers that expose only a balance or credits have no reset time
to wait for. It does not impersonate other clients: requests carry an honest `User-Agent`.

- Other tools' credential files are read-only. They are never refreshed or rewritten, because refresh tokens rotate and
  refreshing would log the owning CLI out.
- A credential file readable by group or others is refused. An expired token counts as "no credential".
- Requests are HTTPS only, with `redirect: "error"` and a timeout.
- Tokens and account ids are never logged or written to the state directory.

## State files and troubleshooting

Everything lives in the state directory as small JSON files: cooldowns, saved windows (`windows-<family>.json`) and
`last-limit.json`, the last limit event, and `limit-history.jsonl`, the recent events (one JSON per line, all providers; appended; past 100 lines it is moved to `limit-history.1.jsonl`), and `dismissed-<family>.json` after cancel/now. Its `source` field tells which step produced the reset time: `headers`,
`message`, `headers-cache`, `usage-endpoint`, `claude-cli`, `native` or `probe`.

| Symptom | Check |
|---|---|
| The wait looks wrong | Read `last-limit.json` and look at `source` and `resetAt`. |
| It waits too long | `/limit-resume status`, then `/limit-resume now` or `cancel`. |
| Nothing is saved for a provider | Use that provider once with a plan login, then run `/limit-resume status`. Providers without a native source only learn windows from response headers. |
| The state directory is not writable | Pi warns once and keeps limits in memory for that Pi only; fix the permissions or set `PI_USAGE_LIMIT_STATE_DIR`. Expired or unreadable cooldown files are removed at session start. |
| A stale cooldown | Normally released automatically when the provider reports capacity. If it has no usage source, delete the `cooldown-<family>-*.json` files from the state directory. |
| Config is ignored | Check the file is valid JSON and the family id is lowercase. |

## Development

```bash
npm install
npm test          # node --test over every *.test.ts
npm run typecheck # tsc, strict, against the Pi types
```

CI runs both on Node 22 and 24. Layout:

| Path | Role |
|---|---|
| `extensions/usage-limit-resume/index.ts` | Events, waiting, `/limit-resume`. |
| `families.ts` | Family resolution and config loading. |
| `parse.ts` | Reset time from headers and error text. |
| `state.ts` | Shared state files. |
| `claude-cli.ts`, `codex-usage.ts` | Claude and Codex sources. |
| `providers/` | One native source per provider, each with its tests. |

## License

MIT
