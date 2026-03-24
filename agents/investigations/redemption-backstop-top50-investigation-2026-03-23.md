# Redemption Backstop Top-50 Investigation

Date: 2026-03-23

## Scope

- Market-cap ranking from `https://api.pharos.watch/api/stablecoins`
- Redemption snapshot from `https://api.pharos.watch/api/redemption-backstops`
- Both live API snapshots were current at 2026-03-23 10:12:55 UTC
- Internal confidence/scoring logic reviewed in:
  - `docs/redemption-backstops.md`
  - `shared/lib/redemption-backstop-confidence.ts`
  - `shared/lib/redemption-backstop-configs/*`
  - `worker/src/lib/redemption-backstop-sources.ts`
  - relevant reserve adapters under `worker/src/cron/reserve-adapters/*`

## Confidence Model Constraint

The current model is the main reason so many large names are still `low`:

- `low` if the route is unresolved
- `low` if capacity is still `heuristic`
- `medium` when the route is resolved and capacity is `documented-bound` or `dynamic`
- `high` only when the route is resolved, capacity is `dynamic`, and fee confidence is not `undisclosed-reviewed`

That means many big names are not low-confidence because the redemption route is weak. They are low-confidence because the route is modeled with heuristic capacity.

## Topline Findings

- Top-50 split today: 36 `low`, 12 `missing`, 1 `medium`, 1 `high`
- Market cap sitting in `low` confidence routes: about `$311.668B`
- Market cap with no redemption route at all in the top 50: about `$10.289B`
- The biggest immediate opportunity is docs/config work:
  - 27 names
  - about `$293.628B`
  - plausible path to at least `medium`
- The real `high`-confidence upgrade candidates are much narrower:
  - `USDS`, `DAI`, `USDD`, `DOLA`
  - `IUSD` can likely move from `medium` to `high`
  - these need dynamic capacity or fee telemetry, not just docs review

## Effort Rubric

- `0`: already at target
- `1`: docs/config-only; no new data source or adapter work
- `2`: add or reclassify config using existing data/model primitives
- `3`: adapter or telemetry work needed for capacity and/or fee fidelity
- `5`: blocked, poor candidate, or likely should stay out of redemption coverage

Priority ranking below uses:

- `priority = market cap / effort`

This intentionally favors assets where a small amount of work unlocks confidence for a large share of tracked market cap.

## Important Corrections Discovered

These matter because some names should not just be "upgraded"; they likely need route corrections first:

- `syrupUSDC` and `syrupUSDT`
  - Maple docs describe `requestRedeem()` and a withdrawal queue.
  - Most withdrawals are processed within 24h, but can take up to 30 days.
  - Current `stablecoin-redeem` / immediate-style modeling looks too optimistic.
- `USDai`
  - USD.AI docs distinguish `USDai` from `sUSDai`.
  - `USDai` is described as instantly redeemable, while `sUSDai` uses 30-day windows.
  - Current queue-heavy modeling likely mixes the two and understates `USDai`.
- `FRAX`
  - Frax docs explicitly say FRAX stablecoins are non-redeemable.
  - This looks like a candidate to remain outside redemption-backstop coverage.
- `crvUSD`
  - Curve docs describe mint/borrow mechanics against collateral.
  - I did not find a credible holder redemption rail comparable to the modeled backstop families.

## Ranked Priority List

Highest-impact names after weighting market cap against effort:

| Priority | Asset | MCap | Current | Target | Effort | What Would Move It |
| --- | --- | ---: | --- | --- | ---: | --- |
| 1 | USDT | $184.071B | low | medium | 1 | Review issuer redemption docs and mark `supply-full` as `documented-bound` |
| 2 | USDC | $78.943B | low | medium | 1 | Same as USDT; Circle Mint route is already modeled |
| 3 | USD1 | $4.431B | low | medium | 1 | Review BitGo / issuer docs and mark `supply-full` as `documented-bound` |
| 4 | PYUSD | $4.094B | low | medium | 1 | Review Paxos/PayPal redemption docs and mark `supply-full` as `documented-bound` |
| 5 | USDS | $8.667B | low | high | 3 | Add dynamic LitePSM capacity telemetry instead of heuristic ratio |
| 6 | BUIDL | $2.543B | low | medium | 1 | Review NAV redemption docs and mark `supply-full` as `documented-bound` |
| 7 | USYC | $2.432B | low | medium | 1 | Review Hashnote redemption docs and mark `supply-full` as `documented-bound` |
| 8 | XAUT | $2.410B | low | medium | 1 | Review Tether Gold delivery/redemption docs and mark `supply-full` as `documented-bound` |
| 9 | PAXG | $2.143B | low | medium | 1 | Review Paxos gold redemption docs and mark `supply-full` as `documented-bound` |
| 10 | USDe | $5.917B | missing | medium | 3 | Add whitelisted mint/redeem config and expose liquid stable redemption buffer from Ethena telemetry |
| 11 | USDG | $1.671B | low | medium | 1 | Review Paxos USDG docs and mark `supply-full` as `documented-bound` |
| 12 | RLUSD | $1.527B | low | medium | 1 | Review Ripple redemption docs and mark `supply-full` as `documented-bound` |
| 13 | DAI | $4.579B | low | high | 3 | Same as USDS; dynamic LitePSM capacity is the clean upgrade path |
| 14 | USDY | $1.312B | low | medium | 1 | Review Ondo NAV redemption docs and mark `supply-full` as `documented-bound` |
| 15 | USTB | $1.242B | low | medium | 1 | Review Superstate redemption docs and mark `supply-full` as `documented-bound` |
| 16 | U | $1.006B | low | medium | 1 | Review 1:1 burn/redeem docs and mark `supply-full` as `documented-bound` |
| 17 | USDTB | $0.893B | low | medium | 1 | Review Ethena / Anchorage route docs and mark `supply-full` as `documented-bound` |
| 18 | OUSG | $0.711B | low | medium | 1 | Review Ondo instant-manager docs and mark `supply-full` as `documented-bound` |
| 19 | syrupUSDC | $1.822B | low | medium | 3 | Re-model as queue/buffer aware using Maple withdrawal docs and/or queue telemetry |
| 20 | YLDS | $0.595B | low | medium | 1 | Review Figure redemption docs and mark `supply-full` as `documented-bound` |

