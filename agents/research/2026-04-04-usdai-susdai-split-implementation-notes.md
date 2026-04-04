# USDAI / sUSDai Split Research (2026-04-04)

## Scope

Research goal: verify whether Pharos is currently mixing base `USDai` and yield-bearing `sUSDai`, then map the implementation changes needed to split them cleanly across reserve sync, redemption backstops, liquidity, and the detail-page data model.

## Bottom line

Pharos is currently modeling `usdai-usd-ai` as a hybrid of two different assets:

- base `USDai`, which USD.AI currently markets and documents as the liquid, non-yielding, instantly redeemable stable token
- `sUSDai`, which USD.AI currently documents as the yield-bearing, queued-withdrawal token tied to GPU-backed credit exposure

That split is explicit in current USD.AI materials fetched on 2026-04-04:

- `USDai` is described as fully backed, liquid, and instantly redeemable
- `sUSDai` is described as the yield-bearing token with queued withdrawals and GPU-backed loan exposure
- USD.AI’s current public proof-of-reserves API mixes liquid stablecoin buckets and GPU-loan rows in one feed, so it is not a trustworthy base-`USDai` collateral feed

Implementation consequence: the current `usdai-usd-ai` record should be corrected to represent only base `USDai`, and a new tracked asset should be added for `sUSDai`.

## External evidence

### 1. Current USD.AI docs and marketing clearly separate the two assets

- `https://docs.usd.ai/`
  - `USDai` is described as a low-risk, fully-backed stablecoin redeemable instantly at all times.
  - `sUSDai` is described as the yield-bearing synthetic dollar backed by AI infrastructure assets, with withdrawals subject to redemption periods.
- `https://docs.usd.ai/faq/usdai-and-susdai-101`
  - `USDai = liquid, non-yielding`
  - `sUSDai = staked, yield-bearing, withdrawable after an unstaking period`
  - base `USDai` redemption is documented as a near-instant burn-and-withdraw path
  - `sUSDai` unstaking enters a queue with fixed 30-day windows
  - the FAQ also mentions only a limited instant liquidity buffer for `sUSDai`, with larger exits handled through the standard redemption flow
- `https://usd.ai/usdai`
  - markets `USDai` and `sUSDai` as two separate products on the same page
  - says `USDai` is instantly redeemable, low-risk, and backed 1:1 by stablecoin reserves
  - says `sUSDai` is yield-bearing and backed by GPU-collateralized loans with structured redemptions

### 2. Current official USD.AI materials support PYUSD for base USDai

- `https://usd.ai/insights/pyusd-paypal-usdai-integration`
  - says USDai is backed by PYUSD
- `https://usd.ai/insights/usdai-foundation-chip`
  - says `USDai` is overcollateralized by PayPal’s `PYUSD`
  - separately describes `sUSDai` as the yield-bearing counterpart

This is materially stronger than the older mixed “stablecoins” wording for the base token. Current public positioning points to base `USDai` being the PYUSD-side product, while `sUSDai` carries the credit/yield exposure.

### 3. Current official materials support a separate sUSDai exchange-rate / NAV surface

- `https://usd.ai/insights/chainlink-usdai-data-feed`
  - says USD.AI uses a `sUSDAI-USDAI` exchange-rate feed and a `USDAI-USD` market-rate feed

This is strong evidence that `sUSDai` should be treated as a first-class appreciating wrapper / NAV token, not as a note attached to the base `USDai` page.

### 4. Current official materials tie the GPU-loan risk to sUSDai

- `https://usd.ai/stories/upgrading-fully-insured-susdai`
  - explicitly frames the GPU-loan risk architecture as applying to `sUSDai`
  - notes that new loans now use Barker-backed insurance / reinsurance instead of the old FiLo-style first-loss structure for new loans

This means any page copy that presents GPU-backed loan exposure as the collateral story for base `USDai` is outdated or category-mistaken.

### 5. Contract addresses confirm the split

- `https://docs.usd.ai/technical-overview/contract-addresses`
  - `USDai`: `0x0A1a1A107E45b7Ced86833863f482BC5f4ed82EF`
  - `sUSDai`: `0x0B2b2B2076d95dda7817e785989fE353fe955ef9`
  - docs say the same addresses are used on other EVM deployments

