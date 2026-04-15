# Redemption Backstop Safety Eligibility Audit - 2026-04-15

## Scope

Goal: identify stablecoins with a modeled redemption backstop that is not used in Safety Score Liquidity / Exit, excluding CDP stablecoins that are being researched separately, and propose adapter or config enhancements that could make the route eligible without weakening the current requirements.

Assumptions:

- Runtime truth comes from the live website data lane fetched on 2026-04-15:
  - `https://pharos.watch/_site-data/report-cards`
  - `https://pharos.watch/_site-data/redemption-backstops`
- The live report-card payload reported `redemptionStale=false`; redemption snapshot age was about 48 minutes at fetch time.
- "Does not make the cut" means `rawInputs.redemptionBackstopScore != null` and `rawInputs.redemptionUsedForLiquidity === false`.
- I excluded the CDP-style set by primary mechanism, not by route family alone: Liquity-style troves, overcollateralized borrow/CDP systems, and close variants.
- I did not propose any change to `isRedemptionEligibleForLiquidity()`, route-family caps, or the severe-active-depeg live-direct gate.

## Current Gate

Safety Score Liquidity / Exit only uses redemption if all of these remain true:

- row is resolved and scored
- `modelConfidence` is not `low`
- `capacitySemantics` is not `eventual-only`
- route is not impaired, paused, degraded, or cohort-limited
- during a severe active depeg, the route is live-direct, dynamic, permissionless, and atomic or immediate

Adapter implications:

- `supply-full` capacity never qualifies because it resolves to `eventual-only`.
- Heuristic `supply-ratio` routes stay excluded because they produce `modelConfidence=low`.
- A route can become eligible only by emitting or configuring an immediate-bounded capacity with non-heuristic confidence, while preserving freshness and warning checks.
- Live reserve adapters must declare redemption capacity support. The validator rejects capacity emitted by adapters whose definition says `redemptionTelemetry.capacity = "none"`.

## Inventory

Live excluded rows found: 128.

CDP-style rows omitted from this audit: 16.

Omitted CDP set: `BOLD`, `fxUSD`, `LUSD`, `USND`, `USDp`, `FEUSD`, `USDaf`, `meUSD`, `ebUSD`, `REUSD`, `NECT`, `satUSD`, `USDA` (Avalon), `USDQ` (Quill), `USDK`, `USBD`.

Non-CDP rows in scope: 112.

Breakdown:

| Group | Count | Current blocker | Main adapter path |
| --- | ---: | --- | --- |
| Issuer fiat/offchain | 57 | mostly `eventual-only` full-supply issuer terms | source-specific liquid reserve or daily-limit capacity, not total reserves |
| Tokenized treasury / NAV | 11 | NAV proof or issuer terms but no immediate redemption capacity | liquidity-facility or instant-redemption adapters |
| Commodity | 8 | physical bar inventory is not immediate exit capacity | only a live cash buyback / redemption facility can qualify |
| Existing live-proxy/direct fix | 4 | current config or deployed version is not using already-modeled live capacity | align adapter definitions, configs, deployment |
| Onchain basket/stable redeem | 14 | full-system basket redeemability, no bounded current output amount | direct contract balance / quote / pause reads |
| Strategy or queue buffer | 15 | full eventual queue or heuristic buffer | live hot-buffer plus queue-depth/current-route telemetry |
| M0 lineage | 3 | M0 collateral feed exists but route remains issuer/full-supply | promote eligible collateral/current cash as proxy capacity |

## Highest-Leverage Fixes

### 1. Fix adapters that already emit capacity-like telemetry

These are the safest first pass because the code already has most of the raw data. Do not simply flip route configs; first make the adapter declarations, validation, and tests consistent.

