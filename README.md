# dsh-warm

Prompt-cache warmer for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), a host plugin. It keeps a session's provider prompt-cache prefix warm **while, and only while, the session's agent loop is blocked inside a tool execution** (long `bash`, `job_output`, `wait_agent` on teammates, and similar waits).

It re-dispatches the session's **last conversation request** through the host `llm/stream` waterfall with `maxTokens: 1` just before the provider's cache would expire (on a fixed `intervalMs` grid when no `ttlMs` is known), then discards the 1-token response. The tool's result lands on the still-warm prefix, so the next real request bills cache-hit input instead of re-prefilling ~90k tokens at miss price and paying the full TTFT again.

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

`$DSH_HOME/storages/dsh-warm/config.json` (written with defaults on first load; edit + restart). The warming rule is **per provider**, because each provider's prompt-cache TTL is its own fact: with a measured or documented `ttlMs` the schedule is expiry-anchored — the anchored schedule pings at 302 s − 60 s = every 242 s, the last safe moment minus a minute's buffer. When `ttlMs` is set, `intervalMs` no longer drives scheduling — leave it in place: it stays the fallback grid if `ttlMs` is dropped and the stats TTL stand-in otherwise:

```json
{
  "enabled": true,
  "dryRun": false,
  "maxPings": 7,
  "providers": {
    "mistral":   { "intervalMs": 240000, "ttlMs": 302000, "marginMs": 60000 },
    "openai":    { "intervalMs": 240000, "ttlMs": 300000, "marginMs": 60000 },
    "anthropic": { "intervalMs": 240000, "ttlMs": 300000, "marginMs": 60000 }
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
| `providers` | see above | **presence in the table = warm this provider**; each entry may set `intervalMs`, `ttlMs` (expiry-anchored scheduling), `marginMs`, and `maxPings`. An entry left `{}` for a known provider adopts the built-in rule (console warn); a `ttlMs`-only entry is kept with `intervalMs` defaulted to 240000 (only the fallback grid reads it); unknown names with neither field warn + drop |
| `maxPings` | `7` | ping cap per tool block when a provider entry doesn't override it. 7 anchored pings (242 s apart) hold the cache up to 7 × 242 + 302 = 1996 s, which covers a 30-min tool wait; at the former 5 (cover 1512 s) every ping of the live ledger's ~30-min blocks expired. An existing `config.json` keeps whatever value it was written with |
| `excludeTools` | `["ask_user_question"]` | user-idle-like waits with uncertain resume |
| `minPrefixChars` | `12000` | skip tiny prefixes (≈chars/4 tokens); preventing a miss on them is not worth a ping |
| `maxConcurrentPings` | `2` | global in-flight guard; over-cap pings retry in 5 s without consuming a slot |
| `dailyPingBudget` | `300` | hard stop per local calendar day, counted over real dispatch attempts (expected need ≈30/day). Recounted from the journal when another host sharing `$DSH_HOME` appended, so side-by-side profiles share one budget |
| `pingTimeoutMs` | `90000` | abort a stalled ping stream |
| `providers.*.ttlMs` | adopted per known provider | the provider's cache TTL floor; when set, pings are expiry-anchored at `ttlMs − marginMs` after the last cache-refreshing event. Still the stats partition threshold. Warns when `ttlMs <= intervalMs` (the fallback grid can never bridge the TTL) |
| `providers.*.marginMs` | `60000` | safety buffer subtracted from `ttlMs`: anchored pings fire `marginMs` before the cache would die. Must be `< ttlMs` — a violating pair drops `ttlMs` (console warn) and the provider falls back to the `intervalMs` grid. Ignored when `ttlMs` is absent. |
| `stats.enabled` | `true` | stats counting + `stats.json` + the `/api/dsh-warm/stats` route's snapshot |
| `debug` | `false` | append every observed event to `storages/dsh-warm/debug.jsonl` (diagnosis aid; off in normal operation) |

### Why these three providers

Interval defaults are tied to each provider's own cache behavior. Measure before adding more:

- **mistral** was measured on this setup (2026-10-17 live probe, `zai-glm-5-3`): hit at 302 s, miss at 424 s; the anchored schedule pings at 302 s − 60 s = every 242 s, the last safe moment minus a minute's buffer.
- **openai** documents its cache as lasting "generally between 5 minutes and up to an hour"; 240 s stays under the short end.
- **anthropic** documents a 5-minute TTL, refreshed on use; 240 s fits.
- **deepseek** is deliberately absent. Its automatic disk cache outlives any sane ping grid (reports range from minutes to hours, and DeepSeek publishes no TTL), so a ping there every 4 minutes is pure waste. Add an entry only after measuring an actual TTL on your account.
- **opencode** is absent: the free models live on `zen/v1`, whose floors are measured (subsection below), but zen's free-tier gate blocks dsh-warm's own pings; the `go` endpoint — the `opencode-go` provider's surface — is a separate, unmeasured cache. Other proxies likewise: probe first, then add e.g. `"opencode-go": { "intervalMs": 120000 }"` — the `{}` shortcut only adopts defaults for the three providers above; an unknown name with an empty entry still drops (with a warn).

