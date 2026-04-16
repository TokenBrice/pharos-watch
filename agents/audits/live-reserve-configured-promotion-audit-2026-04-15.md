# Live Reserve Configured Promotion Audit — 2026-04-15

## Scope

Question: which of the 31 `Reserve View` assets currently shown as `configured` can be improved or fixed so the coverage page promotes them to `live`.

Assumption: `live` means the coverage snapshot sees `reportCard.rawInputs.collateralFromLive === true`. That flag is produced only when `loadFreshIndependentLiveReserveMap()` returns slices for the coin.

Production snapshot checked through `https://pharos.watch/_site-data/report-cards` and `/_site-data/stablecoin-reserves/:id` at about `2026-04-15 06:46 UTC`.

## Promotion Gate

The promotion path is:

- `src/hooks/use-coverage-matrix-model.ts` passes `reportCard.rawInputs.collateralFromLive` as `liveReserveFresh`.
- `src/lib/coverage.ts` renders a true-live adapter as:
  - `Live` when `liveReserveFresh === true`
  - `Configured` when `liveReserveFresh === false`
  - `Checking` when report-card freshness data is unavailable
- `worker/src/lib/live-reserves-store-overview.ts::loadFreshIndependentLiveReserveMap()` requires:
  - consistent `reserve_sync_state` and `reserve_composition` snapshot
  - sync status `ok`
  - fresh composition row within `LIVE_RESERVE_FRESHNESS_SEC`
  - at least one valid slice
  - adapter evidence class `independent`
  - `metadata.sourceTimestamp > 0`, or `metadata.freshnessMode` is `verified` / `not-applicable`

Warnings do not block promotion directly. They block only when they make sync status `degraded` or `error`, or when the metadata remains unverified.

## Current Blockers

| Blocker | Count | Coins |
| --- | ---: | --- |
| `freshness-unverified` | 22 | USDC, USDY, M, sUSDai, EURC, crvUSD, IUSD, MUSD, fxUSD, USDN, ZCHF, USDSC, ctUSD, wM, USDnr, USDK, XO, cUSD, BtcUSD, wsrUSD, CEUR, DEURO |
| `sync-degraded` | 6 | GHO, reUSD, UTY, USDaf, YZUSD, AZND |
| `sync-error` | 2 | FDUSD, USDO |
| `weak-live-probe` | 1 | USDz |

## Likely Promotable With Small Changes

| Coins | Current issue | Smallest plausible fix | Notes |
| --- | --- | --- | --- |
| USDC, EURC | Circle adapter parses composition but ignores page-level `As of Apr 09, 2026`. Definition only allows unverified freshness. | Parse the `As of ...` disclosure date in `circle-transparency.ts`, emit `verifiedFreshnessMetadata()`, change `circle-transparency` allowed freshness to `VERIFIED_OR_UNVERIFIED_FRESHNESS`, add tests. | Prefer the reserve disclosure `As of` date over page `Last Published` / HTTP `Last-Modified`; the latter proves page freshness, not reserve-source freshness. Should promote while the disclosure is within the 7-day disclosure window. |
| M, MUSD, USDN, USDSC, ctUSD, wM, USDnr, USDK, XO | M0 `CollateralCurrent` response has no timestamp, but the same GraphQL schema exposes timestamped collateral/update fields; current latest timestamp is fresh. | Extend `m0.ts` GraphQL query to fetch a trustworthy collateral/source timestamp, emit verified freshness, change adapter definition to allow verified freshness, add tests. | Need decide whether latest update is sufficient for aggregate freshness or whether min active-minter timestamp is required. Candidate fields include `collateralUpdateds`, `minterGateway_latestUpdateTimestampSnapshots`, or a dated `CollateralDailyAverages` point. |
| cUSD, CEUR | Mento page embeds `updated` millisecond timestamps in the reserve payload; adapter currently uses only composition percentages. | Extract a reserve-source timestamp from the embedded `reserveHoldings` data in `mento.ts`, emit verified freshness, change adapter definition to allow verified freshness, add tests. | Current embedded timestamps are fresh. |
| sUSDai | Proof API has no timestamp, but the app page embeds `timeLastUpdated` values for proof-of-reserve collateral. | Pair the existing proof API payload with a timestamp read from `https://app.usd.ai/reserves`, emit verified freshness, change adapter definition to allow verified freshness, add tests. | The implementation should avoid treating unrelated historical rows as current reserve rows; use the app-page update marker conservatively with the adapter source-age policy. |
| reUSD | `re-metrics` has verified fresh timestamps, but sync is degraded because token `liusd-4w` is unmapped and defaults to medium risk. | Add `liusd-4w` to `SYMBOL_CONFIG` in `re-metrics.ts` with an explicit risk label, add fixture/test. | Should promote once sync returns `ok`. |
| YZUSD | Accountable feed is fresh/verified, but 23.30% of buckets are unmapped in the coin config. | Extend YZUSD `riskMap`/`renameMap` in `shared/data/stablecoins/usd-minor.json` for the missing Accountable buckets. | Should promote after unknown exposure drops below degradation threshold. |
| USDO | OpenEden snapshot has verified fresh source timestamp; public direct fetch succeeds locally. Production latest status is `error` on fetch. | Add browser-style headers and/or fallback/retry behavior to `openeden.ts`; check circuit breaker/runtime transport. | If the Worker fetch succeeds, this should promote immediately. |

