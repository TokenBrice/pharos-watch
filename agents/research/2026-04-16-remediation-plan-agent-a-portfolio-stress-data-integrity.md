# Remediation Planning Agent A - Portfolio, Stress-Test, Stablecoin Data Integrity

Date: 2026-04-16

Scope: audit findings `Q1`, `Q2`, `Q3`, `Q7`, and compound issue `C1`.

Out of scope: product-code edits in this pass. This note is an implementation blueprint only.

## Executive Remediation Strategy

The portfolio and stress-test findings should be handled as one data-integrity remediation stream:

1. Fix the numeric correctness bug in upstream exposure first (`Q1`), because it can emit `NaN` into user-facing risk output.
2. Normalize portfolio holding amount semantics in one shared codec/helper (`Q2`), because later tests should lock the canonical behavior rather than encode today's inconsistency.
3. Add behavioral tests around the now-fixed portfolio and stress-test surfaces (`Q7`), focusing on business output, persistence/share round-trips, and stress propagation rather than implementation internals.
4. Tighten curated stablecoin metadata numeric schemas and aggregate checks (`Q3`) so bad checked-in data cannot reintroduce invalid dependency/reserve math.

Recommended implementation sequence: `A1 -> A2 -> A3 -> A4 -> A5`. `A1` and `A2` should land before most `Q7` tests so tests assert the intended behavior, not the current bug.

## Assumptions

- Zero-amount portfolio rows are editor drafts, not invalid state. The current UI intentionally calls `portfolio.addCoin(coin.id, 0)` from `src/app/portfolio/client.tsx:440-443` so a user can pick a coin before typing an amount. The least-surprising remediation is to make finite nonnegative amounts valid everywhere, including URL/storage/live state, and ensure computations treat total-zero portfolios as `NR` / empty exposure.
- Negative and non-finite amounts are invalid everywhere. They should not persist, share, or enter score/exposure math.
- Curated stablecoin reserve slices and dependency weights should be finite positive values. A zero-weight dependency or zero-pct reserve slice carries no useful information and should be removed rather than accepted.
- Contract decimals should be finite integers from `0` through `255`. Current data includes `decimals: 0` and max `24`; `0` must remain valid.
- Reserve totals are currently exactly around 100 in checked-in data. If future overcollateralized reserve totals are intentional, the validator should require an explicit documented allowlist rather than silently accepting them.

## Research Performed

### Local code and docs reviewed

- `docs/architecture.md`
- `docs/api-reference.md`
- `docs/testing.md`
- `docs/worker-and-api-limits.md`
- `docs/classification.md`
- `shared/data/stablecoins/AGENTS.md`
- `agents/audits/2026-04-16-comprehensive-three-pillar-audit-blueprint.md`
- `agents/research/2026-04-16-agent-2-code-quality-audit.md`
- `src/lib/portfolio-analysis.ts`
- `src/lib/portfolio-codec.ts`
- `src/hooks/use-portfolio.ts`
- `src/hooks/use-stress-test.ts`
- `src/app/portfolio/client.tsx`
- `src/components/stress-test-panel.tsx`
- `shared/lib/stablecoins/schema.ts`
- `scripts/check-stablecoin-data.ts`
- Current relevant tests under `src/lib/__tests__/`, `src/hooks/__tests__/`, `src/__tests__/`, and `shared/lib/__tests__/`

### Dependency/API facts checked

- Root `package.json` currently uses `zod` `^4.3.6`; installed package version is `4.3.6`.
- Local runtime inspection confirmed `z.number()` exposes `.finite()`, `.positive()`, `.nonnegative()`, `.int()`, `.min()`, `.max()`, and `.gt()`.
- Zod's current upstream release page reports `v4.3.6` as latest on 2026-01-22: https://github.com/colinhacks/zod

### Baseline validation run

Passed:

```bash
npm test -- src/lib/__tests__/portfolio-codec.test.ts src/__tests__/portfolio-categorize.test.ts src/hooks/__tests__/use-stress-test.test.ts shared/lib/__tests__/stablecoins.test.ts
npm run check:stablecoin-data
```

Current focused test count: 49 passing tests across the four relevant files above.

Coverage research:

