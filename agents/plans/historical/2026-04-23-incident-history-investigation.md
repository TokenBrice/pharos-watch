## Incident history investigation — 2026-04-23

Scope:
- Git history from 2026-04-02 through 2026-04-23
- Focused on status probes, dex-liquidity, sync-dex-liquidity, sync-dex-discovery, freshness warnings, and circuit breakers
- Goal: find recent changes that could plausibly explain `/admin` failures or liquidity lag

Most relevant commit clusters:

1. `0ec41533` (2026-04-18) reduced `sync-dex-discovery` cadence from every 30 minutes to every 2 hours.
   - Current code still merges discovery staging into liquidity scoring via `mergeStagedPools()`, so discovery remains operationally coupled to liquidity freshness.
   - With `DISCOVERY_TIERS.T2_MODULO = 3` and `T3_MODULO = 10`, some assets now refresh on 6h / 20h effective discovery cadences.

2. `bd67e764` (2026-04-17) wired the DexScreener circuit breaker into both discovery and liquidity fallback paths.
   - If `DEXSCREENER_PRICES` opens, both discovery stage-3 and liquidity fallback skip DexScreener.
   - This increases shared failure-domain coupling across discovery and scoring.

3. `/admin` access hardening landed in a tight sequence:
   - `19219681` (2026-04-04): Pages proxy now verifies Cloudflare Access JWTs and enforces same-origin on mutations.
   - `ab54c9dd` (2026-04-05): fixed browser-session auth by accepting the `CF_Authorization` cookie.
   - `1e5c3865` (2026-04-08): raised `/api/status` and `/api/status-history` proxy timeout to 20s.
   - `ae93ddea` (2026-04-17): added admin mutation endpoints, including reset-circuit-breaker.
   - `f7dcdfb4` (2026-04-18): fixed browser admin mutations by forwarding `X-Pharos-Admin` through the Pages proxy.

4. Status/freshness semantics changed materially:
   - `05fcb802` (2026-04-10): moved `status-self-check` into its own isolated cron slot and added sentinel-backed freshness fallback logic.
   - `64f7bab7` (2026-04-17): `/api/status` became read-only with respect to `status_state`; status-self-check is now the sole writer.
   - `2a2e6487` (2026-04-17): invalid `/api/health` responses are classified as semantic `stale`.
   - `42a2a8f1` (2026-04-19): freshness budgets were aligned to producer cadence; dex-liquidity now explicitly warns after 1h endpoint age while public-health availability still tolerates the last successful dataset for 12h.
   - Same commit also made browser endpoint probes treat `Warning` headers as semantic stale/degraded signals.

Bottom line:
- The strongest plausible liquidity-lag cause in recent history is the combination of `0ec41533` and `bd67e764`.
- The strongest plausible `/admin` cause in recent history is the Pages admin-proxy/auth hardening sequence (`19219681`, `ab54c9dd`, `1e5c3865`, `ae93ddea`, `f7dcdfb4`).
- Freshness/probe changes likely explain louder stale/degraded signals, but they look more like observability changes than primary breakage.
