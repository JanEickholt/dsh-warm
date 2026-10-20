/**
 * dsh-warm stats: attribution of ping outcomes to warming value.
 *
 * Model — per-session chain: every real conversation request opens a chain
 * (and closes the previous one as its follow-up); pings join the open chain at
 * dispatch; a later real request closes it. A chain's ANCHORS are its t0 plus
 * the dispatch times of SUCCESSFUL pings only (failed pings refresh no cache,
 * so they never extend the warm window; they land in their own `failed`
 * aggregate). A ping is wasted-needless when the gap between its neighboring
 * anchors is under the provider TTL — the next anchor kept the prefix warm
 * without it. Otherwise it was necessary, and the chain outcome decides:
 * follow-up within TTL of the last successful ping (and that ping hit) →
 * its cacheReadTokens are credited as `savedCacheTokens`; follow-up beyond
 * that → wasted-expired; idle/disposal without follow-up → noFollowup.
 *
 * Conservative by construction: a settle arriving after the chain closed is
 * dropped (hit value unknown), miss-bridged chains are never credited (the
 * miss ping already paid the re-prefill the follow-up would have), and an
 * unsettled ping is never an anchor. The `saved` number can undercount, never
 * overcount. Stats are a pure event sink: the warmer's decisions, epochs, and
 * journal are untouched, and a disabled engine no-ops without writing.
 *
 * Persistence — stats.json is AUTHORITATIVE when present and shape-valid; the
 * journal is only ever a fresh seed (warms/failed counts) when stats.json is
 * absent or corrupt. Outcome buckets are not reconstructible from raw journal
 * lines, and chains open at a crash are dropped rather than guessed (the raw
 * lines stay in warm.jsonl for offline analysis). This keeps restarts from
 * double-counting warms the journal already holds.
 */

import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
// Bucket fields shared by every aggregate; savedCacheTokens is a token amount,
// not a count — it rides along to keep one bucket shape.
const COUNT_FIELDS = ['warms', 'needless', 'noFollowup', 'expired', 'savedCacheTokens']

const zeroCounts = () => {
  const counts = {}
  for (const field of COUNT_FIELDS) counts[field] = 0
  return counts
}

const isCountBucket = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
  && COUNT_FIELDS.every((field) => typeof value[field] === 'number')

/** A stored stats.json is trustworthy only when every bucket has the full shape. */
const shapeOk = (agg) =>
  agg !== null && typeof agg === 'object' && !Array.isArray(agg)
  && typeof agg.failed === 'number'
  && isCountBucket(agg.allTime)
  && isCountBucket(agg.today) && typeof agg.today.day === 'string' && DAY_RE.test(agg.today.day)
  && agg.byDay !== null && typeof agg.byDay === 'object' && !Array.isArray(agg.byDay)
  && Object.entries(agg.byDay).every(([day, bucket]) => DAY_RE.test(day) && isCountBucket(bucket))

/**
 * Create the stats engine. File IO follows the journal pattern (real fs,
 * only the clock injectable); all host facts stay deps for fake-clock tests.
 * @param {object} deps
 * @param {string} deps.storageDir - plugin storage directory; must exist.
 * @param {object} deps.config - resolved configuration (lib/config.js).
 * @param {() => number} [deps.now] - clock source.
 * @param {(message: string) => void} [deps.warn] - loud-failure sink.
 * @returns {{ onRealRequest: (sessionId: string, provider: string) => void, onPingDispatch: (sessionId: string) => void, onPingSettle: (sessionId: string, { ok: boolean, cacheReadTokens: number }) => void, onIdle: (sessionId: string) => void, onDispose: (sessionId: string) => void, dispose: () => void, snapshot: () => object | null }}
 */