```bash
npm test -- --coverage src/lib/__tests__/portfolio-codec.test.ts src/__tests__/portfolio-categorize.test.ts src/hooks/__tests__/use-stress-test.test.ts
```

This command's tests passed, then failed the global line threshold because it intentionally ran only a focused subset. Useful baseline from that output:

- `src/hooks/use-portfolio.ts`: 2.17% line coverage
- `src/hooks/use-stress-test.ts`: 12.69% line coverage
- `src/lib/portfolio-analysis.ts`: 31.63% line coverage
- `src/lib/portfolio-codec.ts`: 94.11% line coverage

### Stablecoin data shape audit

Checked current curated data in `shared/data/stablecoins/*.json`:

- Coins with reserves: `179`
- Coins with manual dependencies: `15`
- Contract deployments: `677`
- Traded contract deployments: `1`
- Commodity entries with `commodityOunces`: `9`
- Min reserve slice pct: `0.2`
- Max reserve slice pct: `100`
- Max dependency weight: `1`
- Max contract decimals: `24`
- Reserve totals outside `95..105`: `0`

Potentially relevant for `Q1`: 15 current coins have reserves that are entirely classified as stablecoin-like by `src/lib/portfolio-analysis.ts` keyword filtering, so the remainder-allocation branch should continue falling back cleanly when filtering leaves no non-stable reserve slices.

## Finding-to-Task Map

| Task | Findings | Primary Files |
| --- | --- | --- |
| `A1` | `Q1`, `C1` | `src/lib/portfolio-analysis.ts`, new/updated tests |
| `A2` | `Q2`, `C1` | `src/lib/portfolio-codec.ts`, `src/hooks/use-portfolio.ts`, `src/app/portfolio/client.tsx`, tests |
| `A3` | `Q7`, `C1` | `src/hooks/use-portfolio.ts`, `src/hooks/use-stress-test.ts`, `src/components/stress-test-panel.tsx`, tests |
| `A4` | `Q3`, `C1` | `shared/lib/stablecoins/schema.ts`, `scripts/check-stablecoin-data.ts`, tests |
| `A5` | `C1` | validation/docs decision only |

## A1 - Fix Upstream Exposure Reserve Allocation

Finding coverage: `Q1`, `C1`

Impact: High

Effort: Small to medium

Dependencies: none

### Current locations

- `src/lib/portfolio-analysis.ts:199-223` (`applyReservesToRemainder`)
- `src/lib/portfolio-analysis.ts:233-241` reserve-only holdings allocation
- `src/lib/portfolio-analysis.ts:266-270` remainder allocation call site
- Existing contrast guard: `shared/lib/report-card-resilience.ts:99-106`

### Current problem

`computeUpstreamExposure()` divides by `totalPct` without checking that `totalPct` is positive:

- Reserve-only holdings path divides at `src/lib/portfolio-analysis.ts:240`.
- Remainder path divides at `src/lib/portfolio-analysis.ts:221`.
- If reserve percentages sum to `0`, `remainderUsd * (reserve.pct / totalPct)` becomes `NaN`.
- If filtering stablecoin-like slices leaves only zero-pct non-stable slices, the same issue occurs in the remainder path.

### Proposed code-level change

In `src/lib/portfolio-analysis.ts`, introduce one local helper inside `computeUpstreamExposure()` or a private top-level helper:

```ts
function allocateReserveCollateral(
  reserves: readonly ReserveSlice[],
  amountUsd: number,
  backing: string,
  options?: { excludeStablecoinSlices?: boolean },
): void {
  const candidates = options?.excludeStablecoinSlices
    ? reserves.filter((reserve) => !isStablecoinSlice(reserve.name))
    : [...reserves];
  const positiveCandidates = candidates.filter((reserve) => reserve.pct > 0);
  const totalPct = positiveCandidates.reduce((sum, reserve) => sum + reserve.pct, 0);

  if (totalPct <= 0) {
    const fallback = backingFallback(backing);
    addCollateral(fallback.name, fallback.symbol, amountUsd);
    return;
  }

  for (const reserve of positiveCandidates) {
    addCollateral(reserve.name, reserve.name, amountUsd * (reserve.pct / totalPct));
  }
}
```