| Adapter | Affected in-scope rows | Current issue | Enhancement |
| --- | --- | --- | --- |
| `cap-vault` | `CUSD` | Live production redemption snapshot still shows v3.8-style `supply-full` eventual-only scoring, while local docs/code describe v3.9 live Cap Vault capacity. | Deploy/refresh the current `cap-vault` path and keep `cusd-cap` on `reserve-sync-metadata`. This should become live-direct, immediate-bounded without methodology changes. |
| `ethena` | `USDe` | Adapter can parse `Liquid Cash`, but the live row still falls back to heuristic immediate capacity. A direct API smoke on 2026-04-15 returned about `$5.17B` Liquid Cash against `$5.84B` total backing. | Investigate why reserve metadata is not being accepted for redemption scoring: stale source, warnings, old deployment, or D1 state. Keep this as live-proxy capacity, not full backing. |
| `frax-balance-sheet` | `FRXUSD`, `USSD`, maybe `FPI` if direct redemption is still supported | Adapter computes stable redeemable balances, but local adapter definitions need to explicitly support redemption capacity before those fields are safe under validation. | Declare proxy capacity support, ensure `capacityRatioOfSupply` is relative to token supply rather than only reserve total, then switch eligible routes to `reserve-sync-metadata`. |
| `accountable` | `NUSD`, `USN`, `YUSD`, `UTY`, plus queue/strategy rows if configured | The adapter computes `stableRedeemableUsd` with broad name matching. That is useful but too loose for Safety Score without tighter mapping. | Add explicit per-asset redeemable bucket maps, declare proxy capacity only after tests prove unknown buckets fail closed, and emit route/queue status when source exposes it. |
| `m0` | `M`, `MUSD`, `USDN` | M0 GraphQL exposes `eligibleTreasuries`, `eligibleTokenCollateral`, and `totalCash`; local adapter computes `eligibleCurrentCapacityUsd`, but live routes still score issuer full-supply. | Declare proxy capacity support for `m0`, wire M0-lineage configs to `reserve-sync-metadata`, and label access as whitelisted primary if redemption is minter/extension-limited. |

### 2. Add source-specific liquid-bucket adapters for issuer rails

These rows are currently valid standalone issuer redemption routes, but Safety Score should not use full supply as exit capacity. They can qualify only when the source publishes a current, bounded liquid bucket or hard daily limit.

Good candidates:

- `USDC`, `EURC`: `circle-transparency` already parses dated reserve buckets. Add `redemption.capacityUsd` from the buckets that are plausibly same-day liquid, such as bank deposits and overnight reverse repo. Do not count all sub-3-month Treasuries unless Circle explicitly publishes them as same-day redeemable capacity.
- `FDUSD`: `fdusd-transparency` parses Cash, Bank Deposits, Reverse Repos, and T-bills. Emit capacity from Cash + Bank Deposits + Overnight Reverse Repos only after preserving source timestamp and verifying labels.
- `EURCV`, `USDCV`: `sgforge-coinvertible` parses cash amount and circulation. This can emit a live-proxy issuer capacity if the page remains timestamped and all reserves are cash deposits.
- `TUSD`, `USD1`: Chainlink PoR / bundle oracles prove backing but not immediate redemption capacity. They need a separate liquid-bucket or daily-limit source, not just the current reserve total.
- `PYUSD`, `USDP`, `GUSD`, `USDG`, `USDT`, `RLUSD`, StraitsX, VNX, StablR, Quantoz, Monerium, Juno, IDRX, Brale, Banking Circle, etc.: replace generic `single-asset` or `curated-validated` proof with source-specific parsers only where official transparency pages expose liquid reserve composition, explicit same-day/daily redemption limits, or an API with current available liquidity.

Rejected shortcut: treating a 100% reserve attestation, NAV oracle, or physical custody proof as `immediate-bounded` capacity. That would loosen the requirement.

### 3. Build tokenized-treasury liquidity facility adapters

Affected rows: `YLDS`, `USTB`, `TBILL`, `BUIDL`, `CETES`, `USYC`, `thBILL`, `USDY`, `mTBILL`, `USDTB`, `OUSG`.

Adapter paths:

