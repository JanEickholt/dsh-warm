# dsh-warm

Prompt-cache warmer for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — a host plugin that keeps a session's provider prompt-cache prefix warm **while, and only while, the session's agent loop is blocked inside a tool execution** (long `bash`, `job_output`, `wait_agent` on teammates, …).

It re-dispatches the session's **last conversation request** through the host `llm/stream` waterfall with `maxTokens: 1` on a fixed interval, then discards the 1-token response. The tool's result lands on the still-warm prefix, so the next real request bills cache-hit input instead of re-prefilling ~90k tokens at miss price and paying the full TTFT again.

## Why only tool blocks

Measured on this setup (2026-10-17, live probe against `api.mistral.ai`, `zai-glm-5-3`; 50 days of ledgers, 350 sessions):

- **TTL is provider-specific** — Mistral's is 5–7 min (hit at 302 s, miss at 424 s, hits refresh the TTL); hence the per-provider interval table.
- **Tool/teammate waits**: certain resume (the loop continues the moment the tool settles) → net **+$7.15 / 50 days** and ~1 h of TTFT recovered, zero tail risk.
- **Idle sessions**: 344 of 350 sessions were never resumed; naive OpenCode-style idle warming nets **−$6.91 / 50 days**. So idle sessions and user-input tools (`ask_user_question`) are **never** warmed here.

Hit price is a 90 % discount on this provider ($1.40/M miss → $0.14/M hit), so each ping costs ~$0.014 per 100k-token prefix and saves a ~$0.126 re-prefill + 25–40 s TTFT when the block ends after the TTL.

## How the replay stays byte-identical

The loop-built request arrives at the `llm/stream` waterfall deep-frozen — a pure function of the session log. The warmer captures that exact object and later sends a fresh shallow copy sharing the frozen fields, changing only:

- `maxTokens: 1` — a sampling field, not part of the cached input prefix,
- `signal` — the captured call's signal chained (`AbortSignal.any`) with the ping timeout, so a user interrupt aborts an in-flight ping too.

The same adapter that served the real call serializes the ping, so the input prefix is byte-identical and the provider serves it from cache. This is the same cache-reusing auxiliary-call pattern the harness itself uses for compaction summarization. The ping is a *hand-built* call (the loop's `markAgentLoopRequest` WeakSet identity does not carry over to the copy), and it traverses the full waterfall — routing adapters behave identically and **dsh-cost-meter bills its usage like any other call**, keeping the ledger honest.

## Install (local plugin, link protocol)

1. `profiles/<profile>/package.json`: add `"dsh-warm": "link:/absolute/path/to/dsh-warm"` to `dependencies` and `"dsh-warm"` to `dsh.profile.bundles`.
2. `pnpm install` inside the profile directory.
3. Restart the harness from a terminal (e.g. `systemctl --user restart <your-dsh-unit>`) — a restart kills the host process, so never trigger it from inside a session.

The plugin's `dsh.bundle.patch` (`cordis.patch.yml`) inserts the loader row automatically; no `cordis.patch.yml` edit needed.

## Configuration

`$DSH_HOME/storages/dsh-warm/config.json` (written with defaults on first load; edit + restart). The ping interval is **per provider**, because the interval must sit under that provider's own prompt-cache TTL:

```json
{
  "enabled": true,
  "dryRun": false,
  "maxPings": 5,
  "providers": {
    "mistral":   { "intervalMs": 240000 },
    "openai":    { "intervalMs": 240000 },
    "anthropic": { "intervalMs": 240000 }
  },
  "excludeTools": ["ask_user_question"],
  "minPrefixChars": 12000,
  "maxConcurrentPings": 2,
  "dailyPingBudget": 300,
  "pingTimeoutMs": 90000
}
```

| field | default | meaning |
| --- | --- | --- |
| `enabled` | `true` | master switch |
| `dryRun` | `false` | journal would-be pings, dispatch nothing — watch mode for a first deploy |
| `providers` | see above | **presence in the table = warm this provider**; each entry needs its own `intervalMs` and may override `maxPings` |
| `maxPings` | `5` | ping cap per tool block when a provider entry doesn't override it (prefix is stale past `maxPings × intervalMs` anyway) |
| `excludeTools` | `["ask_user_question"]` | user-idle-like waits with uncertain resume |
| `minPrefixChars` | `12000` | skip tiny prefixes (≈chars/4 tokens); a miss on them is worthless to prevent |
| `maxConcurrentPings` | `2` | global in-flight guard; over-cap pings retry in 5 s without consuming a slot |
| `dailyPingBudget` | `300` | hard stop per UTC day, counted over real dispatch attempts (expected need ≈30/day) |
| `pingTimeoutMs` | `90000` | abort a stalled ping stream |

### Why these three providers

Interval defaults are tied to each provider's own cache behavior — measure before adding more:

- **mistral** — measured on this setup (2026-10-17 live probe, `zai-glm-5-3`): hit at 302 s, miss at 424 s; 240 s leaves ~1 min headroom.
- **openai** — documented "generally lasts between 5 minutes and up to an hour"; 240 s stays under the short end.
- **anthropic** — documented 5-minute TTL, refreshed on use; 240 s fits.
- **deepseek** — deliberately absent: its automatic disk cache outlives any sane ping grid (reports range from minutes to hours; DeepSeek publishes no TTL), so pinging it every 4 minutes is pure waste. Add an entry only after measuring an actual TTL on your account.
- **opencode-go / other proxies** — absent: TTL unmeasured. Probe first, then add e.g. `"opencode-go": { "intervalMs": 120000 }`.

A pre-table config (`warmProviders` + `intervalMs`) migrates automatically into the per-provider table with a console warning.

## Observability

- `storages/dsh-warm/warm.jsonl` — one line per ping: provider usage (`cacheReadTokens` > 0 ⇒ hit), latency, errors, dry-run markers; rolls at 5 MB. The budget counter boots from today's lines.
- Host console: a load banner with the resolved config, plus rate-limited failure warnings.
- dsh-cost-meter's ledger includes every ping (session-attributed via `sessionId`), so the economics stay verifiable against reality.

## Known limitations

- Provider scope: only providers with an entry in the `providers` table are warmed; each needs a measured or documented TTL floor (deepseek and opencode-go are absent by default for that reason — see the configuration section).
- The re-dispatch goes through the profile's main `llm` service; a provider adapter registered only on an isolated service would serialize differently (none exist in this profile today).
- The 302 s TTL floor is a Mistral measurement for `zai-glm-5-3`; other providers need their own probe before being added to the `providers` table.
