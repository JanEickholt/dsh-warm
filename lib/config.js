/**
 * dsh-warm configuration: a plain JSON file at
 * `$DSH_HOME/storages/dsh-warm/config.json`, validated field-by-field on load.
 *
 * No runtime package imports (cost-meter convention): the plugin shares the
 * host's own module instances, so it only uses `node:` builtins and the bare
 * `ctx` API. Bad values fail loud on the host console and fall back to that
 * field's default instead of silently arming timers with nonsense.
 *
 * The ping interval is per provider: a provider's prompt-cache TTL is a fact
 * about that provider (measured: Mistral zai-glm-5-3 hits at 302 s; documented:
 * OpenAI "5 minutes up to an hour", Anthropic 5 min refreshed on use), so
 * each entry in `providers` carries its own `intervalMs` and optional
 * `maxPings` override. An entry left empty for a provider the defaults
 * table names adopts the built-in rule — "use defaults" must never silently
 * disable warming. A provider absent from the table is never warmed —
 * that is the correct default for providers whose TTL is long or unmeasured
 * (DeepSeek's disk cache outlives any sane ping grid; opencode-go unmeasured).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * Per-provider warming rule. Presence in the table = "warm this provider".
 * @typedef {object} ProviderWarmConfig
 * @property {number} intervalMs - fallback grid when ttlMs is absent; ignored for scheduling when ttlMs is set.
 * @property {number} [ttlMs] - prompt-cache TTL floor; the anchored schedule base (pings fire ttlMs - marginMs after the last proof of warmth) and the stats partition threshold.
 * @property {number} marginMs - safety buffer subtracted from ttlMs; must stay below ttlMs or the pair falls back to the interval grid.
 * @property {number} [maxPings] - ping cap per tool block for this provider; defaults to the global `maxPings`.
 */

/** Default safety buffer between an anchored ping and cache death. */
export const DEFAULT_MARGIN_MS = 60_000

/** Fallback-grid slot when an entry carries ttlMs but no intervalMs. */
const DEFAULT_INTERVAL_MS = 240_000

/** Resolved configuration; every field is a validated primitive, string array, or provider table. */
export const DEFAULT_CONFIG = {
  /** Master switch. */
  enabled: true,
  /** Log would-be pings and skip dispatching them. Watch mode for first deploy. */
  dryRun: false,
  /** Ping cap per tool block when a provider entry does not override it. */
  maxPings: 5,
  /**
   * Providers worth warming, each with its own rule tied to that provider's
   * prompt-cache TTL. With ttlMs set the schedule is expiry-anchored: pings
   * fire ttlMs - marginMs after the last proof of warmth. Remove or comment
   * out (JSON: delete) an entry to stop warming that provider.
   */
  providers: {
    // Measured live 2026-10-17 against api.mistral.ai, zai-glm-5-3:
    // hit at 302 s, miss at 424 s, hits refresh the TTL. ttlMs is the
    // measured floor — the true TTL sits in (302 s, 424 s].
    mistral: { intervalMs: 240_000, ttlMs: 302_000, marginMs: 60_000 },
    // Documented: prompt cache "generally lasts between 5 minutes and up to an
    // hour"; 240 s stays under the short end, 300 s is the documented floor.
    openai: { intervalMs: 240_000, ttlMs: 300_000, marginMs: 60_000 },
    // Documented: 5-minute TTL, refreshed on each use.
    anthropic: { intervalMs: 240_000, ttlMs: 300_000, marginMs: 60_000 },
  },
  /** Tools whose wait is user-idle-like (uncertain resume) — never warm them. */
  excludeTools: ['ask_user_question'],
  /** Skip tiny prefixes (roughly chars/4 tokens): a miss on them costs cents-per-thousand. */
  minPrefixChars: 12_000,
  /** Global in-flight ping guard. */
  maxConcurrentPings: 2,
  /** Hard stop per UTC day, counted over real dispatch attempts. */
  dailyPingBudget: 300,
  /** Abort the ping stream if the provider stalls. */
  pingTimeoutMs: 90_000,
  /** Stats attribution toggle. Off = no attribution and no stats.json; pings still journal. */
  stats: { enabled: true },
  /** Append every observed event to storages/dsh-warm/debug.jsonl. Diagnosis only. */
  debug: false,
}

export function resolveDshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

const isPosInt = (value) => Number.isInteger(value) && value > 0
const isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string')

/**
 * Validate one provider entry from raw config.
 * @param {string} name - the provider name as written in config.json.
 * @param {unknown} raw - the entry's raw value.
 * @param {(message: string) => void} warn - loud-misconfiguration sink.
 * @returns {ProviderWarmConfig | null} a valid rule, or null (entry dropped).
 */
