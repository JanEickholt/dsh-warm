# dsh-warm

Prompt-cache warmer for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), a host plugin. It keeps a session's provider prompt-cache prefix warm **while, and only while, the session's agent loop is blocked inside a tool execution** (long `bash`, `job_output`, `wait_agent` on teammates, and similar waits).

It re-dispatches the session's **last conversation request** through the host `llm/stream` waterfall with `maxTokens: 1` on a fixed interval, then discards the 1-token response. The tool's result lands on the still-warm prefix, so the next real request bills cache-hit input instead of re-prefilling ~90k tokens at miss price and paying the full TTFT again.

## Why only tool blocks

Measured on this setup (2026-10-17, live probe against `api.mistral.ai`, `zai-glm-5-3`; 50 days of ledgers, 350 sessions):

- **TTL is provider-specific.** Mistral's lasts 5 to 7 min here (hit at 302 s, miss at 424 s, and hits refresh the TTL), which is why the interval table is per provider.
- **Tool and teammate waits resume for sure**, since the loop continues the moment the tool settles. Over 50 days that nets **+$7.15** and about 1 h of TTFT recovered, with zero tail risk.
- **Idle sessions mostly never come back.** 344 of 350 sessions were never resumed, and naive OpenCode-style idle warming nets **−$6.91 / 50 days**. So idle sessions and user-input tools (`ask_user_question`) are **never** warmed here.

A cache hit bills at a 90 % discount on this provider ($1.40/M miss, $0.14/M hit). Each ping costs about $0.014 per 100k-token prefix and saves a ~$0.126 re-prefill plus 25 to 40 s of TTFT when the block outlasts the TTL.

## How the replay stays byte-identical

The loop-built request arrives at the `llm/stream` waterfall deep-frozen, a pure function of the session log. The warmer captures that exact object and later sends a fresh shallow copy that shares the frozen fields, changing only:

- `maxTokens: 1`, a sampling field that is not part of the cached input prefix,
- `signal`, the captured call's signal chained (`AbortSignal.any`) with the ping timeout, so a user interrupt aborts an in-flight ping too.

