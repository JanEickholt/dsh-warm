# AGENTS.md — dsh-warm

Contributor notes for agents and humans editing this plugin. The README
covers what it does and why; this file covers what silently breaks.

## Hard constraints

- `lib/` has ZERO runtime package imports: only `node:` builtins and
  relative files, everything else is the bare `ctx` API (no schemastery,
  no dsh packages). Host plugins must share the host's module instances —
  importing any runtime package would load a second copy and break
  identity-based guarantees (WeakSet loop markers, service instance
  equality). Same convention as dsh-cost-meter. Validate config in
  `lib/config.js` instead of adding a schema dependency.
- Function-plugin contract: named exports `name`, `inject`, `apply` — NO
  default export. Every `ctx.on(...)` registration uses `{ global: true }`
  (isolated service contexts must be observed too). Waterfall listeners
  MUST call `next()` on every path, including early returns.
- Plain JS, ESM, no build step, `node >= 20`. Config is plain JSON at
  `$DSH_HOME/storages/dsh-warm/config.json`, auto-created with defaults.
- Loop-built `GenerateOptions` arrive deep-frozen with `options.sessionId`
  and optional `purpose`; the loop marker is a WeakSet, so a shallow copy
  of a captured request is a hand-built call — the intended cache-reusing
  pattern (the harness's compaction summarizer does the same).

## Doctrine — do not "fix" away

- Only tool-execution windows are warmed. Idle sessions and user-input
  tools (`ask_user_question`) are NEVER warmed: the 50-day ledger showed
  idle warming is net-negative (344/350 sessions never resumed). README
  has the numbers.
- Defaults encode measurements: mistral 240 s comes from the live TTL
  probe (302 s hit / 424 s miss, hits refresh the TTL). A provider enters
  the default table only with a measured or documented TTL floor — never
  guess.
- Pings deliberately traverse the normal `llm/stream` waterfall so
  routing and cost-meter billing treat them like real calls (honest
  ledger). Never short-circuit the waterfall; the journal is the warmer's
  own observability on top of it.

## Invariants in lib/warmer.js

- The replay payload must stay prefix-identical to the captured request:
  a shallow copy of the deep-frozen options where only `maxTokens` and
  `signal` differ. Anything else changes the provider cache key and turns
  the ping into a miss.
- `st.epoch` guards pings still in flight when their state is superseded
  (new capture, idle, disposal): they still journal (budget honesty) but
  never count `pings` or re-arm a timer.
- `st.pingEpoch` marks a ping in flight for the current epoch: its settle
  path re-arms, so `armTimer` must not schedule meanwhile (a tool starting
  mid-ping would otherwise catch up off the not-yet-counted slot and
  double-dispatch). The budget gate counts in-flight pings for the same
  reason across sessions.
- `st.refreshBase` is the last proof of warmth — the anchor capture's ts,
  a successful ping's dispatch ts, or dry-run now(); exactly three write
  sites (onLlmStream accepted, epochLive ping settle, dry-run dispatch).
  The anchored due is `refreshBase + ttlMs − marginMs`; a superseded
  ping's settle must never write it (the base would regress and the
  next epoch's ping would arm too early).
- `journal.pingsToday()` must self-rollover at UTC midnight: the budget
  gates call it before `record()` can ever run again, so `record()`-only
  rollover freezes an exhausted budget for the process lifetime.
- Provider failures arrive as terminal finish chunks
  (`reason.kind: 'error' | 'aborted'` with `reason.failure`), not thrown
  errors — track the finish chunk in the consume loop, not just
  try/catch.
- Debug trace (`config.debug: true`): lib/index.js builds an
  appendFileSync sink to `storages/dsh-warm/debug.jsonl` and passes it to
  both engines as `deps.debug`; warmer logs every `llm/stream`
  (pre-guard, with `accepted`), tool window, status, ping dispatch/settle;
  stats logs every chain event with the partition outcome. It is a
  diagnosis channel only — behavior must be identical with the sink
  absent (the suite runs all scenarios but the trace scenario (67) with
  `debug: null`).
- Empty-entry adoption (lib/config.js) and the trace that proves it: a
  `providers` entry with neither `intervalMs` nor `ttlMs` for a provider
  named in `DEFAULT_CONFIG.providers` adopts the built-in rule with one
  warn — dropping it would silently disable warming for a provider the
  user named on purpose; a `ttlMs`-only entry is kept with `intervalMs`
  defaulted 240000 (anchored scheduling never reads it); unknown names
  with neither field still warn + drop. In lib/warmer.js the
  `llm/stream` trace line's `accepted` flag means arm-able capture, and
  a capture whose provider is outside the warmed table logs
  `{ ev: 'drop', reason: 'provider-not-in-table', provider, model }`
  right after — a capture whose provider is outside the warmed table
  must never show `accepted: true` followed by silence; that is a trace
  bug.

## Tests (`npm test` → test/verify.mjs, fake clock + fake timers)

- Never gate a tool call with a real `setTimeout` in a scenario: it
  resolves before the fake clock advances and the scenario proves
  nothing.
- The concurrency scenario asserts shared-grid serialization across two
  `advance()` calls (3 then 4 dispatches), not one big advance.
- Scenario 18 uses a real `openJournal` in a tmp dir — it exists to prove
  the UTC-midnight budget reset; keep it on the real journal.
- The suite must stay green before any change to `lib/`. After host-side
  changes, the harness must be restarted from a terminal — a restart
  kills the host process, so never trigger it from inside a session.

## Client half (`client/index.js`)

- Hand-written CJS factory, `window.__ModuleLoader__.load({ id,
  factory })`, exactly dsh-cost-meter's form: a single closure, `react`
  from the shell baseline, no build step, no bundler. Exports
  `name`/`inject`/`apply` like the host plugin.
- `lib/`'s zero-import rule does NOT apply to `client/` — the factory
  `require()`s shell-baseline modules (today only `react`). Keep the
  list minimal; every new require must exist in the shell baseline.
- Slots: `sidebar.footer.action` (id `dsh-warm-stats`) and the keyed
  `plugins.bundle.config` card (key `dsh-warm`, the package name — the
  Plugins page keys occupants by bundle). `slots.inject(name, factory)`
  is enough; contributions leave with the plugin fiber.
- The client fetches `api/dsh-warm/stats` RELATIVE — never a leading
  slash (reverse proxies drop path prefixes; dsh-context convention).
- Route: `ctx.inject(['connection'], ...)` →
  `connection.fetch.register({ path: '/api/dsh-warm/stats', methods:
  ['GET'], requestBody: 'buffered', fetch })` — the authenticated `/api`
  fence, no hand-rolled auth. Guard the register call; hosts without the
  connection service just lack the route.
- Wire payload (`makeStatsPayload` in lib/index.js) is a documented
  stable schema (`schema: 3`): change shape only behind a schema bump,
  and mirror the change in the README route example. Schema 3 adds
  per-model `failedPingTokens` maps (`models.<id>.failedPingTokens`,
  all-time); the flat top-level `failedPingTokens` is the complete
  all-time total and stays authoritative for pre-upgrade rows — in a
  file mixing epochs flat exceeds the per-model sums by exactly those
  rows, and post-upgrade increments keep the sums equal. Schema 2 added
  per-model `models` maps, all-time flat `failedPingTokens`, and the
  bounded `sessions` map; flat count fields are complete totals in the
  same sense (pre-upgrade rows can widen a flat-vs-models gap; only
  post-upgrade increments are guaranteed to match).
- Client smoke test (scenario 46) evaluates the factory with a stubbed
  `require('react')` and a mock slots service — react is NOT a repo
  dependency and must never become one.
- After client-side changes the harness must be restarted from a
  terminal and the page refreshed for the new bundle to load.

## Cloned Dependency Source

Read-only dependency source repositories are available under
`.slim/clonedeps/` for inspection. Do not edit these clones.

- `.slim/clonedeps/repos/deepseek-ai__deepseek-harness/`: `github.com/deepseek-ai/deepseek-harness` at `master` (687f282); upstream source of the installed DSH packages — client-plugin API facts (slot catalog, `dsh.client` declaration, `sessionProjections`, `connection.fetch`).
- `.slim/clonedeps/repos/bowenliang123__dsh-context/`: `github.com/bowenliang123/dsh-context` at `c22ccb2` (v0.73.3); third-party Context Insights plugin — extension-surface facts and interop boundary for dsh-warm stats (it exposes no foreign-extension surface today).
- `.slim/clonedeps/repos/helloxkk__dsh-scope/`: `github.com/helloxkk/dsh-scope` at `439e009` (v0.3.0); precedent for a hand-written CJS client half plus a `connection.fetch` host route.
