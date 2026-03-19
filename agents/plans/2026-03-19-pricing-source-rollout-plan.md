# Pricing Source Rollout Plan

Date: 2026-03-19

Scope for this production rollout:

1. Add Kraken public ticker to primary pricing consensus.
2. Add Bitstamp public ticker to primary pricing consensus.
3. Add Jupiter Price API as a Solana-only fallback enrichment pass.
4. Add Chainlink FX / metal reference feeds to `sync-fx-rates`.

Deferred from this rollout:

- Meteora DLMM / DAMM
  - Reason: it belongs in the DEX discovery / staging lane, not the shared quarter-hourly pricing slot.
  - Shipping it in this batch would increase architectural and operational risk beyond a safe same-day production push.

Implementation constraints:

- Keep quarter-hourly connection usage bounded.
- Preserve existing pricing confidence semantics.
- Update docs, about-page source listing, status source accounting, and pricing methodology versioning in the same change.
- Verify with lint, tests, build, worker type-check, and merge gate before deploy.
- After deploy, monitor the affected quarter-hourly jobs until two consecutive successful runs are observed.
