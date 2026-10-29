/**
 * dsh-warm state-machine verification with a fake clock, fake timers, fake
 * llm service, and in-memory journal. No host boot required.
 * Run: `node test/verify.mjs` (or `npm test`).
 */

import assert from 'node:assert/strict'
import { createWarmer } from '../lib/warmer.js'

// Days are host-local (lib/journal.js localDayKey). The fixtures below are
// written in UTC instants, so the suite pins the zone; the local-day
// scenarios (74+) switch it explicitly and restore UTC afterwards.
process.env.TZ = 'UTC'

const fakeClock = () => {
  const state = { value: 0 }
  const pending = new Map()
  let seq = 1
  return {
    now: () => state.value,
    setTimer: (cb, ms) => {
      const id = seq++
      pending.set(id, { cb, at: state.value + ms })
      return id
    },
    clearTimer: (id) => pending.delete(id),
    pendingCount: () => pending.size,
    /** Advance the clock, firing due timers in order. */
    advance: (ms) => {
      state.value += ms
      const due = [...pending.entries()].filter(([, t]) => t.at <= state.value).sort((a, b) => a[1].at - b[1].at)
      for (const [id, t] of due) {
        pending.delete(id)
        t.cb()
      }
    },
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

const makeLlm = () => {
  const dispatches = []
  const llm = {
    stream: async function* (options) {
      dispatches.push(options)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'usage', usage: { inputTokens: 1200, cacheReadTokens: 1152, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  return { llm, dispatches }
}

const makeJournal = (initialToday = 0) => {
  const entries = []
  let spent = initialToday
  return {
    entries,
    record: (entry) => {
      entries.push(entry)
      if (entry.counted) spent++
    },
    pingsToday: () => spent,
    path: '(test)',
    close: () => {},
  }
}

const baseConfig = {
  enabled: true,
  dryRun: false,
  maxPings: 5,
  providers: {
    mistral: { intervalMs: 240_000, ttlMs: 302_000, marginMs: 60_000 },
  },
  excludeTools: ['ask_user_question'],
  minPrefixChars: 12_000,
  maxConcurrentPings: 2,
  dailyPingBudget: 300,
  pingTimeoutMs: 90_000,
  stats: { enabled: true },
}

const bigMessages = [{ role: 'user', content: 'x'.repeat(20_000) }]
const conversationRequest = { provider: 'mistral', model: 'zai-glm-5-3', sessionId: 's1', messages: bigMessages, maxTokens: 131_072, temperature: 0.7 }
Object.freeze(conversationRequest)
Object.freeze(conversationRequest.messages)

const makeWarmer = (configOverrides = {}, journalOverrides = {}, depsOverrides = {}) => {
  const clock = fakeClock()
  const { llm, dispatches } = makeLlm()
  const journal = makeJournal()
  Object.assign(journal, journalOverrides)
  const signals = []
  const warmer = createWarmer({
    llm,
    config: { ...baseConfig, ...configOverrides },
    journal,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    signal: (ms) => {
      const s = { timeoutMs: ms }
      signals.push(s)
      return s
    },
    warn: () => {},
    ...depsOverrides,
  })
  return { warmer, clock, dispatches, journal, signals }
}

// --- 1. Ping fires on the grid while a tool is outstanding -----------------
{
  const { warmer, clock, dispatches, journal } = makeWarmer()
  warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
  warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
  const done = warmer.onToolsExecute({ agent: { id: 's1' }, name: 'bash' }, async () => 'result')
  await done
  assert.equal(dispatches.length, 0, 'no ping before the interval')

  // Re-enter the tool and keep it outstanding across the grid.
  const gate = { resolve: null }
  const gatePromise = new Promise((r) => { gate.resolve = r })
  const toolPromise = warmer.onToolsExecute({ agent: { id: 's1' }, name: 'bash' }, async () => { await gatePromise; return 'result' })

  clock.advance(241_000)
  await settle()
  assert.equal(dispatches.length, 0, 'no ping one second before the anchored due')
  clock.advance(1_000)
  await settle()
  assert.equal(dispatches.length, 1, 'first ping at refreshBase + ttl - margin')
  const ping = dispatches[0]
  assert.equal(ping.maxTokens, 1, 'ping caps output at one token')
  assert.equal(ping.messages, conversationRequest.messages, 'ping shares the frozen messages reference byte-identically')
  assert.equal(ping.provider, 'mistral')
  assert.equal(ping.model, 'zai-glm-5-3')
  assert.ok(ping.signal && ping.signal.timeoutMs === 90_000, 'ping carries its own abort signal')
  assert.equal(journal.entries.length, 1)
  assert.equal(journal.entries[0].counted, true)
  assert.equal(journal.entries[0].cacheReadTokens, 1152, 'journal records the provider hit')

  clock.advance(242_000)
  await settle()
  assert.equal(dispatches.length, 2, 'second ping on the next anchored slot (the hit moved the base to 242s)')

  gate.resolve()
  await toolPromise
  clock.advance(240_000)
  await settle()
  assert.equal(dispatches.length, 2, 'no ping after the tool settles')
  assert.equal(clock.pendingCount(), 0, 'timer cleaned up')
  warmer.dispose()
}

// --- 2. Cap: at most maxPings per block ------------------------------------
{
  const { warmer, clock, dispatches } = makeWarmer()
  warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
  warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
  const gate = { resolve: null }
  const gatePromise = new Promise((r) => { gate.resolve = r })
  const toolPromise = warmer.onToolsExecute({ agent: { id: 's1' }, name: 'wait_agent' }, async () => { await gatePromise; return 'ok' })
  clock.advance(241_000)
  await settle()
  assert.equal(dispatches.length, 0, '241s: nothing before the anchored due (the 240s grid slot is dead)')
  for (let i = 0; i < 7; i++) {
    clock.advance(242_000)
    await settle()
  }
  assert.equal(dispatches.length, 5, 'ping cap respected')
  gate.resolve()
  await toolPromise
  warmer.dispose()
}

// --- 3. New conversation request resets the grid ---------------------------
{
  const { warmer, clock, dispatches } = makeWarmer()
  warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
  warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
  const gate = { resolve: null }
  const gatePromise = new Promise((r) => { gate.resolve = r })
  const toolPromise = warmer.onToolsExecute({ agent: { id: 's1' }, name: 'bash' }, async () => { await gatePromise; return 'ok' })
  clock.advance(241_000)
  await settle()
  assert.equal(dispatches.length, 0, 'no ping before the anchored due')
  clock.advance(1_000)
  await settle()
  clock.advance(120_000)
  warmer.onLlmStream({ ...conversationRequest, messages: [...bigMessages, { role: 'assistant', content: 'next' }] }, () => [])[Symbol.iterator]()
  clock.advance(120_000)
  await settle()
  assert.equal(dispatches.length, 1, 'grid restarts from the new request, not the old one')
  clock.advance(122_000)
  await settle()
  assert.equal(dispatches.length, 2)
  gate.resolve()
  await toolPromise
  warmer.dispose()
}

// --- 4. Idle agents are never warmed (turn ended) ---------------------------
{
  const { warmer, clock, dispatches } = makeWarmer()
  warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
  warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
  const gate = { resolve: null }
  const gatePromise = new Promise((r) => { gate.resolve = r })
  const toolPromise = warmer.onToolsExecute({ agent: { id: 's1' }, name: 'bash' }, async () => { await gatePromise; return 'ok' })
  warmer.onAgentStatus({ agent: { id: 's1' }, status: 'idle' })
  clock.advance(240_000)
  await settle()
  assert.equal(dispatches.length, 0, 'idle cancels warming')
  warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
  clock.advance(240_000)
  await settle()
  assert.equal(dispatches.length, 0, 're-running does not resurrect the old schedule without a new request')
  gate.resolve()
  await toolPromise
  warmer.dispose()
}

// --- 5. Excluded tools never arm; other tools still pass through -----------
{
  const { warmer, clock, dispatches } = makeWarmer()
  warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
  warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
  const result = await warmer.onToolsExecute({ agent: { id: 's1' }, name: 'ask_user_question' }, async () => 'user-answer')
  assert.equal(result, 'user-answer', 'excluded tool executes normally')
  clock.advance(240_000)
  await settle()
  assert.equal(dispatches.length, 0, 'no warming during user-input tools')
  warmer.dispose()
}

// --- 6. dryRun journals would-be pings without dispatching -----------------
{
  const { warmer, clock, dispatches, journal } = makeWarmer({ dryRun: true })
  warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
  warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
  const gate = { resolve: null }
  const gatePromise = new Promise((r) => { gate.resolve = r })
  const toolPromise = warmer.onToolsExecute({ agent: { id: 's1' }, name: 'bash' }, async () => { await gatePromise; return 'ok' })
  clock.advance(242_000)
  await settle()
  assert.equal(dispatches.length, 0, 'dry-run never dispatches')
  assert.equal(journal.entries.length, 1)
  assert.equal(journal.entries[0].dryRun, true)
  assert.equal(journal.entries[0].counted, false)
  gate.resolve()
  await toolPromise
  warmer.dispose()
}

// --- 7. Budget gate ----------------------------------------------------------
{
  const { warmer, clock, dispatches } = makeWarmer({}, { pingsToday: () => 300 })
  warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
  warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
  const gate = { resolve: null }
  const gatePromise = new Promise((r) => { gate.resolve = r })
  const toolPromise = warmer.onToolsExecute({ agent: { id: 's1' }, name: 'bash' }, async () => { await gatePromise; return 'ok' })
  clock.advance(240_000)
  await settle()
  assert.equal(dispatches.length, 0, 'budget exhausted means no pings')
  gate.resolve()
  await toolPromise
  warmer.dispose()
}

// --- 8. Provider absent from the table: observe but never warm ---------------
{
  const { warmer, clock, dispatches } = makeWarmer()
  warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
  warmer.onLlmStream({ ...conversationRequest, provider: 'opencode-go' }, () => [])[Symbol.iterator]()
  const gate = { resolve: null }
  const gatePromise = new Promise((r) => { gate.resolve = r })
  const toolPromise = warmer.onToolsExecute({ agent: { id: 's1' }, name: 'bash' }, async () => { await gatePromise; return 'ok' })
  clock.advance(240_000)
  await settle()
  assert.equal(dispatches.length, 0)
  gate.resolve()
  await toolPromise
  warmer.dispose()
}

// --- 9. Auxiliary-purpose requests are not captured ---------------------------
{
  const { warmer, clock, dispatches } = makeWarmer()
  warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
  warmer.onLlmStream({ ...conversationRequest, purpose: 'session-title' }, () => [])[Symbol.iterator]()
  const gate = { resolve: null }
  const gatePromise = new Promise((r) => { gate.resolve = r })
  const toolPromise = warmer.onToolsExecute({ agent: { id: 's1' }, name: 'bash' }, async () => { await gatePromise; return 'ok' })
  clock.advance(240_000)
  await settle()
  assert.equal(dispatches.length, 0, 'no capture, no warming')
  gate.resolve()
  await toolPromise
  warmer.dispose()
}

// --- 10. Tiny prefixes are skipped -------------------------------------------
{
  const { warmer, clock, dispatches } = makeWarmer()
  warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
  warmer.onLlmStream({ provider: 'mistral', model: 'zai-glm-5-3', sessionId: 's1', messages: [{ role: 'user', content: 'hi' }] }, () => [])[Symbol.iterator]()
  const gate = { resolve: null }
  const gatePromise = new Promise((r) => { gate.resolve = r })
  const toolPromise = warmer.onToolsExecute({ agent: { id: 's1' }, name: 'bash' }, async () => { await gatePromise; return 'ok' })
  clock.advance(240_000)
  await settle()
  assert.equal(dispatches.length, 0)
  gate.resolve()
  await toolPromise
  warmer.dispose()
}

// --- 11. Concurrency guard defers without consuming a slot --------------------
{
  const { warmer, clock, dispatches } = makeWarmer({ maxConcurrentPings: 1 })
  // Two sessions both due; only one ping may be in flight.
  warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
  warmer.onAgentStatus({ agent: { id: 's2' }, status: 'running' })
  warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
  warmer.onLlmStream({ ...conversationRequest, sessionId: 's2' }, () => [])[Symbol.iterator]()
  const gates = [0, 1].map(() => {
    const gate = { resolve: null }
    gate.promise = new Promise((r) => { gate.resolve = r })
    return gate
  })
  const tools = Promise.all([
    warmer.onToolsExecute({ agent: { id: 's1' }, name: 'bash' }, async () => { await gates[0].promise; return 'ok' }),
    warmer.onToolsExecute({ agent: { id: 's2' }, name: 'bash' }, async () => { await gates[1].promise; return 'ok' }),
  ])
  clock.advance(241_000)
  await settle()
  assert.equal(dispatches.length, 0, 'one second before the shared anchored due nothing fires')
  clock.advance(1_000)
  await settle()
  assert.equal(dispatches.length, 1, 'concurrency cap: second session deferred')
  clock.advance(5_000)
  await settle()
  assert.equal(dispatches.length, 2, 'deferred session pings after the retry delay')
  clock.advance(242_000)
  await settle()
  assert.equal(dispatches.length, 3, 'shared anchored tick: cap serializes the second session again')
  clock.advance(5_000)
  await settle()
  assert.equal(dispatches.length, 4, 'deferred ping lands; both sessions stay on their anchored schedules')
  for (const g of gates) g.resolve()
  await tools
  warmer.dispose()
}

// --- 12. dispose cancels everything ------------------------------------------
{
  const { warmer, clock, dispatches } = makeWarmer()
  warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
  warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
  const gate = { resolve: null }
  const gatePromise = new Promise((r) => { gate.resolve = r })
  const toolPromise = warmer.onToolsExecute({ agent: { id: 's1' }, name: 'bash' }, async () => { await gatePromise; return 'ok' })
  warmer.dispose()
  clock.advance(240_000)
  await settle()
  assert.equal(dispatches.length, 0)
  assert.equal(clock.pendingCount(), 0)
  gate.resolve()
  await toolPromise
}

// --- 13. Llm failure journals an error, does not throw, keeps the chain ------
{
  const { warmer, clock, dispatches, journal } = makeWarmer()
  const failingLlm = {
    stream: async function* () {
      throw new Error('provider 503')
    },
  }
  const warmer2 = createWarmer({
    llm: failingLlm,
    config: { ...baseConfig },
    journal,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    signal: () => ({ timeoutMs: 90_000 }),
    warn: () => {},
  })
  warmer2.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
  warmer2.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
  const gate = { resolve: null }
  const gatePromise = new Promise((r) => { gate.resolve = r })
  const toolPromise = warmer2.onToolsExecute({ agent: { id: 's1' }, name: 'bash' }, async () => { await gatePromise; return 'ok' })
  clock.advance(242_000)
  await settle()
  assert.equal(dispatches.length, 0)
  assert.equal(journal.entries.length, 1)
  assert.equal(journal.entries[0].ok, false)
  assert.match(journal.entries[0].error, /503/)
  assert.equal(journal.entries[0].counted, true, 'a real dispatch attempt consumes budget even on failure')
  clock.advance(30_000)
  await settle()
  assert.equal(journal.entries.length, 2, 'chain continues after a failure')
  gate.resolve()
  await toolPromise
  warmer2.dispose()
}

// --- 14. Per-provider intervals: independent grids ---------------------------
{
  const { warmer, clock, dispatches } = makeWarmer({ providers: { mistral: { intervalMs: 240_000 }, slow: { intervalMs: 120_000 } } })
  warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
  warmer.onAgentStatus({ agent: { id: 's2' }, status: 'running' })
  warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
  warmer.onLlmStream({ ...conversationRequest, sessionId: 's2', provider: 'slow' }, () => [])[Symbol.iterator]()
  const gates = [0, 1].map(() => {
    const gate = { resolve: null }
    gate.promise = new Promise((r) => { gate.resolve = r })
    return gate
  })
  const tools = Promise.all([
    warmer.onToolsExecute({ agent: { id: 's1' }, name: 'bash' }, async () => { await gates[0].promise; return 'ok' }),
    warmer.onToolsExecute({ agent: { id: 's2' }, name: 'bash' }, async () => { await gates[1].promise; return 'ok' }),
  ])
  clock.advance(120_000)
  await settle()
  assert.equal(dispatches.length, 1, 'only the 120s-interval provider fires at t=120s')
  assert.equal(dispatches[0].provider, 'slow')
  clock.advance(120_000)
  await settle()
  assert.equal(dispatches.length, 3, 'at t=240s both grids fire (slow: 2nd, mistral: 1st)')
  for (const g of gates) g.resolve()
  await tools
  warmer.dispose()
}

// --- 15. Per-provider maxPings override ---------------------------------------
{
  const { warmer, clock, dispatches } = makeWarmer({ providers: { mistral: { intervalMs: 240_000, maxPings: 2 } } })
  warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
  warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
  const gate = { resolve: null }
  const gatePromise = new Promise((r) => { gate.resolve = r })
  const toolPromise = warmer.onToolsExecute({ agent: { id: 's1' }, name: 'bash' }, async () => { await gatePromise; return 'ok' })
  for (let i = 0; i < 5; i++) {
    clock.advance(240_000)
    await settle()
  }
  assert.equal(dispatches.length, 2, 'provider maxPings override caps at 2, not the global 5')
  gate.resolve()
  await toolPromise
  warmer.dispose()
}

// --- 16. Config: per-provider validation, legacy shim, bad entries dropped ---
{
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { loadConfig } = await import('../lib/config.js')
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-warm-cfg-'))
  const warnings = []
  const warn = (m) => warnings.push(m)

  // Fresh dir: defaults written, provider table intact.
  const cfg = loadConfig(join(tmp, 'a'), warn)
  assert.ok(cfg.providers.mistral && cfg.providers.openai && cfg.providers.anthropic, 'default table has the three seeded providers')
  assert.equal(cfg.providers.mistral.intervalMs, 240_000)

  // Custom table: valid entry kept, invalid dropped, global override honored.
  const { mkdirSync } = await import('node:fs')
  mkdirSync(join(tmp, 'b'), { recursive: true })
  writeFileSync(join(tmp, 'b', 'config.json'), JSON.stringify({
    providers: {
      deepseek: { intervalMs: 300_000, maxPings: 3 },
      broken: { intervalMs: 'soon' },
      spotty: { intervalMs: 5_000 },
    },
  }))
  const cfg2 = loadConfig(join(tmp, 'b'), warn)
  assert.deepEqual(cfg2.providers.deepseek, { intervalMs: 300_000, maxPings: 3, marginMs: 60_000 }, 'custom provider entry kept verbatim (marginMs always resolves)')
  assert.equal(cfg2.providers.broken, undefined, 'non-numeric intervalMs drops the entry')
  assert.equal(cfg2.providers.spotty, undefined, 'sub-minute interval drops the entry')
  assert.ok(warnings.some((m) => m.includes('providers["broken"]')), 'dropped entry warns loudly')
  assert.ok(warnings.some((m) => m.includes('providers["spotty"]')), 'spam-floor entry warns loudly')

  // Legacy shape migrates onto the per-provider table.
  mkdirSync(join(tmp, 'c'), { recursive: true })
  writeFileSync(join(tmp, 'c', 'config.json'), JSON.stringify({ warmProviders: ['mistral', 'opencode-go'], intervalMs: 200_000 }))
  const cfg4 = loadConfig(join(tmp, 'c'), warn)
  assert.deepEqual(cfg4.providers, { mistral: { intervalMs: 200_000, ttlMs: 302_000, marginMs: 60_000 }, 'opencode-go': { intervalMs: 200_000, marginMs: 60_000 } }, 'legacy warmProviders+intervalMs migrate to one table; known providers adopt the measured ttlMs default')
  assert.ok(warnings.some((m) => m.includes('migrated')), 'migration warns')

  // Prototype-chain names cannot sneak in as providers: the warmer's
  // hasOwn guard is exercised in scenario 17 below.
  rmSync(tmp, { recursive: true, force: true })
  console.log('dsh-warm test/verify.mjs: config scenarios passed')
}

// --- 17. Prototype-chain provider names are not warmable ---------------------
{
  const { warmer, clock, dispatches } = makeWarmer()
  warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
  warmer.onLlmStream({ ...conversationRequest, provider: 'constructor' }, () => [])[Symbol.iterator]()
  const gate = { resolve: null }
  const gatePromise = new Promise((r) => { gate.resolve = r })
  const toolPromise = warmer.onToolsExecute({ agent: { id: 's1' }, name: 'bash' }, async () => { await gatePromise; return 'ok' })
  clock.advance(240_000)
  await settle()
  assert.equal(dispatches.length, 0, 'Object.prototype keys are not provider rules')
  gate.resolve()
  await toolPromise
  warmer.dispose()
}

// --- 18. Real journal: budget resets at UTC midnight without a new record ----
{
  const { openJournal } = await import('../lib/journal.js')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-warm-journal-'))
  try {
    let nowMs = Date.UTC(2026, 9, 17, 23, 30, 0)
    const journal = openJournal(tmp, { now: () => nowMs })
    for (let i = 0; i < 3; i++) journal.record({ counted: true })
    assert.equal(journal.pingsToday(), 3)
    // Midnight passes with the budget exhausted: no record() can ever run
    // again (the gates block first), so pingsToday() must self-rollover.
    nowMs = Date.UTC(2026, 9, 18, 0, 5, 0)
    assert.equal(journal.pingsToday(), 0, 'budget resets at UTC midnight even with no further records')
    journal.record({ counted: true })
    assert.equal(journal.pingsToday(), 1)
    journal.close()
    const reopened = openJournal(tmp, { now: () => nowMs })
    assert.equal(reopened.pingsToday(), 1, 'boot rescan counts the persisted counted entry of today')
    reopened.close()
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// --- 19. Ping in flight when a new request lands: epoch guard ------------------
{
  // The llm holds each ping in flight until released, so the settle path runs
  // after the second conversation request has replaced the captured state.
  const gate = { resolve: null }
  const gatePromise = new Promise((r) => { gate.resolve = r })
  const dispatches = []
  const llm = {
    stream: async function* (options) {
      dispatches.push(options)
      await gatePromise
      yield { type: 'usage', usage: { inputTokens: 1200, cacheReadTokens: 1152 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const { warmer, clock, journal } = makeWarmer({}, {}, { llm })
  warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
  warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
  const toolGate = { resolve: null }
  const toolPromise = warmer.onToolsExecute({ agent: { id: 's1' }, name: 'bash' }, async () => { await new Promise((r) => { toolGate.resolve = r }); return 'ok' })
  clock.advance(242_000)
  await settle()
  assert.equal(dispatches.length, 1, 'epoch-1 ping is in flight')
  // Second conversation request supersedes the captured state mid-flight.
  warmer.onLlmStream({ ...conversationRequest, messages: [{ role: 'user', content: 'y'.repeat(20_000) }] }, () => [])[Symbol.iterator]()
  gate.resolve()
  await settle()
  assert.equal(journal.entries.length, 1)
  assert.equal(journal.entries[0].counted, true, 'the superseded ping was really dispatched: budget stays honest')
  // New epoch grid: first ping due one anchored slot after the new capture, not two.
  clock.advance(241_000)
  await settle()
  assert.equal(dispatches.length, 1, '483s: one second before the new epoch\'s due nothing fires')
  clock.advance(1_000)
  await settle()
  assert.equal(dispatches.length, 2, 'new epoch pings on its own anchored schedule (no slot stolen by the old ping)')
  clock.advance(241_000)
  await settle()
  assert.equal(dispatches.length, 2, '725s: the hit moved the due to 726s')
  clock.advance(1_000)
  await settle()
  assert.equal(dispatches.length, 3, 'second new-epoch ping keeps the 242s spacing')
  toolGate.resolve()
  await toolPromise
  warmer.dispose()
}

// --- 20. Session disposed mid-ping: no orphan re-arm ---------------------------
{
  const gate = { resolve: null }
  const gatePromise = new Promise((r) => { gate.resolve = r })
  const dispatches = []
  const llm = {
    stream: async function* (options) {
      dispatches.push(options)
      await gatePromise
      yield { type: 'usage', usage: { inputTokens: 1200, cacheReadTokens: 1152 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const { warmer, clock, journal } = makeWarmer({}, {}, { llm })
  warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
  warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
  const toolGate = { resolve: null }
  const toolPromise = warmer.onToolsExecute({ agent: { id: 's1' }, name: 'bash' }, async () => { await new Promise((r) => { toolGate.resolve = r }); return 'ok' })
  clock.advance(242_000)
  await settle()
  assert.equal(dispatches.length, 1, 'ping in flight when the session dies')
  warmer.onSessionDisposed({ id: 's1' })
  gate.resolve()
  await settle()
  assert.equal(journal.entries.length, 1, 'dispatched ping is still journaled (billed = counted)')
  assert.equal(clock.pendingCount(), 0, 'no timer re-armed for the disposed session')
  clock.advance(720_000)
  await settle()
  assert.equal(dispatches.length, 1, 'a disposed session is never pinged again')
  toolGate.resolve()
  await toolPromise
  warmer.dispose()
}

// --- 21. Provider failure arrives as a finish chunk, not a throw --------------
{
  const warns = []
  const dispatches = []
  const llm = {
    stream: async function* (options) {
      dispatches.push(options)
      yield { type: 'usage', usage: { inputTokens: 1200, outputTokens: 0 } }
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'upstream unavailable', code: 'PROVIDER_ERROR', status: 503 } } }
    },
  }
  const { warmer, clock, journal } = makeWarmer({}, {}, { llm, warn: (m) => warns.push(m) })
  warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
  warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
  const gate = { resolve: null }
  const gatePromise = new Promise((r) => { gate.resolve = r })
  const toolPromise = warmer.onToolsExecute({ agent: { id: 's1' }, name: 'bash' }, async () => { await gatePromise; return 'ok' })
  clock.advance(242_000)
  await settle()
  assert.equal(journal.entries.length, 1)
  assert.equal(journal.entries[0].ok, false, 'a 503 finish chunk is a failure, not a success')
  assert.match(journal.entries[0].error, /PROVIDER_ERROR/)
  assert.match(journal.entries[0].error, /503/)
  assert.equal(journal.entries[0].counted, true)
  assert.equal(warns.length, 1, 'failure warn fires for finish-chunk errors')
  clock.advance(240_000)
  await settle()
  assert.equal(journal.entries.length, 2, 'chain continues after a finish-chunk failure')
  gate.resolve()
  await toolPromise
  warmer.dispose()
}

// --- 22. Ping chains the captured call's signal with the timeout ---------------
{
  const dispatches = []
  const combined = []
  const llm = {
    stream: async function* (options) {
      dispatches.push(options)
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const combineSignals = (signals) => {
    combined.push(signals)
    return { chained: true }
  }
  const { warmer, clock } = makeWarmer({}, {}, { llm, combineSignals })
  warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
  const callSignal = new AbortController().signal
  warmer.onLlmStream({ ...conversationRequest, signal: callSignal }, () => [])[Symbol.iterator]()
  const gate = { resolve: null }
  const gatePromise = new Promise((r) => { gate.resolve = r })
  const toolPromise = warmer.onToolsExecute({ agent: { id: 's1' }, name: 'bash' }, async () => { await gatePromise; return 'ok' })
  clock.advance(242_000)
  await settle()
  assert.equal(dispatches.length, 1)
  assert.equal(dispatches[0].signal.chained, true, 'payload carries the combined signal')
  assert.equal(combined.length, 1)
  assert.equal(combined[0][0], callSignal, 'the captured call\'s signal is chained: user interrupt aborts the ping')
  assert.equal(combined[0][1].timeoutMs, 90_000, 'the ping timeout is chained alongside')
  gate.resolve()
  await toolPromise
  warmer.dispose()
}

// --- 23. Tool re-entry while a ping is in flight: no duplicate dispatch --------
{
  // Sequential tool calls of one response: tool A settles while its ping is
  // still in flight and tool B starts. The in-flight ping's settle re-arms, so
  // tool B must not schedule a catch-up ping off the not-yet-counted slot.
  const llmGate = { resolve: null }
  const llmGatePromise = new Promise((r) => { llmGate.resolve = r })
  const dispatches = []
  const llm = {
    stream: async function* (options) {
      dispatches.push(options)
      await llmGatePromise
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
    },
  }
  const { warmer, clock, journal } = makeWarmer({}, {}, { llm })
  warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
  warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
  const gateA = { resolve: null }
  const toolA = warmer.onToolsExecute({ agent: { id: 's1' }, name: 'bash' }, async () => { await new Promise((r) => { gateA.resolve = r }); return 'a' })
  clock.advance(242_000)
  await settle()
  assert.equal(dispatches.length, 1, 'ping 1 in flight during tool A')
  gateA.resolve()
  await toolA
  const gateB = { resolve: null }
  const toolB = warmer.onToolsExecute({ agent: { id: 's1' }, name: 'bash' }, async () => { await new Promise((r) => { gateB.resolve = r }); return 'b' })
  clock.advance(5_000)
  await settle()
  assert.equal(dispatches.length, 1, 'tool B does not double-dispatch while ping 1 is in flight')
  llmGate.resolve()
  await settle()
  assert.equal(journal.entries.length, 1)
  clock.advance(233_000) // t=480: the old 240-grid due lands here
  await settle()
  assert.equal(dispatches.length, 1, '480s is still before the anchored due 484')
  clock.advance(4_000)
  await settle()
  assert.equal(dispatches.length, 2, 'ping 2 lands on the anchored slot after ping 1 settles')
  gateB.resolve()
  await toolB
  warmer.dispose()
}

// --- 24. Budget counts in-flight pings: concurrent pings cannot overshoot ------
{
  const llmGate = { resolve: null }
  const llmGatePromise = new Promise((r) => { llmGate.resolve = r })
  const dispatches = []
  const llm = {
    stream: async function* (options) {
      dispatches.push(options)
      await llmGatePromise
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
    },
  }
  const { warmer, clock } = makeWarmer({ dailyPingBudget: 1, maxConcurrentPings: 2 }, {}, { llm })
  for (const id of ['s1', 's2']) {
    warmer.onAgentStatus({ agent: { id }, status: 'running' })
    warmer.onLlmStream({ ...conversationRequest, sessionId: id }, () => [])[Symbol.iterator]()
  }
  const gate = { resolve: null }
  const gatePromise = new Promise((r) => { gate.resolve = r })
  const tools = Promise.all(['s1', 's2'].map((id) => warmer.onToolsExecute({ agent: { id }, name: 'bash' }, async () => { await gatePromise; return 'ok' })))
  clock.advance(241_000)
  await settle()
  assert.equal(dispatches.length, 0, '241s: nothing before the anchored due')
  clock.advance(1_000)
  await settle()
  assert.equal(dispatches.length, 1, 'budget of 1 admits exactly one dispatch even with two due sessions')
  llmGate.resolve()
  gate.resolve()
  await tools
  warmer.dispose()
}

// --- 25. Budget-exhausted warning re-fires on the next exhausted day ----------
{
  let spent = 300
  const warns = []
  const { warmer, clock, dispatches } = makeWarmer({}, { pingsToday: () => spent }, { warn: (m) => warns.push(m) })
  const budgetWarns = () => warns.filter((m) => m.includes('daily ping budget')).length
  warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
  warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
  const gate = { resolve: null }
  const gatePromise = new Promise((r) => { gate.resolve = r })
  const toolA = warmer.onToolsExecute({ agent: { id: 's1' }, name: 'bash' }, async () => { await gatePromise; return 'ok' })
  assert.equal(budgetWarns(), 1, 'day 1: budget exhausted warns')
  spent = 0 // UTC midnight: the journal rolled the counter over.
  const toolB = warmer.onToolsExecute({ agent: { id: 's1' }, name: 'bash' }, async () => { await gatePromise; return 'ok' })
  spent = 300 // Day 2 exhausted before the armed ping fires.
  clock.advance(242_000)
  await settle()
  assert.equal(dispatches.length, 0)
  assert.equal(budgetWarns(), 2, 'day 2: exhaustion warns again instead of staying silent forever')
  gate.resolve()
  await Promise.all([toolA, toolB])
  warmer.dispose()
}

// --- 26. Captured call already aborted: no ping, no budget burned -------------
{
  const dispatches = []
  const llm = {
    stream: async function* (options) {
      dispatches.push(options)
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted' } } }
    },
  }
  const { warmer, clock, journal } = makeWarmer({}, {}, { llm, combineSignals: () => ({ chained: true }) })
  const controller = new AbortController()
  warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
  warmer.onLlmStream({ ...conversationRequest, signal: controller.signal }, () => [])[Symbol.iterator]()
  controller.abort()
  const gate = { resolve: null }
  const gatePromise = new Promise((r) => { gate.resolve = r })
  const toolPromise = warmer.onToolsExecute({ agent: { id: 's1' }, name: 'bash' }, async () => { await gatePromise; return 'ok' })
  for (let i = 0; i < 3; i++) {
    clock.advance(240_000)
    await settle()
  }
  assert.equal(dispatches.length, 0, 'an aborted call is never replayed')
  assert.equal(journal.entries.length, 0, 'no counted entries for pings that would abort instantly')
  gate.resolve()
  await toolPromise
  warmer.dispose()
}

// --- 27. Prefix size: lazy for unwarmed providers, counts non-string system ---
{
  let serialized = 0
  const probe = { role: 'user', content: 'x'.repeat(20_000), toJSON() { serialized++; return { role: this.role, content: this.content } } }
  const { warmer, clock, dispatches } = makeWarmer()
  warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
  warmer.onLlmStream({ ...conversationRequest, provider: 'deepseek', messages: [probe] }, () => [])[Symbol.iterator]()
  const gate = { resolve: null }
  const gatePromise = new Promise((r) => { gate.resolve = r })
  const toolA = warmer.onToolsExecute({ agent: { id: 's1' }, name: 'bash' }, async () => { await gatePromise; return 'ok' })
  assert.equal(serialized, 0, 'requests to unwarmed providers are never serialized for the size gate')

  // Block-array system prompt: its text counts toward the prefix size.
  warmer.onLlmStream({
    ...conversationRequest,
    messages: [{ role: 'user', content: 'hi' }],
    system: [{ type: 'text', text: 's'.repeat(20_000) }],
  }, () => [])[Symbol.iterator]()
  clock.advance(242_000)
  await settle()
  assert.equal(dispatches.length, 1, 'a large block-array system prompt clears minPrefixChars')
  gate.resolve()
  await toolA
  warmer.dispose()
}

// --- 28. Real journal: rolls past ROLL_BYTES within one process lifetime -------
{
  const { openJournal } = await import('../lib/journal.js')
  const { mkdtempSync, rmSync, existsSync, statSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-warm-roll-'))
  try {
    const nowMs = Date.UTC(2026, 9, 17, 12, 0, 0)
    const journal = openJournal(tmp, { now: () => nowMs })
    const pad = 'p'.repeat(64 * 1024)
    // 5 MB roll threshold: ~90 x 64 KB lines cross it without a restart.
    for (let i = 0; i < 90; i++) journal.record({ counted: true, pad })
    assert.ok(existsSync(join(tmp, 'warm.jsonl.2026-10-17')), 'journal rolled mid-process')
    assert.ok(statSync(join(tmp, 'warm.jsonl')).size < 5 * 1024 * 1024, 'live journal restarted small')
    assert.equal(journal.pingsToday(), 90, 'roll does not touch the in-memory budget counter')
    journal.close()
    const reopened = openJournal(tmp, { now: () => nowMs })
    assert.equal(reopened.pingsToday(), 90, 'boot rescan counts today\'s entries in the rolled file too')
    reopened.close()
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// --- 29. Stats harness + needless: quick follow-up makes the ping moot ------
const { createStatsEngine } = await import('../lib/stats.js')
const { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')

/** Warmer + real stats engine sharing one fake clock; stats.json in a tmp dir. */
const statsHarness = (configOverrides = {}, llmFactory = makeLlm, debug = null) => {
  const clock = fakeClock()
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-warm-stats-'))
  const config = { ...baseConfig, ...configOverrides }
  const stats = createStatsEngine({ storageDir: tmp, config, now: clock.now, warn: () => {}, debug })
  const factory = llmFactory()
  const { llm, dispatches, ...llmExtras } = factory
  const journal = makeJournal()
  const warmer = createWarmer({
    llm, config, journal, stats,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    signal: (ms) => ({ timeoutMs: ms }), warn: () => {}, debug,
  })
  return { warmer, clock, dispatches, journal, stats, tmp, llmExtras }
}
const cleanupStats = (h) => rmSync(h.tmp, { recursive: true, force: true })
const gateTool = (warmer, sid = 's1') => {
  const gate = { resolve: null }
  const promise = warmer.onToolsExecute({ agent: { id: sid }, name: 'bash' }, async () => { await new Promise((r) => { gate.resolve = r }); return 'ok' })
  return { gate, promise }
}

{
  const h = statsHarness()
  try {
    h.warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
    h.warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
    const tool = gateTool(h.warmer)
    h.clock.advance(242_000)
    await settle()
    h.clock.advance(58_000)
    h.warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
    const agg = h.stats.snapshot().allTime
    assert.equal(agg.warms, 1, 'one ping dispatched')
    assert.equal(agg.needless, 1, 'follow-up at 300s kept the prefix warm anyway (300s < 302s TTL)')
    assert.equal(agg.expired, 0)
    assert.equal(agg.noFollowup, 0)
    assert.equal(agg.savedCacheTokens, 0, 'no necessary ping means no credit')
    assert.equal(agg.models['zai-glm-5-3'].pingCacheReadTokens.needless, 1152, "the needless ping's own cache-read cost lands in its per-outcome bucket")
    tool.gate.resolve()
    await tool.promise
    h.warmer.dispose()
  } finally {
    cleanupStats(h)
  }
}

// --- 30. Saved: necessary pings, chain held, last ping hit --------------------
{
  const h = statsHarness()
  try {
    h.warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
    h.warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
    const tool = gateTool(h.warmer)
    h.clock.advance(242_000)
    await settle()
    h.clock.advance(242_000)
    await settle()
    h.clock.advance(220_000)
    h.warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
    const agg = h.stats.snapshot().allTime
    assert.equal(agg.warms, 2)
    assert.equal(agg.needless, 0, 'both pings bridged gaps >= TTL')
    assert.equal(agg.expired, 0, 'follow-up landed within TTL of the last ping')
    assert.equal(agg.savedCacheTokens, 1152, 'the hit on the follow-up is credited to warming')
    tool.gate.resolve()
    await tool.promise
    h.warmer.dispose()
  } finally {
    cleanupStats(h)
  }
}

// --- 31. Expired: follow-up beyond the TTL of the last successful ping -------
{
  const h = statsHarness()
  try {
    h.warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
    h.warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
    const tool = gateTool(h.warmer)
    h.clock.advance(242_000)
    await settle()
    tool.gate.resolve()
    await tool.promise
    h.clock.advance(358_000)
    h.warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
    const agg = h.stats.snapshot().allTime
    assert.equal(agg.warms, 1)
    assert.equal(agg.expired, 1, 'the ping was necessary but the chain broke before the follow-up')
    assert.equal(agg.needless, 0)
    assert.equal(agg.savedCacheTokens, 0)
    h.warmer.dispose()
  } finally {
    cleanupStats(h)
  }
}

// --- 32. No-followup via idle: the turn ended, nothing ever came -------------
{
  const h = statsHarness()
  try {
    h.warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
    h.warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
    const tool = gateTool(h.warmer)
    h.clock.advance(242_000)
    await settle()
    h.warmer.onAgentStatus({ agent: { id: 's1' }, status: 'idle' })
    const agg = h.stats.snapshot().allTime
    assert.equal(agg.warms, 1)
    assert.equal(agg.noFollowup, 1, 'idle closes the chain with no follow-up request')
    assert.equal(agg.needless, 0)
    assert.equal(agg.expired, 0)
    tool.gate.resolve()
    await tool.promise
    h.warmer.dispose()
  } finally {
    cleanupStats(h)
  }
}

// --- 33. No-followup via dispose ---------------------------------------------
{
  const h = statsHarness()
  try {
    h.warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
    h.warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
    const tool = gateTool(h.warmer)
    h.clock.advance(242_000)
    await settle()
    h.warmer.onSessionDisposed({ id: 's1' })
    const agg = h.stats.snapshot().allTime
    assert.equal(agg.noFollowup, 1, 'session disposal closes the chain as no-followup')
    assert.equal(agg.warms, 1)
    tool.gate.resolve()
    await tool.promise
    h.warmer.dispose()
  } finally {
    cleanupStats(h)
  }
}

// --- 34. Miss-bridged chains are never credited -------------------------------
{
  const missLlm = () => {
    const dispatches = []
    const llm = {
      stream: async function* (options) {
        dispatches.push(options)
        yield { type: 'usage', usage: { inputTokens: 1200, cacheReadTokens: 0, outputTokens: 1 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    return { llm, dispatches }
  }
  const h = statsHarness({}, missLlm)
  try {
    h.warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
    h.warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
    const tool = gateTool(h.warmer)
    h.clock.advance(242_000)
    await settle()
    h.clock.advance(160_000)
    h.warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
    const agg = h.stats.snapshot().allTime
    assert.equal(agg.warms, 1)
    assert.equal(agg.savedCacheTokens, 0, 'a miss ping already paid the re-prefill: no credit')
    assert.equal(agg.needless, 0)
    assert.equal(agg.expired, 0, 'necessary and held — useful, not wasted')
    tool.gate.resolve()
    await tool.promise
    h.warmer.dispose()
  } finally {
    cleanupStats(h)
  }
}

// --- 35. Failed pings: own aggregate, excluded from anchors ------------------
{
  const flakyLlm = () => {
    const dispatches = []
    let call = 0
    const llm = {
      stream: async function* (options) {
        dispatches.push(options)
        if (call === 0) {
          // The failed ping surfaced usage before dying: its observed cost must
          // still be priced, flat AND per model (schema 3).
          yield { type: 'usage', usage: { inputTokens: 700, cacheReadTokens: 999, outputTokens: 1 } }
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'rate', message: 'boom' } } }
        } else if (call === 1) {
          // Usage-less failure (died before surfacing any usage chunk): still a
          // failed dispatch, but priced zero — flat AND per model stay put.
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'timeout', message: 'no usage surfaced' } } }
        } else {
          yield { type: 'usage', usage: { inputTokens: 1200, cacheReadTokens: 1152, outputTokens: 1 } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
        call++
      },
    }
    return { llm, dispatches }
  }
  const h = statsHarness({}, flakyLlm)
  try {
    h.warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
    h.warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
    const tool = gateTool(h.warmer)
    h.clock.advance(242_000) // ping 1: fails WITH observed usage
    await settle()
    h.clock.advance(240_000) // the 0-delay re-arm fires overdue: retry at 482 fails with NO usage
    await settle()
    h.clock.advance(30_000) // failed retry re-arms half a margin out: ping 3 at 512 succeeds
    await settle()
    h.clock.advance(190_000) // 702 follow-up; the success re-armed at 754 — no fourth dispatch
    h.warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
    const agg = h.stats.snapshot().allTime
    assert.equal(agg.warms, 3)
    const snap = h.stats.snapshot()
    assert.equal(snap.failed, 2, 'failed pings land in their own aggregate, surfaced usage or not')
    assert.deepEqual(snap.failedPingTokens, { cacheRead: 999, uncached: 700 }, 'flat failed tokens price the observed usage; the usage-less failure adds zero')
    assert.deepEqual(snap.allTime.models['zai-glm-5-3'].failedPingTokens, { cacheRead: 999, uncached: 700 }, 'schema 3: failed tokens attribute per model at closeChain; the usage-less failure adds zero here too')
    assert.equal(
      Object.values(snap.allTime.models).reduce((n, m) => n + m.failedPingTokens.cacheRead + m.failedPingTokens.uncached, 0),
      snap.failedPingTokens.cacheRead + snap.failedPingTokens.uncached,
      'flat failed tokens equal the per-model sums (post-upgrade attribution)',
    )
    assert.equal(agg.expired, 0)
    assert.equal(agg.savedCacheTokens, 1152, 'the successful ping partitions against t0 (failed pings are no anchors) and hits')
    tool.gate.resolve()
    await tool.promise
    h.warmer.dispose()
  } finally {
    cleanupStats(h)
  }
}

// --- 36. Zero-ping block: attribution stays untouched ------------------------
{
  const h = statsHarness()
  try {
    h.warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
    h.warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
    const tool = gateTool(h.warmer)
    h.clock.advance(100_000)
    tool.gate.resolve()
    await tool.promise
    h.clock.advance(200_000)
    h.warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
    const agg = h.stats.snapshot().allTime
    assert.equal(agg.warms, 0, 'no ping, no counts')
    assert.equal(agg.needless + agg.noFollowup + agg.expired + h.stats.snapshot().failed, 0)
    assert.equal(agg.savedCacheTokens, 0)
    h.warmer.dispose()
  } finally {
    cleanupStats(h)
  }
}

// --- 37. Toggle off: engine inert, no stats.json, pings still journal --------
{
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-warm-off-'))
  try {
    const stats = createStatsEngine({ storageDir: tmp, config: { ...baseConfig, stats: { enabled: false } }, now: () => 0, warn: () => {} })
    stats.onRealRequest('s1', 'mistral')
    stats.onPingDispatch('s1')
    stats.onPingSettle('s1', { ok: true, cacheReadTokens: 1152 })
    stats.onIdle('s1')
    stats.dispose()
    assert.equal(stats.snapshot(), null, 'disabled engine reports no aggregates')
    assert.ok(!existsSync(join(tmp, 'stats.json')), 'disabled engine never writes stats.json')
    // Warmer with no sink at all: journal honesty is independent of stats.
    const { warmer, clock, journal } = makeWarmer()
    warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
    warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
    const tool = gateTool(warmer)
    clock.advance(242_000)
    await settle()
    assert.equal(journal.entries.length, 1)
    assert.equal(journal.entries[0].counted, true, 'pings still journal without a stats sink')
    tool.gate.resolve()
    await tool.promise
    warmer.dispose()
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// --- 38. Cross-block turn: one chain, no double count -------------------------
{
  const h = statsHarness()
  try {
    h.warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
    h.warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
    const tool1 = gateTool(h.warmer)
    h.clock.advance(242_000)
    await settle()
    tool1.gate.resolve()
    await tool1.promise
    const tool2 = gateTool(h.warmer)
    h.clock.advance(242_000)
    await settle()
    tool2.gate.resolve()
    await tool2.promise
    h.clock.advance(220_000)
    h.warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
    const agg = h.stats.snapshot().allTime
    assert.equal(agg.warms, 2, 'pings from both blocks count once')
    assert.equal(agg.needless, 0)
    assert.equal(agg.expired, 0)
    assert.equal(agg.savedCacheTokens, 1152, 'a single chain closes once at the follow-up')
    h.warmer.dispose()
  } finally {
    cleanupStats(h)
  }
}

// --- 39. Settle after close: hit value dropped, conservative ------------------
{
  const gatedLlm = () => {
    const dispatches = []
    const gate = { resolve: null }
    const gatePromise = new Promise((r) => { gate.resolve = r })
    const llm = {
      stream: async function* (options) {
        dispatches.push(options)
        await gatePromise
        yield { type: 'usage', usage: { inputTokens: 1200, cacheReadTokens: 1152, outputTokens: 1 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    return { llm, dispatches, gate }
  }
  const h = statsHarness({}, gatedLlm)
  try {
    h.warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
    h.warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
    const tool = gateTool(h.warmer)
    h.clock.advance(242_000)
    await settle()
    // Follow-up lands while the ping is still in flight: the chain closes
    // with the ping unsettled (partitioned against 0..300s — needless).
    h.clock.advance(58_000)
    h.warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
    const aggClosed = h.stats.snapshot().allTime
    assert.equal(aggClosed.needless, 1, 'the in-flight ping partitions without its hit value')
    assert.equal(aggClosed.savedCacheTokens, 0)
    // Only now does the ping settle: the chain is gone, the hit is dropped.
    h.llmExtras.gate.resolve()
    await settle()
    const agg = h.stats.snapshot().allTime
    assert.equal(agg.needless, 1)
    assert.equal(agg.savedCacheTokens, 0, 'a settle after close must not retroactively credit the hit')
    assert.equal(agg.warms, 1)
    tool.gate.resolve()
    await tool.promise
    h.warmer.dispose()
  } finally {
    cleanupStats(h)
  }
}

// --- 40. Midnight rollover: day check on read and on write -------------------
{
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-warm-rollstats-'))
  try {
    let nowMs = Date.UTC(2026, 9, 17, 23, 0, 0)
    const clocked = () => nowMs
    const before = createStatsEngine({ storageDir: tmp, config: baseConfig, now: clocked, warn: () => {} })
    before.onRealRequest('s1', 'mistral')
    nowMs = Date.UTC(2026, 9, 17, 23, 50, 0)
    before.onPingDispatch('s1', 'zai-glm-5-3')
    before.onPingSettle('s1', { ok: true, cacheReadTokens: 1152 })
    before.dispose() // persists warms=1 for 2026-10-17; the open chain drops
    // Boot after midnight: the stale today bucket must reset on read.
    nowMs = Date.UTC(2026, 9, 18, 0, 30, 0)
    const after = createStatsEngine({ storageDir: tmp, config: baseConfig, now: clocked, warn: () => {} })
    let snap = after.snapshot()
    assert.equal(snap.today.day, '2026-10-18', 'day check on read resets a stale today bucket')
    assert.equal(snap.today.warms, 0)
    assert.equal(snap.byDay['2026-10-17'].warms, 1, 'yesterday survives in byDay')
    assert.equal(snap.allTime.warms, 1)
    // New attribution after midnight lands on the new day.
    after.onRealRequest('s1', 'mistral')
    nowMs = Date.UTC(2026, 9, 18, 0, 31, 0)
    after.onPingDispatch('s1', 'zai-glm-5-3')
    after.onPingSettle('s1', { ok: true, cacheReadTokens: 1152 })
    nowMs = Date.UTC(2026, 9, 18, 0, 36, 0)
    after.onRealRequest('s1', 'mistral')
    snap = after.snapshot()
    assert.equal(snap.today.warms, 1, 'write-side rollover counts the new day only')
    assert.equal(snap.today.savedCacheTokens, 1152)
    assert.deepEqual(snap.byDay['2026-10-18'], {
      warms: 1, needless: 0, noFollowup: 0, expired: 0, savedCacheTokens: 1152,
      models: {
        'zai-glm-5-3': {
          warms: 1, needless: 0, noFollowup: 0, expired: 0, savedCacheTokens: 1152,
          pingCacheReadTokens: { held: 1152, needless: 0, noFollowup: 0, expired: 0 },
          pingUncachedTokens: 0,
          failedPingTokens: { cacheRead: 0, uncached: 0 },
        },
      },
    })
    assert.equal(snap.allTime.warms, 2, 'allTime accumulates across days')
    assert.equal(snap.allTime.savedCacheTokens, 1152)
    after.dispose()
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// --- 41. stats.json round-trip: authoritative boot, aggregates continue -------
{
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-warm-roundtrip-'))
  try {
    let nowMs = Date.UTC(2026, 9, 19, 12, 0, 0)
    const clocked = () => nowMs
    const first = createStatsEngine({ storageDir: tmp, config: baseConfig, now: clocked, warn: () => {} })
    first.onRealRequest('s1', 'mistral')
    nowMs = Date.UTC(2026, 9, 19, 12, 4, 0)
    first.onPingDispatch('s1')
    first.onPingSettle('s1', { ok: true, cacheReadTokens: 1152 })
    nowMs = Date.UTC(2026, 9, 19, 12, 7, 0)
    first.onRealRequest('s1', 'mistral') // follow-up: necessary, held, hit → saved 1152
    first.dispose()

    nowMs = Date.UTC(2026, 9, 19, 12, 50, 0)
    const second = createStatsEngine({ storageDir: tmp, config: baseConfig, now: clocked, warn: () => {} })
    let snap = second.snapshot()
    assert.equal(snap.allTime.warms, 1, 'boot adopts stats.json instead of reseeding')
    assert.equal(snap.allTime.savedCacheTokens, 1152)
    second.onRealRequest('s1', 'mistral')
    nowMs = Date.UTC(2026, 9, 19, 12, 54, 0)
    second.onPingDispatch('s1')
    second.onPingSettle('s1', { ok: true, cacheReadTokens: 1152 })
    nowMs = Date.UTC(2026, 9, 19, 12, 57, 0)
    second.onRealRequest('s1', 'mistral')
    snap = second.snapshot()
    assert.equal(snap.allTime.warms, 2, 'attribution continues on top of the adopted file')
    assert.equal(snap.allTime.savedCacheTokens, 2304)
    second.dispose()

    const stored = JSON.parse(readFileSync(join(tmp, 'stats.json'), 'utf8'))
    for (const key of ['today', 'allTime', 'byDay', 'failed', 'sessions']) {
      assert.ok(stored[key] !== undefined, `stats.json carries ${key}`)
    }
    assert.equal(stored.today.day, '2026-10-19')
    assert.equal(stored.sessions.s1.warms, 2, 'session buckets round-trip and accumulate across engines')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// --- 42. Corrupt or absent stats.json: journal seeds warms/failed only -------
{
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-warm-seed-'))
  try {
    const pingLine = (ts, ok) => JSON.stringify({ ts, sessionId: 's1', provider: 'mistral', model: 'm', ttMs: 1000, ok, error: ok ? null : 'x', inputTokens: 1, uncachedInputTokens: 700, cacheReadTokens: ok ? 1152 : 0, outputTokens: 1, dryRun: false, counted: true })
    writeFileSync(join(tmp, 'warm.jsonl'), [
      pingLine('2026-10-19T10:00:00.000Z', true),
      pingLine('2026-10-19T10:04:00.000Z', true),
      pingLine('2026-10-19T10:08:00.000Z', false),
      JSON.stringify({ ts: '2026-10-19T10:12:00.000Z', dryRun: true, counted: false }), // dry-run line: excluded
      'not json at all', // unparsable line: skipped
      '',
    ].join('\n') + '\n')
    writeFileSync(join(tmp, 'stats.json'), '{corrupt')
    let nowMs = Date.UTC(2026, 9, 19, 20, 0, 0)
    const engine = createStatsEngine({ storageDir: tmp, config: baseConfig, now: () => nowMs, warn: () => {} })
    let snap = engine.snapshot()
    assert.equal(snap.allTime.warms, 3, 'corrupt stats.json reseeds warms from the journal')
    assert.equal(snap.failed, 1, 'failed dispatches reseed too')
    assert.equal(snap.allTime.needless + snap.allTime.noFollowup + snap.allTime.expired + snap.allTime.savedCacheTokens, 0, 'outcome buckets are not reconstructible and stay zero')
    assert.equal(snap.allTime.models.m.warms, 3, 'seeded warms attribute per model')
    assert.equal(snap.allTime.models.m.pingUncachedTokens, 1400, 'ok lines seed the raw-token basis per model')
    assert.deepEqual(snap.failedPingTokens, { cacheRead: 0, uncached: 700 }, 'failed lines price only their observed usage')
    assert.deepEqual(snap.allTime.models.m.failedPingTokens, { cacheRead: 0, uncached: 700 }, 'failed tokens reseed per line, per model (journal carries the model)')
    assert.equal(
      Object.values(snap.allTime.models).reduce((n, m) => n + m.failedPingTokens.cacheRead + m.failedPingTokens.uncached, 0),
      snap.failedPingTokens.cacheRead + snap.failedPingTokens.uncached,
      'flat failed tokens equal the per-model reseed sums',
    )
    assert.equal(snap.sessions.s1.warms, 3, 'per-session warms reconstruct from the journal\'s sessionId')
    // Attribution continues on top of the seed.
    engine.onRealRequest('s1', 'mistral')
    nowMs = Date.UTC(2026, 9, 19, 20, 10, 0)
    engine.onPingDispatch('s1')
    engine.onPingSettle('s1', { ok: true, cacheReadTokens: 1152 })
    nowMs = Date.UTC(2026, 9, 19, 20, 14, 0)
    engine.onRealRequest('s1', 'mistral')
    snap = engine.snapshot()
    assert.equal(snap.allTime.warms, 4)
    assert.equal(snap.allTime.savedCacheTokens, 1152)
    assert.equal(Object.values(snap.allTime.models).reduce((n, m) => n + m.warms, 0), snap.allTime.warms, 'flat warms equal the per-model sums even across a seed')
    assert.equal(snap.sessions.s1.warms, 4, 'seeded session counts accumulate with post-seed attribution on the same sid')
    engine.dispose()

    // Absent stats.json + journal present: same seed path.
    const tmp2 = mkdtempSync(join(tmpdir(), 'dsh-warm-seed2-'))
    try {
      writeFileSync(join(tmp2, 'warm.jsonl'), pingLine('2026-10-19T11:00:00.000Z', true) + '\n'
        + JSON.stringify({ ts: '2026-10-19T11:05:00.000Z', sessionId: 's2', provider: 'mistral', model: 'old', ok: true, cacheReadTokens: 1152, counted: true }) + '\n'
        + JSON.stringify({ ts: '2026-10-19T11:10:00.000Z', sessionId: 's2', provider: 'mistral', model: 'old2', ok: false, error: 'x', cacheReadTokens: 500, uncachedInputTokens: 100, counted: true }) + '\n')
      const engine2 = createStatsEngine({ storageDir: tmp2, config: baseConfig, now: () => nowMs, warn: () => {} })
      const snap2 = engine2.snapshot()
      assert.equal(snap2.allTime.warms, 3, 'absent stats.json seeds from the journal')
      assert.equal(snap2.failed, 1)
      assert.equal(snap2.allTime.models.m.pingUncachedTokens, 700, 'the raw-token basis seeds per model')
      assert.equal(snap2.allTime.models.old.pingUncachedTokens, 0, 'journal lines predating the token fields seed as 0')
      assert.deepEqual(snap2.failedPingTokens, { cacheRead: 500, uncached: 100 })
      assert.deepEqual(snap2.allTime.models.old2.failedPingTokens, { cacheRead: 500, uncached: 100 }, 'failed tokens reseed per line onto the line\'s own model')
      assert.deepEqual(snap2.allTime.models.m.failedPingTokens, { cacheRead: 0, uncached: 0 }, 'ok lines never touch failed token maps')
      assert.equal(snap2.sessions.s2.warms, 2, 'the old-format lines carry their own sessionId')
      assert.ok(existsSync(join(tmp2, 'stats.json')), 'the seed is written immediately')
      engine2.dispose()
    } finally {
      rmSync(tmp2, { recursive: true, force: true })
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// --- 43. Config: ttlMs validation + stats toggle validation ------------------
{
  const { loadConfig } = await import('../lib/config.js')
  const { mkdirSync } = await import('node:fs')
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-warm-statcfg-'))
  const warnings = []
  const warn = (m) => warnings.push(m)
  try {
    // ttlMs below the grid: kept, but loudly flagged.
    mkdirSync(join(tmp, 'a'), { recursive: true })
    writeFileSync(join(tmp, 'a', 'config.json'), JSON.stringify({ providers: { mistral: { intervalMs: 240_000, ttlMs: 200_000 } } }))
    const cfgA = loadConfig(join(tmp, 'a'), warn)
    assert.equal(cfgA.providers.mistral.ttlMs, 200_000, 'a valid ttlMs is kept')
    assert.ok(warnings.some((m) => m.includes('ttlMs=200000 <= intervalMs=240000')), 'grid-can-never-bridge warns')

    // Invalid ttlMs dropped; the known-provider default is adopted in its place.
    warnings.length = 0
    mkdirSync(join(tmp, 'b'), { recursive: true })
    writeFileSync(join(tmp, 'b', 'config.json'), JSON.stringify({ providers: { mistral: { intervalMs: 240_000, ttlMs: 'soon' } } }))
    const cfgB = loadConfig(join(tmp, 'b'), warn)
    assert.equal(cfgB.providers.mistral.ttlMs, 302_000, 'invalid ttlMs falls back to the measured default')
    assert.ok(warnings.some((m) => m.includes('ttlMs invalid')), 'invalid ttlMs warns')

    // stats toggle validation.
    mkdirSync(join(tmp, 'c'), { recursive: true })
    writeFileSync(join(tmp, 'c', 'config.json'), JSON.stringify({ stats: { enabled: 'yes' } }))
    const cfgC = loadConfig(join(tmp, 'c'), warn)
    assert.equal(cfgC.stats.enabled, true, 'non-boolean stats.enabled keeps the default')
    assert.ok(warnings.some((m) => m.includes('stats.enabled must be boolean')))

    mkdirSync(join(tmp, 'd'), { recursive: true })
    writeFileSync(join(tmp, 'd', 'config.json'), JSON.stringify({ stats: { enabled: false } }))
    const cfgD = loadConfig(join(tmp, 'd'), warn)
    assert.equal(cfgD.stats.enabled, false, 'boolean false is honored')

    warnings.length = 0
    mkdirSync(join(tmp, 'e'), { recursive: true })
    writeFileSync(join(tmp, 'e', 'config.json'), JSON.stringify({ stats: 'nope' }))
    const cfgE = loadConfig(join(tmp, 'e'), warn)
    assert.equal(cfgE.stats.enabled, true, 'non-object stats keeps the default')
    assert.ok(warnings.some((m) => m.includes('stats must be an object')))

    // Default round-trip: ttlMs + stats ship in a fresh config.json.
    const cfgF = loadConfig(join(tmp, 'f'), warn)
    assert.equal(cfgF.providers.mistral.ttlMs, 302_000)
    assert.equal(cfgF.stats.enabled, true)
    const raw = JSON.parse(readFileSync(join(tmp, 'f', 'config.json'), 'utf8'))
    assert.equal(raw.providers.mistral.ttlMs, 302_000, 'fresh config.json carries the measured ttlMs')
    assert.deepEqual(raw.stats, { enabled: true }, 'fresh config.json carries the stats toggle')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// --- 44. Stats route payload: enabled engine ---------------------------------
{
  const { makeStatsPayload, makeStatsRoute } = await import('../lib/index.js')
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-warm-payload-'))
  try {
    let nowMs = Date.UTC(2026, 9, 20, 10, 0, 0)
    const engine = createStatsEngine({ storageDir: tmp, config: baseConfig, now: () => nowMs, warn: () => {} })
    engine.onRealRequest('s1', 'mistral')
    nowMs += 240_000
    engine.onPingDispatch('s1', 'zai-glm-5-3')
    engine.onPingSettle('s1', { ok: true, cacheReadTokens: 1152, uncachedTokens: 1200 })
    nowMs += 60_000 // a second ping in the same chain fails, but surfaced usage first
    engine.onPingDispatch('s1', 'zai-glm-5-3')
    engine.onPingSettle('s1', { ok: false, cacheReadTokens: 999, uncachedTokens: 700 })
    nowMs += 100_000 // follow-up at +400s total: necessary (400-0 ≥ 302) + held (400-240 < 302)
    engine.onRealRequest('s1', 'mistral') // necessary + held + hit → saved

    const payload = makeStatsPayload(engine, baseConfig)
    assert.equal(payload.schema, 3, 'wire payload carries the schema-3 version')
    assert.equal(payload.statsEnabled, true)
    assert.equal(payload.stats.allTime.warms, 2, 'payload embeds the snapshot')
    assert.equal(payload.stats.today.savedCacheTokens, 1152)
    assert.equal(payload.stats.failed, 1)
    assert.deepEqual(payload.stats.failedPingTokens, { cacheRead: 999, uncached: 700 }, 'flat failed token basis rides the payload')
    assert.deepEqual(payload.stats.allTime.models['zai-glm-5-3'].failedPingTokens, { cacheRead: 999, uncached: 700 }, 'schema 3: failed tokens per model on the wire')
    assert.equal(
      Object.values(payload.stats.allTime.models).reduce((n, m) => n + m.failedPingTokens.cacheRead + m.failedPingTokens.uncached, 0),
      payload.stats.failedPingTokens.cacheRead + payload.stats.failedPingTokens.uncached,
      'flat failed tokens equal the per-model sums (post-upgrade attribution)',
    )
    assert.deepEqual(payload.stats.today.models['zai-glm-5-3'], {
      warms: 2, needless: 0, noFollowup: 0, expired: 0, savedCacheTokens: 1152,
      pingCacheReadTokens: { held: 1152, needless: 0, noFollowup: 0, expired: 0 },
      pingUncachedTokens: 1200,
      failedPingTokens: { cacheRead: 0, uncached: 0 },
    }, 'per-model split: held spend, raw spend, saved credit (failed tokens stay all-time)')
    assert.deepEqual(payload.stats.sessions.s1, {
      warms: 2, needless: 0, noFollowup: 0, expired: 0, savedCacheTokens: 1152,
      models: {
        'zai-glm-5-3': {
          warms: 2, needless: 0, noFollowup: 0, expired: 0, savedCacheTokens: 1152,
          pingCacheReadTokens: { held: 1152, needless: 0, noFollowup: 0, expired: 0 },
          pingUncachedTokens: 1200,
          failedPingTokens: { cacheRead: 0, uncached: 0 },
        },
      },
    }, 'the session bucket mirrors the attribution; deepEqual proves the internal recency ts never reaches the wire')
    for (const field of ['warms', 'needless', 'noFollowup', 'expired', 'savedCacheTokens']) {
      const sum = Object.values(payload.stats.allTime.models).reduce((n, m) => n + m[field], 0)
      assert.equal(sum, payload.stats.allTime[field], `flat ${field} equals the per-model sum`)
    }
    assert.equal(payload.config.providers.mistral.intervalMs, 240_000, 'provider summary carries intervalMs')
    assert.equal(payload.config.providers.mistral.ttlMs, 302_000, 'provider summary carries ttlMs')
    assert.deepEqual(payload.config.budget, { dailyPingBudget: baseConfig.dailyPingBudget, maxPingsPerBlock: baseConfig.maxPings }, 'budget summary')
    assert.equal(payload.config.dryRun, false)
    engine.dispose()
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// --- 45. Stats route: disabled stats + handler contract ----------------------
{
  const { makeStatsPayload, makeStatsRoute } = await import('../lib/index.js')
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-warm-route-'))
  try {
    // Disabled: engine null — payload still serves toggle state for clients.
    const offConfig = structuredClone(baseConfig)
    offConfig.stats.enabled = false
    const payload = makeStatsPayload(null, offConfig)
    assert.equal(payload.statsEnabled, false, 'toggle state visible with stats off')
    assert.equal(payload.stats, null, 'no snapshot when stats off')

    // Enabled engine through the handler: Response + JSON body.
    const engine = createStatsEngine({ storageDir: tmp, config: baseConfig, now: () => Date.UTC(2026, 9, 20, 10, 0, 0), warn: () => {} })
    const handler = makeStatsRoute(engine, baseConfig)
    const res = handler()
    assert.ok(res instanceof Response, 'route returns a Response')
    assert.equal(res.headers.get('content-type'), 'application/json')
    const body = JSON.parse(await res.text())
    assert.equal(body.schema, 3)
    assert.equal(body.statsEnabled, true)
    assert.equal(body.stats.allTime.warms, 0, 'empty engine still snapshots')
    assert.deepEqual(body.stats.allTime.models, {}, 'empty engines expose the empty models map')
    assert.deepEqual(body.stats.sessions, {}, 'empty engines expose the empty sessions map')
    assert.deepEqual(body.stats.failedPingTokens, { cacheRead: 0, uncached: 0 })
    engine.dispose()
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// --- 46. Client factory smoke: loads, registers both surfaces ----------------
{
  const { fileURLToPath } = await import('node:url')
  const { dirname } = await import('node:path')
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const source = readFileSync(join(repoRoot, 'client', 'index.js'), 'utf8')
  assert.ok(source.includes("const STATS_URL = 'api/dsh-warm/stats'"), 'client fetches a RELATIVE stats url (reverse-proxy safe)')
  assert.ok(!source.includes("fetch('/api"), 'no root-absolute fetch anywhere in the client')
  assert.ok(source.includes('wasted: follow-up too late'), 'the expired row leads with the follow-up, not the cache')

  // Load through a stubbed ModuleLoader with a stubbed react baseline.
  const loaded = []
  const captured = {}
  globalThis.window = { __ModuleLoader__: { load: (entry) => { loaded.push(entry) } } }
  try {
    // A plain import of client/index.js would evaluate the factory registration
    // against the stub; the factory itself is invoked with a fake require.
    new Function(source)() // defines window.__ModuleLoader__.load effect + calls it
    assert.equal(loaded.length, 1, 'loader receives exactly one entry')
    assert.equal(loaded[0].id, 'dsh-warm')

    const reactStub = { createElement: Object, Fragment: Object, useState: () => [undefined, () => {}], useEffect: () => {}, useRef: () => ({ current: null }), useCallback: (fn) => fn }
    const fakeRequire = (name) => {
      if (name === 'react') return reactStub
      throw new Error(`unexpected require: ${name}`)
    }
    const clientModule = loaded[0].factory(fakeRequire)
    assert.equal(clientModule.name, 'dsh-warm')
    assert.deepEqual(clientModule.inject, ['slots'])
    assert.equal(typeof clientModule.apply, 'function', 'client module exposes apply')

    // apply() with a mock slots service: both surfaces register, options right.
    // (inject invokes the factory once the slot is declared — the mock does it
    // immediately, capturing what register was called with.)
    const registrations = []
    const mockCtx = {
      slots: {
        inject: (slotName, factory) => { captured[slotName] = true; return factory() },
        register: (options, Component) => { registrations.push({ options, Component }); return () => {} },
      },
    }
    clientModule.apply(mockCtx)
    assert.ok(captured['sidebar.footer.action'], 'footer slot injected')
    assert.ok(captured['plugins.bundle.config'], 'bundle config slot injected')
    assert.equal(registrations.length, 2)
    const footer = registrations.find((r) => r.options.name === 'sidebar.footer.action')
    const card = registrations.find((r) => r.options.name === 'plugins.bundle.config')
    assert.equal(footer.options.id, 'dsh-warm-stats', 'footer options carry a stable id')
    assert.equal(card.options.key, 'dsh-warm', 'bundle card is keyed by the package name')
    assert.equal(typeof footer.Component, 'function', 'footer registers a component')
    assert.equal(typeof card.Component, 'function', 'card registers a component')
  } finally {
    delete globalThis.window
  }
}

// --- 47. Superseded ping's settle must not contaminate the next chain -------
// Oracle finding [1]: a ping streaming past its epoch (capture bumped it) has
// no chain left to attribute — its settle must not mark the NEW chain's
// in-flight ping. Unfixed, the old ping's hit value lands on the new ping and
// the new ping's own settle is dropped: saved overcounts.
{
  // Two independently gated streams; the first reports a distinctively wrong
  // token count (9999) so contamination would be visible in `saved`.
  const gatedPairLlm = () => {
    const dispatches = []
    const gates = []
    const llm = {
      stream: async function* (options) {
        const index = dispatches.push(options) - 1
        const gate = { resolve: null }
        const gatePromise = new Promise((r) => { gate.resolve = r })
        gates.push(gate)
        await gatePromise
        const tokens = index === 0 ? 9999 : 1152
        yield { type: 'usage', usage: { inputTokens: 1200, cacheReadTokens: tokens, outputTokens: 1 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    return { llm, dispatches, gates }
  }
  const h = statsHarness({}, gatedPairLlm)
  try {
    h.warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
    h.warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
    const tool = gateTool(h.warmer)
    h.clock.advance(242_000)
    await settle() // ping1 (chain A) dispatched, stream held at gate[0]
    assert.equal(h.stats.snapshot().allTime.warms, 1)
    // Follow-up request: bumps the epoch, closes chain A (ping1 partitions as
    // needless — 300s < 302s), opens chain B, re-arms the anchored schedule.
    h.clock.advance(58_000)
    h.warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
    assert.equal(h.stats.snapshot().allTime.needless, 1, 'chain A closed with ping1 in flight')
    // Chain B dispatches its own ping (gate[1] holds it).
    h.clock.advance(242_000)
    await settle()
    assert.equal(h.stats.snapshot().allTime.warms, 2, 'chain B dispatched its own ping')
    // The superseded ping1 settles FIRST, while ping2 is in flight: its
    // settle must reach the journal (budget honesty) but NOT the stats engine.
    h.llmExtras.gates[0].resolve()
    await settle()
    // ping2 settles with its own outcome — not overwritten, not dropped.
    h.llmExtras.gates[1].resolve()
    await settle()
    // Follow-up closes chain B: ping2 was necessary (402s ≥ TTL) and held
    // (160s < TTL); only ping2's own hit value may be credited.
    h.clock.advance(160_000)
    h.warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
    const agg = h.stats.snapshot().allTime
    assert.equal(agg.warms, 2)
    assert.equal(agg.needless, 1, 'only chain A\'s in-flight ping was needless')
    assert.equal(agg.expired, 0)
    assert.equal(agg.savedCacheTokens, 1152, 'saved credits ping2\'s own hit, never the superseded ping1\'s 9999')
    const modelAgg = agg.models['zai-glm-5-3']
    assert.equal(modelAgg.pingCacheReadTokens.held, 1152, 'held spend is ping2\'s own hit; the superseded 9999 never lands')
    assert.equal(modelAgg.pingCacheReadTokens.needless, 0, 'chain A\'s in-flight ping had no observed usage at close')
    assert.equal(modelAgg.pingUncachedTokens, 1200, 'raw spend counts ping2 only; ping1\'s dropped settle never prices')
    const session = h.stats.snapshot().sessions.s1
    assert.equal(session.warms, 2, 'the session bucket carries only this session\'s chains')
    assert.equal(session.needless, 1)
    assert.equal(session.savedCacheTokens, 1152)
    assert.equal(session.models['zai-glm-5-3'].pingCacheReadTokens.held, 1152)
    assert.equal(h.journal.entries.length, 2, 'both dispatches still journal (budget honesty)')
    assert.ok(h.journal.entries.every((e) => e.counted === true))
    tool.gate.resolve()
    await tool.promise
    h.warmer.dispose()
  } finally {
    cleanupStats(h)
  }
}

// --- 48. Debug trace: full event sequence through the real wiring -----------
// The debug sink (config debug:true) is the live-host diagnosis channel: it
// must observe every warmer event and every stats partition with enough
// context to reconstruct why an outcome bucket did or did not move.
{
  const events = []
  const h = statsHarness({}, undefined, (event) => events.push(event))
  try {
    h.warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
    h.warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
    const tool = gateTool(h.warmer)
    h.clock.advance(242_000)
    await settle()
    h.clock.advance(58_000)
    h.warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
    const ev = (name) => events.filter((e) => e.ev === name)
    assert.ok(ev('llm/stream').length === 2 && ev('llm/stream').every((e) => e.accepted === true && e.sid === 's1'),
      'every conversation request is traced as accepted')
    assert.deepEqual(ev('tools/execute').map((e) => [e.sid, e.outstanding]), [['s1', 1]],
      'tool window opens with outstanding count')
    assert.ok(ev('ping.dispatch').length === 1 && ev('ping.settle').length === 1,
      'ping dispatch and settle are traced')
    const closes = ev('chain.close')
    assert.equal(closes.length, 2, 'one not-found close (first request) + one attributed close (follow-up)')
    const attributed = closes.find((c) => c.pings !== null)
    assert.equal(attributed.sid, 's1')
    assert.equal(attributed.followup, true)
    assert.equal(attributed.pings, 1)
    assert.equal(attributed.outcome.needless, 1, 'close trace carries the attribution')
    assert.equal(attributed.outcome.pingCacheReadTokens.needless, 1152, 'close trace carries per-outcome token sums')
    assert.equal(attributed.outcome.pingUncachedTokens, 1200)
    assert.equal(attributed.gap, 300_000, 'close trace carries the t0-to-follow-up gap the partition judges')
    assert.equal(ev('ping.settle')[0].model, 'zai-glm-5-3', 'settle trace carries the ping model')
    assert.deepEqual(ev('chain.ping')[0].sid, 's1', 'ping membership trace')
    assert.ok(events.every((e) => e.sid === undefined || e.sid === 's1'), 'sids consistent across the trace')
    const agg = h.stats.snapshot().allTime
    assert.equal(agg.needless, 1, 'the traced flow still attributes')
    tool.gate.resolve()
    await tool.promise
    h.warmer.dispose()
  } finally {
    cleanupStats(h)
  }
}

// --- 49. Token ledger end-to-end: per-outcome per-model buckets + payload ----
{
  // Miss first (the provider recomputed the prefix: 5000 uncached tokens),
  // then hits (1200 uncached + 1152 cache-read each).
  const missFirstLlm = () => {
    const dispatches = []
    let call = 0
    const llm = {
      stream: async function* (options) {
        dispatches.push(options)
        const miss = call++ === 0
        yield { type: 'usage', usage: { inputTokens: miss ? 5000 : 1200, cacheReadTokens: miss ? 0 : 1152, outputTokens: 1 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    return { llm, dispatches }
  }
  const h = statsHarness({}, missFirstLlm)
  try {
    const { makeStatsPayload } = await import('../lib/index.js')
    h.warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
    h.warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]() // chain 1: t0=0
    const tool = gateTool(h.warmer)
    h.clock.advance(242_000)
    await settle() // ping1: miss — raw spend, no anchor value
    h.clock.advance(242_000)
    await settle() // ping2: hit
    h.clock.advance(220_000) // 704 s
    h.warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]() // follow-up closes chain 1 (held), opens chain 2
    h.clock.advance(242_000)
    await settle() // ping3: chain 2's own ping
    h.warmer.onAgentStatus({ agent: { id: 's1' }, status: 'idle' }) // chain 2 closes no-followup

    const agg = h.stats.snapshot().allTime
    assert.equal(agg.warms, 3)
    assert.equal(agg.needless, 0)
    assert.equal(agg.noFollowup, 1)
    assert.equal(agg.savedCacheTokens, 0, 'the miss already paid the re-prefill the follow-up would have: the later hit moved the cost, it saved none')
    const model = agg.models['zai-glm-5-3']
    assert.deepEqual(model.pingCacheReadTokens, { held: 1152, needless: 0, noFollowup: 1152, expired: 0 },
      'each ping\'s cache-read cost lands in its own outcome bucket')
    assert.equal(model.pingUncachedTokens, 7400, 'the miss\'s 5000 uncached tokens are the raw-price basis; hit tails add 1200 each')
    assert.equal(model.warms, 3)

    const payload = makeStatsPayload(h.stats, baseConfig)
    assert.equal(payload.schema, 3)
    const wire = payload.stats
    for (const field of ['warms', 'needless', 'noFollowup', 'expired', 'savedCacheTokens']) {
      const sum = Object.values(wire.allTime.models).reduce((n, m) => n + m[field], 0)
      assert.equal(sum, wire.allTime[field], `flat ${field} equals the per-model sum`)
    }
    assert.equal(wire.today.noFollowup, 1)
    assert.deepEqual(wire.failedPingTokens, { cacheRead: 0, uncached: 0 })
    assert.deepEqual(wire.sessions.s1, {
      warms: 3, needless: 0, noFollowup: 1, expired: 0, savedCacheTokens: 0,
      models: {
        'zai-glm-5-3': {
          warms: 3, needless: 0, noFollowup: 1, expired: 0, savedCacheTokens: 0,
          pingCacheReadTokens: { held: 1152, needless: 0, noFollowup: 1152, expired: 0 },
          pingUncachedTokens: 7400,
          failedPingTokens: { cacheRead: 0, uncached: 0 },
        },
      },
    }, 'the session bucket mirrors the session\'s whole warming story, wire-pure')
    tool.gate.resolve()
    await tool.promise
    h.warmer.dispose()
  } finally {
    cleanupStats(h)
  }
}

// --- 50. Legacy stats.json adopt (schema 1 + 2): absent maps zero-seeded ---
{
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-warm-legacy-'))
  try {
    // Exactly what a schema-1 build wrote: count buckets + failed, no models, no failedPingTokens
    // (today is the persist-time mirror of its own byDay entry).
    const legacy = {
      today: { day: '2026-10-19', warms: 2, needless: 0, noFollowup: 1, expired: 0, savedCacheTokens: 1152 },
      allTime: { warms: 5, needless: 1, noFollowup: 2, expired: 1, savedCacheTokens: 4608 },
      byDay: { '2026-10-19': { warms: 2, needless: 0, noFollowup: 1, expired: 0, savedCacheTokens: 1152 } },
      failed: 1,
    }
    writeFileSync(join(tmp, 'stats.json'), JSON.stringify(legacy))
    let nowMs = Date.UTC(2026, 9, 20, 6, 0, 0)
    const warns = []
    const engine = createStatsEngine({ storageDir: tmp, config: baseConfig, now: () => nowMs, warn: (msg) => { warns.push(msg) } })
    let snap = engine.snapshot()
    assert.deepEqual(warns, [], 'a legacy file is a valid shape: adopt, never warn or reseed')
    assert.equal(snap.allTime.warms, 5, 'legacy counters adopt untouched')
    assert.equal(snap.allTime.savedCacheTokens, 4608)
    assert.equal(snap.failed, 1)
    assert.equal(snap.byDay['2026-10-19'].warms, 2, 'stored history rides along')
    assert.equal(snap.today.day, '2026-10-20', 'today starts fresh on the current UTC day')
    assert.equal(snap.today.warms, 0)
    assert.deepEqual(snap.allTime.models, {}, 'absent models maps zero-seed, never stay undefined')
    assert.deepEqual(snap.failedPingTokens, { cacheRead: 0, uncached: 0 })

    // Attribution continues on top of the adopted file.
    engine.onRealRequest('s1', 'mistral')
    nowMs = Date.UTC(2026, 9, 20, 6, 4, 0)
    engine.onPingDispatch('s1', 'm')
    engine.onPingSettle('s1', { ok: true, cacheReadTokens: 1152, uncachedTokens: 1200, model: 'm' })
    nowMs = Date.UTC(2026, 9, 20, 6, 7, 0)
    engine.onRealRequest('s1', 'mistral') // follow-up: necessary, held → saved 1152
    snap = engine.snapshot()
    assert.equal(snap.allTime.warms, 6)
    assert.equal(snap.allTime.savedCacheTokens, 5760)
    assert.deepEqual(snap.allTime.models.m, {
      warms: 1, needless: 0, noFollowup: 0, expired: 0, savedCacheTokens: 1152,
      pingCacheReadTokens: { held: 1152, needless: 0, noFollowup: 0, expired: 0 },
      pingUncachedTokens: 1200,
      failedPingTokens: { cacheRead: 0, uncached: 0 },
    }, 'post-upgrade attribution is per-model')
    assert.equal(snap.today.models.m.warms, 1, 'the fresh day attributes per model too')
    const modelSum = Object.values(snap.allTime.models).reduce((n, m) => n + m.warms, 0)
    assert.equal(snap.allTime.warms - modelSum, 5,
      'the flat-vs-models gap is exactly the pre-upgrade legacy counts (documented divergence, never an overcount)')
    assert.deepEqual(snap.sessions.s1, {
      warms: 1, needless: 0, noFollowup: 0, expired: 0, savedCacheTokens: 1152,
      models: {
        m: {
          warms: 1, needless: 0, noFollowup: 0, expired: 0, savedCacheTokens: 1152,
          pingCacheReadTokens: { held: 1152, needless: 0, noFollowup: 0, expired: 0 },
          pingUncachedTokens: 1200,
          failedPingTokens: { cacheRead: 0, uncached: 0 },
        },
      },
    }, 'per-session attribution counts only post-upgrade work; the legacy flat counts have no session home')
    engine.dispose()

    // Schema-2 adopt — the per-model failed-token maps' own pre-upgrade file:
    // flat failedPingTokens already existed, per-model maps did not. One
    // post-upgrade failed ping then adds to both sides in lockstep while flat
    // stays the complete total, so the flat-vs-sums gap is exactly the
    // pre-upgrade rows — never an overcount (verifier's live proof: 111 + 222).
    const schema2 = {
      today: { day: '2026-10-19', warms: 1, needless: 0, noFollowup: 0, expired: 0, savedCacheTokens: 0, models: {} },
      allTime: {
        warms: 1, needless: 0, noFollowup: 0, expired: 0, savedCacheTokens: 0,
        models: {
          'legacy-model': {
            warms: 1, needless: 0, noFollowup: 0, expired: 0, savedCacheTokens: 0,
            pingCacheReadTokens: { held: 0, needless: 0, noFollowup: 0, expired: 0 },
            pingUncachedTokens: 800,
          },
        },
      },
      byDay: {
        '2026-10-19': {
          warms: 1, needless: 0, noFollowup: 0, expired: 0, savedCacheTokens: 0,
          models: {
            'legacy-model': {
              warms: 1, needless: 0, noFollowup: 0, expired: 0, savedCacheTokens: 0,
              pingCacheReadTokens: { held: 0, needless: 0, noFollowup: 0, expired: 0 },
              pingUncachedTokens: 800,
            },
          },
        },
      },
      failed: 1,
      failedPingTokens: { cacheRead: 111, uncached: 222 },
    }
    writeFileSync(join(tmp, 'stats.json'), JSON.stringify(schema2))
    const engine2 = createStatsEngine({ storageDir: tmp, config: baseConfig, now: () => nowMs, warn: (msg) => { warns.push(msg) } })
    assert.deepEqual(warns, [], 'a schema-2 file is a valid shape too: adopt, never warn or reseed')
    let snap2 = engine2.snapshot()
    assert.deepEqual(snap2.failedPingTokens, { cacheRead: 111, uncached: 222 }, 'schema-2 flat failed tokens adopt as-is')
    assert.deepEqual(snap2.allTime.models['legacy-model'].failedPingTokens, { cacheRead: 0, uncached: 0 }, 'absent per-model failed-token maps zero-seed, never stay undefined')
    nowMs = Date.UTC(2026, 9, 20, 7, 0, 0)
    engine2.onRealRequest('s2', 'mistral')
    nowMs = Date.UTC(2026, 9, 20, 7, 4, 0)
    engine2.onPingDispatch('s2', 'm')
    engine2.onPingSettle('s2', { ok: false, cacheReadTokens: 999, uncachedTokens: 700, model: 'm' })
    nowMs = Date.UTC(2026, 9, 20, 7, 7, 0)
    engine2.onRealRequest('s2', 'mistral') // follow-up closes the chain: the failed ping prices at close
    snap2 = engine2.snapshot()
    assert.equal(snap2.failed, 2, 'the failed count continues on top of the adopted total')
    assert.equal(snap2.allTime.warms, 2, 'dispatch counts the new ping on top of the adopted warms')
    assert.deepEqual(snap2.failedPingTokens, { cacheRead: 1110, uncached: 922 }, 'flat keeps the legacy rows and adds the increment')
    assert.deepEqual(snap2.allTime.models.m.failedPingTokens, { cacheRead: 999, uncached: 700 }, 'the new failed ping attributes per model')
    const flatTotal = snap2.failedPingTokens.cacheRead + snap2.failedPingTokens.uncached
    const perModelTotal = Object.values(snap2.allTime.models).reduce((n, m) => n + m.failedPingTokens.cacheRead + m.failedPingTokens.uncached, 0)
    assert.equal(flatTotal - perModelTotal, 333, 'the flat-vs-per-model gap is exactly the pre-upgrade rows (111 + 222)')
    engine2.dispose()
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// --- 51. Per-session ledger: parallel sessions + bounded map ------------------
{
  // Part A: two sessions through one warmer — buckets never cross.
  {
    const h = statsHarness()
    try {
      h.warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
      h.warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]() // s1 chain 1: t0=0
      const tool1 = gateTool(h.warmer)
      h.clock.advance(242_000)
      await settle() // s1 ping1: hit
      tool1.gate.resolve()
      await tool1.promise
      h.clock.advance(160_000) // t=402
      h.warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]() // s1 follow-up: chain 1 closes saved, chain 2 opens (no tool pending: no timer)
      h.warmer.onAgentStatus({ agent: { id: 's2' }, status: 'running' })
      const req2 = { ...conversationRequest, sessionId: 's2' }
      h.warmer.onLlmStream(req2, () => [])[Symbol.iterator]() // s2 chain: t0=402
      const tool2 = gateTool(h.warmer, 's2')
      h.clock.advance(242_000)
      await settle() // s2 ping: hit
      h.warmer.onAgentStatus({ agent: { id: 's2' }, status: 'idle' }) // s2 closes no-followup

      const snap = h.stats.snapshot()
      assert.equal(snap.allTime.warms, 2, 'global totals mirror both sessions')
      assert.equal(snap.allTime.savedCacheTokens, 1152)
      assert.equal(snap.allTime.noFollowup, 1)
      assert.deepEqual(snap.sessions.s1, {
        warms: 1, needless: 0, noFollowup: 0, expired: 0, savedCacheTokens: 1152,
        models: {
          'zai-glm-5-3': {
            warms: 1, needless: 0, noFollowup: 0, expired: 0, savedCacheTokens: 1152,
            pingCacheReadTokens: { held: 1152, needless: 0, noFollowup: 0, expired: 0 },
            pingUncachedTokens: 1200,
            failedPingTokens: { cacheRead: 0, uncached: 0 },
          },
        },
      }, 's1: only its own chain, saved on the held follow-up')
      assert.deepEqual(snap.sessions.s2, {
        warms: 1, needless: 0, noFollowup: 1, expired: 0, savedCacheTokens: 0,
        models: {
          'zai-glm-5-3': {
            warms: 1, needless: 0, noFollowup: 1, expired: 0, savedCacheTokens: 0,
            pingCacheReadTokens: { held: 0, needless: 0, noFollowup: 1152, expired: 0 },
            pingUncachedTokens: 1200,
            failedPingTokens: { cacheRead: 0, uncached: 0 },
          },
        },
      }, 's2: idle close, nothing credited, no leak from s1')
      tool2.gate.resolve()
      await tool2.promise
      h.warmer.dispose()
    } finally {
      cleanupStats(h)
    }
  }

  // Part B: the ledger is bounded — 60 fake sessions, only the 50
  // most-recently-active buckets survive; global numbers keep everything.
  {
    const tmp = mkdtempSync(join(tmpdir(), 'dsh-warm-prune-'))
    try {
      let nowMs = Date.UTC(2026, 9, 20, 8, 0, 0)
      const engine = createStatsEngine({ storageDir: tmp, config: baseConfig, now: () => nowMs, warn: () => {} })
      for (let i = 0; i < 60; i++) {
        const sid = `s${i}`
        engine.onRealRequest(sid, 'mistral')
        nowMs += 1000
        engine.onPingDispatch(sid)
        nowMs += 1000
        engine.onRealRequest(sid, 'mistral') // follow-up closes the chain (needless; irrelevant here)
      }
      const snap = engine.snapshot()
      assert.equal(Object.keys(snap.sessions).length, 50, 'the session ledger is bounded at 50')
      assert.ok(snap.sessions.s59 !== undefined, 'the most-recent session survives')
      assert.ok(snap.sessions.s10 !== undefined, 'the 50th most-recent session survives')
      assert.ok(snap.sessions.s9 === undefined, 'older session buckets prune at persist')
      assert.equal(snap.allTime.warms, 60, 'pruned sessions keep their global numbers')
      engine.dispose()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }
}

// --- 52. Dense margin, long window: the live bug — every ping held --------------
// Live case (debug.jsonl, mistral margin 60s, TTL 302s): a 368s block whose
// per-ping marginal rule marked every ping needless (neighbors 120s apart),
// so savedCacheTokens never credited. Chain-level necessity fixes the class.
// marginMs 242000 pins the anchored spacing at 302-242 = 60s, so this stays
// a pure stats-partition proof: the cadence matches the old interval grid.
{
  const denseConfig = { providers: { mistral: { ...baseConfig.providers.mistral, intervalMs: 60_000, marginMs: 242_000 } } }
  const h = statsHarness(denseConfig)
  try {
    h.warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
    h.warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]() // chain: t0=0
    const tool = gateTool(h.warmer)
    for (let i = 0; i < 3; i++) {
      h.clock.advance(60_000)
      await settle() // pings at +60/+120/+180, each hit
    }
    tool.gate.resolve()
    await tool.promise
    h.clock.advance(188_000) // follow-up at +368: past t0+302, within 302 of the last ping
    h.warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()

    const agg = h.stats.snapshot().allTime
    assert.equal(agg.warms, 3)
    assert.equal(agg.needless, 0, 'chain-level necessity: the margin bridged 368s, no ping is expendable')
    assert.equal(agg.expired, 0)
    assert.equal(agg.savedCacheTokens, 1152, 'the follow-up verifiably needed the pings: the last hit is credited')
    assert.equal(agg.models['zai-glm-5-3'].pingCacheReadTokens.held, 3456, 'all three pings\' cache-read cost lands in held')
    assert.equal(agg.models['zai-glm-5-3'].pingUncachedTokens, 3600)
    const session = h.stats.snapshot().sessions.s1
    assert.equal(session.warms, 3, 'the session bucket carries the whole dense-grid story')
    assert.equal(session.savedCacheTokens, 1152)
    assert.equal(session.models['zai-glm-5-3'].pingCacheReadTokens.held, 3456)
    h.warmer.dispose()
  } finally {
    cleanupStats(h)
  }
}

// --- 53. Dense margin, short window: follow-up beats t0 + ttl → all needless --
{
  const denseConfig = { providers: { mistral: { ...baseConfig.providers.mistral, intervalMs: 60_000, marginMs: 242_000 } } }
  const h = statsHarness(denseConfig)
  try {
    h.warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
    h.warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]() // t0=0
    const tool = gateTool(h.warmer)
    h.clock.advance(60_000)
    await settle()
    h.clock.advance(60_000)
    await settle() // pings at +60/+120
    tool.gate.resolve()
    await tool.promise
    h.clock.advance(60_000) // follow-up at +180 < t0+302: the t0 cache alone survives
    h.warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
    const agg = h.stats.snapshot().allTime
    assert.equal(agg.warms, 2)
    assert.equal(agg.needless, 2, 'warm-anyway at chain level, even though each ping\'s neighbor is only 60s away')
    assert.equal(agg.expired, 0)
    assert.equal(agg.savedCacheTokens, 0, 'no ping bought anything: the real request kept the prefix warm')
    assert.equal(agg.models['zai-glm-5-3'].pingCacheReadTokens.needless, 2304)
    assert.equal(agg.models['zai-glm-5-3'].pingCacheReadTokens.held, 0)
    h.warmer.dispose()
  } finally {
    cleanupStats(h)
  }
}

// --- 54. Necessary chain whose cover lapsed: expired, not saved --------------
{
  const denseConfig = { providers: { mistral: { ...baseConfig.providers.mistral, intervalMs: 60_000, marginMs: 242_000 } } }
  const h = statsHarness(denseConfig)
  try {
    h.warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
    h.warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]() // t0=0
    const tool = gateTool(h.warmer)
    h.clock.advance(60_000)
    await settle()
    h.clock.advance(60_000)
    await settle() // pings at +60/+120, both hit
    tool.gate.resolve()
    await tool.promise
    h.clock.advance(380_000) // follow-up at +500: necessary (500 >= 302) but 380s after the last ping
    h.warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
    const agg = h.stats.snapshot().allTime
    assert.equal(agg.warms, 2)
    assert.equal(agg.needless, 0)
    assert.equal(agg.expired, 2, 'the follow-up needed warming, but even the last ping\'s TTL had lapsed')
    assert.equal(agg.savedCacheTokens, 0)
    assert.equal(agg.models['zai-glm-5-3'].pingCacheReadTokens.expired, 2304)
    h.warmer.dispose()
  } finally {
    cleanupStats(h)
  }
}

// --- 55. Anchored schedule: due at ttl - margin, not on the interval grid -----
{
  const { warmer, clock, dispatches, journal } = makeWarmer()
  warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
  warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
  const gate = { resolve: null }
  const gatePromise = new Promise((r) => { gate.resolve = r })
  const toolPromise = warmer.onToolsExecute({ agent: { id: 's1' }, name: 'bash' }, async () => { await gatePromise; return 'ok' })
  clock.advance(241_000)
  await settle()
  assert.equal(dispatches.length, 0, '241s: one second before the anchored due nothing fires (the 240s grid slot is dead)')
  clock.advance(1_000)
  await settle()
  assert.equal(dispatches.length, 1, 'ping fires at ttl - margin after the capture')
  assert.equal(Date.parse(journal.entries[0].ts), 242_000, 'dispatch ts is the anchored due 302-60, not the grid\'s 240')
  clock.advance(242_000)
  await settle()
  assert.equal(dispatches.length, 2)
  assert.equal(Date.parse(journal.entries[1].ts), 484_000, 'the hit moved the base: 242 + 242, not the grid\'s 482')
  clock.advance(215_000)
  await settle()
  assert.equal(dispatches.length, 2, '699s is still short of the third due at 726s')
  gate.resolve()
  await toolPromise
  assert.equal(dispatches.length, 2, 'no ping after the tool settles')
  assert.equal(clock.pendingCount(), 0, 'timer cleaned up')
  warmer.dispose()
}

// --- 56. Anchored schedule ignores the interval grid when ttlMs is set -------
{
  const { warmer, clock, dispatches, journal } = makeWarmer({ providers: { mistral: { intervalMs: 120_000, ttlMs: 302_000, marginMs: 60_000 } } })
  warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
  warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
  const gate = { resolve: null }
  const gatePromise = new Promise((r) => { gate.resolve = r })
  const toolPromise = warmer.onToolsExecute({ agent: { id: 's1' }, name: 'bash' }, async () => { await gatePromise; return 'ok' })
  clock.advance(121_000)
  await settle()
  assert.equal(dispatches.length, 0, '121s: the 120s grid slot passes unused (the old grid would have fired here)')
  clock.advance(121_000)
  await settle()
  assert.equal(dispatches.length, 1, 'the only dispatch lands on the anchored due')
  assert.equal(Date.parse(journal.entries[0].ts), 242_000)
  gate.resolve()
  await toolPromise
  warmer.dispose()
}

// --- 57. Failed pings retry on the margin-half backoff, capped by maxPings ----
{
  const { warmer, clock, dispatches, journal } = makeWarmer()
  const failingLlm = {
    stream: async function* () {
      throw new Error('provider 503')
    },
  }
  const warmer2 = createWarmer({
    llm: failingLlm,
    config: { ...baseConfig },
    journal,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    signal: () => ({ timeoutMs: 90_000 }),
    warn: () => {},
  })
  warmer2.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
  warmer2.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
  const gate = { resolve: null }
  const gatePromise = new Promise((r) => { gate.resolve = r })
  const toolPromise = warmer2.onToolsExecute({ agent: { id: 's1' }, name: 'bash' }, async () => { await gatePromise; return 'ok' })
  clock.advance(242_000)
  await settle()
  assert.equal(journal.entries.length, 1, 'attempt 1 fails at the anchored due')
  assert.equal(journal.entries[0].ok, false)
  assert.equal(journal.entries[0].counted, true, 'every retry attempt is a real dispatch: budget honesty')
  clock.advance(29_000)
  await settle()
  assert.equal(journal.entries.length, 2, 'the failure re-armed at the past due: the retry fires on the next tick')
  for (let i = 0; i < 3; i++) {
    clock.advance(30_000)
    await settle()
  }
  assert.equal(journal.entries.length, 5, 'margin-half backoff cadence up to maxPings')
  for (let i = 2; i < 5; i++) {
    assert.equal(Date.parse(journal.entries[i].ts) - Date.parse(journal.entries[i - 1].ts), 30_000, 'retry backoff is floor(margin/2) = 30s, never a tight loop')
  }
  clock.advance(600_000)
  await settle()
  assert.equal(journal.entries.length, 5, 'maxPings caps the retry chain (the budget is untouched)')
  gate.resolve()
  await toolPromise
  warmer2.dispose()
}

// --- 58. A successful retry moves the base; the failed attempt does not -----
{
  const { warmer, clock, dispatches, journal } = makeWarmer()
  let call = 0
  const flakyLlm = {
    stream: async function* () {
      if (call++ === 0) {
        throw new Error('provider 503')
      }
      yield { type: 'usage', usage: { inputTokens: 1200, cacheReadTokens: 1152, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const warmer2 = createWarmer({
    llm: flakyLlm,
    config: { ...baseConfig },
    journal,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    signal: () => ({ timeoutMs: 90_000 }),
    warn: () => {},
  })
  warmer2.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
  warmer2.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
  const gate = { resolve: null }
  const gatePromise = new Promise((r) => { gate.resolve = r })
  const toolPromise = warmer2.onToolsExecute({ agent: { id: 's1' }, name: 'bash' }, async () => { await gatePromise; return 'ok' })
  clock.advance(242_000)
  await settle()
  assert.equal(journal.entries.length, 1)
  assert.equal(journal.entries[0].ok, false, 'attempt 1 fails; it proves no warmth')
  clock.advance(30_000)
  await settle()
  assert.equal(journal.entries.length, 2)
  assert.equal(journal.entries[1].ok, true, 'the retry succeeds at 272s: its dispatch ts becomes the base')
  clock.advance(241_000)
  await settle()
  assert.equal(journal.entries.length, 2, '513s: one second before 272 + 242 nothing fires')
  clock.advance(1_000)
  await settle()
  assert.equal(journal.entries.length, 3)
  assert.equal(Date.parse(journal.entries[2].ts), 514_000, 'the next ping anchors on the successful retry, not the failed one')
  gate.resolve()
  await toolPromise
  warmer2.dispose()
}

// --- 59. No ttlMs: the legacy interval grid still schedules ------------------
{
  const { warmer, clock, dispatches, journal } = makeWarmer({ providers: { mistral: { intervalMs: 240_000, marginMs: 60_000 } } })
  warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
  warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
  const gate = { resolve: null }
  const gatePromise = new Promise((r) => { gate.resolve = r })
  const toolPromise = warmer.onToolsExecute({ agent: { id: 's1' }, name: 'bash' }, async () => { await gatePromise; return 'ok' })
  clock.advance(240_000)
  await settle()
  assert.equal(dispatches.length, 1, 'without a measured TTL the interval grid still fires at 240s')
  clock.advance(240_000)
  await settle()
  assert.equal(dispatches.length, 2)
  assert.equal(Date.parse(journal.entries[1].ts), 480_000, 'the grid counts slots off the capture, hits or not')
  gate.resolve()
  await toolPromise
  warmer.dispose()
}

// --- 60. Config: marginMs validation and the ttl/margin pairing check -------
{
  const { loadConfig } = await import('../lib/config.js')
  const { mkdirSync } = await import('node:fs')
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-warm-margincfg-'))
  const warnings = []
  const warn = (m) => warnings.push(m)
  try {
    // Invalid marginMs: warn + fall back to the default.
    mkdirSync(join(tmp, 'a'), { recursive: true })
    writeFileSync(join(tmp, 'a', 'config.json'), JSON.stringify({ providers: { flaky: { intervalMs: 240_000, marginMs: 'soon' } } }))
    const cfgA = loadConfig(join(tmp, 'a'), warn)
    assert.deepEqual(cfgA.providers.flaky, { intervalMs: 240_000, marginMs: 60_000 }, 'non-numeric marginMs falls back to 60000')
    assert.ok(warnings.some((m) => m.includes('marginMs invalid')), 'invalid marginMs warns')

    warnings.length = 0
    mkdirSync(join(tmp, 'b'), { recursive: true })
    writeFileSync(join(tmp, 'b', 'config.json'), JSON.stringify({ providers: { flaky: { intervalMs: 240_000, marginMs: 0 } } }))
    const cfgB = loadConfig(join(tmp, 'b'), warn)
    assert.equal(cfgB.providers.flaky.marginMs, 60_000, 'zero marginMs falls back to 60000')
    assert.ok(warnings.some((m) => m.includes('marginMs invalid')))

    // A margin that eats the whole TTL: anchored scheduling impossible — drop ttlMs.
    warnings.length = 0
    mkdirSync(join(tmp, 'c'), { recursive: true })
    writeFileSync(join(tmp, 'c', 'config.json'), JSON.stringify({ providers: { mistral: { intervalMs: 240_000, ttlMs: 302_000, marginMs: 350_000 } } }))
    const cfgC = loadConfig(join(tmp, 'c'), warn)
    assert.equal(cfgC.providers.mistral.ttlMs, undefined, 'marginMs >= ttlMs drops ttlMs: the interval grid takes over')
    assert.equal(cfgC.providers.mistral.marginMs, 350_000, 'marginMs itself is kept (harmless in grid mode)')
    assert.equal(cfgC.providers.mistral.intervalMs, 240_000)
    assert.ok(warnings.some((m) => m.includes('marginMs=350000') && m.includes('dropping ttlMs')), 'the pairing failure warns loudly')

    // Fresh default round-trip carries marginMs.
    const cfgD = loadConfig(join(tmp, 'd'), warn)
    assert.equal(cfgD.providers.mistral.marginMs, 60_000)
    const raw = JSON.parse(readFileSync(join(tmp, 'd', 'config.json'), 'utf8'))
    assert.equal(raw.providers.mistral.marginMs, 60_000, 'fresh config.json carries marginMs')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// --- 61. Budget caps the anchored schedule too --------------------------------
{
  const { warmer, clock, dispatches, journal } = makeWarmer({ dailyPingBudget: 2 })
  warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
  warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
  const gate = { resolve: null }
  const gatePromise = new Promise((r) => { gate.resolve = r })
  const toolPromise = warmer.onToolsExecute({ agent: { id: 's1' }, name: 'bash' }, async () => { await gatePromise; return 'ok' })
  clock.advance(241_000)
  await settle()
  assert.equal(dispatches.length, 0, '241s: nothing before the anchored due')
  clock.advance(1_000)
  await settle()
  assert.equal(dispatches.length, 1, 'ping 1 at the anchored due')
  clock.advance(242_000)
  await settle()
  assert.equal(dispatches.length, 2, 'ping 2 on the moved base')
  clock.advance(600_000)
  await settle()
  assert.equal(dispatches.length, 2, 'the budget gate stops the re-arm; maxPings 5 is never reached')
  assert.equal(journal.entries.length, 2)
  assert.ok(journal.entries.every((e) => e.counted === true))
  gate.resolve()
  await toolPromise
  warmer.dispose()
}

// --- 62. A superseded ping's success must not move the new epoch's base ------
{
  // Same gated-pair llm as scenario 47: the first stream reports a distinctively
  // wrong 9999 cache-read so a stolen base would show up in the dispatch ts.
  const gatedPairLlm = () => {
    const dispatches = []
    const gates = []
    const llm = {
      stream: async function* (options) {
        const index = dispatches.push(options) - 1
        const gate = { resolve: null }
        const gatePromise = new Promise((r) => { gate.resolve = r })
        gates.push(gate)
        await gatePromise
        const tokens = index === 0 ? 9999 : 1152
        yield { type: 'usage', usage: { inputTokens: 1200, cacheReadTokens: tokens, outputTokens: 1 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    return { llm, dispatches, gates }
  }
  const h = statsHarness({}, gatedPairLlm)
  try {
    h.warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
    h.warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
    const tool = gateTool(h.warmer)
    h.clock.advance(242_000)
    await settle() // ping1 (epoch 1) in flight at gate[0]
    h.clock.advance(8_000) // t=250: a new request supersedes epoch 1 (base 250, due 492)
    h.warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
    assert.equal(h.stats.snapshot().allTime.needless, 1, 'chain A closed with its ping in flight (250s < 302s)')
    h.llmExtras.gates[0].resolve() // the superseded ping settles OK: must not move the base
    await settle()
    // Hardening: a superseded settle that (buggy) wrote refreshBase would leave
    // the base at 242 while the capture at 250 set it to 250. The pending timer
    // masks the leak until it fires, so end the tool (cancels the timer) and
    // re-open it — the fresh arm must compute off the capture at 250 (due 492),
    // not the superseded ping at 242 (due 484).
    tool.gate.resolve()
    await tool.promise
    const tool2 = gateTool(h.warmer)
    h.clock.advance(234_000) // t=484: the leaked base would already have dispatched
    await settle()
    assert.equal(h.dispatches.length, 1, 'no dispatch at 484s: the re-open armed from the capture at 250, not the superseded ping at 242')
    h.clock.advance(8_000) // t=492: chain B's own ping
    await settle()
    h.llmExtras.gates[1].resolve()
    await settle()
    assert.equal(h.journal.entries.length, 2, 'both dispatches journal (budget honesty)')
    assert.ok(h.journal.entries.every((e) => e.counted === true))
    const agg = h.stats.snapshot().allTime
    assert.equal(agg.warms, 2)
    assert.equal(agg.savedCacheTokens, 0, 'chain B never closed: the superseded 9999-token hit is never credited')
    // Chain B's ping settled at its dispatch ts 492: the re-armed due must be
    // 492 + 242 = 734. The leaked base (242) would have dispatched at 484,
    // settled, and re-armed at 726 — inside this window.
    h.clock.advance(241_000) // t=733: one second before the re-armed due
    await settle()
    assert.equal(h.dispatches.length, 2, 'no dispatch at 733s: the base moved to the dispatch ts 492, not the leaked 242')
    h.clock.advance(1_000) // t=734: the next anchored ping
    await settle()
    assert.equal(h.dispatches.length, 3)
    tool2.gate.resolve()
    await tool2.promise
    h.warmer.dispose()
  } finally {
    cleanupStats(h)
  }
}

// --- 63. dryRun previews the anchored cadence, never the clamp loop ------------
{
  const { warmer, clock, dispatches, journal } = makeWarmer({ dryRun: true })
  warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
  warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
  const gate = { resolve: null }
  const gatePromise = new Promise((r) => { gate.resolve = r })
  const toolPromise = warmer.onToolsExecute({ agent: { id: 's1' }, name: 'bash' }, async () => { await gatePromise; return 'ok' })
  clock.advance(242_000)
  await settle()
  assert.equal(dispatches.length, 0, 'dry-run never dispatches')
  assert.equal(journal.entries.length, 1)
  assert.equal(journal.entries[0].dryRun, true)
  assert.equal(journal.entries[0].counted, false)
  clock.advance(238_000)
  await settle()
  assert.equal(journal.entries.length, 1, '480s: the old 240-grid dry slot passes unused')
  clock.advance(4_000)
  await settle()
  assert.equal(journal.entries.length, 2, 'dry pings move the base: the preview shows the real cadence')
  assert.equal(Date.parse(journal.entries[1].ts) - Date.parse(journal.entries[0].ts), 242_000, 'without the base move the past due would clamp to 30s repeats')
  gate.resolve()
  await toolPromise
  warmer.dispose()
}

// --- 64. Config: empty {} entry adopts the built-in rule and really warms ---
{
  const { loadConfig } = await import('../lib/config.js')
  const { makeStatsPayload } = await import('../lib/index.js')
  const { mkdirSync } = await import('node:fs')
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-warm-emptycfg-'))
  const warnings = []
  const warn = (m) => warnings.push(m)
  try {
    mkdirSync(join(tmp, 'a'), { recursive: true })
    writeFileSync(join(tmp, 'a', 'config.json'), JSON.stringify({ providers: { mistral: {} } }))
    const cfg = loadConfig(join(tmp, 'a'), warn)
    assert.deepEqual(cfg.providers.mistral, { intervalMs: 240_000, ttlMs: 302_000, marginMs: 60_000 },
      'an empty entry for a known provider adopts the built-in rule instead of dropping it')
    assert.equal(warnings.filter((m) => m.includes('entry empty — adopting built-in scheduling')).length, 1,
      'adoption warns exactly once')
    assert.ok(!warnings.some((m) => m.includes('entry dropped') || m.includes('providers table is empty')),
      'the named provider is neither dropped nor the table declared empty')

    // The adopted rule is live: a tool window dispatches on the anchored grid.
    const { warmer, clock, dispatches } = makeWarmer({ providers: cfg.providers })
    warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
    warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
    const gate = { resolve: null }
    const gatePromise = new Promise((r) => { gate.resolve = r })
    const toolPromise = warmer.onToolsExecute({ agent: { id: 's1' }, name: 'bash' }, async () => { await gatePromise; return 'ok' })
    clock.advance(241_000)
    await settle()
    assert.equal(dispatches.length, 0, 'nothing before the adopted anchored due')
    clock.advance(1_000)
    await settle()
    assert.equal(dispatches.length, 1, 'the adopted defaults dispatch on the anchored schedule')
    gate.resolve()
    await toolPromise
    warmer.dispose()

    // The wire payload echoes the values actually in force, not the empty entry.
    const payload = makeStatsPayload(null, cfg)
    assert.deepEqual(payload.config.providers.mistral, { intervalMs: 240_000, ttlMs: 302_000, marginMs: 60_000 },
      'the stats route echoes the adopted rule (marginMs: the rule is anchored)')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// --- 65. Config: ttlMs-only entry is kept; the grid slot defaults -------------
{
  const { loadConfig } = await import('../lib/config.js')
  const { mkdirSync } = await import('node:fs')
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-warm-ttlonly-'))
  const warnings = []
  const warn = (m) => warnings.push(m)
  try {
    mkdirSync(join(tmp, 'a'), { recursive: true })
    writeFileSync(join(tmp, 'a', 'config.json'), JSON.stringify({ providers: { mistral: { ttlMs: 302_000 } } }))
    const cfg = loadConfig(join(tmp, 'a'), warn)
    assert.deepEqual(cfg.providers.mistral, { intervalMs: 240_000, ttlMs: 302_000, marginMs: 60_000 },
      'ttlMs alone is a complete anchored rule; only the fallback grid reads intervalMs')
    assert.ok(warnings.some((m) => m.includes('intervalMs missing — defaulted to 240000')),
      'the defaulted grid slot warns once')
    assert.ok(!warnings.some((m) => m.includes('entry dropped')), 'the entry is never dropped')

    const { warmer, clock, dispatches } = makeWarmer({ providers: cfg.providers })
    warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
    warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
    const gate = { resolve: null }
    const gatePromise = new Promise((r) => { gate.resolve = r })
    const toolPromise = warmer.onToolsExecute({ agent: { id: 's1' }, name: 'bash' }, async () => { await gatePromise; return 'ok' })
    clock.advance(241_000)
    await settle()
    assert.equal(dispatches.length, 0, 'nothing before the anchored due')
    clock.advance(1_000)
    await settle()
    assert.equal(dispatches.length, 1, 'anchored dispatch on the kept ttlMs')
    gate.resolve()
    await toolPromise
    warmer.dispose()
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// --- 66. Config: unknown provider with an empty entry still drops -------------
{
  const { loadConfig } = await import('../lib/config.js')
  const { mkdirSync } = await import('node:fs')
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-warm-unknown-'))
  const warnings = []
  const warn = (m) => warnings.push(m)
  try {
    mkdirSync(join(tmp, 'a'), { recursive: true })
    writeFileSync(join(tmp, 'a', 'config.json'), JSON.stringify({ providers: { 'opencode-go': {} } }))
    const cfg = loadConfig(join(tmp, 'a'), warn)
    assert.deepEqual(cfg.providers, {}, 'no built-in rule to adopt: the unknown name drops')
    assert.ok(warnings.some((m) => m.includes('providers["opencode-go"]') && m.includes('intervalMs invalid')),
      'the drop warns loudly')
    assert.ok(warnings.some((m) => m.includes('providers table is empty')), 'the empty table says so')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// --- 67. Trace: a non-warmable capture drops loudly, never accepted-then-silence
{
  const events = []
  const h = statsHarness({ providers: {} }, undefined, (event) => events.push(event))
  try {
    h.warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
    h.warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
    const streamLine = events.find((e) => e.ev === 'llm/stream')
    assert.equal(streamLine.accepted, false,
      'a capture whose provider is outside the warmed table is not accepted on the trace')
    const drops = events.filter((e) => e.ev === 'drop')
    assert.equal(drops.length, 1, 'exactly one drop event follows the capture')
    assert.equal(drops[0].reason, 'provider-not-in-table')
    assert.equal(drops[0].provider, 'mistral')
    assert.equal(drops[0].model, 'zai-glm-5-3')
    const tool = gateTool(h.warmer)
    h.clock.advance(600_000)
    await settle()
    assert.equal(h.dispatches.length, 0, 'nothing ever dispatches for a provider outside the table')
    assert.equal(h.journal.entries.length, 0, 'and nothing journals')
    assert.equal(h.clock.pendingCount(), 0, 'no timer was ever armed')
    tool.gate.resolve()
    await tool.promise
    h.warmer.dispose()
  } finally {
    cleanupStats(h)
  }
}

// --- 68. Debug trace rolls instead of growing without bound ------------------
// Live finding: a debug:true host grew debug.jsonl to 43 MB in nine days (the
// journal rolls at 5 MB; the trace had no bound at all).
{
  const { makeDebugSink } = await import('../lib/index.js')
  const { statSync } = await import('node:fs')
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-warm-debug-'))
  try {
    const path = join(tmp, 'debug.jsonl')
    writeFileSync(path, 'x'.repeat(5000) + '\n') // a pre-existing oversized trace from an earlier boot
    const sink = makeDebugSink(path, { rollBytes: 4096 })
    sink({ ev: 'first' })
    assert.ok(existsSync(`${path}.1`), 'an oversized trace found at boot rolls on the first event')
    assert.ok(readFileSync(`${path}.1`, 'utf8').startsWith('xxx'), 'the old trace is kept as .1')
    assert.equal(JSON.parse(readFileSync(path, 'utf8').trim()).ev, 'first', 'the live trace restarts with the new event')
    for (let i = 0; i < 200; i++) sink({ ev: 'fill', pad: 'p'.repeat(100) })
    assert.ok(statSync(path).size <= 4096 + 512, 'the live trace stays near the roll threshold')
    assert.ok(statSync(`${path}.1`).size <= 4096 + 512, 'the rolled trace replaced the boot-time one: at most two files, both bounded')
    sink({ ev: 'tail' })
    const lines = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(lines.at(-1).ev, 'tail')
    assert.equal(typeof lines.at(-1).ts, 'string', 'every line keeps its ts stamp')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// --- 69. Journal: a ping settling after close() lands without leaking an fd ---
// Teardown closes the journal while a ping may still be in flight; its settle
// journals afterwards (budget honesty). It used to reopen a handle nobody ever
// closed — one leaked fd per hot-reload with a ping in flight.
{
  const { openJournal } = await import('../lib/journal.js')
  const { readdirSync } = await import('node:fs')
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-warm-close-'))
  const fdCount = () => (existsSync('/proc/self/fd') ? readdirSync('/proc/self/fd').length : null)
  try {
    const nowMs = Date.UTC(2026, 9, 29, 12, 0, 0)
    const journal = openJournal(tmp, { now: () => nowMs })
    journal.record({ counted: true, n: 1 })
    journal.close()
    const before = fdCount()
    journal.record({ counted: true, n: 2 })
    journal.record({ counted: true, n: 3 })
    if (before !== null) assert.equal(fdCount(), before, 'records after close() hold no file descriptor open')
    const lines = readFileSync(join(tmp, 'warm.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.deepEqual(lines.map((l) => l.n), [1, 2, 3], 'late settles still land in the journal')
    assert.equal(journal.pingsToday(), 3, 'and still count against the budget')
    journal.close()
    const reopened = openJournal(tmp, { now: () => nowMs })
    assert.equal(reopened.pingsToday(), 3, 'the next boot counts the late lines')
    reopened.close()
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// --- 70. Tool opening past the due fires now, not one margin-half later ------
// The response can stream past refreshBase + ttl - margin before the tool
// starts. The margin-half backoff is for retries after an attempt; on the
// first arm it spent 30 s of a 60 s margin and could land the ping past the
// TTL floor.
{
  const { warmer, clock, dispatches } = makeWarmer()
  warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
  warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
  clock.advance(280_000) // the response streamed for 280 s; due was 242 s
  const gate = { resolve: null }
  const toolPromise = warmer.onToolsExecute({ agent: { id: 's1' }, name: 'bash' }, async () => { await new Promise((r) => { gate.resolve = r }); return 'ok' })
  clock.advance(1_000)
  await settle()
  assert.equal(dispatches.length, 1, 'a late tool start pings within a second, still inside the 302 s floor')
  // The successful ping moved the base to 281 s: the next one is anchored again.
  clock.advance(241_000)
  await settle()
  assert.equal(dispatches.length, 1)
  clock.advance(1_000)
  await settle()
  assert.equal(dispatches.length, 2, 'the cadence re-anchors on the ping: 281 + 242 s')
  gate.resolve()
  await toolPromise
  warmer.dispose()
}

// --- 71. Idle releases the capture: no ping source before the next one ------
// The next turn always opens with a fresh capture; a tool that runs first
// (running again, no llm/stream yet) must not ping the previous turn's request.
{
  const { warmer, clock, dispatches } = makeWarmer()
  warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
  warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
  warmer.onAgentStatus({ agent: { id: 's1' }, status: 'idle' })
  clock.advance(60_000)
  warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
  const gate = { resolve: null }
  const toolPromise = warmer.onToolsExecute({ agent: { id: 's1' }, name: 'bash' }, async () => { await new Promise((r) => { gate.resolve = r }); return 'ok' })
  clock.advance(600_000)
  await settle()
  assert.equal(dispatches.length, 0, 'the previous turn\'s request is never replayed')
  assert.equal(clock.pendingCount(), 0, 'nothing armed without a capture')
  // A fresh capture inside the still-open block re-arms normally.
  warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
  clock.advance(242_000)
  await settle()
  assert.equal(dispatches.length, 1, 'the new capture warms as usual')
  gate.resolve()
  await toolPromise
  warmer.dispose()
}

// --- 72. Non-warmable capture supersedes a warmable one, holds nothing -------
{
  const { warmer, clock, dispatches } = makeWarmer()
  warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
  warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
  const other = Object.freeze({ ...conversationRequest, provider: 'opencode-go', model: 'deepseek-v4.1-flash' })
  warmer.onLlmStream(other, () => [])[Symbol.iterator]()
  const gate = { resolve: null }
  const toolPromise = warmer.onToolsExecute({ agent: { id: 's1' }, name: 'bash' }, async () => { await new Promise((r) => { gate.resolve = r }); return 'ok' })
  clock.advance(600_000)
  await settle()
  assert.equal(dispatches.length, 0, 'the earlier mistral request is not replayed after the session moved off the table')
  gate.resolve()
  await toolPromise
  warmer.dispose()
}

// --- 73. stats.json temp is per-process: a sibling host's temp is untouched ---
{
  const h = statsHarness()
  try {
    const foreign = join(h.tmp, 'stats.json.tmp')
    writeFileSync(foreign, '{"half-written": ')
    h.warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
    h.warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
    const tool = gateTool(h.warmer)
    h.clock.advance(242_000)
    await settle()
    assert.equal(readFileSync(foreign, 'utf8'), '{"half-written": ', 'another writer\'s temp file is never truncated or renamed')
    const onDisk = JSON.parse(readFileSync(join(h.tmp, 'stats.json'), 'utf8'))
    assert.equal(onDisk.allTime.warms, 1, 'stats.json is still written atomically')
    assert.ok(!existsSync(join(h.tmp, `stats.json.${process.pid}.tmp`)), 'no own temp left behind')
    tool.gate.resolve()
    await tool.promise
    h.warmer.dispose()
  } finally {
    cleanupStats(h)
  }
}

// --- 74. Stats bucket by the host-local day, not the UTC day ----------------
{
  process.env.TZ = 'Europe/Berlin'
  const h = statsHarness()
  try {
    h.clock.advance(Date.UTC(2026, 9, 29, 23, 30)) // 00:30 on Oct 30 in Berlin (CET), still Oct 29 in UTC
    h.warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
    h.warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
    const tool = gateTool(h.warmer)
    h.clock.advance(242_000)
    await settle()
    const snap = h.stats.snapshot()
    assert.equal(snap.today.day, '2026-10-30', 'today is the local calendar day')
    assert.match(snap.today.day, /^\d{4}-\d{2}-\d{2}$/, 'dsh-context DAY_RE format kept')
    assert.deepEqual(Object.keys(snap.byDay), ['2026-10-30'], 'byDay keys are local days')
    assert.equal(snap.today.warms, 1)
    tool.gate.resolve()
    await tool.promise
    h.warmer.dispose()
  } finally {
    process.env.TZ = 'UTC'
    cleanupStats(h)
  }
}

// --- 75. Journal budget: local midnight, dispatch-day counting, UTC-era lines --
{
  const { openJournal } = await import('../lib/journal.js')
  process.env.TZ = 'Europe/Berlin'
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-warm-localday-'))
  try {
    let nowMs = Date.UTC(2026, 9, 29, 22, 50) // 23:50 local Oct 29
    const journal = openJournal(tmp, { now: () => nowMs })
    journal.record({ ts: new Date(nowMs).toISOString(), counted: true })
    assert.equal(journal.pingsToday(), 1)
    const lateDispatch = new Date(Date.UTC(2026, 9, 29, 22, 59, 50)).toISOString() // 23:59:50 local
    nowMs = Date.UTC(2026, 9, 29, 23, 10) // 00:10 local Oct 30 — UTC is still Oct 29
    assert.equal(journal.pingsToday(), 0, 'the budget resets at LOCAL midnight')
    journal.record({ ts: lateDispatch, counted: true })
    assert.equal(journal.pingsToday(), 0, 'a ping dispatched before midnight counts on its dispatch day, even settling after it')
    journal.close()
    // A UTC-era line: stamped with the UTC day, dispatched after local midnight.
    appendFileSync(join(tmp, 'warm.jsonl'), `${JSON.stringify({ ts: new Date(Date.UTC(2026, 9, 29, 23, 5)).toISOString(), counted: true, day: '2026-10-29' })}\n`)
    const reopened = openJournal(tmp, { now: () => nowMs })
    assert.equal(reopened.pingsToday(), 1, 'lines count by the local day of their ts, whatever basis stamped them')
    const lines = readFileSync(join(tmp, 'warm.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.deepEqual(lines.slice(0, 2).map((l) => l.day), ['2026-10-29', '2026-10-29'], 'new lines stamp the local dispatch day')
    reopened.close()
  } finally {
    process.env.TZ = 'UTC'
    rmSync(tmp, { recursive: true, force: true })
  }
}

// --- 76. A UTC-keyed stats.json from before the switch loads and continues ---
{
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-warm-utcfile-'))
  const warnings = []
  try {
    const t1 = Date.UTC(2026, 9, 29, 10, 0)
    const old = createStatsEngine({ storageDir: tmp, config: baseConfig, now: () => t1, warn: () => {} })
    old.onRealRequest('s1', 'mistral')
    old.onPingDispatch('s1', 'zai-glm-5-3')
    old.dispose()
    process.env.TZ = 'Europe/Berlin'
    const t2 = Date.UTC(2026, 9, 29, 12, 0) // 13:00 local: the same calendar day under both bases
    const engine = createStatsEngine({ storageDir: tmp, config: baseConfig, now: () => t2, warn: (m) => warnings.push(m) })
    assert.equal(warnings.length, 0, 'the UTC-keyed file is shape-valid: no reseed')
    assert.equal(engine.snapshot().today.warms, 1, 'today continues across the basis switch')
    engine.onRealRequest('s1', 'mistral')
    engine.onPingDispatch('s1', 'zai-glm-5-3')
    const snap = engine.snapshot()
    assert.equal(snap.today.warms, 2)
    assert.equal(snap.byDay['2026-10-29'].warms, 2, 'increments land on the same key')
    assert.equal(snap.allTime.warms, 2)
    engine.dispose()
  } finally {
    process.env.TZ = 'UTC'
    rmSync(tmp, { recursive: true, force: true })
  }
}

// --- 77. Partial miss inside a necessary chain credits only what survived ----
{
  const readsLlm = () => {
    const dispatches = []
    const reads = [1152, 600, 1152]
    const llm = {
      stream: async function* (options) {
        const read = reads[dispatches.length] ?? 1152
        dispatches.push(options)
        yield { type: 'usage', usage: { inputTokens: 1200 - read + 48, cacheReadTokens: read, outputTokens: 1 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    return { llm, dispatches }
  }
  const h = statsHarness({}, readsLlm)
  try {
    h.warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
    h.warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
    const tool = gateTool(h.warmer)
    for (let i = 0; i < 3; i++) {
      h.clock.advance(242_000)
      await settle()
    }
    h.clock.advance(220_000)
    h.warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
    const agg = h.stats.snapshot().allTime
    assert.equal(h.dispatches.length, 3)
    assert.equal(agg.savedCacheTokens, 600, 'saved = the prefix warm the whole way (min read), not the last ping\'s 1152')
    assert.equal(agg.expired, 0, 'still held: the pings are useful, the credit is just honest')
    tool.gate.resolve()
    await tool.promise
    h.warmer.dispose()
  } finally {
    cleanupStats(h)
  }
}

// --- 78. Two hosts sharing stats.json: merge on write, no lost updates -------
{
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-warm-merge-'))
  try {
    const t = Date.UTC(2026, 9, 29, 10, 0)
    const a = createStatsEngine({ storageDir: tmp, config: baseConfig, now: () => t, warn: () => {} })
    const b = createStatsEngine({ storageDir: tmp, config: baseConfig, now: () => t, warn: () => {} })
    a.onRealRequest('sa', 'mistral')
    a.onPingDispatch('sa', 'zai-glm-5-3')
    b.onRealRequest('sb', 'mistral')
    b.onPingDispatch('sb', 'zai-glm-5-3')
    a.onPingDispatch('sa', 'zai-glm-5-3')
    const disk = JSON.parse(readFileSync(join(tmp, 'stats.json'), 'utf8'))
    assert.equal(disk.allTime.warms, 3, 'every host\'s increments reach the file (last writer no longer wins)')
    assert.equal(disk.allTime.models['zai-glm-5-3'].warms, 3, 'per-model leaves merge too')
    assert.equal(disk.byDay['2026-10-29'].warms, 3)
    assert.equal(disk.today.warms, 3, 'today is re-derived from byDay')
    assert.deepEqual([disk.sessions.sa.warms, disk.sessions.sb.warms], [2, 1], 'both hosts\' sessions survive')
    assert.equal(a.snapshot().allTime.warms, 3, 'a snapshot sees the sibling\'s writes')
    assert.equal(b.snapshot().allTime.warms, 3)
    a.dispose()
    b.dispose()
    const reboot = createStatsEngine({ storageDir: tmp, config: baseConfig, now: () => t, warn: () => {} })
    assert.equal(reboot.snapshot().allTime.warms, 3, 'disposal writes add nothing twice')
    reboot.dispose()
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// --- 79. stats.json.lock: a live holder defers, a dead or old one is broken --
{
  const { spawnSync } = await import('node:child_process')
  const { utimesSync } = await import('node:fs')
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-warm-lock-'))
  const warnings = []
  try {
    const t = Date.UTC(2026, 9, 29, 10, 0)
    const engine = createStatsEngine({ storageDir: tmp, config: baseConfig, now: () => t, warn: (m) => warnings.push(m) })
    const lock = join(tmp, 'stats.json.lock')
    const fileWarms = () => JSON.parse(readFileSync(join(tmp, 'stats.json'), 'utf8')).allTime.warms
    engine.onRealRequest('s1', 'mistral')
    writeFileSync(lock, `${process.ppid}\n`) // a live sibling mid-write
    engine.onPingDispatch('s1', 'zai-glm-5-3')
    assert.equal(fileWarms(), 0, 'a live lock defers the write')
    assert.equal(warnings.filter((m) => m.includes('busy')).length, 1, 'one warning')
    assert.equal(engine.snapshot().allTime.warms, 1, 'the deferred increment is kept, not lost')
    rmSync(lock)
    engine.onPingDispatch('s1', 'zai-glm-5-3')
    assert.equal(fileWarms(), 2, 'the next write carries the deferred increment too')
    const dead = spawnSync(process.execPath, ['-e', '']).pid
    writeFileSync(lock, `${dead}\n`)
    engine.onPingDispatch('s1', 'zai-glm-5-3')
    assert.equal(fileWarms(), 3, 'a lock whose owner died is broken')
    assert.ok(!existsSync(lock), 'and released after the write')
    writeFileSync(lock, `${process.ppid}\n`)
    const old = (Date.now() - 60_000) / 1000
    utimesSync(lock, old, old)
    engine.onPingDispatch('s1', 'zai-glm-5-3')
    assert.equal(fileWarms(), 4, 'a lock older than any real write is broken')
    engine.dispose()
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// --- 80. Journal: hosts sharing DSH_HOME share one daily budget --------------
{
  const { openJournal } = await import('../lib/journal.js')
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-warm-sharedbudget-'))
  try {
    const nowMs = Date.UTC(2026, 9, 29, 12, 0)
    const ts = new Date(nowMs).toISOString()
    const a = openJournal(tmp, { now: () => nowMs })
    const b = openJournal(tmp, { now: () => nowMs })
    a.record({ ts, counted: true })
    a.record({ ts, counted: true })
    b.record({ ts, counted: true })
    b.record({ ts, counted: true })
    b.record({ ts, counted: true })
    assert.equal(a.pingsToday(), 5, 'host A sees host B\'s pings')
    assert.equal(b.pingsToday(), 5, 'host B sees host A\'s pings')
    a.record({ ts, counted: false })
    assert.equal(b.pingsToday(), 5, 'uncounted lines never consume budget')
    a.close()
    b.close()
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// --- 81. Journal: a second roll the same day keeps the first rolled file ------
{
  const { openJournal } = await import('../lib/journal.js')
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-warm-roll2-'))
  try {
    const nowMs = Date.UTC(2026, 9, 17, 12, 0, 0)
    const journal = openJournal(tmp, { now: () => nowMs })
    const pad = 'p'.repeat(64 * 1024)
    for (let i = 0; i < 180; i++) journal.record({ counted: true, pad })
    assert.ok(existsSync(join(tmp, 'warm.jsonl.2026-10-17')), 'first roll')
    assert.ok(existsSync(join(tmp, 'warm.jsonl.2026-10-17.1')), 'second roll gets its own name')
    journal.close()
    const reopened = openJournal(tmp, { now: () => nowMs })
    assert.equal(reopened.pingsToday(), 180, 'every line of today is counted across both rolls and the live file')
    reopened.close()
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// --- 82. byDay is bounded to the newest 366 days; allTime keeps the totals ---
{
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-warm-days-'))
  try {
    const t = Date.UTC(2026, 9, 29, 10, 0)
    const first = createStatsEngine({ storageDir: tmp, config: baseConfig, now: () => t, warn: () => {} })
    first.dispose()
    const file = JSON.parse(readFileSync(join(tmp, 'stats.json'), 'utf8'))
    const bucket = { warms: 1, needless: 0, noFollowup: 0, expired: 0, savedCacheTokens: 0, models: {} }
    for (let i = 1; i <= 370; i++) file.byDay[new Date(t - i * 86_400_000).toISOString().slice(0, 10)] = { ...bucket }
    file.allTime.warms = 370
    writeFileSync(join(tmp, 'stats.json'), JSON.stringify(file))
    const engine = createStatsEngine({ storageDir: tmp, config: baseConfig, now: () => t, warn: () => {} })
    engine.onRealRequest('s1', 'mistral')
    engine.onPingDispatch('s1', 'zai-glm-5-3')
    const disk = JSON.parse(readFileSync(join(tmp, 'stats.json'), 'utf8'))
    const days = Object.keys(disk.byDay).sort()
    assert.equal(days.length, 366, 'byDay keeps the newest 366 days')
    assert.equal(days.at(-1), '2026-10-29', 'today survives')
    assert.equal(days[0], new Date(t - 365 * 86_400_000).toISOString().slice(0, 10), 'the oldest days go first')
    assert.equal(disk.allTime.warms, 371, 'allTime keeps pruned days\' totals')
    engine.dispose()
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// --- 83. Default maxPings is 7: a 30-min block keeps its cover ---------------
{
  const { loadConfig } = await import('../lib/config.js')
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-warm-maxpings-'))
  try {
    const cfg = loadConfig(tmp, () => {})
    assert.equal(cfg.maxPings, 7, 'default cap is 7')
    assert.equal(JSON.parse(readFileSync(join(tmp, 'config.json'), 'utf8')).maxPings, 7, 'the auto-written config.json carries 7')
    const { warmer, clock, dispatches } = makeWarmer({ maxPings: cfg.maxPings })
    warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
    warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
    const gate = { resolve: null }
    const toolPromise = warmer.onToolsExecute({ agent: { id: 's1' }, name: 'bash' }, async () => { await new Promise((r) => { gate.resolve = r }); return 'ok' })
    for (let i = 0; i < 9; i++) {
      clock.advance(242_000)
      await settle()
    }
    assert.equal(dispatches.length, 7, 'seven anchored pings, then the cap')
    // Cover: last ping at 7 × 242 s = 1694 s, held until 1694 + 302 = 1996 s ≥ a 30-min (1800 s) block.
    assert.ok(7 * 242 + 302 >= 1800)
    gate.resolve()
    await toolPromise
    warmer.dispose()
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// --- 84. Route echoes marginMs for anchored rules only -------------------------
{
  const { makeStatsPayload } = await import('../lib/index.js')
  const cfg = { ...baseConfig, providers: { mistral: { intervalMs: 240_000, ttlMs: 302_000, marginMs: 60_000 }, grid: { intervalMs: 180_000, marginMs: 60_000 } } }
  const payload = makeStatsPayload(null, cfg)
  assert.equal(payload.schema, 3, 'additive optional field: no schema bump')
  assert.deepEqual(payload.config.providers.mistral, { intervalMs: 240_000, ttlMs: 302_000, marginMs: 60_000 })
  assert.deepEqual(payload.config.providers.grid, { intervalMs: 180_000, ttlMs: 180_000 }, 'a grid rule carries no marginMs (its cadence is intervalMs)')
  const source = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8')
  assert.ok(source.includes('rule.ttlMs - rule.marginMs'), 'the client shows the anchored cadence, not the unread grid slot')
}

console.log('dsh-warm test/verify.mjs: all scenarios passed')