function providerConfigOf(name, raw, warn) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    warn('entry must be an object like { "intervalMs": 240000 }; entry dropped')
    return null
  }
  // An entry with neither scheduling field means "use the defaults" for a
  // provider the table ships a measured rule for: adopt it, layering whatever
  // valid overrides the entry still carries. Dropping the entry instead would
  // silently disable warming for a provider the user named on purpose.
  const builtin = DEFAULT_CONFIG.providers[name]
  if (raw.intervalMs === undefined && raw.ttlMs === undefined && builtin !== undefined) {
    warn('entry empty — adopting built-in scheduling (fields present in the entry still apply)')
    raw = { ...builtin, ...raw }
  }
  let intervalMs = raw.intervalMs
  if (intervalMs === undefined && raw.ttlMs !== undefined) {
    // ttlMs alone is a complete anchored rule; only the fallback grid reads
    // intervalMs, so default that slot instead of dropping a warmable provider.
    warn(`intervalMs missing — defaulted to ${DEFAULT_INTERVAL_MS} (only the fallback grid reads it)`)
    intervalMs = DEFAULT_INTERVAL_MS
  }
  if (!isPosInt(intervalMs)) {
    warn(`intervalMs invalid (${JSON.stringify(intervalMs)}); entry dropped`)
    return null
  }
  if (intervalMs < 60_000) {
    warn(`intervalMs=${intervalMs} is below the sane floor 60000; entry dropped (warming would spam the provider)`)
    return null
  }
  if (intervalMs >= 600_000) {
    warn(`intervalMs=${intervalMs}: pings land beyond a ~10 min horizon — make sure that matches this provider's actual TTL`)
  }
  const config = { intervalMs }
  if (raw.ttlMs !== undefined) {
    if (!isPosInt(raw.ttlMs)) {
      warn(`ttlMs invalid (${JSON.stringify(raw.ttlMs)}); using the built-in default`)
    } else {
      config.ttlMs = raw.ttlMs
      if (raw.ttlMs <= intervalMs) {
        warn(`ttlMs=${raw.ttlMs} <= intervalMs=${intervalMs}: the fallback interval grid can never bridge the TTL (anchored scheduling is unaffected)`)
      }
    }
  }
  // marginMs always leaves concrete: the warmer trusts config like it already
  // trusts intervalMs (zero new imports, no per-arm fallback).
  if (raw.marginMs !== undefined && !isPosInt(raw.marginMs)) {
    warn(`marginMs invalid (${JSON.stringify(raw.marginMs)}); using ${DEFAULT_MARGIN_MS}`)
  }
  config.marginMs = isPosInt(raw.marginMs) ? raw.marginMs : DEFAULT_MARGIN_MS
  if (raw.maxPings !== undefined) {
    if (!isPosInt(raw.maxPings)) warn(`maxPings invalid (${JSON.stringify(raw.maxPings)}); using global maxPings`)
    else config.maxPings = raw.maxPings
  }
  return config
}

/**
 * Read + validate `$DSH_HOME/storages/dsh-warm/config.json` over the defaults.
 * Writes the defaults back on first load so the file exists to edit. A legacy
 * `{ warmProviders, intervalMs }` shape migrates into the per-provider table.
 * @param {string} storageDir - plugin storage directory (created if missing).
 * @param {(message: string) => void} [warn] - loud-misconfiguration sink.
 * @returns {typeof DEFAULT_CONFIG} fully resolved configuration.
 */
