# Runbook: Mint/Burn Integrity

Triggered by `StatusCause.code`:
- `onchain_integrity_degraded`
- `onchain_integrity_stale`
- `onchain_monitor_unavailable`

## Symptom

On-chain supply divergence or stale-snapshot ratio exceeds the configured threshold, or the global on-chain supply monitor is unavailable. Mint/burn reconciliation can also flag material drift for assets in `MINT_BURN_CONFIGS`, but that is a separate coverage surface from `onchain_monitor_unavailable`.

Public mint/burn availability causes (`mint_burn_public_degraded`, `mint_burn_public_stale`) are emitted from the critical-lane freshness/health path and currently do not attach a dedicated runbook link. Use this runbook for on-chain integrity causes and the `/flows` / cron diagnostics when the public mint/burn lane is implicated.

## First checks

1. **Admin page → Pipeline section → Mint/Burn Reconciliation card:** which coins are flagged? What's the divergence magnitude?
2. **`sync-mint-burn` + `sync-mint-burn-extended` crons:** healthy? Running on cadence?
3. **`/api/status` → `mintBurnReconciliation`:** detailed per-coin deltas.

## Remediation

- **Backfill mint/burn events:** Admin page → Recommended now → `backfill-mint-burn`. Idempotent.
- **Backfill mint/burn prices:** if divergence is USD-side, `backfill-mint-burn-prices` repopulates price columns.
- **On-chain monitor unavailable:** usually indicates the recent `onchain_supply` monitor rows are missing or unreadable globally. Check the relevant supply-monitoring cron/status sections before treating it as a mint/burn config issue.

### Historical price debt

The request contract is canonical in [API Reference: `POST /api/backfill-mint-burn-prices`](../api-reference.md#post-apibackfill-mint-burn-prices). Operationally:

1. Preview a bounded batch and review every disposition, especially `irreducible` and provider-retry outcomes.
2. Before mutation, take a fresh D1 Time Travel bookmark. Execute the same scope with the required confirmation, bookmark, and a unique `Idempotency-Key`.
3. Repeat until both `backlog.unclassified` and `backlog.pendingAggregate` are zero. A pending aggregate rebuild must finish before more price rows are attempted.
4. Reopen `irreducible` rows only after adding or repairing a named event-day historical source. Current spot, peg-par, and adjacent-day prices are not substitutes.

## Prevention

- Token identity comes from shared stablecoin metadata, but tracker-specific config lives in `worker/src/lib/mint-burn-contracts.ts` and lane state in `worker/src/cron/mint-burn/run-state.ts`. Adding a new coin without mint/burn contract config keeps it outside mint/burn reconciliation and backfill scope; it does not emit a per-coin `onchain_monitor_unavailable`.
- Divergence thresholds live in `shared/lib/status-thresholds.ts` — do not loosen them without a documented investigation.
