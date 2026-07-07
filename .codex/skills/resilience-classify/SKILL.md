---
name: resilience-classify
description: Add explicit resilience overrides (`chainTier`, `deploymentModel`, `collateralQuality`, `custodyModel`) where `inferResilienceDefaults()` is too optimistic. Use when adding a stablecoin or auditing report-card accuracy.
---

# Resilience Classify

Use this skill to identify coins whose resilience defaults are wrong and to add only the override fields that differ from inference.

## Read First

- Read `inferResilienceDefaults()` in `shared/lib/report-card-policy.ts` (imported by `shared/lib/report-cards.ts`).
- Read `docs/report-cards.md` for the scoring model and tier meanings.
- This skill is only for `chainTier`, `deploymentModel`, `collateralQuality`, and `custodyModel`. Leave `governanceQuality` alone unless the user explicitly asked for it.

## Workflow

1. Read the stablecoin entry in `shared/data/stablecoins/coins/*.json` (or `shared/data/stablecoins/coins.generated.json`). Treat the runtime stablecoin re-export as import-only.
2. Compute or reason through the default inference from `backing` and `governance`.
3. Flag candidate mismatches when you see:
- non-Ethereum primary deployment
- multichain or OFT/CCIP/Wormhole/LayerZero architecture
- off-chain or exchange custody
- bridge-heavy collateral
- delta-neutral or structured strategies
- keywords like `CEX`, `Ceffu`, `Copper`, `Fireblocks`, `bridged`, `Bitcoin L2`, `Solana`

4. Research official docs plus one independent source when the architecture is not obvious.

5. Classify using these questions:
- `chainTier`: where do minting logic and collateral really live?
- `deploymentModel`: is the token single-chain, canonically bridged, third-party bridged, or natively issued on multiple chains?
- `collateralQuality`: what is the riskiest significant backing component?
- `custodyModel`: is collateral onchain, institutionally custodied, or effectively exchange/counterparty held?

6. Apply only fields that differ from defaults in the matching per-coin JSON file. Keep the diff minimal and regenerate `shared/data/stablecoins/coins.generated.json`.

7. Regenerate `shared/data/stablecoins/coins.generated.json` and run `npm run check:stablecoin-data`; for full additions, follow Phase 7 in `docs/process/adding-a-stablecoin.md`.

## Tiers

The lists below mirror `CHAIN_TIER_VALUES` / `DEPLOYMENT_MODEL_VALUES` / `COLLATERAL_QUALITY_VALUES` / `CUSTODY_MODEL_VALUES` in `shared/types/core.ts` — the source file wins.

- `chainTier`: `ethereum`, `stage1-l2`, `mature-alt-l1`, `established-alt-l1`, `unproven`
- `deploymentModel`: `single-chain`, `canonical-bridge`, `third-party-bridge`, `native-multichain`
- `collateralQuality`: `native`, `eth-lst`, `rwa`, `alt-lst-bridged-or-mixed`, `exotic`
- `custodyModel`: `onchain`, `institutional-top`, `institutional-regulated`, `institutional-unregulated`, `institutional-sanctioned`, `cex`

## Decision Rules

- `chainTier` is about the core protocol and collateral location, not where bridged wrappers trade.
- `deploymentModel` decision tree:
  - independent mint or redeem on more than one chain -> `native-multichain`
  - one home chain only -> check whether other chains use canonical or third-party bridges
- For mixed collateral, classify by the riskiest significant component.
- If any meaningful backing is exchange- or counterparty-held, lean toward `cex`.
- When torn between two tiers, choose the riskier one and cite the evidence.

## Known Pattern Examples

- Solana-native or other alt-L1 core systems often need `chainTier` overrides.
- CCIP, LayerZero, Wormhole, and similar architectures often imply `third-party-bridge`.
- Delta-neutral or exchange-based collateral often pushes `custodyModel` to `cex` and `collateralQuality` toward `exotic`.
