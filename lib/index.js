/**
 * dsh-warm host plugin.
 *
 * Single Loader row (see cordis.patch.yml) mounting lib/warmer.js:
 * while a session's agent loop is blocked inside a tool execution, the
 * warmer re-dispatches that session's last conversation request through the
 * `llm` waterfall with `maxTokens: 1` on a fixed interval, keeping the
 * provider's prompt-cache prefix warm until the tool settles. Idle sessions
 * and user-input tools are never warmed. Pings are billed by the normal
 * waterfall (dsh-cost-meter sees them like any call) and journaled to
 * `$DSH_HOME/storages/dsh-warm/warm.jsonl`.
 *
 * No runtime package imports (cost-meter convention: only `node:` builtins
 * and the bare `ctx` API, so the plugin shares the host's module instances).
 * ESM `type: module`; exported handlers follow the harness plugin shape
 * (`name` + `inject` + `apply`).
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, resolveDshHome } from './config.js'
import { openJournal } from './journal.js'
import { createStatsEngine } from './stats.js'
import { createWarmer } from './warmer.js'

export const name = 'dsh-warm'

export const inject = ['llm']

/**
 * Stable wire payload for GET /api/dsh-warm/stats. Documented in README as
 * the contract for third-party consumers (e.g. a dsh-context card); change
 * shape only behind a `schema` bump. Schema 3: per-model failed-token maps
 * (`models.<id>.failedPingTokens: { cacheRead, uncached }`, all-time) — the
 * flat top-level `failedPingTokens` is kept and stays authoritative for
 * pre-upgrade rows, so post-upgrade attribution keeps flat equal to the
 * per-model sums. Schema 2 added per-model `models` maps, the flat all-time
 * `failedPingTokens`, and a bounded `sessions` map (per-session buckets
 * shaped like `allTime`) — flat count fields stay totals across models.
 * @param {object|null} stats - stats engine (null when stats disabled).
 * @param {object} config - resolved plugin config.
 */
export function makeStatsPayload(stats, config) {
  const providers = {}
  for (const [name, rule] of Object.entries(config.providers)) {
    providers[name] = { intervalMs: rule.intervalMs, ttlMs: rule.ttlMs ?? rule.intervalMs }
    if (rule.maxPings !== undefined) providers[name].maxPings = rule.maxPings
  }
  return {
    schema: 3,
    statsEnabled: config.stats.enabled,
    stats: stats === null ? null : stats.snapshot(),
    config: {
      providers,
      budget: { dailyPingBudget: config.dailyPingBudget, maxPingsPerBlock: config.maxPings },
      dryRun: config.dryRun === true,
    },
  }
}

/**
 * Fetch handler for the stats route (the authenticated /api fence handles
 * auth; no hand-rolled fence).
 * @param {object|null} stats - stats engine (null when stats disabled).
 * @param {object} config - resolved plugin config.
 */
export function makeStatsRoute(stats, config) {
  return () => new Response(JSON.stringify(makeStatsPayload(stats, config)), {
    headers: { 'content-type': 'application/json' },
  })
}

/** Roll the debug trace past this size: a debug:true host otherwise grows it without bound. */
const DEBUG_ROLL_BYTES = 16 * 1024 * 1024

/**
 * Append-only debug trace sink (config `debug: true`). Rolls `<path>` to
 * `<path>.1` (replacing the previous roll) once it passes `rollBytes`, so a
 * trace left on keeps at most ~2 × rollBytes on disk. Never throws.
 * @param {string} path - trace file (storages/dsh-warm/debug.jsonl).
 * @param {object} [opts]
 * @param {number} [opts.rollBytes] - roll threshold; tests pass a small one.
 * @returns {(event: object) => void}
 */
export function makeDebugSink(path, { rollBytes = DEBUG_ROLL_BYTES } = {}) {
  let size = 0
  try {
    size = statSync(path).size
  } catch {
    // Absent: starts at zero.
  }
  return (event) => {
    try {
      if (size > rollBytes) {
        // Rename failure (EBUSY etc.) still resets: retry after another rollBytes, not per event.
        size = 0
        try {
          renameSync(path, `${path}.1`)
        } catch {
          // Keep appending to the unrolled file.
        }
      }
      const line = `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`
      appendFileSync(path, line)
      size += Buffer.byteLength(line)
    } catch {
      // A diagnostic sink never fails the host.
    }
  }
}

/**
 * Mount the warmer over the host context.
 * @param {object} ctx - host plugin context (cordis `Context`).
 */
export function apply(ctx) {
  const storageDir = join(resolveDshHome(), 'storages', 'dsh-warm')
  try {
    mkdirSync(storageDir, { recursive: true })
  } catch (error) {
    console.error(`[dsh-warm] cannot create storage dir ${storageDir}: ${String(error?.message ?? error)}; plugin stays inert`)
    return
  }
  const config = loadConfig(storageDir)
  if (!config.enabled) {
    console.log('[dsh-warm] disabled by config; observing nothing')
    return
  }

  const journal = openJournal(storageDir)
  const debugPath = join(storageDir, 'debug.jsonl')
  const debug = config.debug ? makeDebugSink(debugPath) : null
  if (config.debug) console.warn(`[dsh-warm] debug trace: ${debugPath}`)
  const stats = config.stats.enabled ? createStatsEngine({ storageDir, config, warn: console.warn, debug }) : null
  const warmer = createWarmer({ llm: ctx.llm, config, journal, stats, debug })

  // `global: true`: cost-meter's precedent — isolated llm/tool service contexts
  // (created by other plugins) must still be observed from this one listener.
  ctx.on('llm/stream', (options, next) => warmer.onLlmStream(options, next), { global: true })
  ctx.on('tools/execute', (exec, next) => warmer.onToolsExecute(exec, next), { global: true })
  ctx.on('agent/status', (payload) => warmer.onAgentStatus(payload), { global: true })
  ctx.on('agent/disposed', (payload) => warmer.onAgentDisposed(payload), { global: true })
  ctx.on('session/disposed', (session) => warmer.onSessionDisposed(session), { global: true })

  // GET /api/dsh-warm/stats behind the authenticated /api fence. Registered
  // even when stats are disabled so clients see the toggle state; absent only
  // on hosts without the connection service or with a rejecting registry
  // (e.g. a duplicate route from a double instantiation) — refuse quietly.
  ctx.inject(['connection'], (c) => {
    const register = c.connection?.fetch?.register
    if (typeof register !== 'function') {
      console.warn('[dsh-warm] connection.fetch unavailable; stats route not registered')
      return
    }
    try {
      c.effect(() => register.call(c.connection.fetch, {
        path: '/api/dsh-warm/stats',
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: makeStatsRoute(stats, config),
      }), 'dsh-warm: stats route')
    } catch (error) {
      console.warn(`[dsh-warm] stats route rejected (${String(error?.message ?? error)}); route stays absent`)
    }
  })

  ctx.effect(() => () => {
    warmer.dispose()
    stats?.dispose()
    journal.close()
  }, 'dsh-warm: teardown')

  const providerSummary = Object.entries(config.providers)
    .map(([provider, rule]) => `${provider}:${Math.round(rule.intervalMs / 1000)}s${rule.maxPings !== undefined ? `/${rule.maxPings}p` : ''}`)
    .join(' ')
  console.log(
    `[dsh-warm] loaded: providers=[${providerSummary}] cap=${config.maxPings}/block`
    + `${config.dryRun ? ' DRY-RUN' : ''} budget=${config.dailyPingBudget}/day`
    + ` stats=${config.stats.enabled ? 'on' : 'off'} journal=${journal.path}`,
  )
}
