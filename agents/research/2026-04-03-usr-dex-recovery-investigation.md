# USR Depeg Recovery Investigation

Date: 2026-04-03

## Scope

Investigate why `usr-resolv` depeg history showed repeated recoveries to `$1` even though the asset has remained severely depegged since 2026-03-22.

## Live Findings

- `GET /api/depeg-events?stablecoin=usr-resolv&limit=20` returned multiple `source: "live"` rows closed with `recoveryPrice` around `$0.9993-$1.0007`.
- The long-running live event from `2026-03-22T02:04:57Z` was closed at `2026-04-02T11:04:06Z`, then immediately replaced by several short-lived live events.
- `GET /api/stablecoins` showed the current primary price near `$0.1041` with multi-source agreement (`coingecko+pyth+redstone`).
- `GET /api/peg-summary` showed `dexPriceCheck.dexPrice = 0.999298` with `sourceTvl ~= $2.14M`, despite the primary market price being near `$0.104`.
- `GET /api/dex-liquidity` for `usr-resolv` showed the aggregate DEX price was being pulled toward a near-peg `bunni-ethereum` protocol source, while visible pools and challenger-style pools still clustered around `$0.10-$0.12`.

## Root Cause

The detector treated the aggregate `dex_prices` row as sufficient evidence for live depeg-state mutation when the primary price was `confirm_required`.

That aggregate row is useful as a pricing bridge, but it is too coarse to act as a standalone recovery oracle:

- a single high-TVL protocol median near peg could dominate the aggregate
- deeper DEX evidence could still contain large challenger pools showing the original depeg
- the recovery path accepted that aggregate row and closed the open event
- the next strong primary sample reopened the depeg, creating synthetic split rows with fake `recoveryPrice ~= $1`

This was not USR-specific; any coin with a misleading aggregate DEX row could be affected.

## Implemented Fix

Hardened `worker/src/cron/detect-depegs.ts` so aggregate DEX rows no longer mutate live depeg state on their own.

DEX-assisted recovery/suppression now requires:

- a trusted aggregate DEX row inside the threshold
- at least 2 corroborating protocol-level DEX sources inside the threshold
- no large challenger pool still showing the old depeg direction

DEX-assisted directional confirmation now also requires at least 2 corroborating protocol-level DEX sources in the expected depeg direction.

This protects:

- ambiguous-primary recovery closes
- authoritative-primary new-event suppression by “DEX says at peg”
- other aggregate-DAX-driven live-state mutations that previously relied on one coarse bridge row

## Follow-up

Existing split rows can be repaired with the existing synthetic-split audit flow after deployment:

- `POST /api/audit-depeg-history?repair=synthetic-splits`
- optionally filtered by `symbol=USR` for a narrower repair pass
