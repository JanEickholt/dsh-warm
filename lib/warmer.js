/**
 * dsh-warm state machine: per-session prompt-cache warming.
 *
 * Trigger window — the session's agent loop is blocked inside a tool
 * execution (`tools/execute` entered, not yet settled). Resume after a tool
 * is certain (the loop immediately builds the next request from the warmed
 * prefix), which is what makes these pings profitable; idle sessions and
 * user-input tools are never warmed (their resume is speculative, and the
 * tails dominate there).
 *
 * Replay — re-dispatch the session's LAST conversation request through the
 * host `llm/stream` waterfall with `maxTokens: 1`. The captured options
 * arrive deep-frozen from the loop (pure function of the session log); the
 * ping payload is a fresh shallow copy sharing those frozen fields, so the
 * provider serializes the identical input prefix while `max_tokens` (a
 * sampling field, not part of the cached prefix) caps output at one token.
 * This is the same cache-reusing auxiliary-call pattern compaction-basic
 * uses for summarization. The ping traverses the full waterfall, so routing
 * and cost-meter billing behave exactly as for a real call.
 */

/**
 * Create the warmer. All host facts are injected for testability.
 * @param {object} deps
 * @param {{ stream: (options: object) => AsyncIterable<object> }} deps.llm - the host `llm` service.
 * @param {object} deps.config - resolved configuration (lib/config.js).
 * @param {{ record: (entry: object) => void, pingsToday: () => number, path: string }} deps.journal
 * @param {{ onRealRequest: (sessionId: string, provider: string) => void, onPingDispatch: (sessionId: string, model: string | null) => void, onPingSettle: (sessionId: string, outcome: { ok: boolean, cacheReadTokens: number, uncachedTokens?: number, model?: string | null }) => void, onIdle: (sessionId: string) => void, onDispose: (sessionId: string) => void } | null} [deps.stats] - stats event sink (lib/stats.js); pure observer.
 * @param {() => number} [deps.now] - clock source.
 * @param {(cb: () => void, ms: number) => unknown} [deps.setTimer]
 * @param {(id: unknown) => void} [deps.clearTimer]
 * @param {(ms: number) => AbortSignal} [deps.signal]
 * @param {(signals: AbortSignal[]) => AbortSignal} [deps.combineSignals] - chains the captured call's signal with the ping timeout.
 * @param {(message: string) => void} [deps.warn]
 * @param {(event: object) => void} [deps.debug] - event-trace sink (config debug:true).
 * @returns warm event handlers + dispose.
 */
