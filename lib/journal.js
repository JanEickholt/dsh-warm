/**
 * dsh-warm journal: one JSONL line per would-be or dispatched ping at
 * `$DSH_HOME/storages/dsh-warm/warm.jsonl`, plus the UTC-day budget counter.
 *
 * The cost ledger already bills every ping (the re-dispatch traverses the
 * host `llm/stream` waterfall, so dsh-cost-meter accounts its usage like any
 * other call). This journal is the warmer's own observability: hit/miss per
 * ping (cacheReadTokens), latency, and the budget state that gates it.
 */

import { closeSync, existsSync, fstatSync, openSync, readFileSync, renameSync, statSync, writeSync } from 'node:fs'
import { join } from 'node:path'

/** Roll the journal once it exceeds this size; keeps boot-time scanning cheap. */
const ROLL_BYTES = 5 * 1024 * 1024

/**
 * Open (or create) the ping journal.
 * @param {string} storageDir - plugin storage directory; must exist.
 * @param {object} [deps]
 * @param {() => number} [deps.now] - clock source, tests inject a fake.
 * @returns {{ record: (entry: object) => void, pingsToday: () => number, close: () => void, path: string }}
 */
export function openJournal(storageDir, { now = Date.now } = {}) {
  const path = join(storageDir, 'warm.jsonl')
  const dayKey = () => new Date(now()).toISOString().slice(0, 10)

  const countToday = () => {
    let count = 0
    const today = dayKey()
    // A roll today moved earlier entries of today into `<path>.<today>`: count those too.
    for (const file of [`${path}.${today}`, path]) {
      if (!existsSync(file)) continue
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (line.length === 0) continue
        try {
          const entry = JSON.parse(line)
          if (entry.day === today && entry.counted) count++
        } catch {
          // Truncated tail line after a crash: ignore.
        }
      }
    }
    return count
  }

  let handle = null
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
  const writer = () => {
    if (handle !== null && size <= ROLL_BYTES) return handle
    closeHandle()
    if (existsSync(path) && statSync(path).size > ROLL_BYTES) {
      try {
        renameSync(path, `${path}.${dayKey()}`)
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
  let spent = countToday()

  return {
    path,
    /**
     * Append one journal entry. `counted: true` entries consume budget.
     * @param {object} entry - JSON-serializable entry; `day` is stamped here.
     */
    record(entry) {
      const day = dayKey()
      if (day !== today) {
        today = day
        spent = 0
      }
      const line = JSON.stringify({ ...entry, day }) + '\n'
      try {
        // Sync write keeps ordering trivial and the volume tiny (budget-capped).
        size += writeSync(writer(), line)
      } catch (error) {
        console.warn(`[dsh-warm] journal write failed: ${String(error?.message ?? error)}`)
      }
      if (entry.counted) spent++
    },
    /** Real dispatch attempts consumed today (UTC). Must self-rollover: the budget gates call this before record() ever runs again, so record()'s rollover alone would freeze an exhausted budget past midnight. */
    pingsToday() {
      const day = dayKey()
      if (day !== today) {
        today = day
        spent = 0
      }
      return spent
    },
    close: closeHandle,
  }
}