export function createStatsEngine({ storageDir, config, now = Date.now, warn = console.warn }) {
  const disabled = config?.stats?.enabled === false
  const statsPath = join(storageDir, 'stats.json')
  const dayKey = () => new Date(now()).toISOString().slice(0, 10)
  const ttlOf = (provider) => config.providers?.[provider]?.ttlMs ?? config.providers?.[provider]?.intervalMs

  /** @type {Map<string, { t0: number, provider: string, pings: object[], closed: boolean }>} sessionId -> open chain. */
  const chains = new Map()
  let stats = null

  const persist = () => {
    try {
      writeFileSync(`${statsPath}.tmp`, `${JSON.stringify(stats)}\n`)
      renameSync(`${statsPath}.tmp`, statsPath)
    } catch (error) {
      warn(`[dsh-warm] stats.json write failed: ${String(error?.message ?? error)}`)
    }
  }

  /** UTC-day rollover (journal self-rollover doctrine): reset today on any touch. */
  const dayCheck = () => {
    const day = dayKey()
    if (stats.today.day !== day) stats.today = { day, ...zeroCounts() }
    return day
  }

  const add = (field, amount = 1, { persistNow = true } = {}) => {
    if (field === 'failed') {
      stats.failed += amount
      if (persistNow) persist()
      return
    }
    const day = dayCheck()
    if (stats.byDay[day] === undefined) stats.byDay[day] = zeroCounts()
    stats.today[field] += amount
    stats.allTime[field] += amount
    stats.byDay[day][field] += amount
    if (persistNow) persist()
  }

  /** Fresh seed from the ping journal: only warms/failed are reconstructible. */
  const seedFromJournal = () => {
    const agg = { today: { day: dayKey(), ...zeroCounts() }, allTime: zeroCounts(), byDay: {}, failed: 0 }
    let names = []
    try {
      names = readdirSync(storageDir)
    } catch {
      return agg
    }
    for (const name of names) {
      if (name !== 'warm.jsonl' && !name.startsWith('warm.jsonl.')) continue
      let text = ''
      try {
        text = readFileSync(join(storageDir, name), 'utf8')
      } catch {
        continue
      }
      for (const line of text.split('\n')) {
        if (line.length === 0) continue
        let entry = null
        try {
          entry = JSON.parse(line)
        } catch {
          continue
        }
        if (entry?.counted !== true || entry.dryRun === true) continue
        // The journal stamps the UTC day at write time (its own budget uses
        // it); prefer that over the dispatch-start ts slice so a ping
        // straddling midnight seeds into the same day the journal accounted.
        const day = typeof entry.day === 'string' && DAY_RE.test(entry.day)
          ? entry.day
          : typeof entry.ts === 'string' ? entry.ts.slice(0, 10) : ''
        if (!DAY_RE.test(day)) continue
        if (agg.byDay[day] === undefined) agg.byDay[day] = zeroCounts()
        agg.byDay[day].warms++
        agg.allTime.warms++
        if (entry.ok === false) agg.failed++
      }
    }
    const day = dayKey()
    agg.today = agg.byDay[day] !== undefined ? { day, ...agg.byDay[day] } : { day, ...zeroCounts() }
    return agg
  }

  const boot = () => {
    let loaded = null
    if (existsSync(statsPath)) {
      try {
        const parsed = JSON.parse(readFileSync(statsPath, 'utf8'))
        if (shapeOk(parsed)) loaded = parsed
        else warn('[dsh-warm] stats.json has an unexpected shape; reseeding from the journal')
      } catch (error) {
        warn(`[dsh-warm] stats.json unreadable (${String(error?.message ?? error)}); reseeding from the journal`)
      }
    }
    if (loaded !== null) {
      stats = loaded
      dayCheck()
      return
    }
    stats = seedFromJournal()
    persist()
  }

  /**
   * Close a session's open chain. FOLLOW-UP partitions pings against the
   * anchor grid; NO-FOLLOWUP buckets every non-failed ping as noFollowup.
   */
  const closeChain = (sessionId, tNext, followup) => {
    const chain = chains.get(sessionId)
    if (chain === undefined || chain.closed) return
    chain.closed = true
    chains.delete(sessionId)
    const ttl = ttlOf(chain.provider)
    const anchors = [chain.t0]
    let lastSuccess = null
    for (const ping of chain.pings) {
      if (ping.settled && ping.ok === true) {
        anchors.push(ping.ts)
        lastSuccess = ping
      }
    }
    anchors.push(tNext)
    anchors.sort((a, b) => a - b)
    const held = followup && lastSuccess !== null && tNext - lastSuccess.ts < ttl
    let anyNecessary = false
    let attributed = false
    for (const ping of chain.pings) {
      if (ping.settled && ping.ok === false) {
        add('failed', 1, { persistNow: false })
        attributed = true
        continue
      }
      if (!followup) {
        add('noFollowup', 1, { persistNow: false })
        attributed = true
        continue
      }
      let prev = null
      let next = null
      for (const anchor of anchors) {
        if (anchor < ping.ts && (prev === null || anchor > prev)) prev = anchor
        if (anchor > ping.ts && (next === null || anchor < next)) next = anchor
      }
      // Missing anchor (degenerate timestamps): not provably needless → necessary.
      if (prev !== null && next !== null && next - prev < ttl) {
        add('needless', 1, { persistNow: false })
        attributed = true
        continue
      }
      anyNecessary = true
      if (!held) {
        add('expired', 1, { persistNow: false })
        attributed = true
      }
    }
    if (followup && held && anyNecessary && lastSuccess.cacheReadTokens > 0) {
      add('savedCacheTokens', lastSuccess.cacheReadTokens, { persistNow: false })
      attributed = true
    }
    if (attributed) persist()
  }

  if (!disabled) boot()

  return {
    /** Real conversation request: closes the previous chain, opens the next. */
    onRealRequest(sessionId, provider) {
      if (disabled) return
      const tNow = now()
      closeChain(sessionId, tNow, true)
      chains.set(sessionId, { t0: tNow, provider, pings: [], closed: false })
    },

    /** Ping left the nest. Membership is frozen here; warms count at dispatch. */
    onPingDispatch(sessionId) {
      if (disabled) return
      const chain = chains.get(sessionId)
      if (chain === undefined || chain.closed) return
      chain.pings.push({ ts: now(), settled: false, ok: null, cacheReadTokens: null })
      add('warms')
    },

    /** Ping outcome. A settle for a closed chain is dropped (hit value lost, conservative). */
    onPingSettle(sessionId, { ok, cacheReadTokens }) {
      if (disabled) return
      const chain = chains.get(sessionId)
      if (chain === undefined || chain.closed) return
      for (let i = chain.pings.length - 1; i >= 0; i--) {
        if (chain.pings[i].settled === false) {
          chain.pings[i].settled = true
          chain.pings[i].ok = ok
          chain.pings[i].cacheReadTokens = cacheReadTokens ?? 0
          return
        }
      }
    },

    /** Turn ended without a follow-up request: idle-close is final. */
    onIdle(sessionId) {
      if (disabled) return
      closeChain(sessionId, now(), false)
    },

    /** Session/agent gone: no-followup, then forget the chain. */
    onDispose(sessionId) {
      if (disabled) return
      closeChain(sessionId, now(), false)
      chains.delete(sessionId)
    },

    /** Host teardown: persist, drop open chains WITHOUT attribution (crash-safe). */
    dispose() {
      if (disabled) return
      chains.clear()
      persist()
    },

    /** Current aggregates (deep copy); null while stats are disabled. */
    snapshot() {
      if (disabled || stats === null) return null
      dayCheck()
      return JSON.parse(JSON.stringify(stats))
    },
  }
}