export function createWarmer({ llm, config, journal, stats = null, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, signal = (ms) => AbortSignal.timeout(ms), combineSignals = (signals) => AbortSignal.any(signals), warn = console.warn, debug = null }) {
  /** @type {Map<string, object>} sessionId -> warm state. */
  const sessions = new Map()
  /** Ping payloads we dispatched ourselves; the capture listener skips them. */
  const pingPayloads = new WeakSet()
  let inFlight = 0
  let warnCount = 0
  let budgetWarned = false
  let disposed = false

  const stateOf = (sessionId) => {
    let st = sessions.get(sessionId)
    if (st === undefined) {
      // `epoch` invalidates pings still in flight when their state is
      // superseded (new capture, idle, disposal): the settle path must not
      // count them onto, or re-arm, the new epoch.
      // `pingEpoch` is the epoch of this session's ping currently in flight
      // (null when none): its settle path re-arms, so armTimer must not
      // schedule a duplicate meanwhile. `prefixChars` is computed lazily.
      // `refreshBase` is the ts of the last PROOF of warmth (captured request,
      // successful ping dispatch, dry-run ping): the anchored due is
      // base + ttl - margin, and only those three sites may write it.
      st = { lastOptions: null, lastRequestAt: 0, outstanding: 0, pings: 0, prefixChars: null, epoch: 0, pingEpoch: null, timerId: null, running: undefined, refreshBase: 0 }
      sessions.set(sessionId, st)
    }
    return st
  }

  const cancelTimer = (st) => {
    if (st.timerId !== null) {
      clearTimer(st.timerId)
      st.timerId = null
    }
  }

  const estimatePrefixChars = (options) => {
    try {
      const system = options.system ?? ''
      return JSON.stringify(options.messages ?? []).length
        + (typeof system === 'string' ? system.length : JSON.stringify(system).length)
    } catch {
      // Non-serializable content: assume large (never block warming on it).
      return Number.MAX_SAFE_INTEGER
    }
  }

  /**
   * Prefix size of the captured request, serialized at most once per capture
   * and only once a warmable provider actually reaches the size gate — not on
   * every conversation request through the waterfall.
   */
  const prefixCharsOf = (st) => {
    if (st.prefixChars === null) st.prefixChars = estimatePrefixChars(st.lastOptions)
    return st.prefixChars
  }

  /** The provider's warming rule, or null when it is not in the table (never warmed). */
  const providerConfigOf = (options) => {
    const provider = options?.provider
    if (typeof provider !== 'string' || provider.length === 0) return null
    const table = config.providers ?? {}
    if (!Object.hasOwn(table, provider)) return null
    return table[provider]
  }

  const budgetExceeded = () => {
    // In-flight pings are already committed dispatch attempts that journal as
    // counted on settle; include them so concurrent pings cannot overshoot.
    if (journal.pingsToday() + inFlight < config.dailyPingBudget) {
      // Re-arm the warning for the next time the budget runs out (next UTC day).
      budgetWarned = false
      return false
    }
    if (!budgetWarned) {
      budgetWarned = true
      warn(`[dsh-warm] daily ping budget ${config.dailyPingBudget} reached; warming paused until tomorrow (journal: ${journal.path})`)
    }
    return true
  }

  /** Schedule the next ping if every gate is open; idempotent per session. */
  const armTimer = (st, sessionId) => {
    if (disposed || !config.enabled || st.timerId !== null || st.outstanding <= 0) return
    if (st.lastOptions === null || st.pingEpoch === st.epoch) return
    const providerConfig = providerConfigOf(st.lastOptions)
    if (providerConfig === null) return
    const maxPings = providerConfig.maxPings ?? config.maxPings
    if (st.pings >= maxPings) return
    if (st.running === false) return
    if (budgetExceeded()) return
    if (prefixCharsOf(st) < config.minPrefixChars) return
    let delay
    if (providerConfig.ttlMs !== undefined) {
      // Anchored: fire `marginMs` before the cache dies at base + ttl. A due
      // already past after an attempt (failed ping moved nothing, degenerate
      // round trip) means retry one margin-half out, never a tight loop —
      // pings/budget bound it. With no attempt yet the tool merely opened
      // late (the response streamed past the due): the margin is already
      // being eaten, so fire now instead of spending half of what is left.
      delay = st.refreshBase + providerConfig.ttlMs - providerConfig.marginMs - now()
      if (delay < 0) delay = st.pings === 0 ? 1000 : Math.max(1000, Math.floor(providerConfig.marginMs / 2))
    } else {
      // No measured TTL: the legacy interval grid, unchanged.
      delay = st.lastRequestAt + (st.pings + 1) * providerConfig.intervalMs - now()
      if (delay < 0) delay = 1000
    }
    st.timerId = setTimer(() => {
      st.timerId = null
      void fire(st, sessionId)
    }, delay)
  }

  const fire = async (st, sessionId) => {
    if (disposed || config.enabled === false) return
    if (st.outstanding <= 0 || st.running === false || st.lastOptions === null) return
    const epoch = st.epoch
    const providerConfig = providerConfigOf(st.lastOptions)
    if (providerConfig === null) return
    const maxPings = providerConfig.maxPings ?? config.maxPings
    if (st.pings >= maxPings) return
    if (budgetExceeded()) return
    if (prefixCharsOf(st) < config.minPrefixChars) return

    const ts = new Date(now()).toISOString()
    if (config.dryRun) {
      st.pings++
      // Dry pings prove nothing, but they PREVIEW the schedule: move the
      // base so the anchored cadence shows up instead of the clamp loop.
      st.refreshBase = now()
      journal.record({ ts, sessionId, provider: st.lastOptions.provider, model: st.lastOptions.model, dryRun: true, counted: false })
      armTimer(st, sessionId)
      return
    }
    if (inFlight >= config.maxConcurrentPings) {
      // Full right now: retry shortly without consuming a ping slot.
      st.timerId = setTimer(() => {
        st.timerId = null
        void fire(st, sessionId)
      }, 5000)
      return
    }

    // Chain the captured call's signal (user interrupt aborts the ping too)
    // with the ping timeout; the payload still shares all frozen prefix fields.
    const baseSignal = st.lastOptions.signal instanceof AbortSignal ? st.lastOptions.signal : null
    // The captured call was already aborted (user interrupt): the ping would
    // abort instantly yet still burn budget, and that signal never recovers.
    if (baseSignal?.aborted) return
    const timeoutSignal = signal(config.pingTimeoutMs)
    const payload = { ...st.lastOptions, maxTokens: 1, signal: baseSignal === null ? timeoutSignal : combineSignals([baseSignal, timeoutSignal]) }
    pingPayloads.add(payload)
    st.pingEpoch = epoch
    debug?.({ ev: 'ping.dispatch', sid: sessionId, epoch, model: payload.model ?? null })
    stats?.onPingDispatch(sessionId, payload.model)
    const startedAt = now()
    let usage = null
    let thrown = null
    let finish = null
    inFlight++
    try {
      for await (const chunk of llm.stream(payload)) {
        if (chunk?.type === 'usage' && chunk.usage != null) usage = chunk.usage
        else if (chunk?.type === 'finish') {
          if (finish === null) finish = chunk
          // Adapters that attach usage only to the terminal chunk still price.
          if (chunk.usage != null) usage = chunk.usage
        }
      }
    } catch (e) {
      // Pre-iteration failures still throw; adapter/dispatch failures arrive
      // as terminal finish chunks carrying `reason.failure` instead.
      thrown = e
    } finally {
      inFlight--
      if (st.pingEpoch === epoch) st.pingEpoch = null
    }
    // A successful maxTokens:1 ping finishes `max-tokens`; error/aborted carry failure.
    const failure = finish?.reason?.failure ?? null
    const error = failure !== null
      ? `code=${failure.code ?? 'unknown'} status=${failure.status ?? 'none'}: ${failure.message ?? String(failure)}`
      : thrown === null ? null : String(thrown?.message ?? thrown)
    if (error !== null) {
      warnCount++
      if (warnCount <= 3 || warnCount % 20 === 0) warn(`[dsh-warm] ping failed (${error})`)
    }
    const epochLive = !disposed && sessions.get(sessionId) === st && st.epoch === epoch
    if (epochLive) {
      st.pings++
      // A hit proves warmth as of its DISPATCH ts (the ledgers' shared clock);
      // a miss or abort proves nothing and never moves the base.
      if (error === null) st.refreshBase = startedAt
    }
    journal.record({
      ts,
      sessionId,
      provider: payload.provider,
      model: payload.model,
      ttMs: now() - startedAt,
      ok: error === null,
      error,
      inputTokens: usage?.inputTokens,
      // The token-ledger basis; pre-schema-2 journal lines have neither field.
      uncachedInputTokens: usage?.inputTokens,
      cacheReadTokens: usage?.cacheReadTokens,
      outputTokens: usage?.outputTokens,
      dryRun: false,
      counted: true,
    })
    // Stats settle only while the dispatching chain is still the session's
    // live epoch: a superseded ping streaming past its epoch has no chain to
    // attribute (stats already partitioned it at the epoch bump), and letting
    // it settle would mark the NEXT chain's in-flight ping with this outcome.
    if (epochLive) stats?.onPingSettle(sessionId, {
      ok: error === null,
      cacheReadTokens: usage?.cacheReadTokens ?? 0,
      uncachedTokens: usage?.inputTokens ?? 0,
      model: payload.model,
    })
    if (epochLive) armTimer(st, sessionId)
    debug?.({ ev: 'ping.settle', sid: sessionId, ok: error === null, cacheReadTokens: usage?.cacheReadTokens ?? null, uncachedTokens: usage?.inputTokens ?? null, model: payload.model ?? null, epochLive })
  }

  /** Forget a session: supersede its in-flight ping and cancel its timer. */
  const drop = (sessionId) => {
    debug?.({ ev: 'drop', sid: sessionId ?? null })
    const st = sessions.get(sessionId)
    if (st === undefined) return
    st.epoch++
    cancelTimer(st)
    sessions.delete(sessionId)
    stats?.onDispose(sessionId)
  }

  return {
    /** `ctx.on('llm/stream', ...)` listener: capture the last conversation request. */
    onLlmStream(options, next) {
      const sid = options?.sessionId
      const accepted = sid !== undefined && sid !== null && !options.purpose && !pingPayloads.has(options)
      // Trace truthfulness: `accepted` must mean "this capture can warm". A
      // provider outside the table captures state yet never arms — accepted
      // true there followed by silence answers exactly nothing.
      const warmable = accepted && providerConfigOf(options) !== null
      debug?.({
        ev: 'llm/stream',
        sid: sid ?? null,
        purpose: options?.purpose ?? null,
        provider: options?.provider ?? null,
        model: options?.model ?? null,
        ping: pingPayloads.has(options),
        accepted: warmable,
      })
      if (accepted) {
        const st = stateOf(sid)
        const ts = now()
        // Only an arm-able capture is worth holding: a non-warmable one still
        // supersedes (epoch, schedule) but must not pin the request — its
        // whole message array — for the session's lifetime.
        st.lastOptions = warmable ? options : null
        st.lastRequestAt = ts
        st.refreshBase = ts
        st.pings = 0
        st.prefixChars = null
        st.epoch++
        // A fresh request supersedes the old schedule; re-arm only if a tool
        // block is somehow still outstanding (it normally already settled).
        cancelTimer(st)
        armTimer(st, sid)
        stats?.onRealRequest(sid, options.provider)
        // The trace must answer "why did nothing arm" for a provider that is
        // captured but not in the warmed table.
        if (!warmable) {
          debug?.({ ev: 'drop', reason: 'provider-not-in-table', sid, provider: options?.provider ?? null, model: options?.model ?? null })
        }
      }
      return next()
    },

    /** `ctx.on('tools/execute', ...)` listener: the warming trigger window. */
    async onToolsExecute(exec, next) {
      const sid = exec?.agent?.id
      if (sid === undefined || sid === null || config.excludeTools.includes(exec?.name ?? '')) {
        debug?.({ ev: 'tools/execute', sid: sid ?? null, tool: exec?.name ?? null, skipped: true })
        return next()
      }
      const st = stateOf(sid)
      st.outstanding++
      debug?.({ ev: 'tools/execute', sid, tool: exec?.name ?? null, outstanding: st.outstanding })
      armTimer(st, sid)
      try {
        return await next()
      } finally {
        st.outstanding--
        if (st.outstanding <= 0) {
          st.outstanding = 0
          cancelTimer(st)
        }
      }
    },

    /** `ctx.on('agent/status', ...)` listener: idle means the turn ended — never warm. */
    onAgentStatus(payload) {
      const sid = payload?.agent?.id
      debug?.({ ev: 'agent/status', sid: sid ?? null, status: payload?.status ?? null, keys: payload === null || typeof payload !== 'object' ? [] : Object.keys(payload) })
      if (sid === undefined || sid === null) return
      const st = stateOf(sid)
      st.running = payload.status === 'running'
      if (st.running === false) {
        st.outstanding = 0
        st.pings = 0
        // The turn ended: the next turn always opens with a fresh capture, so
        // the old request is dead weight — and never a ping source for a tool
        // that runs before that capture (idle sessions are never warmed).
        st.lastOptions = null
        st.prefixChars = null
        st.epoch++
        cancelTimer(st)
        stats?.onIdle(sid)
      }
    },

    /** `ctx.on('agent/disposed' | 'session/disposed', ...)` cleanup. */
    drop,

    /** `ctx.on('agent/disposed')` adapter: payload carries `{ agent }`. */
    onAgentDisposed(payload) {
      drop(payload?.agent?.id)
    },

    /** `ctx.on('session/disposed')` adapter: payload is the Session. */
    onSessionDisposed(session) {
      drop(session?.id)
    },

    /** Teardown: cancel everything. */
    dispose() {
      disposed = true
      for (const st of sessions.values()) cancelTimer(st)
      sessions.clear()
    },
  }
}
