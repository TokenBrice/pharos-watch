---
name: resilience-classify
description: Curate evidence-backed collateralQuality and whole-book custodyModel labels. Use when adding a stablecoin or auditing Selector custody eligibility and DDR depeg-duration verdicts.
---

# Resilience Classify

Use this skill to review collateral quality and whole-book custody coverage, adding only evidence-backed metadata.

**What these fields drive today:** custody eligibility filters in the Selector (`shared/lib/selector/`) and scoped verdict signals in the DDR depeg-duration resolver (`shared/lib/depeg-resolver/`). The Selector's retired custody/collateral V8 ranking axes no longer drive ranking or "what to watch". These scalar labels do **not** feed the current Safety Score methodology. Published safety grades will not move from these labels, so do not promise or expect grade changes.

## Read First

- Read `resolveCustodyModel()` in `shared/lib/report-card-policy.ts`: authored custody wins; omission resolves to `unknown` for RWA-backed assets with non-decentralized governance and to `onchain` for the remaining structural classes. When whole-book evidence cannot support that default, author the reviewed `mixed`/`unknown` label explicitly.
- Read `shared/lib/methodology-versions/current-version.json` before describing scores; use the current Safety Score methodology and let that source file win over remembered versions.
- This skill is only for `collateralQuality` and `custodyModel`. Leave `governanceQuality` alone unless the user explicitly asked for it.

## Workflow

1. Read the stablecoin entry in `shared/data/stablecoins/coins/*.json` (or `shared/data/stablecoins/coins.generated.json`). For coins with a reserves sidecar, the reserve composition that informs `collateralQuality`/`custodyModel` lives in `shared/data/stablecoins/domains/reserves/<id>.json`, not the base file. Treat the runtime stablecoin re-export as import-only.
2. Review the complete material backing and custody layers. Backing and governance flags alone establish no affirmative custody tier.
3. Flag candidate mismatches when you see:
- off-chain or exchange custody
- bridge-heavy collateral
- delta-neutral or structured strategies
- keywords like `CEX`, `Ceffu`, `Copper`, `Fireblocks`, `bridged`

4. Research official docs plus one independent source when the architecture is not obvious.

5. Classify using these questions:
- `collateralQuality`: what is the riskiest significant backing component?
- `custodyModel`: does evidence cover every material backing part for the claimed tier? Use `mixed` for evidenced heterogeneous custody or `unknown` when whole-book coverage is unestablished.

6. Apply sourced labels in the matching per-coin JSON file, keeping the diff minimal. Explicit `mixed`/`unknown` may record the reviewed aggregate outcome; omission follows `resolveCustodyModel()`, not a universal unknown fallback. Retain partial providers, unknown shares and legal safeguards in the reserves sidecar. Then converge the aggregate and dependent projections with `npm run bootstrap:generated` and run `npm run check:stablecoin-data`; for full additions, follow the full validation sequence in Phase 7 of `docs/process/adding-a-stablecoin.md`.

## Tiers

The valid values are `COLLATERAL_QUALITY_VALUES` / `CUSTODY_MODEL_VALUES` in `shared/types/core.ts`; read the source file; do not rely on any list quoted elsewhere.

## Decision Rules

- For mixed collateral, classify by the riskiest significant component.
- A predominant verified custodian cannot establish an asset-wide institutional label. Require evidence across every material backing and custody layer; partial coverage stays mixed/unknown.
- Do not turn an undisclosed regulator into proven unregulated custody, or a mixed book into all-onchain custody.

## Known Pattern Examples

- Delta-neutral strategies can combine institutional, exchange and issuer-controlled wallet exposures. Review every material layer; do not infer a whole-book custody tier from the mechanism name.
