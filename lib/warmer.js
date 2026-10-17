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
 * @param {() => number} [deps.now] - clock source.
 * @param {(cb: () => void, ms: number) => unknown} [deps.setTimer]
 * @param {(id: unknown) => void} [deps.clearTimer]
 * @param {(ms: number) => AbortSignal} [deps.signal]
 * @param {(signals: AbortSignal[]) => AbortSignal} [deps.combineSignals] - chains the captured call's signal with the ping timeout.
 * @param {(message: string) => void} [deps.warn]
 * @returns warm event handlers + dispose.
 */
export function createWarmer({ llm, config, journal, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, signal = (ms) => AbortSignal.timeout(ms), combineSignals = (signals) => AbortSignal.any(signals), warn = console.warn }) {
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
      st = { lastOptions: null, lastRequestAt: 0, outstanding: 0, pings: 0, prefixChars: null, epoch: 0, pingEpoch: null, timerId: null, running: undefined }
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
    const due = st.lastRequestAt + (st.pings + 1) * providerConfig.intervalMs
    let delay = due - now()
    if (delay < 0) delay = 1000
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
    const startedAt = now()
    let usage = null
    let thrown = null
    let finish = null
    inFlight++
    try {
      for await (const chunk of llm.stream(payload)) {
        if (chunk?.type === 'usage' && chunk.usage != null) usage = chunk.usage
        else if (chunk?.type === 'finish' && finish === null) finish = chunk
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
    if (epochLive) st.pings++
    journal.record({
      ts,
      sessionId,
      provider: payload.provider,
      model: payload.model,
      ttMs: now() - startedAt,
      ok: error === null,
      error,
      inputTokens: usage?.inputTokens,
      cacheReadTokens: usage?.cacheReadTokens,
      outputTokens: usage?.outputTokens,
      dryRun: false,
      counted: true,
    })
    if (epochLive) armTimer(st, sessionId)
  }

  /** Forget a session: supersede its in-flight ping and cancel its timer. */
  const drop = (sessionId) => {
    const st = sessions.get(sessionId)
    if (st === undefined) return
    st.epoch++
    cancelTimer(st)
    sessions.delete(sessionId)
  }

  return {
    /** `ctx.on('llm/stream', ...)` listener: capture the last conversation request. */
    onLlmStream(options, next) {
      const sid = options?.sessionId
      if (sid !== undefined && sid !== null && !options.purpose && !pingPayloads.has(options)) {
        const st = stateOf(sid)
        st.lastOptions = options
        st.lastRequestAt = now()
        st.pings = 0
        st.prefixChars = null
        st.epoch++
        // A fresh request supersedes the old schedule; re-arm only if a tool
        // block is somehow still outstanding (it normally already settled).
        cancelTimer(st)
        armTimer(st, sid)
      }
      return next()
    },

    /** `ctx.on('tools/execute', ...)` listener: the warming trigger window. */
    async onToolsExecute(exec, next) {
      const sid = exec?.agent?.id
      if (sid === undefined || sid === null || config.excludeTools.includes(exec?.name ?? '')) return next()
      const st = stateOf(sid)
      st.outstanding++
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
      if (sid === undefined || sid === null) return
      const st = stateOf(sid)
      st.running = payload.status === 'running'
      if (st.running === false) {
        st.outstanding = 0
        st.pings = 0
        st.epoch++
        cancelTimer(st)
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