#### OpenCode free models — measured zen floors (2026-10-20)

Probed live through the genuine opencode client (v2.0.3) because zen's free-tier gate answers raw HTTP clients with `403 FreeTierError "OpenCode's free tier can only be used from within OpenCode"` — dsh-warm cannot ping these models itself, so the numbers are documentation until DSH routes through the opencode client or a fingerprint-accurate proxy. Method: per model, a dedicated client session primed with a fixed ~14k-char prefix (~10k tokens); resends append a tiny follow-up; hit = the resend's `tokens.cache.read` ≈ the prefix, fragment = a constant tiny residue (123/128/191 tokens), miss = 0.

| model (`zen/v1` free) | measured floor | conservative `ttlMs` |
| --- | --- | --- |
| `glm-5.3-flash-free` | (270, 300] s — miss at 300 | `270000` |
| `deepseek-v4.1-flash-free` | (420, 600) s — 600 s jittery | `420000` |
| `minimax-m3.1-flash-free` | ≥ 420 s — 600 s full once, fragment once | `420000` |
| `big-pickle` | (600, 900) s — 900 s fragments | `600000` |

Hits refresh the cache: each ladder's later rungs hit at cumulative ages far beyond the model's single-dwell floor (up to 1,349 s), so an interval below the floor sustains the cache indefinitely; `marginMs` 60000 applies as usual. Free ids rotate (`space-bunny-free` died upstream) — re-check `GET /zen/v1/models` before relying on one. The `go` endpoint (paid models plus its own free ids) has no measured TTL yet; probe it before adding any `opencode-go` entry.

A pre-table config (`warmProviders` + `intervalMs`) migrates automatically into the per-provider table with a console warning.

## Stats

dsh-warm keeps its own ledger of what warming bought and what it wasted, independent of any other plugin. It shows up in three places: a `stats.json` file, a documented HTTP route, and a small client bundle.

**Counters** (kept per host-local calendar day and all-time; `failed` is all-time only; `byDay` keeps the newest 366 days, `allTime` keeps the totals of older ones):

| counter | meaning |
| --- | --- |
| `warms` | pings dispatched |
| `needless` | wasted: the follow-up arrived before `t0 + TTL`, where `t0` is the request that opened the block — the cache from the real request alone still carried it, so no ping bought anything. Judged per block, not per ping: on a dense grid every ping is individually bridgeable by its neighbor, yet the block as a whole was warm-anyway |
| `noFollowup` | wasted: the tool block ended with no follow-up request at all (the turn went idle, or the session was disposed) |
| `expired` | wasted: the follow-up needed the warm prefix but came more than TTL after the last successful ping, so the cache had already dropped |
| `failed` | pings whose own request errored or aborted (counted separately, never as waste) |
| `savedCacheTokens` | in a block whose follow-up was necessary (arrived past `t0 + TTL`: without any ping the cache would have dropped) and still held (within TTL of the last successful ping): the prefix that stayed warm the whole way, i.e. the smallest cache read among the block's successful pings — what warming verifiably bought. One full miss in the block credits nothing (that ping already paid the re-prefill the follow-up would have; later hits only moved the cost); a partial miss credits only what survived |
| `models.*` | per-model slice of every counter above plus the token figures below; flat fields stay totals across models |
| `pingCacheReadTokens` | per model, per outcome: the ping's own cache-read cost. `held` = necessary and the chain held — the cost that bought the credited follow-up; `needless`/`noFollowup`/`expired` = cost that bought nothing |
| `pingUncachedTokens` | per model: the pings' uncached input tokens — the raw-price basis (cache misses pay here) |
| `failedPingTokens` | all-time: failed pings' observed usage, `{ cacheRead, uncached }` — flat plus per-model `models.*.failedPingTokens` (schema 3); the flat field stays authoritative for pre-upgrade rows. In a file mixing epochs, flat exceeds the per-model sums by exactly the pre-upgrade rows; price flat for the all-time total, per-model for attribution |
| `sessions` | per-session bucket shaped exactly like `allTime` (counts + `models`, no `day`), keyed by session id; at most the 50 most-recently-active sessions, pruned at every write — pruned sessions keep their today/allTime/byDay numbers, only their own bucket is gone |

**Outcome semantics** — counts are pings, not prices, and `expired` is not `failed`:

