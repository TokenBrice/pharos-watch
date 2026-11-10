# Depeg Lifecycle Review

Owner runbook for the lifecycle flags the daily digest cron computes over the
eligible open `depeg_events` set. Nothing here is automated beyond the flagging —
freezing or delisting a coin remains a manual decision with its own runbook
([`docs/freezing-stablecoins.md`](../freezing-stablecoins.md)).

## Why this exists

An open lifecycle is not proof of a recoverable coin. Closure follows the
detector's [close-reason contract](../depeg-detection.md#database-schema) and
[recovery thresholds](../depeg-detection.md#thresholds--constants). A permanent
collapse can satisfy none of these conditions, so the flags below prompt manual
lifecycle review rather than auto-close.

## Flags

Computed daily by `worker/src/lib/depeg-lifecycle.ts` inside the digest cron's
active-depeg collector, before the prompt slice. The collector excludes
untracked/frozen coins and unavailable market caps. Flags require a fresh live
price and a positive current authoritative peg reference; the reference
latched when the event opened is not used for USD-quoted events because FX
and commodity references drift, and a stale stored peak never triggers a
freeze review. Flag thresholds, the current-versus-native reference authority
and the degraded-evidence gate are owned by
[the digest pipeline](../digest-pipeline.md#failure-handling). The 21- and
30-day thresholds use a rounded-hourly age that is then floored into days, so
they can trip up to ~30 minutes early.

| Flag | Decision |
|------|----------|
| `stalled-collapse` | A persistent severe dislocation needs review. Decide: freeze (see the freeze runbook), or document why the coin stays active. |
| `chronic-shallow` | The event is technically open (never recovered inside the detector's [close threshold](../depeg-detection.md#thresholds--constants)) but describes a chronic soft peg, not a crisis. Decide: tolerate, or consider a detector-side close/re-baseline. |

## Where to see them

- **Cache:** D1 `cache` table, key `depeg:lifecycle-flags` —
  `{ updatedAt, flags: [{ stablecoinId, symbol, kind, currentBps, ageDays, mcapUsd }] }`,
  sorted by |deviation| × mcap. The cache key, the
  `lifecycle-review: SYMBOL:kind|…` metadata suffix and the degraded-evidence
  gate are owned by
  [the digest pipeline](../digest-pipeline.md#failure-handling); a run with
  degraded lifecycle evidence leaves `updatedAt` naming the last successful
  read and the prior queue pending.

## Review procedure

1. Read the current flags:
   ```bash
   cd worker && npx --no-install wrangler d1 execute stablecoin-db --remote \
     --command "SELECT value FROM cache WHERE key = 'depeg:lifecycle-flags';"
   ```
2. For each `stalled-collapse`: verify the live price independently (the coin
   page, CoinGecko, on-chain pools). If the collapse is real and unremediated,
   run the freeze procedure; freezing removes the coin from the digest's
   active-depeg inputs immediately while preserving event history.
3. For each `chronic-shallow`: review whether the soft peg should remain
   tracked. The flag itself does not control digest eligibility; age, market
   impact, critical-risk overrides, and day-over-day changes do.
4. A flag that should be permanently tolerated (e.g., a documented chronic
   soft peg) can be noted in the coin's `notices`; the flag itself will keep
   reappearing by design.

## Wind-down curation loop (DDR K6)

DDR Stage 1 fires **K6 elevated** when a deep or supply-collapsing fingerprint
looks like an issuer wind-down but the coin registry lacks a timely
`windDownAnnouncedAt` (see `docs/depeg-resolver.md` Stage 1 K6). That elevated
factor is the curation prompt — not a separate review treadmill.

| Step | Action |
|------|--------|
| 1. Detect | Watch DDR reasons / admin cron metadata for `K6_wind_down` elevated (or a severe miss after a public issuer announcement). |
| 2. Scope | Confirm the announcement is for **this token/issuer id**, never a venue, minter dependency, or parent protocol alone. Venue wind-downs must not be written onto the coin. |
| 3. Curate | Within **~3 days**, set optional registry fields on the coin JSON: `windDownAnnouncedAt` (ISO date `YYYY-MM-DD`) and `windDownSourceUrl` (canonical public URL). Semantics: issuer's own public wind-down/termination announcement for this token — distinct from `frozenAt` (Pharos tracking stop). |
| 4. Validate | Coin schema validation + focused DDR fixtures must accept the fields. Severe K6 only applies when `windDownAnnouncedAt ≤` lock/evaluation time; future announcements must not back-fire on earlier locks. |
| 5. Freeze if terminal | If the asset is also a stalled collapse, continue with the freeze runbook after curation; freezing is still manual. |

Do not invent announcement dates. If no public issuer announcement exists, leave the fields absent: K6 remains fingerprint-only elevated evidence, and the full rubric determines the verdict rather than forcing terminal via K6 severe.
