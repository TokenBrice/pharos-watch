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
4. **Publication versus ingestion:** inspect the flow response's `publication.legs` before attributing a stale watermark to a new config. `pending-admission` does not enter published totals or weights. In Access-protected cron detail, `providerOutcomes` identifies actual RPC successes/failures, neutral reads and blocked requests; the cron's overall `error` status is not proof of an Alchemy outage.

## Remediation

- **Native mismatch:** investigate exact identity, reviewed conservation law, fetched/parsed/stored native event completeness and checkpoint hashes before choosing any repair. A mismatch stays unresolved until a verified pass replaces it; do not clear audit caches to make it green.
- **Coverage/backfill:** use the existing bounded mint/burn backfill only after identifying missing events/cursor coverage. Price backfill repairs valuation debt, never the native residual.
- **On-chain monitor unavailable:** usually indicates the recent `onchain_supply` monitor rows are missing or unreadable globally. Check the relevant supply-monitoring cron/status sections before treating it as a mint/burn config issue.

### Publication admission and operator disable

New legs need durable current-fingerprint scan proof for the 90-day baseline through the incumbent publication watermark, plus a fresh frontier under the existing watermark budget. The baseline must also pass the existing hourly valuation-completeness rule: `valuation-incomplete` means the proof-qualified candidate still has incomplete or unknown valuation. Use the historical-price debt workflow below; scan proof alone cannot repair missing USD values. A proven zero-event baseline can qualify without prices. Inspect the public response's full `publication.legs`, evaluation clock and baseline/freshness budgets. Cron metadata instead carries counts and a bounded non-admitted-leg sample; `legsShown`, `legsOmitted` and `legsTruncated` disclose truncation. Missing proof is unavailable, not zero progress. Scheduled catch-up serves admitted configs first and spends only leftover bounded capacity on pending legs; event/receipt cost and provider errors can slow it. Do not move a cursor or extend the grandfathered roster to make admission pass.

Publication membership is durable by `configKey`. The immutable `mint-burn-pipeline/grandfathered-config-keys.json` roster pins the 137 pre-gate keys grandfathered for membership only; future keys use ordinary admission. Configuration edits retain membership, while current-fingerprint scan proof remains mandatory for public coverage. Grandfathering does not certify coverage or extend legacy historical assurance. The admission valuation check does not re-gate grandfathered or previously admitted legs. An admitted leg that later stalls stays in scope under normal freshness/window gates; automatic stall quarantine is not implemented.

For a misbehaving config, use the supported configuration rollback:

1. Set `MINT_BURN_DISABLED_IDS` to the exact `configKey` from publication metadata to disable one leg, or its stablecoin ID to disable all that coin's configs. Values are comma-separated and matched case-insensitively. `MINT_BURN_DISABLED_SYMBOLS` remains supported; `enabled=false` is the checked-in configuration equivalent. Changing the runtime switch requires configuration activation, not a code revert.
2. Observe the first scheduled mint/burn run using that configuration. Before scanning it persists the effective disabled-key policy and atomically purges affected flow caches. Publication readers and later cache writes obey that durable policy, including the aggregate gauge and downstream published-flow readers. A configuration update alone is not evidence that the policy has been applied; verify the affected legs report `disabled` and that the next aggregate's watermark/totals/weights use the remaining admitted scope.
3. Preserve raw events, scan proofs and admission rows for diagnosis. Disabled or inactive known keys are retained in `mint_burn_publication_policy.paused_keys`. Removing the switch retains membership, but a stale leg remains `pending-admission` / `reactivation-pending` until its current-fingerprint frontier is fresh and it proves the incumbent publication's closed hour. It does not repeat 90-day admission. Verify a fresh publication rather than treating the first attempted scan as recovery.

Existing same-coin/same-chain contracts share an hourly bucket. Disabling one therefore removes that shared chain leg (`shared-bucket-disabled`); the existing BUIDL siblings also wait together during reactivation. A newly added sibling cannot be safely isolated in that bucket yet: it remains `pending-admission` / `unsupported-shared-bucket` and is excluded before scanning. Add per-contract event/hourly attribution before supporting such siblings; independent new-chain configs follow ordinary catch-up.

Apply the revised, unreleased `0288_mint_burn_admission.sql`, including `paused_keys`, before activating this Worker. The earlier draft is insufficient for these readers; a database that already applied it needs a separately numbered additive migration because `CREATE TABLE IF NOT EXISTS` cannot amend that table. During rollout, DEWS can consume a retained gauge without `publication` metadata by using only its published coins in the pinned legacy roster and reapplying current policy; it does not invent an empty scope while waiting for the next gauge. Existing freshness and coverage checks still apply.

Pending hourly-materialization failures are isolated after admitted work commits. `pending-hourly-recalc-failed` or `pending-cursor-commit-failed` holds the affected pending cursors/proofs for retry; it does not roll back admitted progress. Inspect the bounded `pendingMaterialization` failure metadata and retained dirty-hour evidence before repair.

Provider recovery is separate: an open Alchemy circuit blocks only Alchemy requests; another admitted endpoint can continue, and the disable policy still persists. Denied transaction-context reads keep the affected config retryable with `tx-context-request-not-started` instead of aborting every config. Inspect `providerOutcomes.terminalFailures` alongside request diagnostics: `ok` resets Alchemy only with an observed request, `degraded` is neutral, and `error` fails Alchemy only with required RPC evidence still incomplete in an admitted config/head scope. Recovered or certified-prefix retries, decode-only errors, conservation failures, exhausted budgets, denied requests, pending work, local exceptions and the publication sidecar cannot establish that failure. Mint/burn does not write Dwellir's parity circuit. Do not clear another provider's breaker to cure a local write, conservation or coverage failure.

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
