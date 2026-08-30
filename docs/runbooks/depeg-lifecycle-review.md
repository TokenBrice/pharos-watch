# Depeg Lifecycle Review

Owner runbook for the lifecycle flags the daily digest cron computes over the
full open `depeg_events` set. Nothing here is automated beyond the flagging —
freezing or delisting a coin remains a manual decision with its own runbook
([`docs/freezing-stablecoins.md`](../freezing-stablecoins.md)).

## Why this exists

Depeg events have no terminal state for a permanently collapsed coin: the
detector closes events only on a sustained recovery inside the close threshold
(50 bps for USD pegs, 75 bps for non-USD), supply under $1M, direction
supersede, or untracking. A coin that dies at $0.38 with $20M of nominal
supply satisfies none of those — usx-dforce sat in an open
"active depeg" for 27 days (and led 17 consecutive digest headlines) before
its manual freeze; usda-avalon's event has been open since 2025-12-30.

## Flags

Computed daily by `worker/src/lib/depeg-lifecycle.ts` inside the digest cron's
active-depeg collector, over **all** open events (not the top-8 digest slice).
Rows without a live price are never flagged — a stale stored peak must not
trigger a freeze review. Thresholds owner-ratified 2026-07-18.
The 21- and 30-day thresholds use a rounded-hourly age that is then floored
into days, so they are not exact elapsed-day boundaries and can trip up to
~1 hour early.

| Flag | Condition | Meaning |
|------|-----------|---------|
| `stalled-collapse` | open ≥ 21 days AND live deviation ≥ 2,500 bps | The peg is not coming back on its own. Decide: freeze (see the freeze runbook), or document why the coin stays active. |
| `chronic-shallow` | open ≥ 30 days AND live deviation < 300 bps | The event is technically open (never recovered inside the 50 bps close threshold — half the 100 bps USD trigger, 75 bps for non-USD pegs) but describes a chronic soft peg, not a crisis. Decide: tolerate, or consider a detector-side close/re-baseline. |

## Where to see them

- **Cache:** D1 `cache` table, key `depeg:lifecycle-flags` —
  `{ updatedAt, flags: [{ stablecoinId, symbol, kind, currentBps, ageDays, mcapUsd }] }`,
  sorted by |deviation| × mcap.
- **Cron metadata:** the `daily-digest` cron lane's metadata string appends
  `lifecycle-review: SYMBOL:kind|…` whenever flags exist, so the admin crons
  view surfaces pending reviews without a new UI surface.

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
3. For each `chronic-shallow`: no digest impact (severity runs on the live
   deviation, and old unchanged events cannot lead) — the flag exists so a
   months-open event is a deliberate choice, not an oversight.
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

Do not invent announcement dates. If no public issuer announcement exists, leave the fields absent and keep treating the row as fingerprint-only elevated / at-risk rather than forcing a false terminal via K6 severe.
