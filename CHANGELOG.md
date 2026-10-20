# Changelog

## [0.2.0] - 2026-10-20
### Added
- Stats. dsh-warm now counts what warming bought and what it wasted: per-day and all-time counters for pings (`warms`) and wasted pings by cause (`needless`, `noFollowup`, `expired`), plus `savedCacheTokens` credited from the cache-read tokens of the last successful ping in a necessary, still-held block, and all-time `failed` dispatches. The counters live in `stats.json` (atomic writes, UTC-day buckets) and are served at `GET /api/dsh-warm/stats` as a documented, versioned schema, so third-party consumers such as a dsh-context-insights card can read them without any import in either direction.
- Stats toggle: `stats.enabled` (default on). Off means no counting, no `stats.json`, and the route still reports the toggle state.
- Provider TTL floors in config (`ttlMs` per provider: mistral 302000 measured, openai/anthropic 300000 documented). The stats classification uses them, and load validates them with a warning when the ping grid can never bridge the TTL.
- Web client bundle (`dsh.client`, no build step): a "Warm" sidebar-footer row that opens a stats panel, and a `dsh-warm` card on the Plugins page. Both read the stats route; nothing is stored client-side.

## [0.1.0] - 2026-10-17
### Added
- Initial release: prompt-cache warmer for tool-execution windows. While the agent loop is blocked in a tool, re-dispatches the session's last conversation request through the llm waterfall with `maxTokens: 1` on a per-provider interval (mistral 240 s default from a live TTL probe: 302 s hit / 424 s miss). Idle sessions and user-input tools are never warmed. Journal + daily ping budget at `$DSH_HOME/storages/dsh-warm/`.