## Fixable But Not Sufficient Alone

| Coins | Current issue | Why not enough |
| --- | --- | --- |
| USDaf | Current degradation is a case-sensitive mapping miss: API returns `wBTC`, adapter map has `WBTC`. | Fixing the map should make sync `ok`, but the source still has `freshnessMode: unverified`, so it will remain `Configured` until the source exposes a timestamp or the adapter can move to a stronger current-state source. |
| GHO | On-chain freshness is `not-applicable`, but sync is `degraded` because residual issuance outside the two tracked GSM modules is 63.65%. | Promotion would require a deliberate policy exception for this residual warning, or broader tracking/classification that reduces residual issuance below the degraded threshold. This is not a parser bug. |
| AZND | Accountable source timestamp is just over the 3-day dashboard freshness limit. | May self-heal when upstream refreshes. Raising the limit would be a methodology choice, not a code fix. |
| UTY | Accountable source timestamp is roughly 15.6 days old. | Needs upstream refresh; increasing the threshold enough to promote this would weaken the freshness policy. |
| FDUSD | Production fetch currently errors, but the last successful disclosure is `Feb 28, 2026`. | Even if fetch succeeds, it will degrade under the 7-day disclosure freshness limit unless First Digital publishes a newer reserve date or the policy changes. |

## Not Immediate Promotions

| Coins | Current blocker | Needed to promote safely |
| --- | --- | --- |
| USDY | Ondo `getPrice()` oracle mode has no update timestamp; tested `getAssetPrice` / `tokenToRWAOracle` against the configured oracle and both reverted. | Different oracle/source exposing `updatedAt`, or a reviewed method to prove current-state freshness. |
| crvUSD | Adapter combines Curve market API data with Yield Basis on-chain reads; the Curve market API has no source timestamp. | Replace or corroborate the API leg with direct current-state on-chain reads, or find a timestamped Curve source. |
| IUSD | infiniFi protocol stats API has no trustworthy timestamp. | Provider timestamp, or direct on-chain/source-specific reads sufficient for `not-applicable` freshness. |
| fxUSD | FX protocol API has no trustworthy timestamp. | Provider timestamp or direct on-chain reserve reads. |
| ZCHF, DEURO | Position and price APIs have no trustworthy source timestamp. | Timestamped APIs or direct current-state reads for both positions and prices. |
| BtcUSD | btcfi market/handler APIs have no timestamp. | Provider timestamp or on-chain/current-state replacement source. |
| wsrUSD | Reservoir API has no source timestamp. | Provider timestamp or direct current-state balance-sheet reads. |
| USDz | `anzen-usdz` is intentionally classified as `weak-live-probe`, not independent evidence. | Stronger evidence for the underlying SPCT reserve, or a deliberate methodology change reclassifying the adapter. |

## Suggested Order

1. Implement timestamp parsing for Circle and Mento. Low risk, clear source evidence, 4 coins.
2. Implement M0 timestamp sourcing after deciding latest-update vs min-active-minter semantics. Potentially 9 coins.
3. Add USD.AI app-page timestamp hydration if the timestamp can be tied cleanly to the proof rows. Potentially 1 coin.
4. Fix reUSD and YZUSD mappings. Clear data/config fixes, 2 coins.
5. Harden OpenEden Worker transport. Likely 1 coin.
6. Decide explicitly whether GHO residual issuance should remain a degradation for collateral scoring.
7. Fix USDaf `wBTC` mapping, but do not expect promotion until freshness is also solved.
8. Leave UTY, AZND, FDUSD, and the no-timestamp API feeds as methodology/source follow-ups rather than forcing promotion.
