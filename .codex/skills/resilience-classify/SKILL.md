---
name: resilience-classify
description: Add explicit resilience overrides (`chainTier`, `deploymentModel`, `collateralQuality`, `custodyModel`) where `inferResilienceDefaults()` is too optimistic. Use when adding a stablecoin or auditing Selector rankings and DDR depeg-duration verdicts.
---

# Resilience Classify

Use this skill to identify coins whose resilience defaults are wrong and to add only the override fields that differ from inference.

**What these fields drive today:** the Selector's ranking and "what to watch" explanations (`shared/lib/selector/`) and the DDR depeg-duration resolver's verdict strata (`shared/lib/depeg-resolver/`). They do **not** feed Safety Score V9 — published safety grades will not move from these overrides, so do not promise or expect grade changes.

## Read First

- Read `inferResilienceDefaults()` in `shared/lib/report-card-policy.ts` for the default inference these overrides correct.
- This skill is only for `chainTier`, `deploymentModel`, `collateralQuality`, and `custodyModel`. Leave `governanceQuality` alone unless the user explicitly asked for it.

## Workflow

1. Read the stablecoin entry in `shared/data/stablecoins/coins/*.json` (or `shared/data/stablecoins/coins.generated.json`). For coins with a reserves sidecar, the reserve composition that informs `collateralQuality`/`custodyModel` lives in `shared/data/stablecoins/domains/reserves/<id>.json`, not the base file. Treat the runtime stablecoin re-export as import-only.
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

6. Apply only fields that differ from defaults in the matching per-coin JSON file, keeping the diff minimal. Then regenerate with `npx tsx scripts/maintenance/generate-stablecoin-per-coin-asset.ts`, run `npm run check:stablecoin-data`, and run `npm run check:generated-artifacts` so dependent projections converge; for full additions, follow Phase 7 in `docs/process/adding-a-stablecoin.md`.

## Tiers

The valid values are `CHAIN_TIER_VALUES` / `DEPLOYMENT_MODEL_VALUES` / `COLLATERAL_QUALITY_VALUES` / `CUSTODY_MODEL_VALUES` in `shared/types/core.ts` — read the source file; do not rely on any list quoted elsewhere.

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
