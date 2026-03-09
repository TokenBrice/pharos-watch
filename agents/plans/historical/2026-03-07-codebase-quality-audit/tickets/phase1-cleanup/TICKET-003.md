---
title: "Remove dead types, exports, and consolidate methodology version modules in shared/"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "high"
done: false
---

## Goal

Remove confirmed dead types and exports from `shared/types/index.ts` and `shared/lib/`, and consolidate the repeated methodology version export glue pattern into a shared helper.

## Context

A codebase audit confirmed these items are never imported by `src/` or `worker/src/`. Dead type/export analysis was performed by scanning all imports across both consumer trees.

## Task

### 1. Remove dead type declarations from shared/types/index.ts

Delete these type/const declarations entirely (not just de-export — they have zero consumers and zero internal uses):

- `DexPriceSource` (~line 533)
- `ReportCardMap` (~line 710)
- `MethodologyEnvelope` (~line 723) — note: `MethodologyEnvelopeSchema` may still be needed, only remove the derived type if unused
- `StabilityIndexComponents` (~line 768)
- `StabilityIndexMethodology` (~line 770)
- `YieldHistoryPoint` (~line 1211) — this is ~8 LOC
- `MintBurnPerCoinChain` (~line 1293)

**Important:** Before deleting each one, do a quick `grep` to confirm it's truly unused. If a type IS used somewhere, keep it and just de-export.

### 2. Collapse redundant methodology type aliases

- `StabilityIndexMethodologySchema` (~line 741) and `DepegDewsMethodologySchema` (~line 1006) are both direct aliases of `MethodologyEnvelopeSchema`. Replace all references to these aliases with `MethodologyEnvelopeSchema` directly, then delete the aliases.

### 3. Remove dead exports from shared/lib/

Delete these declarations entirely (confirmed zero consumers, zero internal uses):

- **`shared/lib/api-endpoints.ts`** (~line 446): `isRouterHandledPath`
- **`shared/lib/classification.ts`** (~line 232): `GRADE_COLORS` (~13 LOC)
- **`shared/lib/psi-colors.ts`** (~line 8): `isConditionBand`
- **`shared/lib/report-cards.ts`** (~line 293): `validateCollateralQualityDrift` (~18 LOC)
- **`shared/lib/strict-contract-paths.ts`** (~line 5): `STRICT_CONTRACT_PATHS_SET`

For each of these methodology version exports, they are removable declarations — delete them:
- **`shared/lib/blacklist-tracker-version.ts`** (~line 144): `BlacklistTrackerMethodologyChangelogEntry`
- **`shared/lib/depeg-dews-version.ts`** (~line 219): `DepegDewsMethodologyChangelogEntry`
- **`shared/lib/liquidity-score-version.ts`** (~line 129): `LiquidityMethodologyChangelogEntry`
- **`shared/lib/liquidity-score-version.ts`** (~line 137): `toLiquidityMethodologyVersionLabel`
- **`shared/lib/mint-burn-flow-version.ts`** (~line 183): `MINT_BURN_FLOW_METHODOLOGY_VERSION`
- **`shared/lib/mint-burn-flow-version.ts`** (~line 192): `MintBurnFlowMethodologyChangelogEntry`
- **`shared/lib/mint-burn-flow-version.ts`** (~line 198): `getMintBurnFlowMethodologyVersionAt`
- **`shared/lib/mint-burn-flow-version.ts`** (~line 200): `toMintBurnFlowMethodologyVersionLabel`
- **`shared/lib/stability-index-version.ts`** (~line 129): `PsiMethodologyChangelogEntry`
- **`shared/lib/yield-methodology-version.ts`** (~line 167): `YIELD_METHODOLOGY_VERSION`
- **`shared/lib/yield-methodology-version.ts`** (~line 176): `YieldMethodologyChangelogEntry`
- **`shared/lib/yield-methodology-version.ts`** (~line 182): `getYieldMethodologyVersionAt`
- **`shared/lib/yield-methodology-version.ts`** (~line 184): `toYieldMethodologyVersionLabel`

**Important:** Before deleting each one, verify with `grep -r` across the entire repo that it's truly unused. If used in tests only, de-export instead of delete (remove the `export` keyword but keep the function/type for internal test use).

### 4. De-export internal-only shared types

For each of these, remove the `export` keyword but keep the declaration (they're used internally by the file or its tests):

From `shared/types/index.ts`, de-export:
- `StablecoinFlags` (~line 37)
- `ProofOfReservesType` (~line 46)
- `ProofOfReserves` (~line 48)
- `StablecoinLink` (~line 54)
- `Jurisdiction` (~line 59)
- `SupplyMethodConfig` (~line 72)

**Important:** Only de-export these if the type is used within the same file. If other types in the same file reference them, they need to stay. Check before de-exporting. Zod schemas that are `z.infer`'d into types that ARE exported must stay exported.

## Acceptance Criteria

- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
- `grep -c 'export.*DexPriceSource\b' shared/types/index.ts` returns 0
- `grep -c 'export.*ReportCardMap\b' shared/types/index.ts` returns 0
- `grep -c 'export.*GRADE_COLORS' shared/lib/classification.ts` returns 0
- `grep -c 'export.*validateCollateralQualityDrift' shared/lib/report-cards.ts` returns 0
- `grep -c 'export.*isRouterHandledPath' shared/lib/api-endpoints.ts` returns 0