- Every count row counts pings. The three waste rows are judged per block — one follow-up classifies all of that block's non-failed pings at once, so a single block that lost the cover can add several pings to `expired`.
- `expired` pings succeeded as requests. Each ping's own bill is measured separately and rides the token ledger: its cache-read tokens in `models.*.pingCacheReadTokens.expired`, its uncached input — the tail a cache hit still pays, or the whole prefix when the ping itself fired at a dead cache — in `models.*.pingUncachedTokens`. `expired: 5` is not five full-price re-prefills.
- The re-prefill the follow-up paid on the dead cache is not in this ledger at all; the follow-up is a normal request, billed like any other outside these fields.
- `failed` is the ping's own request erroring or aborting (provider timeout, user interrupt) — provider mechanics, all-time, priced via `failedPingTokens`, never a waste row. `expired` is a cadence signal: the cover lapsed before the follow-up (cap reached, budget gate, or a failed ping breaking the refresh chain). Tune `marginMs`/`maxPings`/`dailyPingBudget` against `expired`, the provider against `failed`.
- `warms` counts at dispatch, so it includes failed pings and pings of blocks still open; the waste rows fill only when a follow-up (or idle/disposal) closes the block. Pings that verifiably carried a follow-up are not a counter: all-time `warms − failed − needless − noFollowup − expired` counts them plus the still-open or teardown-dropped pings, which is why consumers label that residual "held or open".

dsh-warm ships tokens only — it holds no prices. Consumers price the story themselves: the benefit side is `savedCacheTokens × input price` (gross — the follow-up still paid its own hit price for those tokens); the cost side is the pings' measured spend, per model: every `pingCacheReadTokens` figure at the cache-read price plus `pingUncachedTokens` at the input price, and — schema 3 — the per-model `failedPingTokens.cacheRead` at the cache-read price and `failedPingTokens.uncached` at the input price (all-time scope; pre-upgrade rows carry the flat totals, and the flat field stays authoritative for them).

For the dsh-context card's money legend: Saved = `savedCacheTokens` × miss price; Useful spend = `pingCacheReadTokens.held` × hit price; Wasted spend = waste-bucket `pingCacheReadTokens` + failed `failedPingTokens.cacheRead` (per-model; flat in the legacy fallback) × hit price; Full-price spend = `pingUncachedTokens` (+ per-model `failedPingTokens.uncached`) × miss price.

Approximations, by design: classification compares request/ping timestamps against the configured `ttlMs`, not provider-side cache state. A block containing a ping that reported a miss (`cacheReadTokens` 0) is never credited. After a crash (no clean dispose) the boot reseeds `warms`/`failed` from `warm.jsonl` but leaves outcome counters at zero, because outcomes need the follow-up request that happened after the journal line. Of the token figures, per-model `pingUncachedTokens` and `failedPingTokens` reseed from the journal's recorded usage; only the per-outcome `pingCacheReadTokens` split stays zero with the counters. Usage a stream never surfaced counts as zero (failed pings too). A `stats.json` written before the per-model maps boots as-is: the absent maps start empty and the historical flat counts ride unchanged. The same holds per session: buckets count only post-upgrade attribution, a fresh boot reconstructs per-session `warms` from the journal's `sessionId`, and the recency timestamp behind the 50-session bound is internal — it never appears on the route. Stats are written to `storages/dsh-warm/stats.json` (atomic rename, local-day buckets; a file from the UTC-keyed era loads as-is — same key format, only the boundary hours of that day land on the neighboring date).

