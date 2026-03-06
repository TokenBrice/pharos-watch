---
title: "Add frontend and shared library tests"
agent: "codex"
model: "o4-mini"
reasoning_effort: "high"
done: false
---

## Goal

Write tests for 2 testing-coverage findings: frontend detail-page view-model hook and shared library pure functions.

## Context

- Test runner: Vitest (see `vitest.config.ts`)
- Frontend hooks use TanStack Query — test with `@tanstack/react-query` test utilities or mock the underlying fetch
- Shared lib functions are pure — test directly with no mocking needed
- Path aliases: `@` = `src/`, `@shared` = `shared/`

## Task

### Step 1: TEST-007 — Frontend view-model hook tests

Create `src/hooks/__tests__/use-stablecoin-detail-view-model.test.ts`:

The hook `useStablecoinDetailViewModel` in `src/hooks/use-stablecoin-detail-view-model.ts` composes 5 TanStack Query hooks. Test the derived state logic:

1. Read the hook to understand its return shape and the derived values it computes.

2. **Approach A (recommended)**: If the hook's derivation logic is extractable as a pure function, extract it and test the pure function directly. For example, if there's a `deriveViewModel(stablecoins, pegSummary, dexLiquidity, ...)` function, test that.

3. **Approach B**: If the logic is tightly coupled to hooks, use `renderHook` from `@testing-library/react` with a `QueryClientProvider` wrapper and mock fetch responses:
```typescript
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};
```

4. Test scenarios:
   - **All loading**: All queries pending → hook returns loading state
   - **Coin not found**: Stablecoins loaded but ID doesn't exist → returns not-found
   - **All data ready**: All queries succeed → returns computed values (mcap, deviation, etc.)
   - **Partial error**: One query fails → returns error state with info about which failed

5. For concrete assertions, check that derived values (deviation in bps, mcap formatting, peg reference) are computed correctly from the mock input data.

### Step 2: TEST-011 — Shared library tests

Create `shared/lib/__tests__/peg-rates.test.ts`:

Test `derivePegRates()` and `getPegReference()` from `shared/lib/peg-rates.ts`:

1. **Median calculation**: 3 coins in USD peg group with prices [0.999, 1.001, 1.000] → median is 1.000
2. **Supply threshold**: Coin with <$1M supply excluded from median
3. **Single-coin group**: Median = that coin's price
4. **Empty group**: No rate added
5. **Gold commodity normalization**: If there's gram-to-ounce conversion logic, test it
6. **Fallback rate**: Groups with <3 coins use fallback rate

Create `shared/lib/__tests__/chains.test.ts`:

Test the chain metadata constants from `shared/lib/chains.ts`:

1. **All chain keys lowercase**: `Object.keys(CHAINS).every(k => k === k.toLowerCase())`
2. **EVM chain IDs unique**: No duplicate `evmChainId` values among EVM chains
3. **Non-EVM chains**: Have `evmChainId === null` or undefined
4. **Explorer URLs well-formed**: All URLs start with `https://`

Create `shared/lib/__tests__/psi-eligible.test.ts`:

Test the PSI eligibility set:

1. **Set is non-empty**: At least some coins are eligible
2. **No duplicate IDs**: Set size matches array length
3. **Known coins included**: USDT, USDC, DAI are PSI-eligible (verify from the source)

## Acceptance Criteria

1. `npm test` passes — all new and existing tests pass
2. `npx tsc --noEmit` passes (root)
3. New test files exist:
   - `src/hooks/__tests__/use-stablecoin-detail-view-model.test.ts`
   - `shared/lib/__tests__/peg-rates.test.ts`
   - `shared/lib/__tests__/chains.test.ts`
   - `shared/lib/__tests__/psi-eligible.test.ts`
4. View-model hook test covers at least: loading, not-found, ready, and error states
5. Peg-rates test covers: median calculation, supply threshold, empty group
6. Chains test covers: key format, ID uniqueness, URL format
