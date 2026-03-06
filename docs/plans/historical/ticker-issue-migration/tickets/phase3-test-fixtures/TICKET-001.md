---
title: "Update all test fixtures to use canonical stablecoin IDs"
agent: "codex"
reasoning_effort: "high"
done: false
---

## Prerequisites

- Phase 1 TICKET-005 must be completed first (creates `shared/lib/__tests__/stablecoin-id-registry.test.ts`)
- This ticket runs **in parallel** with other Phase 3 worktrees (master-switchover and frontend-compat). Use `./DESIGN-MAPPING-TABLE.ts` to determine post-migration expected values rather than depending on Phase 3 source changes being completed first

## Goal

Replace all hardcoded legacy stablecoin IDs in test files with their canonical ticker-issuer equivalents.

## Task

Use the mapping table at `./DESIGN-MAPPING-TABLE.ts` (copied to the worktree root by the orchestrator) for all translations.

### 1. Discovery (CRITICAL — do not skip)

The test suite has ~50+ test files. Do NOT rely on the list below — it's a starting point. Run comprehensive discovery:

```bash
# Find ALL test files with potential stablecoin IDs
grep -rlE '"[0-9]+"' worker/src/ src/ shared/ --include="*.test.ts" --include="*.test.tsx"
grep -rl '"cg-\|"gold-\|"silver-\|"iron-finance"' worker/src/ src/ shared/ --include="*.test.ts" --include="*.test.tsx"
# Also find test files with stablecoin IDs embedded in URL strings (e.g., /api/stablecoin/1, ?stablecoin=1)
grep -rlE 'stablecoin/[0-9]|stablecoin=[0-9]' worker/src/ src/ shared/ --include="*.test.ts" --include="*.test.tsx"
# Also check fixture/helper files used by tests (use find instead of globstar)
find worker/src src shared -path '*/__tests__/*.ts' ! -name '*.test.ts' -exec grep -lE '"[0-9]+"' {} +
```

Process EVERY file found, not just the ones listed below.

### 2. Worker test files (starting list — discovery may find more)

- `worker/src/api/__tests__/stablecoin-detail.test.ts`
- `worker/src/api/__tests__/helpers/fixtures.ts` — shared test fixture data
- `worker/src/cron/__tests__/sync-stablecoins.test.ts`
- `worker/src/cron/__tests__/sync-yield-data.test.ts`
- `worker/src/cron/__tests__/sync-mint-burn.test.ts`
- `worker/src/lib/__tests__/mint-burn-contracts.test.ts`
- `worker/src/lib/__tests__/mint-burn-bridge-classifier.test.ts`
- All other `__tests__/` files under `worker/src/`

### 3. Frontend test files (starting list)

- `src/lib/__tests__/api-endpoints.test.ts` — **Important**: this tests probe paths from `shared/lib/api-endpoints.ts` which are migrated in P3-MS-TICKET-004. Test assertions must match the new probe paths.
- `src/lib/__tests__/mint-burn-timeframes.test.ts`
- `src/hooks/__tests__/use-safety-score-history.test.ts`
- `src/__tests__/portfolio-categorize.test.ts`

### 4. Shared test files

- `shared/lib/__tests__/stablecoin-id-registry.test.ts` — see section 6 below

### 5. Important distinctions

- **Test fixtures simulating DefiLlama API responses:** Keep DL numeric IDs in the mock INPUT data (that's what the real DL API returns). Change the EXPECTED output/assertions to canonical IDs (since the Phase 2 sync remap converts DL IDs to canonical).
- **Test fixtures for internal APIs/DB queries:** Use canonical IDs everywhere.
- **Test assertions checking specific IDs:** Update to canonical.
- **Source-code dependency warning:** Some test assertions verify hardcoded values from source files that are migrated in OTHER Phase 3 tickets (e.g., `api-endpoints.test.ts` tests probe paths from `api-endpoints.ts`, `mint-burn-timeframes.test.ts` tests overrides from `mint-burn-timeframes.ts`). Since all Phase 3 worktrees run in parallel and merge together, the test assertions must match the POST-migration source values. Use the mapping table to determine what the new source values will be.

### 6. Registry test updates

Update the tests written in Phase 1 (P1-TICKET-005) to reflect that canonical IDs are now ticker-issuer format:
```ts
// Before Phase 3:
resolveStablecoinId("1") → { canonicalId: "1", matchedBy: "canonical" }
// After Phase 3:
resolveStablecoinId("usdt-tether") → { canonicalId: "usdt-tether", matchedBy: "canonical" }
resolveStablecoinId("1", { allowLegacy: true }) → { canonicalId: "usdt-tether", matchedBy: "llama" }
resolveStablecoinId("1") → null  // Without allowLegacy, numeric IDs no longer resolve
```

Also update `REGISTRY_BY_ID.has(...)` assertions to use canonical IDs.

### 7. False positive awareness

When grepping for `"cg-` or `"gold-` patterns in test files, be aware of false positives:
- Strings like `"cg-"` appearing in regex patterns being tested (e.g., testing that prefix checks were removed)
- DL mock response data that legitimately contains these as raw input (should NOT be changed)
- `"cg-key"` in `sync-dex-liquidity.test.ts` — this is a CoinGecko API key parameter, NOT a stablecoin ID
- `"gold-api.com"` in `sync-fx-rates.test.ts` — this is a URL domain for the gold price API, NOT a stablecoin ID
- `id.startsWith("cg-")` in `stablecoin-detail.test.ts` — this is runtime logic that dynamically finds CG-prefixed IDs; post-migration no IDs will start with `cg-`, so this test logic may need updating (not just string replacement)
- Only change values that represent **internal stablecoin IDs** used for assertions, DB queries, or API calls

## Acceptance Criteria

- `npm test` exits 0 with all tests passing
- `grep -rlE '"cg-[a-z]{2,}[-a-z]+"' worker/src/ src/ shared/ --include="*.test.ts" --include="*.test.tsx" | grep -v sync-dex-liquidity.test.ts | wc -l` returns 0 (no remaining cg-prefix stablecoin IDs — excludes `"cg-key"` false positive in sync-dex-liquidity via file exclusion and min-length `{2,}`)
- `grep -rl '"gold-\(xaut\|paxg\|dgld\|xaum\|kau\|cgo\|vro\)' worker/src/ src/ shared/ --include="*.test.ts" --include="*.test.tsx" | wc -l` returns 0 (checks specific gold-prefixed stablecoin IDs, excludes `"gold-api.com"` false positive)
- `grep -rl '"iron-finance"' worker/src/ src/ shared/ --include="*.test.ts" --include="*.test.tsx" | wc -l` returns 0
- DL mock input integrity preserved: `grep -A3 'peggedAssets\|mockResponse' worker/src/cron/__tests__/sync-stablecoins.test.ts | grep '"id"' | head -3` should still show numeric DL IDs
- Canonical output assertions: `grep 'usdt-tether\|usdc-circle' worker/src/cron/__tests__/sync-stablecoins.test.ts` returns at least 1 match
- Registry tests updated: `grep -c 'allowLegacy' shared/lib/__tests__/stablecoin-id-registry.test.ts` returns at least 1
