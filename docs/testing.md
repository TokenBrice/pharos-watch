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

The `deploy-worker` job runs in parallel and type-checks the worker separately (`npx tsc --noEmit`).

## Test Setup

**Config:** `vitest.config.ts`

```ts
test: { globals: true }           // describe/it/expect available without imports
resolve: { alias: { "@": "src" }} // Same path alias as Next.js
```

**Location:** `src/lib/__tests__/` — colocated with the library code they test.

**Pattern:** `*.test.ts` — Vitest discovers files matching `**/*.{test,spec}.?(c|m)[jt]s?(x)`.

## Existing Test Suites

| File | Module Under Test | What It Covers |
|------|-------------------|----------------|
| `format.test.ts` | `src/lib/format.ts` | `formatCurrency`, `formatBps`, `formatPegDeviation`, `formatPercentChange`, `formatSupply`, `formatAddress`, `formatDuration`, `formatNativePrice`, `formatPegStability`, `formatDeathDate`, `formatDeathDateShort` |
| `supply.test.ts` | `src/lib/supply.ts` | `sumPegBuckets`, `getCirculatingRaw`, `getPrevDayRaw`, `getPrevWeekRaw`, `getPrevMonthRaw` |
| `classification.test.ts` | `src/lib/classification.ts` | Label maps (`GOVERNANCE_LABELS`, `BACKING_LABELS`, `PEG_LABELS`), short label consistency, color map key/value integrity, `PEG_CURRENCY_COUNT` |
| `report-cards.test.ts` | `src/lib/report-cards.ts` | Grade computation, dimension scorers, peg multiplier, dependency risk blending, stress test recomputation |

All four suites test pure functions from `src/lib/` — no DOM, no React, no network.

## Conventions

### What to test

- **Pure `src/lib/` functions** — formatters, supply helpers, classification maps, peg-rate derivation. These are the highest-value tests: deterministic, fast, and catch regressions in shared logic.
- **Edge cases** — `NaN`, `Infinity`, `null`, `undefined`, zero, negative values, empty inputs. The existing tests set this standard.
- **Boundary values** — tier boundaries in formatters (e.g., 999 vs 1000 for K suffix).

### What NOT to test (for now)

- **React components** — no jsdom/happy-dom environment configured. Component tests would need that added to `vitest.config.ts`.
- **API/worker handlers** — the worker has its own TypeScript config and no test runner. Worker logic is validated via type-checking and integration tests in production (health endpoint, circuit breakers).
- **TanStack Query hooks** — these are thin wrappers around fetch calls; testing them requires mocking the API layer.

### Test style

- Use `describe` per function, `it` per behavior.
- Test names describe the behavior, not the implementation: `"returns 0 for undefined input"` not `"calls sumPegBuckets with undefined"`.
- Use the `mockCoin()` helper (see `supply.test.ts`) for partial `StablecoinData` mocks — avoids `as any` casts.
- Keep tests focused: one assertion per `it` block when possible.

## Adding a New Test

1. Create `src/lib/__tests__/<module>.test.ts`.
2. Import from the module under test (use `@/lib/...` alias).
3. Write `describe`/`it` blocks following the conventions above.
4. Run `npm test` to verify, then `npm run lint` to check for issues.

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
