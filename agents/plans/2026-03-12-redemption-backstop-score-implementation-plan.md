# Redemption Backstop Score Implementation Plan

Date: 2026-03-12

Related research:

- `agents/research/2026-03-12-redeemable-assets-liquidity-research.md`

## Objective

Add a new `redemptionBackstopScore` to Pharos so assets with meaningful direct redemption paths are not judged solely by DEX liquidity.

The implementation must:

- keep the existing DEX liquidity score semantically pure
- be generalizable across many tracked assets, not just `cusd-cap` and `iusd-infinifi`
- distinguish between atomic redemption, collateral redemption, queue-based redemption, and offchain issuer redemption
- avoid over-crediting fractional-reserve or delayed-settlement systems
- provide enough coverage to justify changing report cards and other risk surfaces

## Core Design Decision

Pharos should model three related but distinct concepts:

1. `liquidityScore`
   - unchanged
   - remains a DEX / market-liquidity score only

2. `redemptionBackstopScore`
   - new
   - measures direct protocol / issuer exit quality

3. `effectiveExitScore`
   - new derived score
   - combines market liquidity and redemption backstop for risk surfaces such as report cards

This preserves the meaning of the existing `/liquidity` page while giving report cards and detail pages a more realistic answer to "can users get out?"

## Scope

### In scope

- New `redemptionBackstopScore`
- New `effectiveExitScore`
- Candidate coverage for the strongest tracked redemption-backstop assets
- Dynamic adapters for onchain and reserve-buffer systems where possible
- Static metadata support for issuer and delayed / offchain systems
- Report-card integration after coverage reaches a defined threshold
- Methodology docs and `/methodology` updates

### Out of scope for v1

- Replacing the existing DEX liquidity score
- Full historical backfill of redemption-backstop scores
- Commodity / physical-delivery redemption modeling
- NAV / fund-share wrapper modeling as part of the stablecoin exit-backstop score

## Candidate Universe

The tracked base contains many coins whose `pegMechanism` mentions mint / redeem / queue / PSM / direct redemption. They should not all be treated identically.

### Wave 1: strongest protocol-native candidates

These are the best fit for first-class dynamic scoring because the backstop is protocol-enforced and usually queryable onchain or from protocol APIs.

- `cusd-cap`
- `iusd-infinifi`
- `lusd-liquity`
- `bold-liquity`
- `feusd-felix`
- `usdaf-asymmetry`
- `usnd-nerite`
- `ebusd-ebisu`
- `nect-beraborrow`
- `meusd-mezo`
- `alusd-alchemix`
- `fxusd-f-x-protocol`
- `dusd-dtrinity`
- `dai-makerdao`
- `gho-aave`
- `dola-inverse-finance`
- `eura-angle`
- `buck-bucket-protocol`
- `hollar-hydrated`

### Wave 2: strong but conditional / queue-based candidates

These have a meaningful backstop but require more nuanced capacity handling.

- `iusd-infinifi`
- `reusd-re-protocol`
- `cgusd-cygnus-finance`
- `uty-xsy`
- `usp-pikudao`
- `aznd-mu-digital`
- `avusd-avant`
- `usdu-unitas`
- `yzusd-yuzu`
- `nusd-neutrl`

### Wave 3: centralized issuer-redemption candidates

These are valid candidates in principle, but their scoring is mostly metadata-driven rather than telemetry-driven.

- `usdc-circle`
- `usdt-tether`
- `pyusd-paypal`
- `fdusd-first-digital`
- `rlusd-ripple`
- `eurc-circle`
- `usdp-paxos`
- `gusd-gemini`
- `usdg-paxos`
- `usdx-hex-trust`
- `xusd-straitsx`
- `xsgd-straitsx`
- `euri-banking-circle`
- `usdq-quantoz`
- `eurq-quantoz`
- `usd1-world-liberty-financial`
- `ausd-agora`
- `usdo-openeden`
- `usdm-moneta`
- similar fiat / regional issuer coins

### Explicit non-candidates for v1

- NAV / fund-share wrappers: `ousg-ondo-finance`, `ustb-superstate`, `mtbill-midas`, `buidl-blackrock`, etc.
- commodity tokens redeemed for physical metal
- assets whose "redemption" is only a generic marketing claim without a meaningful exit route

## Explicit treatment of LUSD and BOLD

Yes, both should be included.

They belong to the `onchain-collateral-redemption` family.

Why:

- both have protocol-native direct redemption
- both are permissionless and onchain
- both offer a hard peg floor mechanism via redemption
- both can have weaker DEX depth than their real protocol exit quality would suggest

How to model them:

- do not treat them like stablecoin-reserve redemptions
- they redeem into collateral, not dollars
- score them highly on access, latency, and execution certainty
- apply a haircut on output-asset quality because the redemption asset is ETH / branch collateral rather than a stable reserve asset

## Metric Definitions

### `redemptionBackstopScore`

Score from 0-100 representing the quality of direct redemption.

This should not answer "how much DEX liquidity exists?"

It should answer:

- can users redeem?
- how fast?
- how permissioned?
- into what asset?
- at what certainty and cost?
- with what immediately available capacity?

### `effectiveExitScore`

Derived score used in report cards and other risk surfaces.

This should answer:

- given both market liquidity and direct redemption, how strong is the user’s exit path overall?

## Scoring Model

### Redemption Backstop Score components

Recommended component weights:

- `accessScore`: 20%
- `settlementScore`: 15%
- `executionCertaintyScore`: 15%
- `capacityScore`: 25%
- `outputAssetQualityScore`: 15%
- `costScore`: 10%

### Component scoring

#### 1. Access score

- `permissionless-onchain`: 100
- `whitelisted-onchain`: 75
- `issuer-api / institutional workflow`: 40
- `manual / discretionary / unclear`: 20

#### 2. Settlement score

- `atomic / same-tx`: 100
- `same-block / immediate`: 90
- `same-day / short delay`: 65
- `1-7 days`: 35
- `queue-based / undefined`: 20

#### 3. Execution certainty score

- deterministic onchain quote: 100
- deterministic basket redemption: 80
- oracle / NAV-based but rules-driven: 60
- discretionary or opaque: 30

#### 4. Capacity score

Use only immediately available redemption capacity.

Never use total reserves as a substitute for liquid exit capacity in fractional-reserve systems.

Capacity score should blend:

- `coverageRatioScore`: how much of circulating supply is immediately redeemable
- `absoluteCapacityScore`: how much notional is immediately redeemable in dollars

Recommended formula:

- `capacityScore = round(coverageRatioScore * 0.6 + absoluteCapacityScore * 0.4)`

Suggested thresholds:

Coverage ratio:

- `<1%`: 10
- `1%`: 20
- `5%`: 40
- `10%`: 60
- `25%`: 80
- `50%+`: 100

Absolute capacity:

- `$100k`: 20
- `$1M`: 40
- `$10M`: 60
- `$50M`: 80
- `$250M+`: 100

#### 5. Output asset quality score

- cash / USDC / USDT / regulated fiat stable: 100
- high-quality stable basket: 80
- ETH / BTC / blue-chip collateral: 65
- mixed or strategy-linked collateral: 45
- illiquid / opaque / NAV-like output: 20

#### 6. Cost score

- `<=10 bps`: 100
- `<=50 bps`: 80
- `<=100 bps`: 60
- dynamic / variable / unclear: 40
- manual / unbounded friction: 20

### Route-family caps

To keep the score honest:

- `queue-based` systems: cap at `70`
- `basket-redemption` systems: cap output-asset certainty at `80`
- `offchain issuer` systems: cap total score at `65` unless the system has strong published redemption SLAs and broad retail access
- `fractional-reserve` systems: capacity score must use liquid sleeve only

## Effective Exit Score

Recommended v1 formula:

If both scores exist:

- `effectiveExitScore = round(max(liquidityScore, liquidityScore * 0.55 + redemptionBackstopScore * 0.45))`

If only liquidity exists:

- `effectiveExitScore = liquidityScore`

If only redemption backstop exists:

- `effectiveExitScore = round(min(70, redemptionBackstopScore * 0.75))`

Rationale:

- preserves the DEX score as a floor
- lets redemption backstops help, but not fully erase poor market liquidity
- prevents queue-based or offchain systems from looking unrealistically liquid

This formula should be calibrated against a representative basket before report-card rollout.

## Data Model

### Shared metadata additions

Add a new config to `StablecoinMeta`:

- `redemptionBackstopConfig?: RedemptionBackstopConfig`

Proposed structure:

