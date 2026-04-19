# Documentation Audit Loop 1 - 2026-04-19

Scope: whole `/docs` corpus, README, public about/API/methodology/product-page documentation surfaces, and API reference.

Mode: read code/config/tests as source of truth; subagents audited API, infrastructure, core methodology, monitoring methodology, public route docs, and data/model docs.

Result: first verification pass returned more than 3 issues, so loop 1 proceeded to corrections.

## Correction Summary

- Fixed public route-contract docs for homepage, Start Here, stablecoin detail, cemetery/compare URL handling, and compare reliability behavior.
- Fixed stablecoin data and classification docs for cemetery data, CoinGecko/on-chain cache admission, and commodity historical data source boundaries.
- Fixed live reserve docs for attempt fencing, resolver ownership, status fields, API cache tiers, admin monitoring surface, and frontend polling cadence.
- Fixed redemption/report-card docs for offchain-issuer exit gating, blacklist descriptive status, missing v6.98/v6.99 timeline entries, and current weight range.
- Fixed methodology page copy for Safety Score dependency scoring, self-backed dependency baselines, pricing circuit-breaker wording, M0 inherited pricing scope, depeg trust wording, PYS rounding, benchmark-aware PYS FAQ copy, and DEWS same-peg contagion copy.
- Fixed operational docs for local dev proxy path, circuit-breaker scope, worker reserve schema summaries, cache-helper file ownership, connection-budget table wording, duplicate-export script behavior, and critical coverage list wording.
- Fixed API reference for optional freshness headers, `blacklist-summary` realtime cache profile, blockquote-free rendering, yield-rankings 503 semantics, request-source stats bounds, and admin status response exhaustiveness note.
- Fixed Telegram, feedback, and status docs/page copy for launch target handling, admin surface naming, server/client contact-handle validation split, reserve-composition status fields, and critical-cron escalation semantics.

## Verification Inputs

- Automated checks run before edits: `check:doc-source-paths`, `check:doc-counts`, `check:verified-doc-links`, `check:doc-sync`, `check:cron-sync`.
- Subagent targeted checks reported passing slices including stablecoin-data/redemption checks, cron/docs/env checks, and targeted methodology/API tests.

## Loop Policy

User adjustment during loop 1: stop after third-loop corrections are implemented, even if the next verification pass would still find more than 3 errors.
