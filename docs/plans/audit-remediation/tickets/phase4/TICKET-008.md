---
title: "Improve test infrastructure: mock-d1 fidelity and fixture alignment"
agent: "codex"
model: "gpt-5.1-codex-mini"
reasoning_effort: "high"
done: false
---

## Goal

Improve the mock D1 database helper to be bind-sensitive and support batch failure semantics. Update fixture builders to match current runtime schemas. This is a prerequisite for other test tickets.

## Context

- `worker/src/api/__tests__/helpers/mock-d1.ts` uses substring matching (`sql.includes(t.match)`) and ignores bind parameters entirely. This means tests can pass even when SQL is wrong or bindings are missing.
- `worker/src/api/__tests__/helpers/fixtures.ts` has drifted from `shared/types/index.ts` — missing recent fields like `score_components_json`, `locked_liquidity_pct`, etc.

## Task

### Step 1: TEST-004 — Improve mock-d1 bind sensitivity

In `worker/src/api/__tests__/helpers/mock-d1.ts`:

1. Read the current implementation to understand the mock API surface.

2. Add bind-parameter tracking to the mock. The mock should record what bind values were passed:
```typescript
interface MockPreparedStatement {
  sql: string;
  boundValues: unknown[];
  // ...
}
```

3. Add an optional `matchBinds` to the mock configuration so tests can assert specific bind values:
```typescript
interface MockTableConfig {
  match: string;           // SQL substring to match
  matchBinds?: unknown[];  // If provided, also match bind values
  rows: Record<string, unknown>[];
}
```

4. When matching, if `matchBinds` is provided, verify the bound values match (order-sensitive):
```typescript
const sqlMatch = sql.includes(t.match);
const bindMatch = !t.matchBinds || JSON.stringify(boundValues) === JSON.stringify(t.matchBinds);
return sqlMatch && bindMatch;
```

5. Add a `getBoundValues()` method or expose the history of all prepared+bound statements so tests can make assertions:
```typescript
mockDb.getHistory(): Array<{ sql: string; binds: unknown[] }>
```

6. Add batch semantics: `db.batch()` should execute all statements and if any throw, the batch result should reflect the failure. Currently it always succeeds.

7. **Do not break existing tests.** The `matchBinds` parameter is optional — existing tests that don't provide it continue to work as before. Run `npm test` after each change to verify.

### Step 2: TEST-005 — Update fixture builders

In `worker/src/api/__tests__/helpers/fixtures.ts`:

1. Read `shared/types/index.ts` to find the current `StablecoinData` / `PeggedAsset` / related types.

2. Compare fixture builder output shapes with the actual types. For each builder (e.g., `makeAsset()`, `makeDexLiquidityRow()`, `makeBlacklistRow()`):
   - Add any missing fields with sensible defaults
   - Remove any fields that no longer exist in the types
   - Keep all fields optional via spread override pattern: `{ ...defaults, ...overrides }`

3. Specifically add:
   - `score_components_json` to `makeDexLiquidityRow()` (default: `null`)
   - `locked_liquidity_pct` to `makeDexLiquidityRow()` (default: `null`)
   - Any other fields that exist in the runtime types but not in fixtures

4. **Do not break existing tests.** New fields should have defaults that maintain current test behavior. Run `npm test` after changes.

## Acceptance Criteria

1. `npm test` passes — all existing tests still pass
2. `cd worker && npx tsc --noEmit` passes
3. `npm run lint` passes
4. Mock D1 records bind values and exposes them for assertion
5. Mock D1 supports optional `matchBinds` in config
6. Mock D1 `batch()` propagates failures
7. Fixture builders produce objects that match current type definitions
8. Verify: `npx tsc --noEmit` in the test files doesn't show type errors for fixture shapes