Important caveat: CoinGecko’s `platforms` metadata is inconsistent here and should not be trusted as the source of truth for contract addresses. Use USD.AI’s contract-address docs instead.

### 6. The current proof-of-reserves API is protocol-mixed, not base-USDai-specific

Live source checked on 2026-04-04:

- `https://api.usd.ai/usdai/dashboard/proof-of-reserves?chainId=42161`

The feed contains:

- `TBILL` rows such as `PYUSD`
- many `DEAL` rows representing GPU-backed loan exposure

That makes it suitable only for the protocol / yield-side reserve mix, not as a direct collateral feed for base `USDai`.

### 6b. The live app already appears to track USDai and sUSDai separately

On 2026-04-04, the server-rendered payload from `https://app.usd.ai/reserves` exposed distinct keys for both assets, including separate `usdai_*` and `susdai_*` records and a dedicated `susdai_queue_arbitrum` entry. That reinforces the conclusion that Pharos should not keep presenting them as one combined asset.

### 7. Thread claim status

The X thread at `https://x.com/ssmccul/status/2040158911634751758?s=20` was only partially recoverable programmatically on 2026-04-04, but the lead claim that base `USDai` has no GPU-loan exposure and behaves as a PYUSD-side wrapper is corroborated by the official USD.AI sources above. The implementation plan below is based on the official docs/site/app evidence, not on the thread alone.

## Current repo mismatch

### Metadata currently mixes both assets into one record

File: `shared/data/stablecoins/usd-major.json`

Current `usdai-usd-ai` problems:

- `flags.yieldBearing` is `true` even though base `USDai` is documented as non-yielding
- collateral text mixes PYUSD-side reserves with GPU-backed loan exposure
- peg mechanism text mixes instant base redemption with `sUSDai` queue semantics
- `yieldConfig` is attached to the base token
- `liveReservesConfig` points base `USDai` at the mixed proof-of-reserves API

### Redemption backstop is already base-token-corrected, but only for the existing USDAI id

Files:

- `shared/lib/redemption-backstop-configs/stablecoin-redeem.ts`
- `shared/lib/redemption-backstop-version.ts`

These already say the slower queue belongs to `sUSDai`, not base `USDai`. That makes the new work mostly additive on the backstop side: keep base `USDai`, add a new `sUSDai` route.

### Yield is still hanging off the base USDAI id

File: `worker/src/cron/yield-config.ts`

Problems:

- `RAW_YIELD_VARIANT_MAP["usdai-usd-ai"]` points to wrapper semantics instead of a first-class `sUSDai` asset
- `RAW_YIELD_POOL_MAP["usdai-usd-ai"]` also attaches the `sUSDai` yield pool to base `USDai`
- the configured `variantAddress` is `0x46850aD61C2B7d64d08c9C754F45254596696984`, which is the Arbitrum `PYUSD` address already tracked elsewhere in the repo, not the official `sUSDai` token address

That address mismatch is a concrete bug and should be removed as part of the split.

### Liquidity is structurally capable of splitting correctly once contracts are split

Relevant code:

- `worker/src/cron/dex-liquidity/pool-helpers.ts`
- `worker/src/lib/dex-api-common.ts`

The liquidity system resolves tracked tokens by `chain + address` first and only falls back to symbol matching when a source is addressless. That is good news:

- base `USDai` pools can stay attached to `0x0A1a...`
- `sUSDai` pools can attach to `0x0B2b...`
- once both assets have distinct `contracts[]`, the core DEX/liquidity pipeline should separate them naturally

## Recommended implementation model

## 1. Base USDai: correct the existing `usdai-usd-ai` record

Recommended truth model:

- symbol: `USDai`
- keep existing id: `usdai-usd-ai`
- `yieldBearing: false`
- `navToken: false`
- collateral / reserves: stablecoin-side collateral only
- remove all `sUSDai` queue / GPU-loan language from collateral and peg text
- remove `yieldConfig`

Reserve-sync recommendation:

- do not keep the current mixed `usdai-proof-of-reserves` adapter on base `USDai`
- unless a base-token-specific reserve feed is found, it is more honest to remove `liveReservesConfig` and fall back to curated reserve metadata than to keep showing the mixed protocol feed as if it were base-token collateral

