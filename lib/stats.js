/**
 * dsh-warm stats: attribution of ping outcomes to warming value.
 *
 * Model — per-session chain: every real conversation request opens a chain
 * (and closes the previous one as its follow-up); pings join the open chain
 * at dispatch; a later real request closes it. NECESSITY is judged per CHAIN,
 * not per ping: a follow-up arriving past `t0 + ttl` would have missed the
 * cache with zero pings (the TTL floor is what the cache alone survives), so
 * the chain verifiably bought the hit. Inside a necessary chain a successful
 * ping is held when the follow-up landed within TTL of it (the last such
 * ping's cacheReadTokens are credited as `savedCacheTokens`), expired when
 * even the last successful ping's cover had lapsed. A follow-up before
 * `t0 + ttl` is warm-anyway — every ping needless, however dense the grid:
 * each ping is only individually bridgeable because its NEIGHBOR would have
 * carried the prefix, but the request itself already did. Failed pings
 * refresh no cache, so they land in their own `failed` aggregate;
 * idle/disposal without follow-up buckets every non-failed ping as
 * noFollowup.
 *
 * Token ledger (schema 3) — every aggregate also carries a per-model split:
 * each ping's own cache-read tokens land in `pingCacheReadTokens` under its
 * outcome (`held` = necessary + held chain: cost that bought the credited
 * follow-up), its uncached input tokens in flat `pingUncachedTokens` (raw
 * spend needs no outcome split), and failed pings' observed usage in
 * `failedPingTokens` — all-time, kept both flat and per model. The flat
 * field is the complete all-time total (authoritative for rows written
 * before the per-model maps); post-upgrade increments keep the per-model
 * sums equal — pre-upgrade rows can widen the gap. Flat
 * count fields stay totals across models; dsh-warm ships tokens only —
 * the client holds the price book. A bounded `sessions` map (allTime-shaped
 * buckets for the 50 most-recently-active sessions) carries each session's
 * own story; the recency ts behind the bound is internal and never
 * reaches the wire.
 *
 * Conservative by construction: a settle arriving after the chain closed is
 * dropped (hit value unknown), miss-bridged chains are never credited (the
 * miss ping already paid the re-prefill the follow-up would have), and an
 * unsettled ping at close prices as zero tokens. The `saved` number can
 * undercount, never overcount. Stats are a pure event sink: the warmer's
 * decisions, epochs, and journal are untouched, and a disabled engine no-ops
 * without writing.
 *
 * Persistence — stats.json is AUTHORITATIVE when present and shape-valid; the
 * journal is only ever a fresh seed (warms/failed counts plus the raw-token
 * basis) when stats.json is absent or corrupt. Outcome buckets are not
 * reconstructible from raw journal lines, and chains open at a crash are
 * dropped rather than guessed (the raw lines stay in warm.jsonl for offline
 * analysis). Files written before schema 2/3 load as-is: absent `models`/
 * `sessions` maps, `failedPingTokens`, and per-model `failedPingTokens`
 * maps are zero-seeded, never wiped. This keeps restarts from
 * double-counting warms the journal already holds.
 */

import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
// Bucket fields shared by every aggregate; savedCacheTokens is a token amount,
// not a count — it rides along to keep one bucket shape.
const COUNT_FIELDS = ['warms', 'needless', 'noFollowup', 'expired', 'savedCacheTokens']
// Per-model ping-token outcomes. `held` is not a count bucket (useful pings
// are warms - failed - wasted); only their tokens are tracked.
const PING_OUTCOMES = ['held', 'needless', 'noFollowup', 'expired']
// Session ledger bound: only the most-recently-active session buckets persist;
// pruned sessions keep their today/allTime/byDay numbers.
const MAX_SESSIONS = 50

const zeroCountFields = () => {
  const counts = {}
  for (const field of COUNT_FIELDS) counts[field] = 0
  return counts
}

const zeroModelCounts = () => ({
  ...zeroCountFields(),
  pingCacheReadTokens: { held: 0, needless: 0, noFollowup: 0, expired: 0 },
  pingUncachedTokens: 0,
  failedPingTokens: { cacheRead: 0, uncached: 0 },
})

const zeroCounts = () => ({ ...zeroCountFields(), models: {} })

/** Per-session slice: an allTime-shaped bucket plus the INTERNAL recency ts. */
const zeroSessionBucket = () => ({ ...zeroCounts(), lastAt: 0 })

const isCountBucket = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
  && COUNT_FIELDS.every((field) => typeof value[field] === 'number')