```ts
interface RedemptionBackstopConfig {
  adapter: string;
  version: number;
  routeFamily:
    | "stablecoin-redeem"
    | "basket-redeem"
    | "collateral-redeem"
    | "psm-swap"
    | "queue-redeem"
    | "offchain-issuer";
  accessModel:
    | "permissionless-onchain"
    | "whitelisted-onchain"
    | "issuer-api"
    | "manual";
  settlementModel:
    | "atomic"
    | "immediate"
    | "same-day"
    | "days"
    | "queued";
  outputAssetType:
    | "stable-single"
    | "stable-basket"
    | "bluechip-collateral"
    | "mixed-collateral"
    | "nav";
  docs?: {
    url?: string;
    label?: string;
  };
  inputs?: {
    primary?: RedemptionBackstopInput;
    fallbacks?: RedemptionBackstopInput[];
  };
  params?: Record<string, unknown>;
}
```

### New D1 tables

#### `redemption_backstop`

Latest snapshot only:

- `stablecoin_id`
- `score`
- `effective_exit_score`
- `access_score`
- `settlement_score`
- `execution_certainty_score`
- `capacity_score`
- `output_asset_quality_score`
- `cost_score`
- `route_family`
- `provider`
- `immediate_capacity_usd`
- `immediate_capacity_ratio`
- `queue_enabled`
- `fee_bps`
- `updated_at`
- `methodology_version`
- `details_json`

#### `redemption_backstop_history`

Daily snapshots for future trend analysis:

- `stablecoin_id`
- `snapshot_date`
- `score`
- `effective_exit_score`
- `updated_at`
- `methodology_version`
- `details_json`

## Runtime Architecture

### New worker modules

- `worker/src/lib/redemption-backstop-types.ts`
- `worker/src/lib/redemption-backstop-scoring.ts`
- `worker/src/lib/redemption-backstop-sources.ts`
- `worker/src/cron/sync-redemption-backstops.ts`
- `worker/src/api/redemption-backstops.ts`

### Reuse existing infrastructure

- authoritative onchain quote helpers from `worker/src/lib/authoritative-price-sources.ts`
- reserve sync state and reserve adapters where possible
- existing chain RPC / `eth_call` infrastructure

### Cron placement

Recommended:

- add `sync-redemption-backstops` to the hourly reserve-sync lane
- run it sequentially after `sync-live-reserves`

Why:

- overlapping source families
- isolated cron lane
- lower risk to half-hour DEX / yield slot fetch budgets

## Adapter Families and Data Gathering

### Family A: onchain stablecoin / basket redemption quote

Examples:

- `cusd-cap`
- `dusd-dtrinity`
- possibly `msusd-main-street` later if queryable

Data source strategy:

- direct quote functions (`getBurnAmount`, `redeem`, `previewRedeem`, etc.)
- onchain fee functions where available
- reserve composition / basket-quality metadata

### Family B: onchain collateral redemption

Examples:

- `lusd-liquity`
- `bold-liquity`
- `feusd-felix`
- `usdaf-asymmetry`
- `usnd-nerite`
- `ebusd-ebisu`
- `meusd-mezo`
- `fxusd-f-x-protocol`

Data source strategy:

- redemption fee / rate contract reads
- active redeemable debt / branch / trove capacity
- oracle and pause state
- collateral-type mapping for output quality

For `LUSD` / `BOLD`, this is the path.

### Family C: PSM / GSM / module swap backstop

Examples:

- `dai-makerdao`
- `gho-aave`
- `dola-inverse-finance`
- `eura-angle`
- `buck-bucket-protocol`
- `hollar-hydrated`

Data source strategy:

- module reserves / caps
- swap fee
- current availability / pause state
- quote asset type and size

### Family D: liquid reserve buffer / queue systems

Examples:

- `iusd-infinifi`
- `reusd-re-protocol`
- `cgusd-cygnus-finance`
- `uty-xsy`
- `usp-pikudao`
- `aznd-mu-digital`
- `avusd-avant`
- `usdu-unitas`

Data source strategy:

- reserve APIs or onchain vault state
- explicit liquid vs illiquid split
- queue enabled / settlement window
- fee policy

Important:

- capacity must use liquid reserves only

### Family E: offchain issuer redemption

Examples:

- `usdc-circle`
- `usdt-tether`
- `fdusd-first-digital`
- `rlusd-ripple`
- `eurc-circle`
- `usdp-paxos`
- `gusd-gemini`

Data source strategy:

- static metadata curated from issuer docs
- KYC requirement
- redemption minimums
- settlement window
- fee policy

This family should be supported in metadata from day one, but can ship with lower confidence and limited dynamic telemetry.