Suggested collateral wording direction:

- current best evidence supports modeling base `USDai` as PYUSD-backed / PYUSD-overcollateralized
- at minimum, it should be shown as stablecoin-reserve backed with zero GPU-loan exposure on the page

## 2. Add a new first-class tracked asset for sUSDai

Recommended truth model:

- proposed id: `susdai-usd-ai`
- symbol: `sUSDai`
- name: `Staked USDai` or `USD.AI sUSDai`
- `detailProvider: "coingecko"`
- `geckoId: "susdai"`
- `yieldBearing: true`
- `navToken: true`
- collateral: GPU-backed credit / AI infrastructure asset exposure, with the liquid stablecoin sleeve where applicable
- peg / mechanism: appreciating staking token whose value is measured relative to `USDai`, with queued withdrawals

Contract source of truth:

- use USD.AI docs, not CoinGecko platform mappings
- primary contracts should be built from the official `0x0B2b...` address set from the contract-address docs

Why `detailProvider: "coingecko"`:

- DefiLlama’s stablecoin list currently contains `USDai` but not `sUSDai`
- the repo already supports first-class wrapper assets via the supplemental CoinGecko path

## 3. Reserve sync ownership

### Recommended split

- base `USDai`
  - no live reserve sync unless a base-token-specific feed exists
  - curated reserve metadata only, or a future dedicated single-asset proof source if USD.AI exposes one
- `sUSDai`
  - take ownership of the current mixed proof-of-reserves adapter

### Adapter work

Current adapter:

- `worker/src/cron/reserve-adapters/usdai-proof-of-reserves.ts`

Recommended change:

- rebind the adapter to `susdai-usd-ai`
- optionally rename the adapter to something token-accurate such as `susdai-proof-of-reserves` or `usdai-protocol-proof-of-reserves`

Why:

- the adapter groups `DEAL` rows into one GPU-loan slice and preserves liquid stablecoin buckets such as `PYUSD`
- that is exactly the mixed protocol / yield-side reserve story
- it is not the right reserve story for base `USDai`

### Additional reserve nuance

The February 6, 2026 `sUSDai` insurance post means the narrative copy for the high-risk slice should not keep implying that all current risk protection is still FiLo-style first-loss capital. New copy should note that current public materials now describe Barker-backed coverage for new loans.

## 4. Redemption backstops

### Base USDai

Keep the existing route family:

- `stablecoin-redeem`
- permissionless onchain
- atomic settlement
- stable-single output

Current repo status:

- already mostly correct in `shared/lib/redemption-backstop-configs/stablecoin-redeem.ts`

Required follow-through:

- keep the route attached to `usdai-usd-ai`
- make sure page collateral / reserve copy no longer contradicts it

### sUSDai

Add a new backstop entry in:

- `shared/lib/redemption-backstop-configs/queue-redeem.ts`

Recommended shape:

- route family: `queue-redeem`
- access: `permissionless-onchain`
- settlement: `queued`
- execution: `rules-based-nav`
- output asset: `stable-single` (the actual withdrawal token is `USDai`)
- capacity model: `supply-full` with documented-bound confidence and `full-system-eventual` basis

Why not `reserve-sync-metadata`:

- the current USD.AI reserve adapter exposes no redeemable-capacity telemetry
- official docs mention a limited instant buffer for `sUSDai`, but no public numeric bound was found on 2026-04-04

Important note to include in config:

- public docs describe a limited instant liquidity buffer, but Pharos should not model that as quantified immediate capacity until a real numeric source exists

## 5. Liquidity module

### Core behavior

No architectural liquidity rewrite appears necessary.

Why:

- DEX matching is address-first
- `USDai` and `sUSDai` have separate token contracts
- adding `sUSDai` as a first-class tracked asset should naturally split pool attribution

### What to change

- add `sUSDai` contracts to tracked metadata
- ensure the base `USDai` asset keeps only the `0x0A1a...` contract set
- verify top pools on both pages after the split

### What to watch for

- symbol-only fallbacks from addressless sources should still be reviewed after the split, but `sUSDai` is unique enough that collision risk looks low
- any lingering yield-variant-based assumptions must be removed so `sUSDai` does not get pulled back under base `USDai`