const isTokenSplit = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
  && PING_OUTCOMES.every((field) => typeof value[field] === 'number')

// Optional on disk (pre-schema-3 files): zero-seeded on adopt, never wiped.
const isFailedTokens = (value) => value === undefined
  || (value !== null && typeof value === 'object' && !Array.isArray(value)
    && typeof value.cacheRead === 'number' && typeof value.uncached === 'number')

const isModelBucket = (value) => isCountBucket(value)
  && typeof value.pingUncachedTokens === 'number' && isTokenSplit(value.pingCacheReadTokens)
  && isFailedTokens(value.failedPingTokens)

// `models` and `failedPingTokens` are optional on disk: files written before
// schema 2 validate without them and are zero-seeded on adopt.
const isModelsMap = (value) => value === undefined
  || (value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.values(value).every(isModelBucket))

const isBucket = (value) => isCountBucket(value) && isModelsMap(value.models)

// `sessions` is optional on disk exactly like `models`: files written before
// the sessions amendment validate without it and get an empty map on adopt.
const isSessionBucket = (value) => isBucket(value)
  && (value.lastAt === undefined || typeof value.lastAt === 'number')

const isSessionsMap = (value) => value === undefined
  || (value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.values(value).every(isSessionBucket))

/** A stored stats.json is trustworthy only when every bucket has the full shape. */
const shapeOk = (agg) =>
  agg !== null && typeof agg === 'object' && !Array.isArray(agg)
  && typeof agg.failed === 'number' && isFailedTokens(agg.failedPingTokens)
  && isBucket(agg.allTime)
  && isBucket(agg.today) && typeof agg.today.day === 'string' && DAY_RE.test(agg.today.day)
  && isSessionsMap(agg.sessions)
  && agg.byDay !== null && typeof agg.byDay === 'object' && !Array.isArray(agg.byDay)
  && Object.entries(agg.byDay).every(([day, bucket]) => DAY_RE.test(day) && isBucket(bucket))

/**
 * Create the stats engine. File IO follows the journal pattern (real fs,
 * only the clock injectable); all host facts stay deps for fake-clock tests.
 * @param {object} deps
 * @param {string} deps.storageDir - plugin storage directory; must exist.
 * @param {object} deps.config - resolved configuration (lib/config.js).
 * @param {() => number} [deps.now] - clock source.
 * @param {(message: string) => void} [deps.warn] - loud-failure sink.
 * @param {(event: object) => void} [deps.debug] - event-trace sink (config debug:true).
 * @returns {{ onRealRequest: (sessionId: string, provider: string) => void, onPingDispatch: (sessionId: string, model: string | null) => void, onPingSettle: (sessionId: string, outcome: { ok: boolean, cacheReadTokens: number, uncachedTokens?: number, model?: string | null }) => void, onIdle: (sessionId: string) => void, onDispose: (sessionId: string) => void, dispose: () => void, snapshot: () => object | null }}
 */
