# Curated vs Live Reserve Drift Investigation — 2026-04-22

## Scope

Investigated the four `/status` reserve-drift entries visible on 2026-04-22:

- `buck-buck-assets`
- `gho-aave`
- `usdu-unitas`
- `mim-abracadabra`

I compared:

1. curated `reserves[]` metadata in `shared/data/stablecoins/*.json`
2. current live reserve payloads from `https://pharos.watch/_site-data/stablecoin-reserves/:id`
3. the adapter logic that produces those live slices
4. nearby methodology / planning notes when the mismatch looked structural

## Current Drift Snapshot

Pulled on 2026-04-22 UTC from the public site-data lane:

| Coin | Curated score | Live score | Delta | Primary finding |
| --- | ---: | ---: | ---: | --- |
| `buck-buck-assets` | `36.5` | `55.8` | `19.3` | Internal risk-tier mismatch on the same STRC reserve slice |
| `gho-aave` | `73.0` | `54.9` | `18.1` | Curated reserves still model legacy Aave collateral mix while live logic now models facilitator/GSM issuance mix |
| `mim-abracadabra` | `32.8` | `48.8` | `16.0` | Drift is real, but live coverage is intentionally Ethereum-only and therefore only a partial reserve view |
| `usdu-unitas` | `25.0` | `40.9` | `15.9` | Live adapter is scoring Accountable venue buckets, not a reserve-quality breakdown comparable to curated strategy slices |

## Findings

### 1. `buck-buck-assets` is a straightforward repo inconsistency

- Curated metadata still scores STRC as `high` risk in [shared/data/stablecoins/usd-minor.json](/home/ahirice/Documents/git/stablecoin-dashboard/shared/data/stablecoins/usd-minor.json:11315).
- The live adapter explicitly scores the same STRC slice as `medium` in [worker/src/cron/reserve-adapters/buck-io-transparency.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/reserve-adapters/buck-io-transparency.ts:73).
- The live mix percentages are otherwise basically identical to curated (`76.9/23.1` live vs `77/23` curated), so the entire 19.3-point drift is coming from that single risk-tier disagreement.

Conclusion: this is not a live-source surprise. It is a canonical-risk mismatch between curated metadata and adapter logic.

### 2. `gho-aave` is curated metadata drift after the April 16 methodology change

- Curated metadata still describes GHO as if its reserve mix were mostly Aave collateral assets such as `wstETH`, `sDAI`, `WETH`, and `WBTC` in [shared/data/stablecoins/usd-major.json](/home/ahirice/Documents/git/stablecoin-dashboard/shared/data/stablecoins/usd-major.json:3233).
- The live adapter now decomposes GHO into tracked GSM backing plus residual issuance allocated across active facilitators in [worker/src/cron/reserve-adapters/gho.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/reserve-adapters/gho.ts:423).
- Safety-score methodology v`7.06`, dated **2026-04-16**, explicitly says GHO residual issuance is now decomposed across active facilitators and that direct-minter facilitators contribute `medium`-risk residual slices in [shared/lib/safety-score-version-data.ts](/home/ahirice/Documents/git/stablecoin-dashboard/shared/lib/safety-score-version-data.ts:40).

Conclusion: the live output matches the current repo methodology. The curated `reserves[]` block still reflects the older collateral story and should be rewritten or removed from drift comparisons.

### 3. `usdu-unitas` is mostly a comparability problem, not clean metadata drift

- Curated metadata describes USDU as `80%` JLP plus `20%` short-perp margin, both `high` risk, in [shared/data/stablecoins/usd-minor.json](/home/ahirice/Documents/git/stablecoin-dashboard/shared/data/stablecoins/usd-minor.json:2072).
- The live adapter is configured to read Accountable `reserves_split` buckets in [shared/data/stablecoins/usd-minor.json](/home/ahirice/Documents/git/stablecoin-dashboard/shared/data/stablecoins/usd-minor.json:2088).
- The Accountable adapter blindly turns whichever bucket is selected into reserve slices based on `riskMap` in [worker/src/cron/reserve-adapters/accountable.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/reserve-adapters/accountable.ts:95).
- Current upstream data for Unitas exposes buckets like `Binance`, `Solana`, `Bnb_smartchain`, and `Aster`, which are venue/location labels rather than strategy-asset labels.
- There is also a small mapping bug: config expects `BNB Smart Chain`, but the live payload emits `Bnb_smartchain`, so that slice is currently falling into the generic unknown-high bucket.

Conclusion: the large score uplift is mainly because the live path treats `Solana` as a `low`-risk reserve bucket. That is not semantically comparable to the curated `JLP + short perps` strategy mix. This alert should not be interpreted as a simple metadata stale case.

### 4. `mim-abracadabra` is a mix of real metadata drift and known partial live coverage

- Curated metadata still includes `GM tokens` and `Other exotic collateral` at `30%` combined in [shared/data/stablecoins/usd-minor.json](/home/ahirice/Documents/git/stablecoin-dashboard/shared/data/stablecoins/usd-minor.json:4539).
- The current live adapter only covers four Ethereum cauldrons in [shared/data/stablecoins/usd-minor.json](/home/ahirice/Documents/git/stablecoin-dashboard/shared/data/stablecoins/usd-minor.json:4567).
- The rollout plan for this adapter explicitly states that MIM is multi-chain and that the shipped config was an **Ethereum-only initial rollout** with cross-chain coverage deferred in [agents/plans/historical/2026-04-16-reserve-sync-remediation-and-expansion.md](/home/ahirice/Documents/git/stablecoin-dashboard/agents/plans/historical/2026-04-16-reserve-sync-remediation-and-expansion.md:1465).

Conclusion: the watch alert is directionally useful, but the live side is intentionally partial. Treat this as "curated mix no longer matches the currently tracked Ethereum cauldrons" rather than as a full-protocol ground truth mismatch.

## Recommended Actions

1. `buck-buck-assets`
   - Pick one canonical STRC risk tier and align both curated metadata and adapter logic to it.
2. `gho-aave`
   - Update curated `reserves[]` to match the facilitator/GSM model now used by v7.06+.
3. `usdu-unitas`
   - Either switch to a genuinely comparable Accountable bucket, or exclude USDU from drift watch until the live feed exposes reserve-quality slices instead of location buckets.
   - Independently fix the `Bnb_smartchain` naming mismatch.
4. `mim-abracadabra`
   - Either finish multi-chain cauldron coverage before trusting drift watch, or explicitly document that the live score is Ethereum-only and should not be compared against full-protocol curated reserves.

## Commands / Endpoints Used

- `https://pharos.watch/_site-data/stablecoin-reserves/buck-buck-assets`
- `https://pharos.watch/_site-data/stablecoin-reserves/gho-aave`
- `https://pharos.watch/_site-data/stablecoin-reserves/usdu-unitas`
- `https://pharos.watch/_site-data/stablecoin-reserves/mim-abracadabra`
- `https://cache.accountable.capital/dashboard/unitas`
- `https://buck.io/transparency`