Then:

- Replace `applyReservesToRemainder()` with `allocateReserveCollateral(..., { excludeStablecoinSlices: true })`.
- Replace the direct reserve-only loop at `src/lib/portfolio-analysis.ts:233-241` with `allocateReserveCollateral(reserves, holding.amount, backing)`.
- Keep `addCollateral()`'s `$0.01` dust filter.
- Do not add a logging path here; invalid curated data should be caught by `A4`, and the user-facing calculator should degrade deterministically.

### Tests to add/update

Add `src/lib/__tests__/portfolio-analysis.test.ts`.

Because `PORTFOLIO_META_BY_ID` is built at module load from `ACTIVE_STABLECOINS`, use module mocking for synthetic reserve fixtures:

```ts
vi.resetModules();
vi.doMock("@shared/lib/stablecoins", () => ({
  ACTIVE_STABLECOINS: [
    {
      id: "synthetic-zero",
      name: "Synthetic Zero",
      symbol: "SZERO",
      flags: { backing: "rwa-backed" },
      reserves: [
        { name: "Treasury Bills", pct: 0, risk: "very-low" },
        { name: "Cash", pct: 0, risk: "very-low" },
      ],
    },
  ],
}));
const { computeUpstreamExposure } = await import("../portfolio-analysis");
```

Specific test cases:

- `computeUpstreamExposure` falls back to `Real-World Assets (RWA)` for reserve-only holdings when all reserve pct values are `0`.
- Mixed zero and nonzero reserve slices allocate only across positive slices and never emit non-finite `usd` or `pct`.
- Remainder path with dependencies plus stablecoin-like reserve slices falls back to the backing-level collateral bucket when filtering leaves no non-stable candidates.
- Unknown metadata still uses the existing backing fallback and returns finite values.
- Add a generic assertion helper:

```ts
function expectFiniteExposure(rows: UpstreamExposure[]) {
  for (const row of rows) {
    expect(Number.isFinite(row.usd)).toBe(true);
    expect(Number.isFinite(row.pct)).toBe(true);
  }
}
```

### Validation commands

```bash
npm test -- src/lib/__tests__/portfolio-analysis.test.ts src/__tests__/portfolio-categorize.test.ts
npm run lint
npm run typecheck
```

### Rollout risks

- Low behavioral risk: fallback bucket output changes only for zero/invalid reserve pct shapes, which current curated data does not contain.
- Medium test brittleness risk if module-level mocking leaks between cases. Use `vi.resetModules()` and `vi.doUnmock()`/`vi.unmock()` in `afterEach`.

## A2 - Normalize Portfolio Amount Semantics Across URL, Storage, and Live Actions

Finding coverage: `Q2`, `C1`

Impact: Medium

Effort: Medium

Dependencies: `A1` preferred, because exposure tests should assert finite outputs after amount normalization.

### Current locations

- `src/lib/portfolio-codec.ts:13-30` (`parsePortfolioUrlParam`)
- `src/lib/portfolio-codec.ts:32-42` (`encodePortfolioHoldings`)
- `src/lib/portfolio-codec.ts:44-77` (`migratePortfolioIds`)
- `src/lib/portfolio-codec.ts:79-86` (`isPortfolioHolding`)
- `src/hooks/use-portfolio.ts:49-76` storage load/save
- `src/hooks/use-portfolio.ts:116-130` `addCoin` / `setAmount`
- `src/app/portfolio/client.tsx:100-103` (`parseUsdInput`)
- `src/app/portfolio/client.tsx:440-443` initial add path

### Current problem

Amount acceptance differs by entry point:

- URL parser accepts only finite positive amounts.
- Storage type guard requires `amount > 0` but does not require `Number.isFinite`.
- Live `addCoin` and `setAmount` accept any `number`, including `0`, `NaN`, and `Infinity`.
- UI creates zero-amount draft holdings by design, but those drafts are not round-trip stable through URL/storage parsing.

### Proposed behavior

Canonical portfolio holding invariant:

```ts
coinId: known canonical stablecoin ID
amount: finite number >= 0
```

Invalid amount behavior:

- URL/storage parsing: drop invalid holdings.
- `addCoin`: ignore invalid negative/non-finite amount; allow zero.
- `setAmount`: if amount is negative/non-finite, set to `0` or ignore. Recommended choice: set to `0` only through the UI parser and ignore invalid programmatic calls in the hook. This prevents accidental corruption while keeping user input clearing behavior explicit.
- Encoding: encode only normalized holdings. Zero holdings are encoded so draft selections share/reload consistently.

### Proposed code-level change

In `src/lib/portfolio-codec.ts`, add:

```ts
export function normalizePortfolioAmount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

export function normalizePortfolioHolding(value: unknown): PortfolioHolding | null {
  if (typeof value !== "object" || value === null) return null;
  const coinId = (value as { coinId?: unknown }).coinId;
  const amount = normalizePortfolioAmount((value as { amount?: unknown }).amount);
  if (typeof coinId !== "string" || amount === null) return null;
  const migrated = migratePortfolioIds([{ coinId, amount }]);
  return migrated[0] ?? null;
}
```

Refinements needed while implementing:

- Avoid recursion between `normalizePortfolioHolding()` and `migratePortfolioIds()`. If needed, split ID canonicalization into a private helper:

```ts
function canonicalPortfolioCoinId(coinId: string): string | null {
  return (REGISTRY_BY_ID.get(coinId) ?? REGISTRY_BY_LLAMA_ID.get(coinId))?.id ?? null;
}
```

- Rework `migratePortfolioIds()` so it:
  - canonicalizes IDs through `canonicalPortfolioCoinId()`,
  - drops invalid amounts,
  - merges duplicates,
  - keeps zero amounts.
- Rework `isPortfolioHolding()` to use `normalizePortfolioHolding(value) !== null`.
- Rework `parsePortfolioUrlParam()` to decode token, canonicalize ID, parse amount with `Number(amountRaw)`, and keep finite `>= 0`.
- Rework `encodePortfolioHoldings()` to normalize/migrate first, then encode, filtering any invalid rows.

In `src/hooks/use-portfolio.ts`:

- Import `normalizePortfolioAmount` / `normalizePortfolioHolding`.
- In `loadFromStorage()`, replace `parsed.filter(isPortfolioHolding)` with `parsed.map(normalizePortfolioHolding).filter(...)`.
- Save migrated normalized holdings back when storage had invalid rows or legacy IDs.
- In `addCoin`, normalize `{ coinId, amount }` before adding; if normalization returns `null`, return previous state.
- In `setAmount`, normalize the amount before updating; if invalid, return previous state. The UI parser will pass `0` for cleared invalid text, so user clearing still works.
- Keep duplicate prevention.

In `src/app/portfolio/client.tsx`:

- Replace `parseUsdInput()` with stricter input parsing backed by `normalizePortfolioAmount`.
- Suggested parser:

```ts
function parseUsdInput(raw: string): number {
  const normalized = raw.trim().replace(/[$,\s_]/g, "");
  if (!/^\d*(?:\.\d*)?$/.test(normalized)) return 0;
  const value = normalized === "" || normalized === "." ? 0 : Number(normalized);
  return normalizePortfolioAmount(value) ?? 0;
}
```

This stops `-5` from becoming `5` and stops `1.2.3` from becoming `1.2`.

### Tests to add/update

Update `src/lib/__tests__/portfolio-codec.test.ts`:

- URL parser keeps zero rows:

```ts
expect(parsePortfolioUrlParam("usdc-circle:0")).toEqual([{ coinId: "usdc-circle", amount: 0 }]);
```

- URL parser drops `Infinity`, `NaN`, negative, malformed, and unknown IDs.
- Storage helper/type guard rejects non-finite and negative values.
- `migratePortfolioIds()` merges duplicate canonical IDs while preserving zero.
- `encodePortfolioHoldings()` filters invalid rows and does not emit `Infinity` or `NaN`.
- Add explicit legacy llama ID + zero merge case.

Add `src/hooks/__tests__/use-portfolio.test.ts` with `// @vitest-environment jsdom`:

- Loads URL holdings, including zero drafts, and marks `isFromUrl=true`.
- Loads localStorage holdings, drops invalid rows, migrates legacy IDs, and writes normalized storage back.
- `addCoin("usdc-circle", 0)` creates a draft holding and `shareUrl()` includes `usdc-circle:0`.
- `setAmount("usdc-circle", Number.POSITIVE_INFINITY)` does not corrupt `totalUsd`.
- `setAmount("usdc-circle", 1234)` updates total, weighted score, and dimension scores.
- From-URL portfolios do not persist to localStorage because `usePortfolio` currently gates persistence with `!isFromUrl` at `src/hooks/use-portfolio.ts:107-112`.

Optional but useful component test: add `src/app/portfolio/client.test.tsx` after hook tests are stable.

- Mock `useReportCards`, `useLogos`, and `CoinSelector`.
- Select a coin and assert an amount row appears empty/zero.
- Type invalid input such as `-5` or `1.2.3`, blur, and assert the displayed amount remains empty/zero rather than becoming positive partial input.

### Validation commands

```bash
npm test -- src/lib/__tests__/portfolio-codec.test.ts src/hooks/__tests__/use-portfolio.test.ts
npm test -- src/app/portfolio/client.test.tsx
npm run lint
npm run typecheck
npm run build
```

### Rollout risks

- Behavior change: share URLs can now include `:0` draft holdings. This is intentional under the "zero rows are drafts" assumption.
- Behavior change: reloading after selecting a zero-amount coin can preserve the draft instead of dropping it.
- If preserving zero rows in share URLs is not desired, use a two-model approach instead: `PortfolioDraftHolding` for editor state and positive-only `PortfolioHolding` for persisted/share/computed state. That is cleaner domain modeling but larger and not recommended for the first remediation pass.

## A3 - Add Portfolio and Stress-Test Behavioral Coverage

Finding coverage: `Q7`, `C1`

Impact: Medium

Effort: Medium

Dependencies: `A1`, `A2`

### Current locations

- `src/hooks/use-portfolio.ts:101-243`
- `src/lib/portfolio-analysis.ts:180-309`
- `src/hooks/use-stress-test.ts:145-343`
- `src/hooks/__tests__/use-stress-test.test.ts:1-20`
- `src/__tests__/portfolio-categorize.test.ts:83-178`
- `src/components/stress-test-panel.tsx:47-320`

### Current problem

Existing coverage verifies categorization/grouping and query parsing, but not:

- weighted portfolio grade,
- per-dimension weighted scores,
- storage/share round-trips,
- upstream exposure,
- stress target derivation,
- grade option derivation,
- affected ID and impact sorting,
- headline/systemic-risk calculations,
- stress panel interactions.

### Proposed tests

#### Portfolio analysis tests

File: `src/lib/__tests__/portfolio-analysis.test.ts`

Add after `A1`:

- Dependency exposure aggregates stablecoin upstream dependencies by ID.
- Collateral reserve exposure falls back by backing type when no reserves are present.
- Grouped exposure recalculates percentages against total USD and keeps stablecoins before collateral.
- All rows from representative fixtures have finite `usd` and `pct`.

#### Portfolio hook tests

File: `src/hooks/__tests__/use-portfolio.test.ts`

Test fixture: build minimal `ReportCard` objects with all five dimensions and `rawInputs.dependencies`.

Cases:

- Weighted overall score excludes `overallScore: null` cards from numerator and denominator.
- Per-dimension weighted average excludes `null` dimension scores per dimension.
- Empty or total-zero portfolio returns `NR`, `portfolioScore: null`, all dimensions `null`, and empty upstream exposure.
- `shareUrl()` updates/removes `p` correctly after add/clear.
- `clearAll()` empties state and persists `[]` when not URL-sourced.
- URL-sourced state does not write to localStorage.

#### Stress hook tests

Extend `src/hooks/__tests__/use-stress-test.test.ts` and add `// @vitest-environment jsdom` if using `renderHook`.

Test fixture:

- `upstream` card with high score and no dependencies.
- `dependent-a` with dependency on `upstream`.
- `dependent-b` with dependency on `dependent-a` to exercise transitive recomputation.
- `independent` with no dependencies.
- `dependencyGraph.edges` matching `rawInputs.dependencies`.
- Full `ReportCardsResponse` envelope fields required by the type: `cards`, `methodology`, `dependencyGraph`, and `updatedAt`. The hook does not use every methodology field directly, but typed fixtures should still include them to avoid cast-heavy tests.
- `mcapMap` with deterministic market caps.