## Recommended Work Buckets

### Bucket 1: Docs / Config Only

These are the best immediate ROI. They already have a modeled route, and the main missing piece is upgrading heuristic capacity to a reviewed `documented-bound` route.

Coverage in this bucket:

- 27 names
- about `$293.628B` of top-50 market cap

Names in priority order:

- `USDT` ($184.071B): offchain issuer, low -> medium
- `USDC` ($78.943B): offchain issuer, low -> medium
- `USD1` ($4.431B): offchain issuer, low -> medium
- `PYUSD` ($4.094B): offchain issuer, low -> medium
- `BUIDL` ($2.543B): offchain issuer, low -> medium
- `USYC` ($2.432B): offchain issuer, low -> medium
- `XAUT` ($2.410B): offchain issuer, low -> medium
- `PAXG` ($2.143B): offchain issuer, low -> medium
- `USDG` ($1.671B): offchain issuer, low -> medium
- `RLUSD` ($1.527B): offchain issuer, low -> medium
- `USDY` ($1.312B): offchain issuer, low -> medium
- `USTB` ($1.242B): offchain issuer, low -> medium
- `U` ($1.006B): stablecoin-redeem, low -> medium
- `USDTB` ($0.893B): offchain issuer, low -> medium
- `OUSG` ($0.711B): stablecoin-redeem, low -> medium
- `YLDS` ($0.595B): offchain issuer, low -> medium
- `USD0` ($0.559B): stablecoin-redeem, low -> medium
- `TUSD` ($0.484B): offchain issuer, low -> medium
- `A7A5` ($0.474B): offchain issuer, low -> medium
- `EURC` ($0.421B): offchain issuer, low -> medium
- `FDUSD` ($0.386B): offchain issuer, low -> medium
- `KAU` ($0.326B): offchain issuer, low -> medium
- `BRZ` ($0.257B): offchain issuer, low -> medium
- `KAG` ($0.228B): offchain issuer, low -> medium
- `AUSD` ($0.167B): offchain issuer, low -> medium
- `satUSD` ($0.159B): collateral-redeem, low -> medium, assuming docs support protocol-level redemption arbitrage
- `GUSD` ($0.143B): offchain issuer, low -> medium

Practical implication:

- This is the fastest path to materially improving top-end coverage.
- It will mostly produce `medium`, not `high`, because these routes still lack dynamic immediate-capacity measurement.

### Bucket 2: Add / Reclassify Config Using Existing Primitives

These are not blocked by missing data plumbing. They mostly need a new route config or a route-family correction that better matches the product docs.

Coverage in this bucket:

- 6 names
- about `$1.528B`

Names:

- `USX` ($0.360B): add new issuer-style config using institutional mint/redeem docs
- `USDai` ($0.329B): likely route-family correction; docs describe direct burn/withdraw for supported stablecoins
- `USDA` ($0.271B): add new config for 1:1 USDa -> USDT conversion with one-business-day settlement
- `M` ($0.225B): add config for M0 primary-liquidity / extension redemption path
- `NUSD` ($0.199B): review docs and likely replace the conservative queue heuristic with a more direct router-based route
- `IUSD` ($0.144B): already medium; with dynamic capacity already present, the main remaining work is fee confidence so it can reach high

### Bucket 3: Telemetry / Adapter Work Needed

These have the biggest methodology lift potential beyond `medium`, but they need new telemetry or adapter work.

Coverage in this bucket:

- 9 names
- about `$25.058B`

Names:

