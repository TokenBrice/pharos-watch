# Testing & Linting

## Overview

The project uses **Vitest** for unit tests and **ESLint** (via `eslint-config-next`) for linting. Both run in CI before every deploy.

## Commands

```bash
npm test              # Run all tests once (CI mode)
npm run test:watch    # Watch mode — re-runs on file changes
npm run lint          # ESLint across frontend + worker code
npm run lint -- --fix # Auto-fix fixable warnings (stale directives, etc.)
```

## CI Pipeline

Defined in `.github/workflows/deploy-cloudflare.yml`. The `deploy-pages` job runs sequentially:

1. `npm run lint` — ESLint must pass (warnings OK, errors block)
2. `npm test` — Vitest must pass (exit code 0)
3. `npm run build` — Next.js static export (also runs TypeScript type-checking)
4. Deploy to Cloudflare Pages

The `deploy-worker` job runs first (deploy-pages has `needs: deploy-worker`). It installs root deps (`npm ci`) for shared `src/lib/` type resolution, then installs worker deps and type-checks (`npx tsc --noEmit`).

## Test Setup

**Config:** `vitest.config.ts`

```ts
test: { globals: true }           // describe/it/expect available without imports
resolve: { alias: { "@": "src" }} // Same path alias as Next.js
```

**Locations:**
- `src/lib/__tests__/` — frontend library tests (pure functions)
- `worker/src/lib/__tests__/` — worker library tests (scoring, parsing)
- `worker/src/api/__tests__/` — API handler contract tests

**Pattern:** `*.test.ts` — Vitest discovers files matching `**/*.{test,spec}.?(c|m)[jt]s?(x)`.

## Existing Test Suites

| File | Module Under Test | What It Covers |
|------|-------------------|----------------|
| `format.test.ts` | `src/lib/format.ts` | `formatCurrency`, `formatBps`, `formatPegDeviation`, `formatPercentChange`, `formatSupply`, `formatAddress`, `formatDuration`, `formatNativePrice`, `formatPegStability`, `formatDeathDate`, `formatDeathDateShort` |
| `supply.test.ts` | `src/lib/supply.ts` | `sumPegBuckets`, `getCirculatingRaw`, `getPrevDayRaw`, `getPrevWeekRaw`, `getPrevMonthRaw` |
| `classification.test.ts` | `src/lib/classification.ts` | Label maps (`GOVERNANCE_LABELS`, `BACKING_LABELS`, `PEG_LABELS`), short label consistency, color map key/value integrity, `PEG_CURRENCY_COUNT` |
| `report-cards.test.ts` | `src/lib/report-cards.ts` | Grade computation, dimension scorers, peg multiplier, dependency risk blending, stress test recomputation |
| `reserve-templates.test.ts` | `src/lib/reserve-templates.ts` | Reserve composition templates, `getReserves()`, `deriveDependencies()` |
| `reserve-coinid-validation.test.ts` | `src/lib/reserve-templates.ts` | Validates reserve slice `coinId` references match tracked stablecoin IDs |
| `liquidity-coverage.test.ts` | `src/lib/dex-constants.ts` | Validates DEX pool configs cover all stablecoins with DEX presence |
| `yield-helpers.test.ts` | `worker/src/cron/yield-helpers.ts` | `computePYS`, `computeApyFromRate`, `computeApyFromPrice`, `computeYieldStability`, `detectWarningSignals` |

All eight suites test pure functions — no DOM, no React, no network.

### Worker Library Tests

Located in `worker/src/lib/__tests__/`. These test worker-side pure functions.

| File | Module Under Test | What It Covers |
|------|-------------------|----------------|
| `mint-burn-scoring.test.ts` | `worker/src/lib/mint-burn-scoring.ts` | `computeFlowIntensity`, `computeGaugeScore`, `detectFlightToQuality`, `getGaugeBand` |
| `evm-logs.test.ts` | `worker/src/lib/evm-logs.ts` | `buildTopicParams` — topic filter construction for EVM log queries |
| `resolve-market-cap.test.ts` | `worker/src/lib/resolve-market-cap.ts` | `resolveMarketCap` — CG vs computed mcap agreement, frozen data detection |

### API Contract Tests

Located in `worker/src/api/__tests__/`. These test that worker handlers return the correct response shape for each endpoint mode. They use a lightweight D1 mock (`helpers/mock-d1.ts`) that returns canned row data.

| File | Handler | Modes Tested |
|------|---------|--------------|
| `mint-burn-flows.test.ts` | `handleMintBurnFlows` | Aggregate (gauge + coins[]), Per-coin (flat + chains[]), 404 |
| `stability-index.test.ts` | `handleStabilityIndex` | Summary, Detail (with components in history) |

Contract tests validate responses against the same Zod schemas the frontend uses, creating a direct link between what the worker produces and what the frontend expects.

### Zod Runtime Validation

Five high-priority API response types have Zod schemas in `src/lib/types.ts`:
- `StablecoinListResponseSchema`
- `PegSummaryResponseSchema`
- `ReportCardsResponseSchema`
- `MintBurnFlowsResponseSchema`
- `MintBurnPerCoinResponseSchema`