Cases:

- `targetableCoins` includes upstream IDs from `dependencyGraph.edges`, sorted by dependent count.
- `gradeOptions` contains only grades below the target coin's current grade.
- `setTarget()` resets `targetGrade` to `null`.
- `setGrade()` produces `stressedCards`, non-empty `impacts`, and `allAffectedIds` when the target has dependents.
- `impacts` are sorted by absolute delta descending.
- `headline.totalAtRisk` sums only impacted IDs from `mcapMap`; `headline.totalSupply` sums all `mcapMap`.
- `systemicRisks` sorts by `dependentSupplyAtRisk` and excludes the target coin's own market cap from `dependentSupplyAtRisk`.
- No-data state returns empty arrays/sets and `headline: null`.

#### Stress panel component test

Add `src/components/__tests__/stress-test-panel.test.tsx`.

Cases:

- Collapsed panel expands on header click and renders target/grade selects.
- Grade select is disabled until `targetCoinId` exists.
- Changing target select calls `stressTest.setTarget(id)`.
- Changing grade select calls `stressTest.setGrade(grade)`.
- Clicking "Run" in the systemic risk list calls `setTarget(risk.coinId)` then `setGrade("D")`.

### Validation commands

```bash
npm test -- src/lib/__tests__/portfolio-analysis.test.ts src/hooks/__tests__/use-portfolio.test.ts src/hooks/__tests__/use-stress-test.test.ts src/components/__tests__/stress-test-panel.test.tsx
npm test -- src/lib/__tests__/portfolio-codec.test.ts src/__tests__/portfolio-categorize.test.ts
npm run lint
npm run typecheck
npm run build
```

Optional focused coverage check without global threshold:

```bash
npx vitest run --coverage --coverage.thresholds.lines=0 src/lib/__tests__/portfolio-codec.test.ts src/lib/__tests__/portfolio-analysis.test.ts src/hooks/__tests__/use-portfolio.test.ts src/hooks/__tests__/use-stress-test.test.ts src/components/__tests__/stress-test-panel.test.tsx
```

### Rollout risks

- Tests around `computeStressedGrades()` can become brittle if they assert exact final scores without owning the scoring fixture carefully. Prefer exact assertions for simple fixture math, and broader assertions (`affected IDs`, sorted order, finite scores) where the exact grade depends on shared methodology weights.
- Hook tests need `window.history.replaceState()` and `localStorage.clear()` isolation in `beforeEach`.

## A4 - Tighten Stablecoin Numeric Schemas and Aggregate Data Checks

Finding coverage: `Q3`, `C1`

Impact: Medium

Effort: Medium

Dependencies: can run in parallel with `A1`, but should merge after test strategy is agreed.

### Current locations

- `shared/lib/stablecoins/schema.ts:54-58` (`ContractDeploymentAssetSchema`)
- `shared/lib/stablecoins/schema.ts:60-64` (`DependencyWeightAssetSchema`)
- `shared/lib/stablecoins/schema.ts:66-73` (`ReserveSliceAssetSchema`)
- `shared/lib/stablecoins/schema.ts:119` (`commodityOunces`)
- `scripts/check-stablecoin-data.ts:86-139`
- Tests: `shared/lib/__tests__/stablecoins.test.ts`

### Current problem

The schema accepts numeric type only:

- `decimals: z.number()`
- `weight: z.number()`
- `pct: z.number()`
- `commodityOunces: z.number().optional()`

That accepts negative numbers and non-domain values at the curated-data boundary.

### Proposed code-level change

In `shared/lib/stablecoins/schema.ts`, introduce named numeric schemas for readability:

```ts
const ContractDecimalsSchema = z.number().finite().int().min(0).max(255);
const DependencyWeightNumberSchema = z.number().finite().positive().max(1);
const ReservePctSchema = z.number().finite().positive().max(100);
const CommodityOuncesSchema = z.number().finite().positive();
```

Apply them:

```ts
const ContractDeploymentAssetSchema = z.object({
  chain: z.string(),
  address: z.string(),
  decimals: ContractDecimalsSchema,
}).strict();

const DependencyWeightAssetSchema = z.object({
  id: z.string(),
  weight: DependencyWeightNumberSchema,
  type: z.enum(DEPENDENCY_TYPE_VALUES).optional(),
}).strict();

const ReserveSliceAssetSchema = z.object({
  name: z.string(),
  pct: ReservePctSchema,
  ...
}).strict();

commodityOunces: CommodityOuncesSchema.optional(),
```

In `scripts/check-stablecoin-data.ts`, add aggregate semantic checks after schema parsing:

```ts
function getNumericSemanticIssues(coin: StablecoinMeta): string[] {
  const issues: string[] = [];
  const reserveTotal = coin.reserves?.reduce((sum, reserve) => sum + reserve.pct, 0) ?? null;
  if (reserveTotal !== null) {
    if (reserveTotal <= 0) issues.push("reserve pct total must be > 0");
    if (Math.abs(reserveTotal - 100) > 0.5 && !RESERVE_TOTAL_ALLOWLIST.has(coin.id)) {
      issues.push(`reserve pct total ${reserveTotal} is outside 100 +/- 0.5; document intentional overcollateralization`);
    }
  }
  const dependencyTotal = coin.dependencies?.reduce((sum, dependency) => sum + dependency.weight, 0) ?? null;
  if (dependencyTotal !== null && dependencyTotal <= 0) {
    issues.push("dependency weight total must be > 0");
  }
  return issues;
}
```

Add a local constant:

```ts
const RESERVE_TOTAL_ALLOWLIST = new Set<string>([
  // Add coin IDs here only when reserve totals intentionally differ from 100.
]);
```

Rationale: `scoreDependencyRisk()` can normalize dependency totals greater than `1`, so only per-weight bounds and positive aggregate are necessary for dependencies. Reserve totals are display/modeling percentages and current curated data is exactly 100; deviations should be reviewed explicitly.

### Tests to add/update

Update `shared/lib/__tests__/stablecoins.test.ts`:

- `parseStablecoinMetaAssets()` rejects `contracts[0].decimals = -1`.
- Rejects non-integer decimals such as `6.5`.
- Accepts `decimals = 0`.
- Rejects `dependencies[0].weight = 0`.
- Rejects `dependencies[0].weight = 1.01`.
- Rejects `reserves[0].pct = 0`.
- Rejects `reserves[0].pct = -1`.
- Rejects `commodityOunces = 0`.
- Keeps existing real JSON registry assets loading through the schemas.

Add or update `scripts/__tests__/check-stablecoin-data.test.ts` if script helper functions can be exported without running the CLI at import time. If not, first refactor the script minimally:

- Move pure helpers into `scripts/lib/stablecoin-data-validation.ts`.
- Keep `scripts/check-stablecoin-data.ts` as thin CLI.
- Test the pure helper for reserve total outside tolerance and allowlisted total.

Recommended if keeping changes surgical: avoid a script refactor in the first pass and rely on `npm run check:stablecoin-data` plus schema tests. Add helper-unit tests only if aggregate validation becomes nontrivial.

### Validation commands

```bash
npm run check:stablecoin-data
npm test -- shared/lib/__tests__/stablecoins.test.ts
npm run lint
npm run typecheck
```

If script helpers are extracted:

```bash
npm test -- scripts/__tests__/check-stablecoin-data.test.ts
```

### Rollout risks

- Tightening schemas can fail at import time if any checked-in JSON violates the new constraints. Current data research found no invalid values for the proposed per-field bounds.
- Reserve-total aggregate checks are policy-bearing. If strict `100 +/- 0.5` is considered too opinionated, reduce the first implementation to `total > 0` and add a follow-up for reserve-total policy.
- Schema error messages will change. Existing tests only require readable labels, so this is low risk.

## A5 - Validation and Release Checklist

Finding coverage: `C1`

Impact: Medium

Effort: Small

Dependencies: `A1` through `A4`

### Required local validation before claiming remediation complete

