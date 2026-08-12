---
name: resilience-classify
description: Add explicit resilience overrides (`collateralQuality`, `custodyModel`) where `inferResilienceDefaults()` is too optimistic. Use when adding a stablecoin or auditing Selector rankings and DDR depeg-duration verdicts.
---

# Resilience Classify

Use this skill to identify coins whose resilience defaults are wrong and to add only the override fields that differ from inference.

**What these fields drive today:** the Selector's ranking and "what to watch" explanations (`shared/lib/selector/`) and the DDR depeg-duration resolver's verdict strata (`shared/lib/depeg-resolver/`). They do **not** feed Safety Score V9 — published safety grades will not move from these overrides, so do not promise or expect grade changes.

## Read First

- Read `inferResilienceDefaults()` in `shared/lib/report-card-policy.ts` for the default inference these overrides correct.
- This skill is only for `collateralQuality` and `custodyModel`. Leave `governanceQuality` alone unless the user explicitly asked for it.

## Workflow

1. Read the stablecoin entry in `shared/data/stablecoins/coins/*.json` (or `shared/data/stablecoins/coins.generated.json`). For coins with a reserves sidecar, the reserve composition that informs `collateralQuality`/`custodyModel` lives in `shared/data/stablecoins/domains/reserves/<id>.json`, not the base file. Treat the runtime stablecoin re-export as import-only.
2. Compute or reason through the default inference from `backing` and `governance`.
3. Flag candidate mismatches when you see:
- off-chain or exchange custody
- bridge-heavy collateral
- delta-neutral or structured strategies
- keywords like `CEX`, `Ceffu`, `Copper`, `Fireblocks`, `bridged`

4. Research official docs plus one independent source when the architecture is not obvious.

5. Classify using these questions:
- `collateralQuality`: what is the riskiest significant backing component?
- `custodyModel`: is collateral onchain, institutionally custodied, or effectively exchange/counterparty held?

6. Apply only fields that differ from defaults in the matching per-coin JSON file, keeping the diff minimal. Then converge the aggregate and dependent projections with `npm run prebuild -- --only stablecoin-client-registry,report-card-registry-fingerprint,legacy-stablecoin-redirects` and run `npm run check:stablecoin-data`; for full additions, follow the commit-derived artifact sequence and full validation in Phase 7 of `docs/process/adding-a-stablecoin.md`.

## Tiers

The valid values are `COLLATERAL_QUALITY_VALUES` / `CUSTODY_MODEL_VALUES` in `shared/types/core.ts` — read the source file; do not rely on any list quoted elsewhere.

## Decision Rules

- For mixed collateral, classify by the riskiest significant component.
- If any meaningful backing is exchange- or counterparty-held, lean toward `cex`.
- When torn between two tiers, choose the riskier one and cite the evidence.

## Known Pattern Examples

- Delta-neutral or exchange-based collateral often pushes `custodyModel` toward an institutional/counterparty tier and `collateralQuality` toward `exotic`.