## Coverage Strategy

Do not block the entire feature on perfect coverage.

Instead:

- add `redemptionBackstopConfig` across the broad candidate universe first
- implement dynamic adapters for Wave 1 and Wave 2
- implement metadata-only scoring for Wave 3

Rollout gate for report-card integration:

- at least `80%` of market cap among configured candidates must have a scored `redemptionBackstopScore`
- and no major top-20 redeemable asset should still be `NR`

## API Surface

### New endpoint

- `GET /api/redemption-backstops`

Per-coin response should include:

- `score`
- `effectiveExitScore`
- component breakdown
- route family
- queue flag
- immediate capacity
- fee / settlement metadata
- methodology version

### Existing endpoints to extend

- `/api/report-cards`
  - add `redemptionBackstopScore`
  - add `effectiveExitScore`
  - change Liquidity dimension wording to reflect exit-quality usage if/when integrated

- `/api/status`
  - add redemption-backstop sync health
  - add coverage summary

## Frontend Surface

### Liquidity page

- keep existing DEX liquidity score unchanged
- add contextual badge when a redemption backstop exists
- optionally show "Market liquidity only" label to make semantics explicit

### Stablecoin detail page

- add a new `Redemption Backstop` card / section
- show:
  - score
  - route family
  - settlement model
  - output asset type
  - immediate capacity if known
  - queue warning if applicable

### Report cards

- do not directly overwrite the displayed raw liquidity score
- add `effectiveExitScore` and use it for the report-card Liquidity / Exit dimension after calibration

### Methodology page

- add a full new section for Redemption Backstop Score
- update Safety Scores / Report Cards section to explain `effectiveExitScore`

## Docs To Add / Update

Add:

- `docs/redemption-backstop-score.md`

Update:

- `docs/report-cards.md`
- `docs/methodology-page.md`
- `src/app/methodology/methodology-sections.tsx`
- `docs/api-reference.md`
- `docs/architecture.md`
- `docs/data-flow-map.md`
- `docs/worker-infrastructure.md`
- `docs/testing.md`

## Testing Plan

### Unit tests

- scoring component tables
- route-family caps
- `effectiveExitScore` formula
- metadata validation

### Adapter tests

- cUSD quote adapter
- LUSD / BOLD collateral-redemption adapters
- infiniFi liquid-buffer adapter
- PSM / GSM adapters

### API tests

- new endpoint contract
- report-card integration contract
- status health contract

### Invariant tests

- DEX liquidity score unchanged for unaffected assets
- queue systems never use total reserves as immediate capacity
- output asset quality haircuts apply for collateral-redemption systems

## Rollout Plan

### Phase 0: metadata and schema

- add shared config types
- populate candidate configs broadly
- add D1 tables
- add methodology version module

### Phase 1: dynamic scoring pipeline

- implement `sync-redemption-backstops`
- ship new endpoint and detail-page surfaces
- no report-card score changes yet

### Phase 2: calibration

- compare exemplars:
  - `cusd-cap`
  - `iusd-infinifi`
  - `lusd-liquity`
  - `bold-liquity`
  - `dai-makerdao`
  - `gho-aave`
  - `usdc-circle`
- tune caps and `effectiveExitScore`

### Phase 3: report-card integration

- consume `effectiveExitScore` in report cards
- update methodology docs and changelog

## Risks

- Over-crediting queue-based systems
- Blurring DEX liquidity semantics if labels are not explicit
- Missing liquid / illiquid split for reserve-buffer products
- Underestimating complexity of PSM / GSM module state
- Using offchain issuer claims without enough evidence

## Key Guardrails

- DEX liquidity score stays untouched
- use liquid capacity, not total reserves
- collateral-redemption systems get output-asset haircuts
- offchain issuer redemptions start metadata-first, not pseudo-telemetry
- report cards do not switch to `effectiveExitScore` until coverage and calibration pass

## Recommended Immediate Build Order

1. Add shared config + scoring modules
2. Populate candidate metadata across the tracked base
3. Implement adapters for:
   - `cusd-cap`
   - `iusd-infinifi`
   - `lusd-liquity`
   - `bold-liquity`
   - `feusd-felix`
   - `usdaf-asymmetry`
   - `usnd-nerite`
   - `dai-makerdao`
   - `gho-aave`
4. Ship the new endpoint and detail-page surface
5. Calibrate with live production data
6. Integrate into report cards