- `USTB`: Superstate exposes a public liquidity endpoint. On 2026-04-15, `https://api.superstate.com/v1/funds/liquidity` returned USTB `circle_usd_available_amount` and `usdc_redemption_idle_balance`. A `superstate-liquidity` adapter can emit the sum as an immediate USDC/USD capacity lower bound.
- `OUSG`: NAV oracle alone is insufficient. Research the instant manager / USDC or BUIDL liquidity contract and emit only the current amount that can be redeemed immediately by whitelisted holders.
- `mTBILL`: the Midas transparency/NAV path needs a machine-readable instant-redemption capacity or contract balance. A documented target is not enough unless the source publishes a hard current bound.
- `TBILL`, `USYC`, `BUIDL`, `USDTB`, `YLDS`, `thBILL`, `CETES`, `USDY`: keep excluded unless the issuer publishes a current cash/USDC liquidity facility, queue availability, or hard daily redemption limit. NAV and total AUM remain reserve quality evidence, not exit-capacity evidence.

### 4. Add direct onchain capacity reads for basket and stablecoin redeem routes

Affected rows: `EUSD`, `USDai`, `OUSD`, `apxUSD`, Celo `cUSD`, `USX`, `MSUSD`, Celo `CEUR`, `USD0`, `U`, `HONEY`, `AID`, `FPI`, `DUSD`.

Implementation pattern:

- Read the actual redemption contract, vault, branch holder, or instant manager balances.
- Emit `capacityUsd` as the lower of current output assets available and any contract or docs cap.
- Emit `capacityRatioOfSupply` against current token supply.
- Emit `routeStatus` from pause/freeze/allowlist/queue signals where available.
- Keep basket routes as `stable-basket` or `mixed-collateral`; do not upgrade output quality unless the output is a single stable asset.

Likely concrete work:

- `evm-branch-balances`: add an optional `redemptionCapacityMode` for branch balances that are actual redeemable output assets. This is relevant for `HONEY` and potentially `USD0` style branch reserves, but it must not apply to arbitrary reserve composition.
- Reserve Protocol style routes (`EUSD`): read current backing basket and issuance/redeem contract state. Full basket redeemability can become immediate-bounded only if the adapter proves the basket assets are available to redemption now.
- Origin / OUSD: if current vault collateral is directly redeemable and not queued, add a protocol adapter that reads current vault assets and redeem fee/status.
- Celo stable assets: use Mento reserve/trading limits only if a direct redemption/swap rail and current capacity are exposed, otherwise keep DEX liquidity as the Safety Score path.

### 5. Queue and strategy routes need hot-buffer and queue telemetry

Affected rows: `sUSDai`, `NUSD`, `USN`, `AZND`, `rwaUSDi`, `dUSD`, `syrupUSDC`, `cgUSD`, `YUSD`, `ALUSD`, `syrupUSDT`, `avUSD`, `YZUSD`, `yoUSD`, `UTY`.

Adapter paths:

- Strategy-backed Accountable feeds: use explicit stable/cash bucket maps instead of regex. Count only assets that are immediately returned by the protocol's redemption rail.
- Maple syrup tokens: read withdrawal manager / pool liquidity and queue state. Safety capacity should be current claimable or near-term pool liquidity, not total loan book or eventual FIFO settlement.
- Alchemix: read Transmuter claimable underlying and queued conversion state.
- Cygnus: read current USDC redemption pool, NFT queue size, and withdrawal fee.
- USD.AI `sUSDai`: docs mention limited instant liquidity but no numeric public bound in current config notes. It should stay excluded until an adapter can fetch the current instant buffer.
- `yoUSD`, `UTY`, `YUSD`, `USN`, `dUSD`: replace heuristic ratios with live buffer telemetry or reviewed documented-bound ratios from official data. A plain 15-30% heuristic should remain low-confidence and excluded.

Queue routes can still be Safety Score-eligible under the current model, but their contribution is capped before blending. That cap is enough only after current capacity confidence improves.

### 6. Commodity tokens mostly should remain excluded

Affected rows: `PAXG`, `XAUT`, `CGO`, `KAG`, `KAU`, `XAUm`, `PGOLD`, `DGLD`.

Physical metal custody proves backing, not immediate exit capacity. These should remain excluded unless the issuer publishes one of:

- a live cash buyback pool
- a current market-maker redemption facility with hard size
- a same-day metal-to-cash capacity limit
- an onchain/issuer API with current redeemable cash balance

Do not count total allocated gold/silver bars as immediate-bounded Safety Score capacity.

## Full In-Scope Grouping

