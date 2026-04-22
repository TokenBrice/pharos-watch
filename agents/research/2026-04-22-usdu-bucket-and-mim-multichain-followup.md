# USDU Alternative Live Bucket + MIM Multi-Chain Expansion Follow-Up

Date: 2026-04-22

## Scope

Follow-up research after fixing the immediate `BUCK` / `GHO` curated-vs-live drift:

1. Is there a better current live bucket for `usdu-unitas` than the current Accountable `reserves_split` mapping?
2. What would expanding `mim-abracadabra` from the current Ethereum-only live coverage to a multi-chain reserve view actually require?

## 1. `usdu-unitas`: alternative live bucket research

### Current state

Current repo config:

- `shared/data/stablecoins/usd-minor.json`
- `liveReservesConfig.adapter = "accountable"`
- `bucket = "reserves_split"`

Current upstream payload from `https://cache.accountable.capital/dashboard/unitas` on 2026-04-22:

- `reserves_split`: populated
- `type`: `null`
- `deployment`: `null`
- `type_split`: `null`
- `stablecoin_split`: `null`
- `exposure_split`: `null`

Observed `reserves_split` values:

- `Binance`
- `Solana`
- `Bnb_smartchain`
- `Aster`

This is the root problem: those are venue / chain buckets, not reserve-quality buckets comparable to the curated strategy mix (`80% JLP`, `20% short-perp margin`).

### Best-fit bucket, if Accountable exposes one later

**Best future candidate: `exposure_split`.**

Why:

- It is the most semantically comparable bucket family already used elsewhere in repo configs (`yzusd-yuzu`).
- It can represent concrete strategy exposures rather than custody locations.
- For USDU, the ideal exposure-level split would look more like:
  - JLP / long spot basket
  - short-perp margin / hedge sleeve
  - insurance / liquidity buffer

That shape is directly aligned with current Unitas docs:

- `Minting USDu`: `https://docs.unitas.so/solution-design/minting-usdu`
  - majority of deposited USDC goes into JLP
  - remainder supports the hedge / margin side
- `Backing, Custody, and Security Overview`: `https://docs.unitas.so/backing-custody-and-security/overview`
  - USDu is backed by on-chain collateral plus delta-neutral hedging
- `Off-Exchange Settlement`: `https://docs.unitas.so/backing-custody-and-security/off-exchange-settlement-oes-in-unitas`
  - Copper / Ceffu custody and short-perp settlement are explicit protocol components

### Second-best future candidate

**Possible but weaker fallback: `deployment`.**

Why:

- In other Accountable-backed integrations, `deployment` is used for strategy-family buckets.
- If Accountable were to expose USDU buckets such as `JLP`, `short perp margin`, `insurance fund`, or `liquidity buffer` under `deployment`, that would be good enough for a comparable live score.

### Buckets that would still be weak even if populated

- `type_split`
  - Better than `reserves_split`, but likely too coarse unless it separates JLP / hedge margin meaningfully.
- `stablecoin_split`
  - Would likely over-focus on constituent stablecoins and miss the actual strategy risk.
- `type`
  - Usually too top-level for a delta-neutral system.

### Recommendation

**There is no better Accountable bucket available today for `usdu-unitas`.**

Practical recommendation order:

1. Keep `reserves_split` out of drift-watch / collateral-quality override logic because it is not comparable to curated reserve semantics.
2. If Accountable later populates `exposure_split`, switch `usdu-unitas` to that first.
3. If only `deployment` becomes available and it separates JLP / hedge / buffer semantics cleanly, that is an acceptable fallback.
4. If no better Accountable bucket appears, the correct long-term fix is a custom Unitas adapter rather than stretching `reserves_split` further.

### Small immediate cleanup

Current repo `riskMap` expects `BNB Smart Chain`, but upstream currently emits `Bnb_smartchain`.

That naming mismatch is not the main problem, but it should be corrected if the current adapter remains in place even temporarily.

## 2. `mim-abracadabra`: what multi-chain expansion would entail

### Current state

Current repo coverage is intentionally Ethereum-only:

- `shared/data/stablecoins/usd-minor.json` config lists only 4 Ethereum cauldrons
- current adapter uses one `input.chain`
- current adapter uses one shared box address (`bentoBoxAddress`)

This matches the historical rollout note:

- `agents/plans/historical/2026-04-16-reserve-sync-remediation-and-expansion.md`
- Task 4.5 explicitly shipped an Ethereum-only first pass and deferred multi-chain support

### Why Ethereum-only is no longer enough for full-fidelity live coverage

Official Abracadabra deployment docs show active cauldrons on multiple chains relevant to tracked MIM:

- Ethereum Mainnet: `https://dev.abracadabra.money/deployment-addresses/ethereum-mainnet`
  - WETH active, plus box addresses (`DegenBox` and `BentoBox`)
