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

New legs need durable current-fingerprint scan proof for the 90-day baseline through the incumbent publication watermark, plus a fresh frontier under the existing watermark budget. The baseline must also pass the existing hourly valuation-completeness rule: `valuation-incomplete` means the proof-qualified candidate still has incomplete or unknown valuation. Use the historical-price debt workflow below; scan proof alone cannot repair missing USD values. A proven zero-event baseline can qualify without prices. Inspect `publication.evaluatedAt`, `requiredBaselineSec`, `freshnessBudgetSec`, and each leg's `reason`, `baselineFrom`, `baselineTo`, `coveredSeconds` and `frontierAgeSec`. Missing proof is unavailable, not zero progress. Scheduled catch-up serves admitted configs first and spends only leftover bounded capacity on pending legs; event/receipt cost and provider errors can slow it. Do not move a cursor or add a grandfathered fingerprint to make admission pass.

The immutable legacy-cutover fingerprint roster pins the 137 pre-gate identities grandfathered for publication membership only; future configs use ordinary admission. It does not certify current coverage or extend legacy historical assurance. The new admission valuation check does not re-gate grandfathered or previously admitted legs. Once durably admitted, an unchanged fingerprint stays in scope if it later stalls; normal freshness/window gates then apply. Automatic stall quarantine is not implemented.

For a misbehaving config, use the supported configuration rollback:

1. Set `MINT_BURN_DISABLED_IDS` to the exact `configKey` from publication metadata to disable one leg, or its stablecoin ID to disable all that coin's configs. Values are comma-separated and matched case-insensitively. `MINT_BURN_DISABLED_SYMBOLS` remains supported; `enabled=false` is the checked-in configuration equivalent. Changing the runtime switch requires configuration activation, not a code revert.
2. Observe the first scheduled mint/burn run using that configuration. Before scanning it persists the effective disabled-key policy and atomically purges affected flow caches. Publication readers and later cache writes obey that durable policy, including the aggregate gauge and downstream published-flow readers. A configuration update alone is not evidence that the policy has been applied; verify the affected legs report `disabled` and that the next aggregate's watermark/totals/weights use the remaining admitted scope.
3. Preserve raw events, scan proofs and admission rows for diagnosis. Removing the switch resumes the same exact-fingerprint admission and ordinary freshness checks; a changed fingerprint must qualify afresh. Verify a new publication rather than treating the re-enabled config's first attempted scan as recovery.

Existing same-coin/same-chain contracts share an hourly bucket. Disabling one therefore removes that shared chain leg (`shared-bucket-disabled`). A newly added sibling cannot be safely isolated in that bucket yet: it remains `pending-admission` / `unsupported-shared-bucket` and is excluded before scanning. Add per-contract event/hourly attribution before supporting such siblings; independent new-chain configs follow ordinary catch-up.

Provider recovery is separate: an open Alchemy circuit blocks only Alchemy requests; another admitted endpoint can continue. Inspect that provider's measured `providerOutcomes` and circuit, not a non-Alchemy config's degraded streak. The publication sidecar cannot fail a provider circuit. Do not clear another provider's breaker to cure a local write, conservation or coverage failure.

### USDT Tron admission and rollback

USDT Tron uses exact config key `tron-TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`. It starts as `pending-admission`; scheduled critical catch-up establishes its history after activation, with no pre-activation bootstrap requirement. The reviewed floor is block **84,842,059**, timestamp **2026-07-28 00:00:00 UTC**; its predecessor **84,842,058** is **2026-07-27 23:59:57 UTC**. The source label is `dwellir-tron-header-2026-07-28-reviewed-2026-10-28`. This is a coverage floor, not deployment evidence. Keep the block, source and event definitions stable because they participate in the admission fingerprint.

For the planned 2026-10-28 22:00 UTC activation, the floor supplies 92 days 22 hours: a 2-day-22-hour margin beyond the 90-day baseline. At three seconds/block the initial debt is about 2.68 million blocks. Pending Tron planning reserves enough capacity for the first scan and a retry over half that range, so eventful headers cannot force the same oversized prefix to fail every run. Conservatively allocating 60 requests to an opportunity leaves 57 after three shared head reads. With two topics and 10,000-block log pages, a 170,000-block prefix reserves `17 × 2 + 2 = 36` log/proof requests plus `9 × 2 + 2 = 20` for its 85,000-block retry: `56 ≤ 57`. A successful quiet prefix therefore uses 39 requests including the head; eventful scans and retries can consume the full allowance. With separate global head capacity, the 60-request config cap can fund a 180,000-block prefix and its 90,000-block retry (`38 + 20 = 58`). No historical-conservation requests are made.

Sixteen conservative half-hour opportunities cover 2.72 million blocks, enough for the initial debt plus roughly 9,600 moving-frontier blocks over eight hours. The scan-only estimate is 7.5–8 hours from the first adequately funded opportunity: a first run at October 28 22:04 UTC reaches its sixteenth opportunity at October 29 05:34 UTC, allowing through 06:04 for alignment. This is not an admission guarantee. Admitted work runs first; event timestamps, reduced retry prefixes, fallback, latency, sparse usable evidence and missing historical valuations can delay admission.

First-production acceptance:

1. Confirm migration `0288_mint_burn_admission.sql` is applied before the Worker/config activates.
2. Observe Tron as `pending-admission` with the expected fingerprint and advancing durable coverage/frontier metadata. The existing admitted roster, USDT published scope and common watermark must remain unchanged by pending Tron.
3. Inspect provider outcomes, request limits and `tronRpc` diagnostics. A stale solidified head carries `tron-rpc-stale-solid-head`; a failed head carries its failure reason. Neither is a successful up-to-date scan. Conservation remains `unsupported` / `tron-historical-state-unavailable` rather than a pass.
4. After full current-fingerprint 90-day coverage, complete baseline valuation and a fresh frontier, confirm durable `admitted` membership and a new publication containing Tron. Check `netFlow90dUsd` remains available where the incumbent value was available; then verify the expanded USDT nets, gauge weight, digest gauge inputs and DDR mint-surge scope. An eventful control must count Issue/Redeem once despite the paired Transfer.

To remove only Tron from ingestion and publication, append **`tron-TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`** to `MINT_BURN_DISABLED_IDS`, retaining other configured values, and activate that configuration. Do not use `usdt-tether` or `USDT` when Ethereum should remain enabled. Follow the policy-persistence/cache checks above: wait for the scheduled run to report this leg `disabled`, verify the remaining scope and account for ordinary edge-cache expiry. This is not an instantaneous CDN purge. Removing the switch retains exact-fingerprint admission but still requires ordinary fresh coverage. The scheduled path is the supported Tron catch-up mechanism; operator Tron backfill is not included in this release. Automatic operator selection stays EVM-only; explicit Tron selection returns HTTP 400 with `mint-burn-operator-chain-unsupported: tron` before credential checks, provider reads or D1 selection writes.

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
