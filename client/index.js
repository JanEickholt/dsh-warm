/**
 * dsh-warm browser bundle (single file, loaded via __ModuleLoader__).
 *
 * Surfaces (both self-contained, no host services beyond slots):
 *  - sidebar.footer.action: compact "Warm" row with today's counts; click opens
 *    a fixed panel with today / all-time detail and the provider grid. Polls
 *    every 60 s mounted, every 15 s while the panel is open.
 *  - plugins.bundle.config (key `dsh-warm`, the Plugins page card): resolved
 *    provider grid, budget, stats toggle state and the same stats summary.
 *
 * Data: one host fetch route, GET api/dsh-warm/stats (RELATIVE on purpose — a
 * root-absolute spelling would drop a reverse proxy's path prefix; same
 * convention as dsh-context's client). The route is registered host-side in
 * lib/index.js behind the authenticated /api fence.
 *
 * Form: hand-written CJS factory (dsh-cost-meter's shape), no build step.
 * `react` comes from the shell baseline. All colors go through --dsw-*
 * theme aliases so light/dark follow the host.
 */

window.__ModuleLoader__.load({
  id: 'dsh-warm',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const el = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    // Relative on purpose (reverse-proxy safe). No leading slash.
    const STATS_URL = 'api/dsh-warm/stats'
    const FOOTER_POLL_MS = 60_000
    const PANEL_POLL_MS = 15_000

    const fmt = (n) => (n === null || n === undefined ? '–' : String(n))
    // Cost-meter's sidebar abbreviation: plain below 1e3, K below 999.5e3, then M.
    const fmtCompact = (n) => {
      const v = Math.max(0, Number(n) || 0)
      const short = (a) => (a >= 100 ? String(Math.round(a)) : String(Math.round(a * 10) / 10))
      return v < 1e3 ? String(Math.round(v)) : v < 999500 ? `${short(v / 1e3)}K` : `${short(v / 1e6)}M`
    }

    async function fetchStats() {
      const res = await fetch(STATS_URL)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    }

    // ── styles ─────────────────────────────────────────────────────────────

    const css = [
      '/* dsh-warm: sidebar row + stats panel */',
      // Expanded state copies cost-meter's boxed footer (measured live):
      // bordered skin, left-aligned 12px/400 secondary row, bg-only hover.
      // The container query restores cost's collapsed borderless centered rail.
      // order:2 and min-width:32px are base rules on purpose — a container
      // query cannot restyle the container element itself. order keeps warm
      // below cost's self-reordering stack (-1 expanded → 1 collapsed) in
      // both states; min-width keeps the collapsed rail visible without
      // cost-meter (inline-size containment zeroes intrinsic width).
      '.dwf-box{width:100%;min-width:32px;order:2;container-type:inline-size;}',
      '.dwf-skin{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;',
      ' background:var(--dsw-alias-bg-layer-1);}',
      '.dwf-item{display:flex;align-items:center;justify-content:flex-start;gap:6px;width:100%;box-sizing:border-box;',
      ' height:26px;padding:0 8px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:400;',
      ' color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;}',
      '.dwf-item:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      '.dwf-ico{display:none;}',
      '@container (max-width:80px){.dwf-skin{border:0;background:transparent}',
      ' .dwf-item{justify-content:center;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      ' .dwf-item span{display:none}',
      ' .dwf-ico{display:block;flex:none}}',
      // Joins warm's box flush onto cost-meter's adjacent .cm-footer-stack
      // (its literal, non-hashed class): single hairline seam, cost's stack
      // silhouette. Safe no-op when cost-meter is absent or not adjacent.
      '@container (min-width:81px){.cm-footer-stack + .dwf-box .dwf-skin{border-top:0;margin-top:-1px;border-radius:0 0 10px 10px}}',
      '.dwf-panel{position:fixed;z-index:60;width:280px;max-height:70vh;overflow:auto;',
      ' background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l);border-radius:10px;',
      ' box-shadow:0 8px 24px rgba(0,0,0,.18);padding:10px 12px;font-size:12px;color:var(--dsw-alias-label-primary);}',
      '.dwf-panel h4{margin:2px 0 8px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);}',
      '.dwf-grid{display:grid;grid-template-columns:1fr auto;gap:2px 12px;margin:0 0 8px;',
      ' color:var(--dsw-alias-label-secondary);}',
      '.dwf-grid b{font-weight:500;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;text-align:right;}',
      '.dwf-sub{margin:8px 0 2px;color:var(--dsw-alias-label-tertiary);font-size:11px;text-transform:uppercase;letter-spacing:.04em;}',
      '.dwf-warn{color:var(--dsw-alias-state-warn-primary);}',
      '.dwf-err{color:var(--dsw-alias-state-error-primary);}',
      '.dwf-off{color:var(--dsw-alias-label-tertiary);}',
      '.dwf-tbl{width:100%;border-collapse:collapse;margin:2px 0 4px;}',
      '.dwf-tbl td{padding:1px 0;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;}',
      '.dwf-tbl td+td{text-align:right;color:var(--dsw-alias-label-primary);}',
      '.dwf-tbl td.dwf-provider{color:var(--dsw-alias-label-primary);}',
      '.dwf-card{display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--dsw-alias-label-primary);}',
      '.dwf-card .dwf-grid{margin:0;}',
    ].join('')

    let cssMounted = false
    function mountCss() {
      if (cssMounted || typeof document === 'undefined') return
      const tag = document.createElement('style')
      tag.id = 'dsh-warm-client-css'
      tag.textContent = css
      document.head.appendChild(tag)
      cssMounted = true
    }

    // ── shared render helpers ───────────────────────────────────────────────

    function StatsGrid({ state }) {
      const stats = state?.stats
      // state === undefined → first fetch in flight; null → fetch failed.
      if (state === undefined) return el('div', { className: 'dwf-off' }, 'loading…')
      if (!state) return el('div', { className: 'dwf-err' }, 'route unavailable')
      if (!state.statsEnabled) {
        return el('div', { className: 'dwf-off' },
          'stats disabled (config.json: stats.enabled)')
      }
      if (!stats) return el('div', { className: 'dwf-err' }, 'no stats payload')
      const allTime = stats.allTime ?? {}
      // Every row names its period: today's counters first, then all-time
      // (`failed` exists only all-time on the wire).
      return el('div', { className: 'dwf-grid' },
        el('span', null, 'warms (today)'),
        el('b', null, fmt(stats.today?.warms)),
        el('span', null, 'saved cache tokens (today)'),
        el('b', null, fmt(stats.today?.savedCacheTokens)),
        el('span', { className: 'dwf-warn' }, 'wasted: needless (today)'),
        el('b', { className: 'dwf-warn' }, fmt(stats.today?.needless)),
        el('span', { className: 'dwf-warn' }, 'wasted: no follow-up (today)'),
        el('b', { className: 'dwf-warn' }, fmt(stats.today?.noFollowup)),
        el('span', { className: 'dwf-warn' }, 'wasted: follow-up too late (today)'),
        el('b', { className: 'dwf-warn' }, fmt(stats.today?.expired)),
        el('span', null, 'warms (all-time)'),
        el('b', null, fmt(allTime.warms)),
        el('span', null, 'saved cache tokens (all-time)'),
        el('b', null, fmt(allTime.savedCacheTokens)),
        el('span', null, 'failed pings (all-time)'),
        el('b', null, fmt(stats.failed)))
    }

    function ProviderTable({ state }) {
      const providers = state?.config?.providers
      if (!providers) return null
      return el('table', { className: 'dwf-tbl' },
        el('tbody', null, Object.entries(providers).map(([name, rule]) => el('tr', { key: name },
          el('td', { className: 'dwf-provider' }, name),
          // marginMs rides only anchored rules: their cadence is ttl − margin,
          // and intervalMs is a fallback the schedule never reads.
          el('td', null, typeof rule.marginMs === 'number'
            ? `every ${Math.round((rule.ttlMs - rule.marginMs) / 1000)}s`
            : `every ${Math.round(rule.intervalMs / 1000)}s (grid)`),
          el('td', null, `ttl ${Math.round(rule.ttlMs / 1000)}s`)))))
    }

    // ── sidebar footer row + panel ─────────────────────────────────────────

    function WarmPanel({ onClose, ignoreRef, pos }) {
      const [state, setState] = useState(undefined)
      const [error, setError] = useState(null)
      const ref = useRef(null)

      useEffect(() => {
        let stopped = false
        const refresh = async () => {
          try {
            const next = await fetchStats()
            if (!stopped) { setState(next); setError(null) }
          } catch (e) {
            if (!stopped) setError(String(e?.message ?? e))
          }
        }
        refresh()
        const timer = setInterval(refresh, PANEL_POLL_MS)
        return () => { stopped = true; clearInterval(timer) }
      }, [])

      useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose() }
        const onPointer = (e) => {
          if (ref.current && !ref.current.contains(e.target)
            && !(ignoreRef?.current?.contains?.(e.target) === true)) onClose()
        }
        document.addEventListener('keydown', onKey)
        document.addEventListener('pointerdown', onPointer)
        return () => {
          document.removeEventListener('keydown', onKey)
          document.removeEventListener('pointerdown', onPointer)
        }
      }, [onClose, ignoreRef])

      return el('div', { ref, className: 'dwf-panel', style: pos },
        el('h4', null, 'dsh-warm stats'),
        error ? el('div', { className: 'dwf-err' }, `stats unavailable: ${error}`) : el(StatsGrid, { state }),
        el('div', { className: 'dwf-sub' }, 'provider grid'),
        el(ProviderTable, { state }),
        el('div', { className: 'dwf-sub' }, 'budget'),
        el('div', { className: 'dwf-grid' },
          el('span', null, 'daily ping budget'),
          el('b', null, fmt(state?.config?.budget?.dailyPingBudget)),
          el('span', null, 'max pings / block'),
          el('b', null, fmt(state?.config?.budget?.maxPingsPerBlock)),
          el('span', null, 'dry run'),
          el('b', null, state?.config?.dryRun ? 'yes' : 'no')))
    }

    function WarmFooter() {
      const [open, setOpen] = useState(false)
      const [state, setState] = useState(undefined)
      const anchorRef = useRef(null)
      const panelPosRef = useRef(null)

      useEffect(() => {
        let stopped = false
        const refresh = async () => {
          try {
            const next = await fetchStats()
            if (!stopped) setState(next)
          } catch {
            // The row stays quiet; the panel distinguishes failure (null)
            // from the still-loading initial fetch (undefined).
            if (!stopped) setState(null)
          }
        }
        refresh()
        const timer = setInterval(refresh, FOOTER_POLL_MS)
        return () => { stopped = true; clearInterval(timer) }
      }, [])

      const toggle = useCallback(() => {
        setOpen((was) => !was)
      }, [])

      mountCss()
      const today = state?.stats?.today
      // Cost-style single span: "Today 6 warms · 256K saved". "Warm" is the
      // quiet placeholder until today's payload lands (or the route fails).
      const text = today
        ? `Today ${fmtCompact(today.warms)} warms${today.savedCacheTokens ? ` · ${fmtCompact(today.savedCacheTokens)} saved` : ''}`
        : 'Warm'
      const activate = () => {
        // Measure while still closed: the panel anchors above this row.
        if (!open && anchorRef.current?.getBoundingClientRect) {
          const rect = anchorRef.current.getBoundingClientRect()
          panelPosRef.current = { left: `${Math.round(rect.left)}px`, bottom: `${Math.round(window.innerHeight - rect.top) + 8}px` }
        }
        toggle()
      }
      const row = el('div', { className: 'dwf-box' },
        el('div', { className: 'dwf-skin' },
          el('div', {
            ref: anchorRef,
            className: 'dwf-item',
            title: text,
            onClick: activate,
            onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate() } },
            role: 'button',
            tabIndex: 0,
          },
            el('svg', { className: 'dwf-ico', width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': 'true', fill: 'currentColor' },
              el('path', { d: 'M8 2.25c1.25 1.625 2.5 2.875 2.5 4.375a2.5 2.5 0 0 1-5 0c0-1.5 1.25-2.75 2.5-4.375z' })),
            el('span', null, text))))
      if (!open) return row
      return el(React.Fragment, null,
        row,
        el(WarmPanel, { onClose: () => setOpen(false), ignoreRef: anchorRef, pos: panelPosRef.current ?? { left: '12px', bottom: '48px' } }))
    }

    // ── Plugins page card ──────────────────────────────────────────────────

    function WarmConfigCard() {
      const [state, setState] = useState(undefined)
      useEffect(() => {
        let stopped = false
        fetchStats().then((next) => { if (!stopped) setState(next) }).catch(() => { if (!stopped) setState(null) })
        return () => { stopped = true }
      }, [])
      mountCss()
      return el('div', { className: 'dwf-card' },
        el(StatsGrid, { state }),
        el('div', { className: 'dwf-sub' }, 'provider grid'),
        el(ProviderTable, { state }),
        el('div', { className: 'dwf-sub' }, 'budget'),
        el('div', { className: 'dwf-grid' },
          el('span', null, 'daily ping budget'),
          el('b', null, fmt(state?.config?.budget?.dailyPingBudget)),
          el('span', null, 'max pings / block'),
          el('b', null, fmt(state?.config?.budget?.maxPingsPerBlock)),
          el('span', null, 'dry run'),
          el('b', null, state?.config?.dryRun ? 'yes' : 'no')),
        el('div', { className: 'dwf-off' }, 'config: $DSH_HOME/storages/dsh-warm/config.json'))
    }

    // ── registration ───────────────────────────────────────────────────────

    function apply(ctx) {
      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register({ name: 'sidebar.footer.action', id: 'dsh-warm-stats', order: 3 }, WarmFooter))
      ctx.slots.inject('plugins.bundle.config', () =>
        ctx.slots.register({ name: 'plugins.bundle.config', key: 'dsh-warm' }, WarmConfigCard))
    }

    exports.name = 'dsh-warm'
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
