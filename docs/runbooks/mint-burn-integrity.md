# Runbook: Mint/Burn Integrity

Triggered by `StatusCause.code`:
- `onchain_integrity_degraded`
- `onchain_integrity_stale`
- `onchain_monitor_unavailable`

## Symptom

On-chain supply divergence exceeds the configured ratio, or the mint/burn monitor is unavailable. Either a sync cron has stalled or the reconciliation is flagging material drift.

## First checks

1. **Admin page → Pipeline section → Mint/Burn Reconciliation card:** which coins are flagged? What's the divergence magnitude?
2. **`sync-mint-burn` + `sync-mint-burn-extended` crons:** healthy? Running on cadence?
3. **`/api/status` → `mintBurnReconciliation`:** detailed per-coin deltas.

## Remediation

- **Backfill mint/burn events:** Admin page → Recommended actions → `backfill-mint-burn`. Idempotent.
- **Backfill mint/burn prices:** if divergence is USD-side, `backfill-mint-burn-prices` repopulates price columns.
- **Monitor unavailable:** usually indicates the cron is mid-deploy or the underlying query is hitting D1 per-statement limits. Check the cron's recent runs for `error` status and error messages.

## Prevention

- Token identity comes from shared stablecoin metadata, but tracker-specific config lives in `worker/src/lib/mint-burn-contracts.ts` and lane state in `worker/src/cron/mint-burn/run-state.ts`. Adding a new coin without its mint/burn contract config produces `onchain_monitor_unavailable` for that coin only.
- Divergence thresholds live in `shared/lib/status-thresholds.ts` — do not loosen them without a documented investigation.