- Arbitrum One: `https://dev.abracadabra.money/deployment-addresses/arbitrum-one`
  - active cauldrons include `WETH`, `magicGLP`, `gmARB`, `gmETH`, `gmBTC`, `gmSOL`, `gmLINK`
- BNB Chain: `https://dev.abracadabra.money/deployment-addresses/bnb-chain`
  - active cauldrons include `BNB`, `CAKE`
- Avalanche C-Chain: `https://dev.abracadabra.money/deployment-addresses/avalanche-c-chain`
  - active cauldrons include `AVAX`, `AVAX/MIM SLP`
- Fantom Opera: `https://dev.abracadabra.money/deployment-addresses/fantom-opera`
  - multiple active cauldrons including `FTM`, `yvWFTM`, `xBOO`, `FTM/MIM` LP variants
- Optimism: `https://dev.abracadabra.money/deployment-addresses/optimism`
  - active `Velodrome vOP/USDC`
- Kava also has active cauldrons in official docs, while tracked MIM metadata already includes a Kava deployment

So the current live view is not just incomplete in theory; it clearly excludes material active cauldron families outside Ethereum.

### Required engineering work

#### A. Adapter schema redesign

Current `abracadabra` adapter assumes:

- one `input.chain`
- one box address
- one shared RPC/routing context

Multi-chain support requires at least:

- `cauldrons[].chain`
- `cauldrons[].boxAddress` or chain-level box lookup
- likely `cauldrons[].boxKind` (`BentoBox` vs `DegenBox`) for clarity, even if `toAmount()` remains the same ABI

#### B. Config inventory refresh per chain

For each supported chain:

1. enumerate official active cauldrons from Abracadabra docs
2. prune deprecated / archived cauldrons
3. verify which active cauldrons have non-zero `totalCollateralShare()`
4. map collateral token address, decimals, and risk tier

This is not one-time doc copying; it needs a production-safe prune pass against actual on-chain non-zero collateral.

#### C. Per-chain RPC strategy

The adapter currently uses one chain context. Multi-chain rollout needs:

- chain-aware on-chain reads
- per-chain RPC fallback handling
- bounded concurrency so the reserve cron does not explode its outbound connection budget

Each cauldron currently costs:

1. one `totalCollateralShare()` call
2. one `toAmount()` call on the relevant box
3. later pricing resolution

Scaling that across many chains can multiply call volume quickly.

#### D. Cross-chain price input handling

The current adapter already prices by `(chain, address)` through DefiLlama, which is a good base.

But multi-chain rollout still needs:

- consistent chain tagging per collateral
- duplicate-address safety across chains
- explicit handling for LP / GM / strategy tokens that are much more common off Ethereum

#### E. Test expansion

Would need new tests for:

- per-cauldron chain routing
- mixed `BentoBox` / `DegenBox` support
- multi-chain price-map resolution
- pruning / zero-share behavior
- multi-chain aggregation correctness

### Product / methodology decisions still needed

#### 1. Chain scope

Do we want:

- only the biggest active MIM cauldron chains first (`Ethereum + Arbitrum + Avalanche + BNB`, likely)
- or every official active chain from day one?

A staged rollout is much safer.

#### 2. Omnichain token vs collateral scope

Tracked MIM exists on more chains than the active cauldron set.

Need to preserve the distinction between:

- omnichain token deployments / bridge endpoints
- actual reserve-generating cauldrons

Reserve composition should reflect collateral-bearing cauldrons, not every chain where bridged MIM exists.

#### 3. Risk-tier review for non-Ethereum collateral families

Arbitrum GM tokens, LP positions, Fantom LP / xBOO positions, etc. are not covered by the current Ethereum-only simplified mix.

Adding them means either:

- accepting more `very-high` / `high` slices in live scoring
- or doing a dedicated reserve-risk review for each new collateral family

### Recommended rollout shape

Safest path:

1. redesign adapter schema for per-cauldron chain + box address
2. add `Ethereum + Arbitrum` first
3. validate runtime budget and live stability
4. expand to `Avalanche + BNB`
5. treat Fantom / Optimism / Kava as a later tranche if still material

That keeps the first follow-up limited to the most likely meaningful non-Ethereum cauldrons without forcing a full long-tail rollout immediately.

## Bottom line

- `USDU`: no better Accountable bucket is available today. The right future bucket is `exposure_split`; `deployment` is the only acceptable fallback if it becomes semantically strategy-level. Otherwise this wants a custom Unitas adapter, not more tuning of `reserves_split`.
- `MIM`: multi-chain expansion is real adapter work, not a config tweak. It needs per-cauldron chain support, per-chain box handling, chain-aware RPC fan-out, new collateral risk review, and a staged rollout.