export function loadConfig(storageDir, warn = console.error) {
  const config = { ...DEFAULT_CONFIG, providers: {}, excludeTools: [...DEFAULT_CONFIG.excludeTools], stats: { ...DEFAULT_CONFIG.stats } }
  for (const [name, entry] of Object.entries(DEFAULT_CONFIG.providers)) {
    config.providers[name] = { ...entry }
  }
  const file = join(storageDir, 'config.json')
  let raw = null
  if (existsSync(file)) {
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      warn(`[dsh-warm] config.json unreadable (${String(error?.message ?? error)}); using defaults`)
      raw = null
    }
  } else {
    try {
      mkdirSync(storageDir, { recursive: true })
      writeFileSync(file, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n')
    } catch (error) {
      warn(`[dsh-warm] could not write default config.json (${String(error?.message ?? error)})`)
    }
  }
  if (raw === null || typeof raw !== 'object') return config

  const bool = (key) => {
    if (typeof raw[key] === 'boolean') config[key] = raw[key]
    else if (raw[key] !== undefined) warn(`[dsh-warm] config ${key} must be boolean; keeping ${JSON.stringify(config[key])}`)
  }
  const int = (key, validate, min = null) => {
    const value = raw[key]
    if (value === undefined) return
    if (!validate(value)) {
      warn(`[dsh-warm] config ${key} invalid (${JSON.stringify(value)}); keeping ${config[key]}`)
      return
    }
    config[key] = value
    if (min !== null && value < min) {
      warn(`[dsh-warm] config ${key}=${value} is below the sane floor ${min}; keeping ${min}`)
      config[key] = min
    }
  }
  const strings = (key) => {
    if (raw[key] === undefined) return
    if (isStringArray(raw[key])) config[key] = raw[key]
    else warn(`[dsh-warm] config ${key} must be an array of strings; keeping previous value`)
  }

  bool('enabled')
  bool('dryRun')
  bool('debug')
  int('maxPings', isPosInt)
  int('minPrefixChars', (v) => Number.isInteger(v) && v >= 0)
  int('maxConcurrentPings', isPosInt)
  int('dailyPingBudget', isPosInt)
  int('pingTimeoutMs', isPosInt, 10_000)
  strings('excludeTools')

  if (raw.providers !== undefined) {
    if (raw.providers === null || typeof raw.providers !== 'object' || Array.isArray(raw.providers)) {
      warn('[dsh-warm] config providers must be an object keyed by provider name; using defaults')
    } else {
      config.providers = {}
      for (const [name, entry] of Object.entries(raw.providers)) {
        const providerConfig = providerConfigOf(name, entry, (m) => warn(`[dsh-warm] providers["${name}"]: ${m}`))
        if (providerConfig !== null) config.providers[name] = providerConfig
      }
    }
  } else if (Array.isArray(raw.warmProviders)) {
    // Legacy shape (pre per-provider table): map the flat list onto one table,
    // through the same validation as native entries (floor + spam warn apply).
    const legacyInterval = isPosInt(raw.intervalMs) ? raw.intervalMs : DEFAULT_CONFIG.providers.mistral.intervalMs
    config.providers = {}
    for (const name of raw.warmProviders) {
      if (typeof name !== 'string') continue
      const providerConfig = providerConfigOf(name, { intervalMs: legacyInterval }, (m) => warn(`[dsh-warm] providers["${name}"]: ${m}`))
      if (providerConfig !== null) config.providers[name] = providerConfig
    }
    warn(`[dsh-warm] config migrated: warmProviders + intervalMs -> providers table (${legacyInterval} ms); edit config.json to set per-provider intervals`)
  } else if (raw.warmProviders !== undefined || raw.intervalMs !== undefined) {
    warn('[dsh-warm] config warmProviders/intervalMs ignored: use the per-provider "providers" table')
  }

  // config.json files written before stats existed carry no ttlMs: known
  // providers adopt the measured/documented default (doctrine: defaults
  // encode measurements). A user-set ttlMs is never overwritten.
  for (const [name, entry] of Object.entries(config.providers)) {
    if (entry.ttlMs === undefined && DEFAULT_CONFIG.providers[name] !== undefined) {
      entry.ttlMs = DEFAULT_CONFIG.providers[name].ttlMs
    }
  }

  // Anchored scheduling is impossible when the margin eats the whole TTL:
  // drop ttlMs (loud) and fall back to the interval grid — symmetric with
  // invalid-ttlMs handling; clamping would invent margins and spam grids.
  // marginMs stays on the entry (harmless in fallback mode).
  for (const [name, entry] of Object.entries(config.providers)) {
    if (entry.ttlMs !== undefined && entry.marginMs >= entry.ttlMs) {
      warn(`[dsh-warm] providers["${name}"]: marginMs=${entry.marginMs} >= ttlMs=${entry.ttlMs}: anchored scheduling impossible; dropping ttlMs, using the intervalMs grid`)
      delete entry.ttlMs
    }
  }

  if (raw.stats !== undefined) {
    if (raw.stats === null || typeof raw.stats !== 'object' || Array.isArray(raw.stats)) {
      warn('[dsh-warm] config stats must be an object like { "enabled": true }; using defaults')
    } else if (typeof raw.stats.enabled !== 'boolean') {
      warn(`[dsh-warm] config stats.enabled must be boolean; keeping ${JSON.stringify(config.stats.enabled)}`)
    } else {
      config.stats.enabled = raw.stats.enabled
    }
  }

  if (!config.enabled) return config
  if (Object.keys(config.providers).length === 0) warn('[dsh-warm] providers table is empty: the plugin will observe but never warm anything.')
  return config
}
