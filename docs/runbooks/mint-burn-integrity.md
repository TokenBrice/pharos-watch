# Runbook: Mint/Burn Integrity

Triggered by `StatusCause.code`:
- `onchain_integrity_degraded`
- `onchain_integrity_stale`
- `onchain_monitor_unavailable`

## Symptom

On-chain supply divergence exceeds the configured ratio, or the global on-chain supply monitor is unavailable. Mint/burn reconciliation can also flag material drift for assets in `MINT_BURN_CONFIGS`, but that is a separate coverage surface from `onchain_monitor_unavailable`.

## First checks

1. **Admin page → Pipeline section → Mint/Burn Reconciliation card:** which coins are flagged? What's the divergence magnitude?
2. **`sync-mint-burn` + `sync-mint-burn-extended` crons:** healthy? Running on cadence?
3. **`/api/status` → `mintBurnReconciliation`:** detailed per-coin deltas.

## Remediation

- **Backfill mint/burn events:** Admin page → Recommended actions → `backfill-mint-burn`. Idempotent.
- **Backfill mint/burn prices:** if divergence is USD-side, `backfill-mint-burn-prices` repopulates price columns.
- **On-chain monitor unavailable:** usually indicates the recent `onchain_supply` monitor rows are missing or unreadable globally. Check the relevant supply-monitoring cron/status sections before treating it as a mint/burn config issue.

## Prevention

- Token identity comes from shared stablecoin metadata, but tracker-specific config lives in `worker/src/lib/mint-burn-contracts.ts` and lane state in `worker/src/cron/mint-burn/run-state.ts`. Adding a new coin without mint/burn contract config keeps it outside mint/burn reconciliation and backfill scope; it does not emit a per-coin `onchain_monitor_unavailable`.
- Divergence thresholds live in `shared/lib/status-thresholds.ts` — do not loosen them without a documented investigation.