The same adapter that served the real call serializes the ping, so the input prefix is byte-identical and the provider serves it from cache. This is the same cache-reusing auxiliary-call pattern the harness itself uses for compaction summarization. The ping is a *hand-built* call (the loop's `markAgentLoopRequest` WeakSet identity does not carry over to the copy) and it traverses the full waterfall, so routing adapters behave identically and **dsh-cost-meter bills its usage like any other call**. The ledger stays honest.

## Install

```sh
dsh plugin --profile web add dsh-warm                      # from npm
dsh plugin --profile web add github:JanEickholt/dsh-warm  # from GitHub, no npm needed
```

Or as a local plugin (link protocol):

1. `profiles/<profile>/package.json`: add `"dsh-warm": "link:/absolute/path/to/dsh-warm"` to `dependencies` and `"dsh-warm"` to `dsh.profile.bundles`.
2. `pnpm install` inside the profile directory.
3. Restart the harness from a terminal (e.g. `systemctl --user restart <your-dsh-unit>`). A restart kills the host process; never trigger it from inside a session.

The plugin's `dsh.bundle.patch` (`cordis.patch.yml`) inserts the loader row automatically; no `cordis.patch.yml` edit needed.

## Configuration

`$DSH_HOME/storages/dsh-warm/config.json` (written with defaults on first load; edit + restart). The ping interval is **per provider**, because the interval must sit under that provider's own prompt-cache TTL:

```json
{
  "enabled": true,
  "dryRun": false,
  "maxPings": 5,
  "providers": {
    "mistral":   { "intervalMs": 240000, "ttlMs": 302000 },
    "openai":    { "intervalMs": 240000, "ttlMs": 300000 },
    "anthropic": { "intervalMs": 240000, "ttlMs": 300000 }
  },
  "excludeTools": ["ask_user_question"],
  "minPrefixChars": 12000,
  "maxConcurrentPings": 2,
  "dailyPingBudget": 300,
  "pingTimeoutMs": 90000,
  "stats": { "enabled": true }
}
```

| field | default | meaning |
| --- | --- | --- |
| `enabled` | `true` | master switch |
| `dryRun` | `false` | journal would-be pings, dispatch nothing. Watch mode for a first deploy. |
| `providers` | see above | **presence in the table = warm this provider**; each entry needs its own `intervalMs` and may override `maxPings` and `ttlMs` |
| `maxPings` | `5` | ping cap per tool block when a provider entry doesn't override it (the prefix is stale past `maxPings × intervalMs` anyway) |
| `excludeTools` | `["ask_user_question"]` | user-idle-like waits with uncertain resume |
| `minPrefixChars` | `12000` | skip tiny prefixes (≈chars/4 tokens); preventing a miss on them is not worth a ping |
| `maxConcurrentPings` | `2` | global in-flight guard; over-cap pings retry in 5 s without consuming a slot |
| `dailyPingBudget` | `300` | hard stop per UTC day, counted over real dispatch attempts (expected need ≈30/day) |
| `pingTimeoutMs` | `90000` | abort a stalled ping stream |
| `providers.*.ttlMs` | adopted per known provider | the provider's cache TTL floor, used by stats classification; `intervalMs` when a provider has no measured value. Warns when `ttlMs <= intervalMs` (the grid can never bridge the TTL) |
| `stats.enabled` | `true` | stats counting + `stats.json` + the `/api/dsh-warm/stats` route's snapshot |

### Why these three providers

Interval defaults are tied to each provider's own cache behavior. Measure before adding more:

- **mistral** was measured on this setup (2026-10-17 live probe, `zai-glm-5-3`): hit at 302 s, miss at 424 s, so 240 s leaves about a minute of headroom.
- **openai** documents its cache as lasting "generally between 5 minutes and up to an hour"; 240 s stays under the short end.
- **anthropic** documents a 5-minute TTL, refreshed on use; 240 s fits.
- **deepseek** is deliberately absent. Its automatic disk cache outlives any sane ping grid (reports range from minutes to hours, and DeepSeek publishes no TTL), so a ping there every 4 minutes is pure waste. Add an entry only after measuring an actual TTL on your account.
- **opencode-go / other proxies** are absent because their TTL is unmeasured. Probe first, then add e.g. `"opencode-go": { "intervalMs": 120000 }"`.

A pre-table config (`warmProviders` + `intervalMs`) migrates automatically into the per-provider table with a console warning.

## Stats

dsh-warm keeps its own ledger of what warming bought and what it wasted, independent of any other plugin. It shows up in three places: a `stats.json` file, a documented HTTP route, and a small client bundle.

**Counters** (kept per UTC day and all-time; `failed` is all-time only):

| counter | meaning |
| --- | --- |
| `warms` | pings dispatched |
| `needless` | wasted: the follow-up request arrived within the provider TTL anyway, so the prefix was still warm without the ping |
| `noFollowup` | wasted: the tool block ended with no follow-up request at all (the turn went idle, or the session was disposed) |
| `expired` | wasted: the follow-up needed the warm prefix but came more than TTL after the last successful ping, so the cache had already dropped |
| `failed` | pings that errored (counted separately, never as waste) |
| `savedCacheTokens` | cache-read tokens of the last successful ping in a block whose follow-up was necessary and arrived within TTL, i.e. what warming verifiably bought |

Approximations, by design: classification compares request/ping timestamps against the configured `ttlMs`, not provider-side cache state. A ping that reported a miss (`cacheReadTokens` 0) is never credited. After a crash (no clean dispose) the boot reseeds `warms`/`failed` from `warm.jsonl` but leaves outcome counters at zero, because outcomes need the follow-up request that happened after the journal line. Stats are written to `storages/dsh-warm/stats.json` (atomic rename, UTC-day buckets).

**Toggle:** `"stats": { "enabled": true }`, on by default. Off means no counting, no `stats.json`, and the route below serves `"statsEnabled": false, "stats": null` so consumers can render the state instead of guessing.

**`GET /api/dsh-warm/stats`** serves a stable schema for third-party consumers (say a dsh-context-insights card; both plugins stay fully independent, this route is the only coupling, and it fails open when dsh-warm is absent). The shape changes only behind a `schema` bump:

```json
{
  "schema": 1,
  "statsEnabled": true,
  "stats": {
    "today":   { "day": "2026-10-20", "warms": 3, "needless": 0, "noFollowup": 1, "expired": 0, "savedCacheTokens": 1152 },
    "allTime": { "warms": 12, "needless": 1, "noFollowup": 2, "expired": 1, "savedCacheTokens": 4608 },
    "byDay":   { "2026-10-20": { "warms": 3, "needless": 0, "noFollowup": 1, "expired": 0, "savedCacheTokens": 1152 } },
    "failed": 0
  },
  "config": {
    "providers": { "mistral": { "intervalMs": 240000, "ttlMs": 302000 } },
    "budget": { "dailyPingBudget": 300, "maxPingsPerBlock": 5 },
    "dryRun": false
  }
}
```

The route sits behind the harness's authenticated `/api` fence (no separate auth; same fence as the harness's own routes) and exists whenever the plugin is enabled, also when stats are off, so the toggle state is visible.

**Client bundle:** the package ships a web client (`dsh.client`, a plain CJS factory, no build step). A "Warm" row in the sidebar footer opens a detail panel with today and all-time counters, the provider grid, and the budget; it polls while open. A `dsh-warm` card on the Plugins page shows the same data. Both surfaces only read the route; nothing is stored client-side.

## Observability

- `storages/dsh-warm/warm.jsonl` holds one line per ping: provider usage (`cacheReadTokens` > 0 means a hit), latency, errors, dry-run markers. It rolls at 5 MB, and the budget counter boots from today's lines.
- `storages/dsh-warm/stats.json` holds the stats counters above (see Stats), atomic-written, resilient to crashes.
- Host console: a load banner with the resolved config, plus rate-limited failure warnings.
- dsh-cost-meter's ledger includes every ping (session-attributed via `sessionId`), so the economics stay verifiable against reality.

## Known limitations

- Provider scope: only providers with an entry in the `providers` table are warmed, and each needs a measured or documented TTL floor. deepseek and opencode-go are absent by default for that reason (see the configuration section).
- The re-dispatch goes through the profile's main `llm` service; a provider adapter registered only on an isolated service would serialize differently (none exist in this profile today).
- The 302 s TTL floor is a Mistral measurement for `zai-glm-5-3`; other providers need their own probe before being added to the `providers` table.
