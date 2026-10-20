/**
 * dsh-warm state-machine verification with a fake clock, fake timers, fake
 * llm service, and in-memory journal. No host boot required.
 * Run: `node test/verify.mjs` (or `npm test`).
 */

import assert from 'node:assert/strict'
import { createWarmer } from '../lib/warmer.js'

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
    mistral: { intervalMs: 240_000, ttlMs: 302_000 },
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

  clock.advance(240_000)
  await settle()
  assert.equal(dispatches.length, 1, 'first ping at lastRequestAt + interval')
  const ping = dispatches[0]
  assert.equal(ping.maxTokens, 1, 'ping caps output at one token')
  assert.equal(ping.messages, conversationRequest.messages, 'ping shares the frozen messages reference byte-identically')
  assert.equal(ping.provider, 'mistral')
  assert.equal(ping.model, 'zai-glm-5-3')
  assert.ok(ping.signal && ping.signal.timeoutMs === 90_000, 'ping carries its own abort signal')
  assert.equal(journal.entries.length, 1)
  assert.equal(journal.entries[0].counted, true)
  assert.equal(journal.entries[0].cacheReadTokens, 1152, 'journal records the provider hit')

  clock.advance(240_000)
  await settle()
  assert.equal(dispatches.length, 2, 'second ping on the next grid slot')

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
  for (let i = 0; i < 7; i++) {
    clock.advance(240_000)
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
  clock.advance(240_000)
  await settle()
  clock.advance(120_000)
  warmer.onLlmStream({ ...conversationRequest, messages: [...bigMessages, { role: 'assistant', content: 'next' }] }, () => [])[Symbol.iterator]()
  clock.advance(120_000)
  await settle()
  assert.equal(dispatches.length, 1, 'grid restarts from the new request, not the old one')
  clock.advance(120_000)
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
  clock.advance(240_000)
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
  clock.advance(240_000)
  await settle()
  assert.equal(dispatches.length, 1, 'concurrency cap: second session deferred')
  clock.advance(5_000)
  await settle()
  assert.equal(dispatches.length, 2, 'deferred session pings after the retry delay')
  clock.advance(235_000)
  await settle()
  assert.equal(dispatches.length, 3, 'shared grid tick: cap serializes the second session again')
  clock.advance(5_000)
  await settle()
  assert.equal(dispatches.length, 4, 'deferred ping lands; both sessions stay on their grids')
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
  clock.advance(240_000)
  await settle()
  assert.equal(dispatches.length, 0)
  assert.equal(journal.entries.length, 1)
  assert.equal(journal.entries[0].ok, false)
  assert.match(journal.entries[0].error, /503/)
  assert.equal(journal.entries[0].counted, true, 'a real dispatch attempt consumes budget even on failure')
  clock.advance(240_000)
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
  assert.deepEqual(cfg2.providers.deepseek, { intervalMs: 300_000, maxPings: 3 }, 'custom provider entry kept verbatim')
  assert.equal(cfg2.providers.broken, undefined, 'non-numeric intervalMs drops the entry')
  assert.equal(cfg2.providers.spotty, undefined, 'sub-minute interval drops the entry')
  assert.ok(warnings.some((m) => m.includes('providers["broken"]')), 'dropped entry warns loudly')
  assert.ok(warnings.some((m) => m.includes('providers["spotty"]')), 'spam-floor entry warns loudly')

  // Legacy shape migrates onto the per-provider table.
  mkdirSync(join(tmp, 'c'), { recursive: true })
  writeFileSync(join(tmp, 'c', 'config.json'), JSON.stringify({ warmProviders: ['mistral', 'opencode-go'], intervalMs: 200_000 }))
  const cfg4 = loadConfig(join(tmp, 'c'), warn)
  assert.deepEqual(cfg4.providers, { mistral: { intervalMs: 200_000, ttlMs: 302_000 }, 'opencode-go': { intervalMs: 200_000 } }, 'legacy warmProviders+intervalMs migrate to one table; known providers adopt the measured ttlMs default')
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
  clock.advance(240_000)
  await settle()
  assert.equal(dispatches.length, 1, 'epoch-1 ping is in flight')
  // Second conversation request supersedes the captured state mid-flight.
  warmer.onLlmStream({ ...conversationRequest, messages: [{ role: 'user', content: 'y'.repeat(20_000) }] }, () => [])[Symbol.iterator]()
  gate.resolve()
  await settle()
  assert.equal(journal.entries.length, 1)
  assert.equal(journal.entries[0].counted, true, 'the superseded ping was really dispatched: budget stays honest')
  // New epoch grid: first ping due one interval after the new capture, not two.
  clock.advance(240_000)
  await settle()
  assert.equal(dispatches.length, 2, 'new epoch pings on its own grid (no slot stolen by the old ping)')
  clock.advance(240_000)
  await settle()
  assert.equal(dispatches.length, 3, 'second new-epoch ping keeps the 240s spacing')
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
  clock.advance(240_000)
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
  clock.advance(240_000)
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
  clock.advance(240_000)
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
  clock.advance(240_000)
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
  clock.advance(235_000)
  await settle()
  assert.equal(dispatches.length, 2, 'ping 2 lands on the grid slot after ping 1 settles')
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
  clock.advance(240_000)
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
  clock.advance(240_000)
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
  clock.advance(240_000)
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
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')

/** Warmer + real stats engine sharing one fake clock; stats.json in a tmp dir. */
const statsHarness = (configOverrides = {}, llmFactory = makeLlm) => {
  const clock = fakeClock()
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-warm-stats-'))
  const config = { ...baseConfig, ...configOverrides }
  const stats = createStatsEngine({ storageDir: tmp, config, now: clock.now, warn: () => {} })
  const factory = llmFactory()
  const { llm, dispatches, ...llmExtras } = factory
  const journal = makeJournal()
  const warmer = createWarmer({
    llm, config, journal, stats,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    signal: (ms) => ({ timeoutMs: ms }), warn: () => {},
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
    h.clock.advance(240_000)
    await settle()
    h.clock.advance(60_000)
    h.warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
    const agg = h.stats.snapshot().allTime
    assert.equal(agg.warms, 1, 'one ping dispatched')
    assert.equal(agg.needless, 1, 'follow-up at 300s kept the prefix warm anyway (300s < 302s TTL)')
    assert.equal(agg.expired, 0)
    assert.equal(agg.noFollowup, 0)
    assert.equal(agg.savedCacheTokens, 0, 'no necessary ping means no credit')
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
    h.clock.advance(240_000)
    await settle()
    h.clock.advance(240_000)
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
    h.clock.advance(240_000)
    await settle()
    tool.gate.resolve()
    await tool.promise
    h.clock.advance(360_000)
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
    h.clock.advance(240_000)
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
    h.clock.advance(240_000)
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
    h.clock.advance(240_000)
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
        if (call++ === 0) {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'rate', message: 'boom' } } }
          return
        }
        yield { type: 'usage', usage: { inputTokens: 1200, cacheReadTokens: 1152, outputTokens: 1 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    return { llm, dispatches }
  }
  const h = statsHarness({}, flakyLlm)
  try {
    h.warmer.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
    h.warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
    const tool = gateTool(h.warmer)
    h.clock.advance(240_000)
    await settle()
    h.clock.advance(240_000)
    await settle()
    h.clock.advance(220_000)
    h.warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
    const agg = h.stats.snapshot().allTime
    assert.equal(agg.warms, 2)
    assert.equal(h.stats.snapshot().failed, 1, 'failed pings land in their own aggregate')
    assert.equal(agg.expired, 0)
    assert.equal(agg.savedCacheTokens, 1152, 'the second ping partitions against t0 (failed ping is no anchor) and hits')
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
    clock.advance(240_000)
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
    h.clock.advance(240_000)
    await settle()
    tool1.gate.resolve()
    await tool1.promise
    const tool2 = gateTool(h.warmer)
    h.clock.advance(240_000)
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
    h.clock.advance(240_000)
    await settle()
    // Follow-up lands while the ping is still in flight: the chain closes
    // with the ping unsettled (partitioned against 0..300s — needless).
    h.clock.advance(60_000)
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
    before.onPingDispatch('s1')
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
    after.onPingDispatch('s1')
    after.onPingSettle('s1', { ok: true, cacheReadTokens: 1152 })
    nowMs = Date.UTC(2026, 9, 18, 0, 36, 0)
    after.onRealRequest('s1', 'mistral')
    snap = after.snapshot()
    assert.equal(snap.today.warms, 1, 'write-side rollover counts the new day only')
    assert.equal(snap.today.savedCacheTokens, 1152)
    assert.deepEqual(snap.byDay['2026-10-18'], { warms: 1, needless: 0, noFollowup: 0, expired: 0, savedCacheTokens: 1152 })
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
    for (const key of ['today', 'allTime', 'byDay', 'failed']) {
      assert.ok(stored[key] !== undefined, `stats.json carries ${key}`)
    }
    assert.equal(stored.today.day, '2026-10-19')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// --- 42. Corrupt or absent stats.json: journal seeds warms/failed only -------
{
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-warm-seed-'))
  try {
    const pingLine = (ts, ok) => JSON.stringify({ ts, sessionId: 's1', provider: 'mistral', model: 'm', ttMs: 1000, ok, error: ok ? null : 'x', inputTokens: 1, cacheReadTokens: ok ? 1152 : 0, outputTokens: 1, dryRun: false, counted: true })
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
    engine.dispose()

    // Absent stats.json + journal present: same seed path.
    const tmp2 = mkdtempSync(join(tmpdir(), 'dsh-warm-seed2-'))
    try {
      writeFileSync(join(tmp2, 'warm.jsonl'), pingLine('2026-10-19T11:00:00.000Z', true) + '\n')
      const engine2 = createStatsEngine({ storageDir: tmp2, config: baseConfig, now: () => nowMs, warn: () => {} })
      assert.equal(engine2.snapshot().allTime.warms, 1, 'absent stats.json seeds from the journal')
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
    engine.onPingDispatch('s1')
    engine.onPingSettle('s1', { ok: true, cacheReadTokens: 1152 })
    nowMs += 160_000 // follow-up at +400s total: necessary (400-0 ≥ 302) + held (400-240 < 302)
    engine.onRealRequest('s1', 'mistral') // necessary + held + hit → saved

    const payload = makeStatsPayload(engine, baseConfig)
    assert.equal(payload.schema, 1, 'wire payload carries a schema version')
    assert.equal(payload.statsEnabled, true)
    assert.equal(payload.stats.allTime.warms, 1, 'payload embeds the snapshot')
    assert.equal(payload.stats.today.savedCacheTokens, 1152)
    assert.equal(payload.stats.failed, 0)
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
    assert.equal(body.schema, 1)
    assert.equal(body.statsEnabled, true)
    assert.equal(body.stats.allTime.warms, 0, 'empty engine still snapshots')
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
    h.clock.advance(240_000)
    await settle() // ping1 (chain A) dispatched, stream held at gate[0]
    assert.equal(h.stats.snapshot().allTime.warms, 1)
    // Follow-up request: bumps the epoch, closes chain A (ping1 partitions as
    // needless — 300s < 302s), opens chain B, re-arms the grid.
    h.clock.advance(60_000)
    h.warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
    assert.equal(h.stats.snapshot().allTime.needless, 1, 'chain A closed with ping1 in flight')
    // Chain B dispatches its own ping (gate[1] holds it).
    h.clock.advance(240_000)
    await settle()
    assert.equal(h.stats.snapshot().allTime.warms, 2, 'chain B dispatched its own ping')
    // The superseded ping1 settles FIRST, while ping2 is in flight: its
    // settle must reach the journal (budget honesty) but NOT the stats engine.
    h.llmExtras.gates[0].resolve()
    await settle()
    // ping2 settles with its own outcome — not overwritten, not dropped.
    h.llmExtras.gates[1].resolve()
    await settle()
    // Follow-up closes chain B: ping2 was necessary (400s ≥ TTL) and held
    // (160s < TTL); only ping2's own hit value may be credited.
    h.clock.advance(160_000)
    h.warmer.onLlmStream(conversationRequest, () => [])[Symbol.iterator]()
    const agg = h.stats.snapshot().allTime
    assert.equal(agg.warms, 2)
    assert.equal(agg.needless, 1, 'only chain A\'s in-flight ping was needless')
    assert.equal(agg.expired, 0)
    assert.equal(agg.savedCacheTokens, 1152, 'saved credits ping2\'s own hit, never the superseded ping1\'s 9999')
    assert.equal(h.journal.entries.length, 2, 'both dispatches still journal (budget honesty)')
    assert.ok(h.journal.entries.every((e) => e.counted === true))
    tool.gate.resolve()
    await tool.promise
    h.warmer.dispose()
  } finally {
    cleanupStats(h)
  }
}

console.log('dsh-warm test/verify.mjs: all scenarios passed')