Issuer fiat/offchain: `USDP`, `FIDD`, `AUSD`, `PYUSD`, `EURR`, `USDC`, `XSGD`, `RLUSD`, `USDG`, `EURCV`, `USDCV`, `VEUR`, `EURC`, `USDT`, `USD1`, `USAT`, `EURE`, `VCHF`, `MXNB`, `CASH`, `XUSD`, `EUROP`, `GUSD` (Gemini), `USDGO`, `JPYC`, `EURAU`, `WUSD`, `SBC`, `tGBP`, `IDRX`, `USDH`, `USDQ` (Quantoz), `TUSD`, `FDUSD`, `EURI`, `AUDD`, `AxCNH`, `USDR`, `EURQ`, `USDA` (Anzens), `pUSD` (Plume), `GUSD` (Gate), `MNEE`, `EURS`, `TRYB`, `AEUR`, `PUSD` (Pleasing), `ZARP`, `CADC`, `IDRT`, `BRZ`, `USDX`, `USDM`, `A7A5`, `GYEN`, `CHFAU`, `VGBP`.

Tokenized treasury / NAV: `YLDS`, `USTB`, `TBILL`, `BUIDL`, `CETES`, `USYC`, `thBILL`, `USDY`, `mTBILL`, `USDTB`, `OUSG`.

Commodity: `PAXG`, `XAUT`, `CGO`, `KAG`, `KAU`, `XAUm`, `PGOLD`, `DGLD`.

Existing live-proxy/direct fix: `FRXUSD`, `USSD`, `USDe`, `CUSD`.

Onchain basket/stable redeem: `EUSD`, `USDai`, `OUSD`, `apxUSD`, Celo `cUSD`, `USX`, `MSUSD`, Celo `CEUR`, `USD0`, `U`, `HONEY`, `AID`, `FPI`, `DUSD`.

Strategy or queue buffer: `sUSDai`, `NUSD`, `USN`, `AZND`, `rwaUSDi`, `dUSD`, `syrupUSDC`, `cgUSD`, `YUSD`, `ALUSD`, `syrupUSDT`, `avUSD`, `YZUSD`, `yoUSD`, `UTY`.

M0 lineage: `MUSD`, `USDN`, `M`.

## Recommended Order

1. Fix/deploy existing live capacity paths: `cap-vault`, `ethena`, `frax-balance-sheet`, `accountable`, `m0`.
2. Add source-specific issuer liquidity capacity for Circle, FDUSD, and SG-FORGE, because their adapters already parse structured reserve data.
3. Add a `superstate-liquidity` adapter for USTB and research analogous instant-liquidity feeds for OUSG and mTBILL.
4. Add opt-in redemption capacity modes to onchain branch/basket adapters, starting with routes where the redeemable output balances are already read onchain.
5. Research queue-specific adapters for Maple, Alchemix, Cygnus, and USD.AI only if public current buffer or queue state exists.
6. Leave commodity tokens and issuer routes with only total-reserve attestations excluded until a real cash/liquidity capacity source exists.

## Source Notes

Repo sources:

- `shared/lib/report-card-peg-liquidity.ts`
- `shared/lib/redemption-backstop-confidence.ts`
- `worker/src/lib/redemption-backstop-capacity.ts`
- `worker/src/lib/redemption-backstop-live-metadata.ts`
- `worker/src/cron/reserve-adapters/*`
- `shared/lib/live-reserve-adapters-definitions.ts`
- `docs/report-cards.md`
- `docs/redemption-backstops.md`
- live snapshots under `/tmp/pharos-report-cards.json` and `/tmp/pharos-redemption-backstops.json`

External checks:

- Pharos live report cards: `https://pharos.watch/_site-data/report-cards`
- Pharos live redemption backstops: `https://pharos.watch/_site-data/redemption-backstops`
- Ethena collateral API: `https://app.ethena.fi/api/positions/current/collateral`
- Superstate liquidity API: `https://api.superstate.com/v1/funds/liquidity`
- M0 collateral composition docs/API: `https://docs.m0.org/api/recipes/collateral-composition/`, `https://protocol-api.m0.org/graphql`
- OpenEden USDO redemption docs, useful pattern for instant liquidity facilities: `https://docs.openeden.com/usdo/usdo-token/redemption-workflow`