- `USDS` ($8.667B): dynamic LitePSM capacity
- `USDe` ($5.917B): whitelisted config plus live liquid-buffer telemetry
- `DAI` ($4.579B): dynamic LitePSM capacity
- `syrupUSDC` ($1.822B): queue-aware Maple modeling
- `USDf` ($1.631B): Falcon queue/buffer modeling
- `USDD` ($1.152B): dynamic PSM capacity
- `syrupUSDT` ($0.924B): queue-aware Maple modeling
- `reUSD` ($0.184B): public transparency exists, but no adapter/config yet for the instant buffer
- `DOLA` ($0.182B): dynamic PSM/Fed capacity

Most likely `high`-confidence wins in this bucket:

- `USDS`
- `DAI`
- `USDD`
- `DOLA`

`IUSD` is the other realistic `high` candidate, but it sits in Bucket 2 because the dynamic capacity part is already done.

### Bucket 4: Defer / Likely Not Worth Near-Term Spend

These are poor candidates right now.

Coverage in this bucket:

- 7 names
- about `$1.885B`

Names:

- `USDX` / live ID `214` ($0.683B): not in local registry; asset curation first
- `crvUSD` ($0.247B): no credible holder redemption rail found in official docs
- `BUSD` / live ID `153` ($0.233B): not in local registry; likely cemetery path
- `FRAX` ($0.210B): official docs say non-redeemable
- `HUSD` / live ID `17` ($0.192B): not in local registry; likely cemetery path
- `FLEXUSD` / live ID `21` ($0.166B): not in local registry; likely cemetery path
- `MUST` / live ID `328` ($0.154B): not in local registry; asset curation first

## Suggested Execution Order

1. Do the docs/config-only medium lifts first.
   - This covers the most market cap for the least work.
   - It should materially improve the module without touching adapters.
2. Then do the dynamic-capacity high-confidence lifts.
   - `USDS`, `DAI`, `USDD`, `DOLA`
   - optionally `IUSD` fee confidence in the same pass
3. Then add missing high-impact configs.
   - `USDe`, `USDf`, `USX`, `USDA`, `M`, `NUSD`
4. Treat Maple as a correction project, not just a confidence uplift.
   - better confidence probably comes with a lower but more defensible route score
5. Do not spend near-term time on `FRAX`, `crvUSD`, or the non-registry numeric IDs.

## Sources

Internal:

- `docs/redemption-backstops.md`
- `shared/lib/redemption-backstop-confidence.ts`
- `shared/lib/redemption-backstop-configs/offchain-issuer.ts`
- `shared/lib/redemption-backstop-configs/stablecoin-redeem.ts`
- `shared/lib/redemption-backstop-configs/psm-and-basket.ts`
- `shared/lib/redemption-backstop-configs/queue-redeem.ts`
- `shared/lib/redemption-backstop-configs/collateral-redeem.ts`
- `worker/src/lib/redemption-backstop-sources.ts`
- `worker/src/cron/reserve-adapters/ethena.ts`
- `worker/src/cron/reserve-adapters/falcon.ts`
- `worker/src/cron/reserve-adapters/m0.ts`
- `worker/src/cron/reserve-adapters/frax.ts`
- `worker/src/cron/reserve-adapters/reservoir.ts`
- `worker/src/cron/reserve-adapters/infinifi.ts`
- `worker/src/cron/reserve-adapters/sky-makercore.ts`

Live data:

- https://api.pharos.watch/api/stablecoins
- https://api.pharos.watch/api/redemption-backstops

Official docs / primary sources used to validate route quality or blockers:

- Ethena terms and redemption conditions: https://docs.ethena.fi/resources/usde-terms-and-conditions
- Falcon mint/redeem flow: https://docs.falcon.finance/resources/quick-app-guide/navigating-the-swap-tab
- Falcon collateral mechanics: https://docs.falcon.finance/mechanism/usdf/overcollateralization-ratio
- Maple withdrawal queue docs: https://docs.maple.finance/syrupusdc-for-lenders/risk
- Maple backend integration / `requestRedeem()`: https://docs.maple.finance/integrate-syrupusd/backend-integrations
- M0 ecosystem and shared liquidity:
  - https://docs.m0.org/get-started/m0-ecosystem/
  - https://docs.m0.org/get-started/accessing-liquidity/
  - https://docs.m0.org/home/technical-documentations/extensions/
- USD.AI redemption behavior:
  - https://docs.usd.ai/faq/usdai-and-susdai-101
  - https://docs.usd.ai/technical-protocol-overview
- Re Protocol redemption buffer / queue:
  - https://docs.re.xyz/protocol/redemption-process-and-liquidity
  - https://docs.re.xyz/faqs
- Avalon USDa 1:1 conversion:
  - https://docs.avalonfinance.xyz/avalon-btcfi-products/cedefi-cdp-usda
  - https://docs.avalonfinance.xyz/avalon-btcfi-products/cedefi-cdp-usda/why-usda-stands-out
- Neutrl documentation and audit surfaces:
  - https://docs.neutrl.fi/
  - https://docs.neutrl.fi/pdf/report-cantinacode-neutrl-2407.pdf
- Frax non-redeemability:
  - https://docs.frax.finance/frax-v3-100-cr-and-more/overview
- Curve crvUSD docs:
  - https://resources.curve.finance/crvusd/overview/