export function createStatsEngine({ storageDir, config, now = Date.now, warn = console.warn, debug = null }) {
  const disabled = config?.stats?.enabled === false
  const statsPath = join(storageDir, 'stats.json')
  const dayKey = () => new Date(now()).toISOString().slice(0, 10)
  const ttlOf = (provider) => config.providers?.[provider]?.ttlMs ?? config.providers?.[provider]?.intervalMs
  // Model ids come from the captured request; anything else still counts
  // (flat totals keep their meaning) under one honest bucket.
  const modelOf = (model) => (typeof model === 'string' && model.length > 0 ? model : 'unknown')

  /** @type {Map<string, { t0: number, provider: string, pings: object[], closed: boolean }>} sessionId -> open chain. */
  const chains = new Map()
  let stats = null

  // Per-process temp name: two hosts sharing one DSH_HOME (a second profile
  // run side by side) must never truncate each other's half-written temp —
  // an interleaved file renamed into place would fail shapeOk and reseed,
  // losing every outcome counter (those are not reconstructible).
  const tmpPath = `${statsPath}.${process.pid}.tmp`

  const persist = () => {
    try {
      pruneSessions(stats.sessions)
      writeFileSync(tmpPath, `${JSON.stringify(stats)}\n`)
      renameSync(tmpPath, statsPath)
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

  /** The byDay bucket for today, created on first increment. */
  const dayBucketOf = () => {
    const day = dayCheck()
    if (stats.byDay[day] === undefined) stats.byDay[day] = zeroCounts()
    return day
  }

  /** Per-model slice of an aggregate, created on demand. */
  const modelBucketOf = (bucket, model) => {
    let entry = bucket.models[model]
    if (entry === undefined) {
      entry = zeroModelCounts()
      bucket.models[model] = entry
    }
    return entry
  }

  /** Per-session slice; every attribution refreshes the recency ts. */
  const sessionBucketOf = (sid) => {
    let entry = stats.sessions[sid]
    if (entry === undefined) {
      entry = zeroSessionBucket()
      stats.sessions[sid] = entry
    }
    entry.lastAt = now()
    return entry
  }

  /** Bounded session ledger: keep the MAX_SESSIONS most-recently-active. */
  const pruneSessions = (sessions) => {
    const entries = Object.entries(sessions)
    if (entries.length <= MAX_SESSIONS) return
    entries.sort((a, b) => b[1].lastAt - a[1].lastAt)
    for (const [sid] of entries.slice(MAX_SESSIONS)) delete sessions[sid]
  }

  const add = (field, amount = 1, { persistNow = true, model = null, sid = null } = {}) => {
    if (field === 'failed') {
      stats.failed += amount
      if (persistNow) persist()
      return
    }
    const day = dayBucketOf()
    const targets = [stats.today, stats.allTime, stats.byDay[day]]
    if (sid !== null) targets.push(sessionBucketOf(sid))
    for (const bucket of targets) bucket[field] += amount
    if (model !== null) {
      for (const bucket of targets) modelBucketOf(bucket, model)[field] += amount
    }
    if (persistNow) persist()
  }

  /** Ping token sums onto the per-model splits of today/allTime/byDay/sessions. */
  const addPingTokens = (model, outcome, cacheRead, uncached, sid = null) => {
    if (cacheRead <= 0 && uncached <= 0) return
    const day = dayBucketOf()
    const targets = [stats.today, stats.allTime, stats.byDay[day]]
    if (sid !== null) targets.push(sessionBucketOf(sid))
    for (const bucket of targets) {
      const entry = modelBucketOf(bucket, model)
      if (cacheRead > 0) entry.pingCacheReadTokens[outcome] += cacheRead
      if (uncached > 0) entry.pingUncachedTokens += uncached
    }
  }

  /** Fresh seed from the ping journal: warms/failed plus the raw-token basis are reconstructible; outcome buckets are not. */
  const seedFromJournal = () => {
    const agg = {
      today: { day: dayKey(), ...zeroCounts() },
      allTime: zeroCounts(),
      byDay: {},
      failed: 0,
      failedPingTokens: { cacheRead: 0, uncached: 0 },
      sessions: {},
    }
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
        const model = modelOf(entry.model)
        // Uncached input is the raw-price basis; lines pre-dating the field seed as 0.
        const uncached = typeof entry.uncachedInputTokens === 'number' ? entry.uncachedInputTokens : 0
        for (const bucket of [agg.byDay[day], agg.allTime]) {
          bucket.warms++
          modelBucketOf(bucket, model).warms++
        }
        // Per-session warms reconstruct from the journal's sessionId; the line
        // ts doubles as the recency floor (outcome buckets are not seedable).
        if (typeof entry.sessionId === 'string' && entry.sessionId.length > 0) {
          let session = agg.sessions[entry.sessionId]
          if (session === undefined) {
            session = zeroSessionBucket()
            agg.sessions[entry.sessionId] = session
          }
          session.warms++
          modelBucketOf(session, model).warms++
          const tsMs = Date.parse(entry.ts)
          if (Number.isFinite(tsMs) && tsMs > session.lastAt) session.lastAt = tsMs
        }
        if (entry.ok === false) {
          agg.failed++
          // Per line, flat AND per model: the journal carries the model, so the
          // reseed never needs single-model inference (schema 3).
          const failedEntry = modelBucketOf(agg.allTime, model)
          if (typeof entry.cacheReadTokens === 'number') {
            agg.failedPingTokens.cacheRead += entry.cacheReadTokens
            failedEntry.failedPingTokens.cacheRead += entry.cacheReadTokens
          }
          if (uncached > 0) {
            agg.failedPingTokens.uncached += uncached
            failedEntry.failedPingTokens.uncached += uncached
          }
        } else if (uncached > 0) {
          for (const bucket of [agg.byDay[day], agg.allTime]) modelBucketOf(bucket, model).pingUncachedTokens += uncached
        }
      }
    }
    pruneSessions(agg.sessions)
    const day = dayKey()
    // Deep-copy the models map: today must mirror byDay, not share it (a
    // shared reference would double-count every per-model increment).
    agg.today = agg.byDay[day] !== undefined
      ? { day, ...agg.byDay[day], models: JSON.parse(JSON.stringify(agg.byDay[day].models)) }
      : { day, ...zeroCounts() }
    return agg
  }

  /** Old files (pre-schema-2/3) adopt as-is: absent maps are zero-seeded, never wiped. */
  const normalize = (agg) => {
    const buckets = [agg.today, agg.allTime, ...Object.values(agg.byDay)]
    if (agg.sessions !== undefined) buckets.push(...Object.values(agg.sessions))
    for (const bucket of buckets) {
      if (bucket.models === undefined) bucket.models = {}
      // Schema-3 amendment: per-model failed-token maps start at 0; the flat
      // field keeps the legacy totals (authoritative for pre-upgrade rows).
      for (const entry of Object.values(bucket.models)) {
        if (entry.failedPingTokens === undefined) entry.failedPingTokens = { cacheRead: 0, uncached: 0 }
      }
    }
    if (agg.failedPingTokens === undefined) agg.failedPingTokens = { cacheRead: 0, uncached: 0 }
    if (agg.sessions === undefined) agg.sessions = {}
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
      stats = normalize(loaded)
      dayCheck()
      return
    }
    stats = seedFromJournal()
    persist()
  }

  /**
   * Close a session's open chain. FOLLOW-UP judges the chain as a whole:
   * necessary iff `tNext - t0 >= ttl` — with zero pings the cache would have
   * dropped by then, so some ping bought the hit. Non-failed pings partition
   * as needless (chain was warm-anyway), held (necessary + within TTL of the
   * last successful ping — no count bucket, useful = warms - failed -
   * wasted), or expired. NO-FOLLOWUP buckets every non-failed ping as
   * noFollowup. Counts and ping-token sums attribute together, per model.
   */
  const closeChain = (sessionId, tNext, followup) => {
    const chain = chains.get(sessionId)
    if (chain === undefined || chain.closed) {
      debug?.({ ev: 'chain.close', sid: sessionId, followup, found: chain !== undefined, closed: chain?.closed ?? null, pings: chain?.pings.length ?? null })
      return
    }
    chain.closed = true
    chains.delete(sessionId)
    const ttl = ttlOf(chain.provider)
    const gap = tNext - chain.t0
    // Chain-level necessity: with zero pings the cache died at t0 + ttl.
    const necessary = followup && gap >= ttl
    let lastSuccess = null
    for (const ping of chain.pings) {
      if (ping.settled && ping.ok === true) lastSuccess = ping
    }
    const held = followup && lastSuccess !== null && tNext - lastSuccess.ts < ttl
    let anyNecessary = false
    let attributed = false
    const outcome = {
      needless: 0,
      expired: 0,
      noFollowup: 0,
      failed: 0,
      savedCacheTokens: 0,
      pingCacheReadTokens: { held: 0, needless: 0, noFollowup: 0, expired: 0 },
      pingUncachedTokens: 0,
      failedPingTokens: { cacheRead: 0, uncached: 0 },
    }
    for (const ping of chain.pings) {
      const model = ping.model
      const cacheRead = ping.cacheReadTokens ?? 0
      const uncached = ping.uncachedTokens ?? 0
      if (ping.settled && ping.ok === false) {
        // Failed pings never partition; observed usage still prices them —
        // all-time, flat AND per model (schema 3). Flat is the complete
        // total (pre-upgrade rows may widen the gap); post-upgrade
        // increments keep the sums equal.
        add('failed', 1, { persistNow: false })
        stats.failedPingTokens.cacheRead += cacheRead
        stats.failedPingTokens.uncached += uncached
        const failedEntry = modelBucketOf(stats.allTime, model)
        failedEntry.failedPingTokens.cacheRead += cacheRead
        failedEntry.failedPingTokens.uncached += uncached
        outcome.failed++
        outcome.failedPingTokens.cacheRead += cacheRead
        outcome.failedPingTokens.uncached += uncached
        attributed = true
        continue
      }
      let pingOutcome = 'held' // necessary + held chain: cost that bought the follow-up
      if (!followup) {
        add('noFollowup', 1, { persistNow: false, model, sid: sessionId })
        outcome.noFollowup++
        pingOutcome = 'noFollowup'
      } else if (!necessary) {
        // Warm-anyway: the follow-up beat t0 + ttl, so the cache the real
        // request left behind carried it — no ping bought anything.
        add('needless', 1, { persistNow: false, model, sid: sessionId })
        outcome.needless++
        pingOutcome = 'needless'
      } else {
        anyNecessary = true
        if (!held) {
          add('expired', 1, { persistNow: false, model, sid: sessionId })
          outcome.expired++
          pingOutcome = 'expired'
        }
      }
      // The ping's own tokens ride its outcome; uncached input is flat raw spend.
      if (cacheRead > 0 || uncached > 0) {
        addPingTokens(model, pingOutcome, cacheRead, uncached, sessionId)
        if (cacheRead > 0) outcome.pingCacheReadTokens[pingOutcome] += cacheRead
        outcome.pingUncachedTokens += uncached
        attributed = true
      }
    }
    if (followup && held && anyNecessary && lastSuccess.cacheReadTokens > 0) {
      add('savedCacheTokens', lastSuccess.cacheReadTokens, { persistNow: false, model: lastSuccess.model, sid: sessionId })
      outcome.savedCacheTokens = lastSuccess.cacheReadTokens
      attributed = true
    }
    if (attributed) persist()
    debug?.({
      ev: 'chain.close',
      sid: sessionId,
      followup,
      pings: chain.pings.length,
      ttl,
      gap,
      held,
      anyNecessary,
      outcome,
    })
  }

  if (!disabled) boot()

  return {
    /** Real conversation request: closes the previous chain, opens the next. */
    onRealRequest(sessionId, provider) {
      if (disabled) return
      const tNow = now()
      debug?.({ ev: 'chain.open', sid: sessionId, provider })
      closeChain(sessionId, tNow, true)
      chains.set(sessionId, { t0: tNow, provider, pings: [], closed: false })
    },

    /**
     * Ping left the nest. Membership is frozen here; warms count at dispatch
     * (flat and per model, in lockstep) so a dropped settle can never
     * desynchronize post-upgrade increments.
     */
    onPingDispatch(sessionId, model = null) {
      if (disabled) return
      const chain = chains.get(sessionId)
      debug?.({ ev: 'chain.ping', sid: sessionId, found: chain !== undefined, closed: chain?.closed ?? null, pings: chain?.pings.length ?? null })
      if (chain === undefined || chain.closed) return
      const norm = modelOf(model)
      chain.pings.push({ ts: now(), settled: false, ok: null, cacheReadTokens: null, uncachedTokens: null, model: norm })
      add('warms', 1, { model: norm, sid: sessionId })
    },

    /** Ping outcome. A settle for a closed chain is dropped (hit value lost, conservative). */
    onPingSettle(sessionId, { ok, cacheReadTokens, uncachedTokens = 0, model = null }) {
      if (disabled) return
      const chain = chains.get(sessionId)
      if (chain === undefined || chain.closed) {
        debug?.({ ev: 'chain.settle', sid: sessionId, ok, found: chain !== undefined, closed: chain?.closed ?? null, dropped: true })
        return
      }
      for (let i = chain.pings.length - 1; i >= 0; i--) {
        if (chain.pings[i].settled === false) {
          chain.pings[i].settled = true
          chain.pings[i].ok = ok
          chain.pings[i].cacheReadTokens = cacheReadTokens ?? 0
          chain.pings[i].uncachedTokens = uncachedTokens ?? 0
          if (modelOf(model) !== 'unknown') chain.pings[i].model = modelOf(model)
          debug?.({ ev: 'chain.settle', sid: sessionId, ok, cacheReadTokens: chain.pings[i].cacheReadTokens, uncachedTokens: chain.pings[i].uncachedTokens, index: i, dropped: false })
          return
        }
      }
      debug?.({ ev: 'chain.settle', sid: sessionId, ok, dropped: true, reason: 'no-unsettled-ping' })
    },

    /** Turn ended without a follow-up request: idle-close is final. */
    onIdle(sessionId) {
      if (disabled) return
      debug?.({ ev: 'chain.idle', sid: sessionId })
      closeChain(sessionId, now(), false)
    },

    /** Session/agent gone: no-followup, then forget the chain. */
    onDispose(sessionId) {
      if (disabled) return
      debug?.({ ev: 'chain.dispose', sid: sessionId })
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
      const copy = JSON.parse(JSON.stringify(stats))
      // The wire is contract-pure: the internal recency ts never leaves.
      for (const bucket of Object.values(copy.sessions)) delete bucket.lastAt
      return copy
    },
  }
}