```bash
npm test -- src/lib/__tests__/portfolio-codec.test.ts src/lib/__tests__/portfolio-analysis.test.ts src/hooks/__tests__/use-portfolio.test.ts src/hooks/__tests__/use-stress-test.test.ts src/components/__tests__/stress-test-panel.test.tsx src/__tests__/portfolio-categorize.test.ts shared/lib/__tests__/stablecoins.test.ts
npm run check:stablecoin-data
npm run lint
npm run typecheck
npm run build
```

Recommended broader validation:

```bash
npm test
npm run coverage:critical
npm run check:unused-code
npm run check:shared-cycles
npm run check:worker-boundary
npm run test:merge-gate
```

`npm run build` is included in the required list because the likely implementation touches `src/app/portfolio/client.tsx`, which is Pages-impacting frontend code. If an implementer splits `A4` into a schema-only PR, `npm run build` can be deferred for that schema-only PR, but the combined `C1` remediation should run it.

### Documentation decision

No public methodology version bump appears necessary if:

- stress-test scoring semantics do not change,
- report-card methodology does not change,
- stablecoin data-source semantics do not change,
- portfolio UI behavior only becomes internally consistent around draft zero rows.

Update docs only if the implementation chooses a user-visible semantic change, for example positive-only persisted holdings with separate drafts or a changed stress-test methodology.

## Prioritized Task Breakdown

| Order | Task | Action | Files | Effort | Depends On |
| --- | --- | --- | --- | --- | --- |
| 1 | `A1` | Add guarded reserve allocation and finite exposure tests | `src/lib/portfolio-analysis.ts`, `src/lib/__tests__/portfolio-analysis.test.ts` | Small/Medium | None |
| 2 | `A2` | Add shared portfolio normalization and wire URL/storage/live/UI to it | `src/lib/portfolio-codec.ts`, `src/hooks/use-portfolio.ts`, `src/app/portfolio/client.tsx`, tests | Medium | `A1` preferred |
| 3 | `A3` | Add portfolio hook and stress hook/panel behavioral coverage | `src/hooks/__tests__/use-portfolio.test.ts`, `src/hooks/__tests__/use-stress-test.test.ts`, `src/components/__tests__/stress-test-panel.test.tsx` | Medium | `A1`, `A2` |
| 4 | `A4` | Tighten stablecoin numeric schemas and aggregate validator checks | `shared/lib/stablecoins/schema.ts`, `scripts/check-stablecoin-data.ts`, tests | Medium | None |
| 5 | `A5` | Run targeted plus broader validation, decide docs | command-only | Small | `A1`-`A4` |

## Open Questions

1. Should zero-amount holdings be shareable/persisted draft rows? This plan assumes yes because the current UI creates zero rows intentionally. If no, implementation should introduce a separate draft-row model and keep persisted/share holdings positive-only.
2. How strict should reserve aggregate totals be? This plan recommends `100 +/- 0.5` with an explicit allowlist for intentional exceptions. A less policy-bearing first step is only `total > 0`.
3. Should `setAmount()` ignore invalid programmatic values or coerce them to `0`? This plan recommends ignoring invalid programmatic values and using the UI parser to explicitly pass `0` for cleared/invalid user text.
4. Should component-level portfolio tests be included in the first remediation PR? Hook and codec tests cover the core risk; a route-level `PortfolioClient` test is useful but can increase mocking overhead.

## Self-Review Against Request

- Exact files/functions: included in each task.
- Proposed code-level changes: included for `A1`, `A2`, and `A4`; test-level details included for `A3`.
- Tests to add/update: included with concrete filenames and scenarios.
- Validation commands: included per task and final checklist.
- Rollout risks: included per task.
- Dependencies between tasks: included in finding map and prioritized breakdown.
- Effort estimates: included per task.
- Open questions: included.
- Product code edits: none made in this planning pass.

## Plan Review Loop

Review pass 1 found two minor issues:

- The frontend-touching validation path did not require `npm run build`.
- The stress-hook fixture description did not explicitly call out the full `ReportCardsResponse` envelope.

Both were patched in this note. Review pass 2 found no remaining blocking issues and one acceptable minor ambiguity: the zero-draft persistence choice remains an explicit open question because it is a product semantics decision, not a plan defect.
