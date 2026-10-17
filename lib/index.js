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

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, resolveDshHome } from './config.js'
import { openJournal } from './journal.js'
import { createWarmer } from './warmer.js'

export const name = 'dsh-warm'

export const inject = ['llm']

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
  const warmer = createWarmer({ llm: ctx.llm, config, journal })

  // `global: true`: cost-meter's precedent — isolated llm/tool service contexts
  // (created by other plugins) must still be observed from this one listener.
  ctx.on('llm/stream', (options, next) => warmer.onLlmStream(options, next), { global: true })
  ctx.on('tools/execute', (exec, next) => warmer.onToolsExecute(exec, next), { global: true })
  ctx.on('agent/status', (payload) => warmer.onAgentStatus(payload), { global: true })
  ctx.on('agent/disposed', (payload) => warmer.onAgentDisposed(payload), { global: true })
  ctx.on('session/disposed', (session) => warmer.onSessionDisposed(session), { global: true })

  ctx.effect(() => () => {
    warmer.dispose()
    journal.close()
  }, 'dsh-warm: teardown')

  const providerSummary = Object.entries(config.providers)
    .map(([provider, rule]) => `${provider}:${Math.round(rule.intervalMs / 1000)}s${rule.maxPings !== undefined ? `/${rule.maxPings}p` : ''}`)
    .join(' ')
  console.log(
    `[dsh-warm] loaded: providers=[${providerSummary}] cap=${config.maxPings}/block`
    + `${config.dryRun ? ' DRY-RUN' : ''} budget=${config.dailyPingBudget}/day journal=${journal.path}`,
  )
}
