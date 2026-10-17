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
- `journal.pingsToday()` must self-rollover at UTC midnight: the budget
  gates call it before `record()` can ever run again, so `record()`-only
  rollover freezes an exhausted budget for the process lifetime.
- Provider failures arrive as terminal finish chunks
  (`reason.kind: 'error' | 'aborted'` with `reason.failure`), not thrown
  errors — track the finish chunk in the consume loop, not just
  try/catch.

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