**Diagnosing counts:** set `"debug": true` and restart the harness; every observed `llm/stream`, tool window, ping, and chain partition is then appended to `storages/dsh-warm/debug.jsonl`, which shows exactly which event an outcome bucket missed (the trace rolls to `debug.jsonl.1` past 16 MB, so at most two bounded files stay on disk). Each `chain.close` carries the two numbers the partition compares — `gap` (follow-up minus the block's opening request) and `ttl`. Turn it off when done.

**Toggle:** `"stats": { "enabled": true }`, on by default. Off means no counting, no `stats.json`, and the route below serves `"statsEnabled": false, "stats": null` so consumers can render the state instead of guessing.

**`GET /api/dsh-warm/stats`** serves a stable schema for third-party consumers (say a dsh-context-insights card; both plugins stay fully independent, this route is the only coupling, and it fails open when dsh-warm is absent). The shape changes only behind a `schema` bump:

```json
{
  "schema": 3,
  "statsEnabled": true,
  "stats": {
    "today": {
      "day": "2026-10-20", "warms": 3, "needless": 0, "noFollowup": 1, "expired": 0, "savedCacheTokens": 1152,
      "models": {
        "zai-glm-5-3": {
          "warms": 3, "needless": 0, "noFollowup": 1, "expired": 0, "savedCacheTokens": 1152,
          "pingCacheReadTokens": { "held": 180000, "needless": 0, "noFollowup": 90000, "expired": 0 },
          "pingUncachedTokens": 1200,
          "failedPingTokens": { "cacheRead": 0, "uncached": 0 }
        }
      }
    },
    "allTime": {
      "warms": 12, "needless": 1, "noFollowup": 2, "expired": 1, "savedCacheTokens": 4608,
      "models": {
        "zai-glm-5-3": {
          "warms": 12, "needless": 1, "noFollowup": 2, "expired": 1, "savedCacheTokens": 4608,
          "pingCacheReadTokens": { "held": 720000, "needless": 90000, "noFollowup": 180000, "expired": 90000 },
          "pingUncachedTokens": 130000,
          "failedPingTokens": { "cacheRead": 24000, "uncached": 8000 }
        }
      }
    },
    "byDay": {
      "2026-10-20": {
        "warms": 3, "needless": 0, "noFollowup": 1, "expired": 0, "savedCacheTokens": 1152,
        "models": {
          "zai-glm-5-3": {
            "warms": 3, "needless": 0, "noFollowup": 1, "expired": 0, "savedCacheTokens": 1152,
            "pingCacheReadTokens": { "held": 180000, "needless": 0, "noFollowup": 90000, "expired": 0 },
            "pingUncachedTokens": 1200,
            "failedPingTokens": { "cacheRead": 0, "uncached": 0 }
          }
        }
      }
    },
    "failed": 2,
    "failedPingTokens": { "cacheRead": 24000, "uncached": 8000 },
    "sessions": {
      "34955360-85de-4149-9981-bc7f2904ab29": {
        "warms": 3, "needless": 0, "noFollowup": 1, "expired": 0, "savedCacheTokens": 1152,
        "models": {
          "zai-glm-5-3": {
            "warms": 3, "needless": 0, "noFollowup": 1, "expired": 0, "savedCacheTokens": 1152,
            "pingCacheReadTokens": { "held": 180000, "needless": 0, "noFollowup": 90000, "expired": 0 },
            "pingUncachedTokens": 1200,
            "failedPingTokens": { "cacheRead": 0, "uncached": 0 }
          }
        }
      }
    }
  },
  "config": {
    "providers": { "mistral": { "intervalMs": 240000, "ttlMs": 302000, "marginMs": 60000 } },
    "budget": { "dailyPingBudget": 300, "maxPingsPerBlock": 7 },
    "dryRun": false
  }
}
```

In `config.providers`, an entry that sets `maxPings` echoes it as an optional field, and an expiry-anchored rule (one with `ttlMs`) echoes `marginMs`: its real cadence is `ttlMs − marginMs`. A rule without `marginMs` runs on the `intervalMs` grid (its `ttlMs` then repeats `intervalMs`). Both fields are additive and optional, so the schema stays 3.

The route sits behind the harness's authenticated `/api` fence (no separate auth; same fence as the harness's own routes) and exists whenever the plugin is enabled, also when stats are off, so the toggle state is visible.

**Client bundle:** the package ships a web client (`dsh.client`, a plain CJS factory, no build step). A "Warm" row in the sidebar footer opens a detail panel with today and all-time counters, the provider grid, and the budget; it polls while open. A `dsh-warm` card on the Plugins page shows the same data. Both surfaces only read the route; nothing is stored client-side.

## Observability

- `storages/dsh-warm/warm.jsonl` holds one line per ping: provider usage (`cacheReadTokens` > 0 means a hit), latency, errors, dry-run markers. It rolls at 5 MB into `warm.jsonl.<day>` (a second roll the same day gets `.<day>.1`, never replacing the first), and the budget counter boots from today's lines — a line counts on the local day of its dispatch `ts`.
- `storages/dsh-warm/stats.json` holds the stats counters above (see Stats), atomic-written, resilient to crashes. Hosts sharing one `$DSH_HOME` merge into it: every write re-reads the file under `stats.json.lock` and adds only its own increments, so no host's counts overwrite another's (a lock whose owner died, or older than 10 s, is broken).
- Host console: a load banner with the resolved config, plus rate-limited failure warnings.
- dsh-cost-meter's ledger includes every ping (session-attributed via `sessionId`), so the economics stay verifiable against reality.

## Known limitations

- Provider scope: only providers with an entry in the `providers` table are warmed, and each needs a measured or documented TTL floor. deepseek and opencode-go are absent by default for that reason (see the configuration section).
- The re-dispatch goes through the profile's main `llm` service; a provider adapter registered only on an isolated service would serialize differently (none exist in this profile today).
- The 302 s TTL floor is a Mistral measurement for `zai-glm-5-3`; other providers need their own probe before being added to the `providers` table.
