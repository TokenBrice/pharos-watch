# Test Suite Upgrade: Type Safety + Runtime Validation + Contract Tests

**Date**: 2026-03-01
**Status**: Approved
**Trigger**: `data.coins.find(...)` crash in production — polymorphic API endpoint returned a flat object where the frontend expected an array.

## Problem

The mint-burn flows API has two modes (aggregate vs per-coin) returning structurally different JSON, but one hook (`useMintBurnFlows`) types both as `MintBurnFlowsResponse`. TypeScript can't catch this because `useApiQuery<T>` is a trust-me generic with zero runtime validation. The test suite (163 pure-function tests) doesn't cover hooks, components, or API response shapes.

## Solution: Three Layers

```
                    ┌─────────────────────────┐
                    │  1. Discriminated Types  │
                    │  (compile-time safety)   │
                    └────────────┬────────────┘
                                 │
                    ┌────────────┴────────────┐
                    │                         │
           ┌───────▼──────┐        ┌─────────▼────────┐
           │ 2. Zod        │        │ 3. API Contract   │
           │ Schemas       │        │    Tests           │
           │ (runtime      │        │ (build-time        │
           │  validation)  │        │  verification)     │
           └──────────────┘        └────────────────────┘
```

| Failure mode                              | Types         | Zod              | Contract tests |
|-------------------------------------------|---------------|------------------|----------------|
| Hook called with wrong generic            | Compile error | —                | —              |
| API response missing a field              | —             | console.warn     | Test failure   |
| API adds new response mode without type   | —             | —                | Review catches |
| API field changes type (number→string)    | —             | console.warn     | Test failure   |
| Component calls `.find()` on wrong shape  | Compile error | —                | —              |

## Layer 1: Discriminated Union Types + Separate Hooks

**mint-burn-flows** (caused the crash):

- Add `MintBurnPerCoinResponse` to `types.ts`: `{ stablecoinId, symbol, mintVolumeUsd, burnVolumeUsd, netFlowUsd, mintCount, burnCount, chains[], hourly[], updatedAt }`
- Keep `MintBurnFlowsResponse` as-is (correct for aggregate mode)
- Split hook in `use-mint-burn-flows.ts`:
  - `useMintBurnFlows(hours?)` — aggregate only, returns `UseQueryResult<MintBurnFlowsResponse>`
  - `useMintBurnFlowsCoin(stablecoinId, hours?)` — per-coin only, returns `UseQueryResult<MintBurnPerCoinResponse>`
- `FlowSummaryCard` already calls `useMintBurnFlows()` without an ID — no consumer change needed

**stability-index**: Already correctly split into `useStabilityIndex()` and `useStabilityIndexDetail()` with separate types. No change needed.

## Layer 2: Zod Schemas + Runtime Validation

**Scope**: 5 high-priority response types with nested arrays accessed via `.find()` or `.map()`:

| Response Type               | Risk                                                              |
|-----------------------------|-------------------------------------------------------------------|
| `MintBurnFlowsResponse`     | Caused the crash. Polymorphic endpoint.                           |
| `MintBurnPerCoinResponse`   | New type — born with a schema.                                    |
| `ReportCardsResponse`       | Deep nesting. `.find()` in detail page.                           |
| `PegSummaryResponse`        | `.find()` on detail page, `.map()` on homepage.                   |
| `StablecoinListResponse`    | Most consumed hook. `.find()` everywhere.                         |

**Not in scope**: `DexLiquidityMap`, `BluechipRatingsMap`, `UsdsStatus`, `DailyDigestData`, flat array types.

**Implementation**:

1. In `types.ts`: Replace 5 interfaces with Zod schemas + `z.infer<>`. Exported type names stay the same — no downstream import changes.
2. In `api.ts`: Add `safeParseFetch<T>(path, schema)` alongside existing `apiFetch<T>`. On validation failure: `console.warn` + return data as-is (graceful degradation).
3. In hooks: The 5 prioritized hooks switch to `safeParseFetch`. All other hooks unchanged.
4. Add `zod` to frontend `package.json`.

**No Zod in the worker** — validation belongs at the consumption boundary, not the production boundary.

## Layer 3: API Contract Tests

**Which handlers**:

| Handler                  | Modes                                        | Assertions                                                                                  |
|--------------------------|----------------------------------------------|---------------------------------------------------------------------------------------------|
| `handleMintBurnFlows`    | Aggregate, Per-coin, 404 (unknown coin)      | Aggregate has `gauge`, `coins[]`, `hourly[]`. Per-coin has `stablecoinId`, `chains[]`, no `coins`. |
| `handleStabilityIndex`   | Summary (default), Detail (`?detail=true`)   | Both have `current` + `history[]`. Detail history includes `components`.                     |

**D1 mock**: Lightweight mock implementing `.prepare().bind().all()/.first()/.run()` chains. Returns canned row data. Matches on table name substrings — tests response shape, not SQL correctness.

**Test structure**:
```
worker/src/api/__tests__/
  mint-burn-flows.test.ts    — 3 tests
  stability-index.test.ts    — 2 tests
  helpers/
    mock-d1.ts               — shared D1 mock
```

Tests optionally validate responses against the same Zod schemas from `src/lib/types.ts`, creating a direct link between worker output and frontend expectations.

## Files Touched

| File                                              | Change                                              |
|---------------------------------------------------|-----------------------------------------------------|
| `package.json`                                    | Add `zod` dependency                                |
| `src/lib/types.ts`                                | Replace 5 interfaces with Zod schemas + z.infer. Add `MintBurnPerCoinResponse`. |
| `src/lib/api.ts`                                  | Add `safeParseFetch` alongside `apiFetch`           |
| `src/hooks/use-mint-burn-flows.ts`                | Split into two hooks                                |
| `src/hooks/use-stablecoins.ts`                    | Switch to `safeParseFetch`                          |
| `src/hooks/use-peg-summary.ts`                    | Switch to `safeParseFetch`                          |
| `src/hooks/use-report-cards.ts`                   | Switch to `safeParseFetch`                          |
| `worker/src/api/__tests__/mint-burn-flows.test.ts`| New — 3 tests                                       |
| `worker/src/api/__tests__/stability-index.test.ts`| New — 2 tests                                       |
| `worker/src/api/__tests__/helpers/mock-d1.ts`     | New — shared mock                                   |
| `docs/testing.md`                                 | Update with new test categories                     |

## Decisions Made

- **Schema location**: Colocate in `types.ts` — single source of truth via `z.infer`
- **D1 mocking**: Lightweight mock returning canned rows — no Miniflare
- **Validation failure mode**: `console.warn` + return data as-is (graceful degradation in prod)
- **Approach**: Top-down (fix type lie first, then add validation layers)