## 6. Yield module

This is a required part of the split even though the immediate user issue was collateral correctness.

Recommended changes:

- remove `usdai-usd-ai` from `RAW_YIELD_VARIANT_MAP`
- remove `usdai-usd-ai` from `RAW_YIELD_POOL_MAP`
- add `susdai-usd-ai` as the first-class yield-bearing asset that owns the existing `sUSDai` pool mapping
- attach `yieldConfig` to `susdai-usd-ai`, not base `usdai-usd-ai`

This avoids:

- showing `sUSDai` yield on the base `USDai` page
- incorrect yield-page classification
- continued dependence on the wrong `variantAddress`

## 7. Product implications

### Base USDai page

After the split, the base `USDai` page should:

- stop showing GPU-backed loan exposure as its reserve story
- stop presenting itself as yield-bearing
- keep instant stablecoin/PYUSD redemption semantics
- likely improve upstream collateral interpretation and related safety surfaces

### sUSDai page

After the split, the new `sUSDai` page should:

- show GPU-backed / AI-infrastructure reserve exposure
- show queued redemption semantics
- behave like other NAV-style yield wrappers
- render as a first-class yield-bearing asset rather than a child note on the `USDai` page

Because `sUSDai` should likely be `navToken: true`, expected page behavior includes:

- no depeg-history section
- price / premium behavior treated as NAV-style rather than strict `$1` peg behavior
- its own yield section and its own DEX-liquidity surface

## Repo surfaces to change

High-confidence implementation surfaces:

- `shared/data/stablecoins/usd-major.json`
- `shared/data/stablecoins/canonical-order.json`
- `worker/src/cron/yield-config.ts`
- `worker/src/cron/reserve-adapters/usdai-proof-of-reserves.ts`
- `worker/src/cron/reserve-adapters/__tests__/usdai-proof-of-reserves.test.ts`
- `shared/lib/live-reserve-adapters.ts`
- `shared/lib/redemption-backstop-configs/stablecoin-redeem.ts`
- `shared/lib/redemption-backstop-configs/queue-redeem.ts`
- `shared/lib/redemption-backstop-version.ts`
- `data/logos.json`
- `data/ai-summaries.json`

Docs that should move with the implementation:

- `docs/live-reserves.md`
- `docs/redemption-backstops.md`
- `docs/yield-intelligence.md`
- the relevant methodology / timeline changelog files if the published reserve, backstop, liquidity, or score behavior changes for these assets

Nice-to-have but not necessarily phase-1 blockers:

- mint/burn coverage for `sUSDai` if the page should also expose flow telemetry
- a better supplemental-asset chain-distribution path if `sUSDai` needs multichain supply attribution beyond CoinGecko-only history

## Open questions / caveats

### 1. Exact base-USDai reserve presentation

Current evidence is strong that base `USDai` should not carry GPU-loan exposure and that PYUSD is the right collateral story. If Pharos wants to show a live reserve badge for base `USDai`, a token-specific reserve source is still needed.

### 2. sUSDai instant-liquidity buffer is real but not quantified publicly

Official docs mention a limited instant buffer, but no public numeric bound was found on 2026-04-04. Pharos should not invent one.

### 3. CoinGecko contract-platform metadata is inconsistent

Use CoinGecko for `geckoId`, price, and market-cap history only. Use USD.AI’s official docs for the tracked contract set.

### 4. Some older USD.AI technical docs are stale or internally inconsistent

Older materials still describe older M0 / timelock / free-floating-token semantics. The more recent FAQ, site pages, contract-address page, and 2025-2026 insight posts are the better source of truth for this split.

## Recommended implementation order

1. Split metadata first: correct `usdai-usd-ai`, add `susdai-usd-ai`.
2. Move the current mixed reserve adapter off base `USDai` and onto `sUSDai`.
3. Move yield ownership from base `USDai` to `sUSDai`, deleting the bad variant-address path.
4. Add the `sUSDai` queue redemption backstop.
5. Verify DEX/liquidity attribution for both assets by contract address.
6. Rewrite the affected AI summaries and docs so the UI and methodology text stop contradicting the new asset split.
