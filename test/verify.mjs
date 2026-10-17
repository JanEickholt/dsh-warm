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
    mistral: { intervalMs: 240_000 },
  },
  excludeTools: ['ask_user_question'],
  minPrefixChars: 12_000,
  maxConcurrentPings: 2,
  dailyPingBudget: 300,
  pingTimeoutMs: 90_000,
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
  assert.deepEqual(cfg4.providers, { mistral: { intervalMs: 200_000 }, 'opencode-go': { intervalMs: 200_000 } }, 'legacy warmProviders+intervalMs migrate to one table')
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

console.log('dsh-warm test/verify.mjs: all scenarios passed')
