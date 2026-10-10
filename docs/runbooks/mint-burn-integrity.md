# Runbook: Mint/Burn Integrity

Triggered by `StatusCause.code`:
- `onchain_integrity_degraded`
- `onchain_integrity_stale`
- `onchain_monitor_unavailable`

## Symptom

On-chain supply divergence/staleness causes remain a separate supply-monitor surface. The Mint/Burn Integrity card instead diagnoses exact native-token conservation over reviewed matched-block ranges; a verified mismatch is critical, while missing, stale, malformed or unsupported proof remains unverified. USD circulation differences are retired and cannot diagnose ingestion integrity.

Public mint/burn availability causes (`mint_burn_public_degraded`, `mint_burn_public_stale`) are emitted from the critical-lane freshness/health path and currently do not attach a dedicated runbook link. Use this runbook for on-chain integrity causes and the `/flows` / cron diagnostics when the public mint/burn lane is implicated.

## First checks

1. For the trigger codes above, inspect `onchain_supply` monitor freshness/divergence first. **Pipeline → Mint/Burn Integrity** is a separate native-conservation surface: inspect the affected contract, config fingerprint, reviewed law, block range/hashes and raw residual. A one-base-unit mismatch matters.
2. **Critical/extended crons:** inspect each contract's lane, observed head and stored cursor. A passing record requires a completed fresh scan covering its audited blocks; an unrelated new run cannot renew it.
3. **`mintBurnReconciliation`:** inspect `conservationIssue`, per-record reason, both audit/checkpoint ages and `coverageStatus`. Missing supply-cache data must not hide native records. Unsupported identities require reviewed admission, not a fabricated pass.

## Remediation

- **Native mismatch:** investigate exact identity, reviewed conservation law, fetched/parsed/stored native event completeness and checkpoint hashes before choosing any repair. A mismatch stays unresolved until a verified pass replaces it; do not clear audit caches to make it green.
- **Coverage/backfill:** use the existing bounded mint/burn backfill only after identifying missing events/cursor coverage. Price backfill repairs valuation debt, never the native residual.
- **On-chain monitor unavailable:** usually indicates the recent `onchain_supply` monitor rows are missing or unreadable globally. Check the relevant supply-monitoring cron/status sections before treating it as a mint/burn config issue.

### Historical price debt

The command contract is canonical in [Operator runbook: historical mint/burn prices](./one-shot-backfills.md#backfill-mint-burn-prices). Operationally:

1. Preview a bounded batch and review every disposition, especially `irreducible` and provider-retry outcomes.
2. Before mutation, take a fresh D1 Time Travel bookmark and coordinate a maintenance window for the [atomic import availability impact](./one-shot-backfills.md#transport-safety). Execute the same scope with `--execute --allow-atomic-import`, the required confirmation, bookmark, and a unique `--idempotency-key`.
3. Repeat until both `backlog.unclassified` and `backlog.pendingAggregate` are zero. A pending aggregate rebuild must finish before more price rows are attempted.
4. Reopen `irreducible` rows only after adding or repairing a named event-day historical source. Current spot, peg-par, and adjacent-day prices are not substitutes.
5. No lane substitutes ingestion time for event-time price evidence. Since mint-burn-flow v6.23, live ingestion and the 48-hour auto-heal admit only evidence whose actual observation time is within ±24 hours of the event (a `supply_history` snapshot price through its recorded `price_observed_at`, or an in-window replay-safe `price_cache` observation); anything else stays NULL and enters this backlog. Expect this for NAV tokens over weekends/holidays (observation older than 24h) and for nominal-par assets. Heal skips coins with no admissible evidence in its 48-hour window, so their rows age into this historical backlog instead of blocking the auto-heal budget. The operator path is stricter still: exact UTC event-day evidence only.
6. Rows written before v6.23 with `price_source = 'price-cache-current'` were valued at ingestion and stamped with run time. Audit only retained raw rows (compare `timestamp` with `price_timestamp`) through a separately approved bounded repair plus hourly rebuild. Eight days is the pruning age floor, not a guaranteed deletion time: unsettled valuation, incomplete hours and tape/frontier debt can retain older rows. Pruned rows and their hourly buckets cannot reconstruct that provenance.

### Valuation-completeness debt

Unpriced events are retention-protected until price repair classifies them, so a burst of out-of-window events (backfills, new configs, `price_cache` outages) grows `nullPriceBacklogHistorical` and keeps their hours `partial`: the public API publishes null nets and NR pressure for those windows. Watch `nullPriceBacklog` in `sync-mint-burn` metadata and drain it through the historical price debt sequence above rather than loosening the ±24h admission.

## Prevention

- Token identity comes from shared stablecoin metadata, but tracker-specific config lives in `worker/src/lib/mint-burn-contracts.ts` and lane state in `worker/src/cron/mint-burn/run-state.ts`. Adding a new coin without mint/burn contract config keeps it outside mint/burn reconciliation and backfill scope; it does not emit a per-coin `onchain_monitor_unavailable`.
- Supply-monitor divergence thresholds live in `shared/lib/status-thresholds.ts`. Native conservation instead requires an exact zero residual; passing audit and checkpoint evidence must each be no older than 75 minutes (`worker/src/lib/status/derived-data.ts`). Do not loosen either policy to conceal missing proof.