Four of these are wired into their hooks via `useApiQuery`'s `schema` option: `StablecoinListResponse`, `PegSummaryResponse`, `MintBurnFlowsResponse`, and `MintBurnPerCoinResponse`. On validation failure: `console.warn` with details, return data as-is (graceful degradation). `ReportCardsResponse` keeps a hand-written interface (narrow `ReportCardGrade`/`DimensionKey` types needed by downstream components) — its schema is exported for contract tests but not wired into the hook. Most types are derived via `z.infer<>`.

When adding a new API endpoint:
1. Define the response schema in `src/lib/types.ts` if the response has nested arrays or objects accessed via `.find()` / `.map()`
2. Pass the schema to `useApiQuery` via `{ schema: MyResponseSchema }`
3. Add a contract test in `worker/src/api/__tests__/` if the endpoint has multiple response modes

**Narrow-type gotcha:** If your response type uses string unions or branded types (e.g. `ReportCardGrade`, `DimensionKey`), Zod schemas infer `string` instead. In that case, keep the hand-written `interface` for TypeScript and export the Zod schema separately for contract tests only — don't wire it into the hook via `useApiQuery`. See `ReportCardsResponse` / `ReportCardsResponseSchema` for the pattern.

**Worker CI note:** `src/lib/types.ts` imports `zod`, and the worker type-checks that file via its `@/*` path alias. The deploy-worker CI job installs root deps (`npm ci`) specifically for this. If you add new npm packages imported at the top level of shared `src/lib/` files, they'll be resolved from root `node_modules/` — no need to add them to `worker/package.json` unless the worker uses them at runtime.

## Conventions

### What to test

- **Pure `src/lib/` functions** — formatters, supply helpers, classification maps, peg-rate derivation. These are the highest-value tests: deterministic, fast, and catch regressions in shared logic.
- **Edge cases** — `NaN`, `Infinity`, `null`, `undefined`, zero, negative values, empty inputs. The existing tests set this standard.
- **Boundary values** — tier boundaries in formatters (e.g., 999 vs 1000 for K suffix).
- **API contract tests** — when a worker handler has multiple response modes (different JSON shapes based on query params), add a contract test for each mode in `worker/src/api/__tests__/`. Use the D1 mock from `helpers/mock-d1.ts`.

### What NOT to test (for now)

- **React components** — no jsdom/happy-dom environment configured. Component tests would need that added to `vitest.config.ts`.
- **API/worker handlers (full integration)** — the D1 mock tests response shape, not SQL correctness. Full end-to-end worker testing would need a real D1 instance.
- **TanStack Query hooks** — these are thin wrappers around fetch calls; testing them requires mocking the API layer.

### Test style

- Use `describe` per function, `it` per behavior.
- Test names describe the behavior, not the implementation: `"returns 0 for undefined input"` not `"calls sumPegBuckets with undefined"`.
- Use the `mockCoin()` helper (see `supply.test.ts`) for partial `StablecoinData` mocks — avoids `as any` casts.
- Keep tests focused: one assertion per `it` block when possible.

## Adding a New Test

**Frontend library test:**
1. Create `src/lib/__tests__/<module>.test.ts`.
2. Import from the module under test (use `@/lib/...` alias).
3. Write `describe`/`it` blocks following the conventions above.
4. Run `npm test` to verify, then `npm run lint` to check for issues.

**Worker library test:** Same as above but in `worker/src/lib/__tests__/`. Import via relative paths (no `@/` alias).

**API contract test:** Create in `worker/src/api/__tests__/`. Import the handler and use `mockD1()` from `helpers/mock-d1.ts`. Validate response shape against Zod schemas from `src/lib/types.ts`.

Example skeleton:

```ts
import { describe, it, expect } from "vitest";
import { myFunction } from "../my-module";

describe("myFunction", () => {
  it("handles the happy path", () => {
    expect(myFunction("input")).toBe("expected");
  });

  it("returns fallback for null input", () => {
    expect(myFunction(null)).toBe("N/A");
  });
});
```

## ESLint Configuration

**Config:** `eslint.config.mjs` (flat config format)

**Extends:** `eslint-config-next/core-web-vitals` + `eslint-config-next/typescript`

**Custom rules** — React Compiler rules are downgraded to warnings since they flag valid patterns that work correctly at runtime:

| Rule | Level | Reason |
|------|-------|--------|
| `react-hooks/preserve-manual-memoization` | warn | Compiler can't optimize `useMemo([data])` when body accesses `data.current.*` sub-properties |
| `react-hooks/set-state-in-effect` | warn | Standard pattern for reading localStorage/sessionStorage on mount |
| `react-hooks/purity` | warn | `Date.now()` in render is intentional for timestamp-based UIs |
| `react-hooks/incompatible-library` | warn | TanStack Virtual `useVirtualizer()` — known library limitation |

**Ignored paths:** `.next/`, `out/`, `build/`, `worker/.wrangler/` (auto-generated build artifacts).
