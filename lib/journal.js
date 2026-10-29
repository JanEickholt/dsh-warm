/**
 * dsh-warm journal: one JSONL line per would-be or dispatched ping at
 * `$DSH_HOME/storages/dsh-warm/warm.jsonl`, plus the local-day budget counter.
 *
 * The cost ledger already bills every ping (the re-dispatch traverses the
 * host `llm/stream` waterfall, so dsh-cost-meter accounts its usage like any
 * other call). This journal is the warmer's own observability: hit/miss per
 * ping (cacheReadTokens), latency, and the budget state that gates it.
 *
 * Days are host-local calendar days (`YYYY-MM-DD`), the same key the stats
 * engine buckets by. A line counts on the local day of its dispatch `ts`, not
 * on its stamped `day`: lines written before the UTC → local switch carry a
 * UTC stamp, and the ts re-derives them on the current basis.
 */

import { appendFileSync, closeSync, existsSync, fstatSync, openSync, readFileSync, readdirSync, renameSync, statSync, writeSync } from 'node:fs'
import { join } from 'node:path'

/** Roll the journal once it exceeds this size; keeps boot-time scanning cheap. */
const ROLL_BYTES = 5 * 1024 * 1024

const JOURNAL_NAME = 'warm.jsonl'

/**
 * Host-local calendar day of an epoch-ms instant, `YYYY-MM-DD` — the bucket key
 * shared by the budget and the stats (`today.day`, `byDay`).
 * @param {number} ms
 * @returns {string}
 */
export function localDayKey(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${String(d.getFullYear()).padStart(4, '0')}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * The local day a journal line counts on: its dispatch `ts`; the stamped `day`
 * only for a line without a parseable ts.
 * @param {object} entry - parsed journal line.
 * @returns {string | undefined}
 */
export function journalLineDay(entry) {
  const ms = typeof entry?.ts === 'string' ? Date.parse(entry.ts) : Number.NaN
  if (Number.isFinite(ms)) return localDayKey(ms)
  return typeof entry?.day === 'string' ? entry.day : undefined
}

/**
 * Open (or create) the ping journal.
 * @param {string} storageDir - plugin storage directory; must exist.
 * @param {object} [deps]
 * @param {() => number} [deps.now] - clock source, tests inject a fake.
 * @returns {{ record: (entry: object) => void, pingsToday: () => number, close: () => void, path: string }}
 */
export function openJournal(storageDir, { now = Date.now } = {}) {
  const path = join(storageDir, JOURNAL_NAME)
  const dayKey = () => localDayKey(now())

  /** Size of the live file, 0 when absent. */
  const liveSize = () => {
    try {
      return statSync(path).size
    } catch {
      return 0
    }
  }

  const countToday = (today) => {
    let count = 0
    let names = []
    try {
      names = readdirSync(storageDir)
    } catch {
      return 0
    }
    // Lines of today live in the live file or in a file rolled today
    // (`<name>.<today>`, `<name>.<today>.<n>`); rolls name the roll day, so
    // older rolls hold no line of today.
    const files = names.filter((name) => name === JOURNAL_NAME || name === `${JOURNAL_NAME}.${today}` || name.startsWith(`${JOURNAL_NAME}.${today}.`))
    for (const name of files) {
      let text = ''
      try {
        text = readFileSync(join(storageDir, name), 'utf8')
      } catch {
        continue
      }
      for (const line of text.split('\n')) {
        if (line.length === 0) continue
        try {
          const entry = JSON.parse(line)
          if (entry.counted && journalLineDay(entry) === today) count++
        } catch {
          // Truncated tail line after a crash: ignore.
        }
      }
    }
    return count
  }

  /** First free roll target for today: a second roll the same day must never replace the first. */
  const rollTarget = () => {
    const first = `${path}.${dayKey()}`
    if (!existsSync(first)) return first
    for (let n = 1; ; n++) {
      const next = `${first}.${n}`
      if (!existsSync(next)) return next
    }
  }

  let handle = null
  /** Set by close(): a ping still in flight at teardown settles later; it must not reopen a handle nobody closes. */
  let closed = false
  /** Bytes in the file behind `handle`; checked on every write so a long-lived host still rolls. */
  let size = 0
  const closeHandle = () => {
    if (handle === null) return
    try {
      closeSync(handle)
    } catch {
      // Already closed at teardown: nothing to do.
    }
    handle = null
  }
  /** True when `handle` no longer names the live file (another host sharing DSH_HOME rolled it). */
  const handleStale = () => {
    try {
      return fstatSync(handle).ino !== statSync(path).ino
    } catch {
      return true
    }
  }
  const writer = () => {
    if (handle !== null && size <= ROLL_BYTES && !handleStale()) return handle
    closeHandle()
    if (existsSync(path) && statSync(path).size > ROLL_BYTES) {
      try {
        renameSync(path, rollTarget())
      } catch {
        // Rename failed (EBUSY on Windows, etc.): keep appending, size only costs boot scan.
      }
    }
    handle = openSync(path, 'a')
    size = fstatSync(handle).size
    // Rename failed above: retry only after another ROLL_BYTES of appends, not on every write.
    if (size > ROLL_BYTES) size = 0
    return handle
  }

  let today = dayKey()
  let spent = countToday(today)
  // The live file's size as this instance last accounted it. A mismatch means
  // another host sharing DSH_HOME appended (or rolled): the budget recounts
  // from the files, so two hosts share one daily budget instead of each
  // spending a full one from its own memory.
  let knownSize = liveSize()

  return {
    path,
    /**
     * Append one journal entry. `counted: true` entries consume budget on the
     * local day of their dispatch `ts`.
     * @param {object} entry - JSON-serializable entry; `day` is stamped here.
     */
    record(entry) {
      const nowDay = dayKey()
      if (nowDay !== today) {
        today = nowDay
        spent = countToday(today)
        knownSize = liveSize()
      }
      // A ping dispatched before midnight and settled after it counts on its
      // dispatch day — the day boot recounts and the stats seed put it on.
      const day = journalLineDay(entry) ?? nowDay
      const line = JSON.stringify({ ...entry, day }) + '\n'
      try {
        // Sync write keeps ordering trivial and the volume tiny (budget-capped).
        // After close() the line still lands (budget honesty for the next
        // instance's boot count), via a one-shot append that leaks no fd.
        if (closed) {
          appendFileSync(path, line)
        } else {
          const fd = writer()
          const sizeBefore = liveSize()
          const written = writeSync(fd, line)
          size += written
          // Only our own append moves knownSize; anyone else's shows up as a mismatch.
          if (sizeBefore === knownSize) knownSize += written
        }
      } catch (error) {
        console.warn(`[dsh-warm] journal write failed: ${String(error?.message ?? error)}`)
      }
      if (entry.counted && day === today) spent++
    },
    /** Real dispatch attempts consumed today (local day). Must self-rollover: the budget gates call this before record() ever runs again, so record()'s rollover alone would freeze an exhausted budget past midnight. Recounts from the files when another host appended. */
    pingsToday() {
      const day = dayKey()
      const current = liveSize()
      if (day !== today || current !== knownSize) {
        today = day
        spent = countToday(today)
        knownSize = current
      }
      return spent
    },
    close() {
      closed = true
      closeHandle()
    },
  }
}
