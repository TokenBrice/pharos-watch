# Active Depeg Grade Cap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure catastrophic active depegs produce F grades by steepening the peg multiplier exponent and adding graduated overall-score caps for severe active depegs.

**Architecture:** Two changes: (1) raise `PEG_MULTIPLIER_EXPONENT` from 0.2 to 0.4 so peg stability has more meaningful impact on all grades, (2) add `activeDepegBps` option to `computeOverallGrade` that hard-caps overall score at D (49) for active depegs >= 1000 bps and F (39) for >= 2500 bps. The active depeg bps is threaded through `RawDimensionInputs` so `computeStressedGrades` and frontend re-computations can apply the same cap.

**Tech Stack:** TypeScript, Vitest, shared/lib runtime-neutral modules

---

### Task 1: Bump safety score version

**Files:**
- Modify: `shared/lib/safety-score-version-data.ts:3-4`

- [ ] **Step 1: Add changelog entry and bump version**

Add a new entry at the top of the changelog array and update `currentVersion`:

```ts
export const SAFETY_SCORE_VERSION_CONFIG: MethodologyVersionConfig = {
  currentVersion: "6.93",
  changelogPath: "/methodology/scoring-changelog/",
  changelog: [
    {
      version: "6.93",
      title: "Steeper peg multiplier + active depeg grade cap",
      date: "2026-04-05",
      effectiveAt: 1775433600,
      summary:
        "Peg multiplier exponent raised from 0.2 to 0.4 so peg stability impacts grades more meaningfully. Active depegs above 1000 bps now cap the overall score at D; above 2500 bps caps at F.",
      impact: [
        "PEG_MULTIPLIER_EXPONENT changed from 0.2 to 0.4 — coins with pegScore 80+ see ~1-5% more reduction; coins with pegScore < 30 see 19-34% more reduction",
        "New graduated active depeg cap: >= 2500 bps (25%) caps overall at 39 (F), >= 1000 bps (10%) caps overall at 49 (D)",
        "Active depeg severity (activeDepegBps) added to RawDimensionInputs for reproducibility in stressed grades and frontend",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "6.92",
```

- [ ] **Step 2: Commit**

```bash
git add shared/lib/safety-score-version-data.ts
git commit -m "chore: bump safety score version to 6.93 for depeg cap"
```

---

### Task 2: Raise PEG_MULTIPLIER_EXPONENT and add depeg cap constants

**Files:**
- Modify: `shared/lib/report-card-core.ts:14`

- [ ] **Step 1: Write failing test for new exponent value**

In `shared/lib/__tests__/report-cards.test.ts`, add a test that imports `PEG_MULTIPLIER_EXPONENT` and asserts the new value:

```ts
import {
  scoreLiquidity,
  scoreToGrade,
  computeOverallGrade,
  computeStressedGrades,
  scoreDependencyRisk,
  scoreResilience,
  scoreDecentralization,
  chainInfraScore,
  getBlacklistStatusLabel,
  isBlacklistable,
  enrichLiveSlicesForBlacklist,
  GRADE_THRESHOLDS,
  resolveBlacklistStatuses,
  PEG_MULTIPLIER_EXPONENT,
} from "../report-cards";
```

Then add:

```ts
describe("PEG_MULTIPLIER_EXPONENT", () => {
  it("is 0.4", () => {
    expect(PEG_MULTIPLIER_EXPONENT).toBe(0.4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/ahirice/Documents/git/stablecoin-dashboard && npx vitest run shared/lib/__tests__/report-cards.test.ts --reporter=verbose 2>&1 | tail -20`

Expected: FAIL — `PEG_MULTIPLIER_EXPONENT` is currently 0.2.

- [ ] **Step 3: Update the constant and add depeg cap constants**

In `shared/lib/report-card-core.ts`, change the exponent and add cap constants:

```ts
export const PEG_MULTIPLIER_EXPONENT = 0.4;
export const NO_LIQUIDITY_PENALTY = 0.9;

/** Overall score cap when an active depeg exceeds these thresholds (absolute bps). */
export const ACTIVE_DEPEG_CAP_F_BPS = 2500;
export const ACTIVE_DEPEG_CAP_D_BPS = 1000;
export const ACTIVE_DEPEG_CAP_F_SCORE = 39;
export const ACTIVE_DEPEG_CAP_D_SCORE = 49;
```

- [ ] **Step 4: Export new constants from report-cards barrel**

In `shared/lib/report-cards.ts`, add the new constants to the export list from `./report-card-core`:

```ts
export {
  METHODOLOGY_VERSION,
  DIMENSION_WEIGHTS,
  PEG_MULTIPLIER_EXPONENT,
  NO_LIQUIDITY_PENALTY,
  ACTIVE_DEPEG_CAP_F_BPS,
  ACTIVE_DEPEG_CAP_D_BPS,
  ACTIVE_DEPEG_CAP_F_SCORE,
  ACTIVE_DEPEG_CAP_D_SCORE,
  DIMENSION_LABELS,
  DIMENSION_SHORT_LABELS,
  GRADE_THRESHOLDS,
  REPORT_CARD_GRADE_COLORS,
  DIMENSION_ORDER,
  GRADE_RADAR_COLORS,
  scoreToGrade,
  gradeRange,
} from "./report-card-core";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /Users/ahirice/Documents/git/stablecoin-dashboard && npx vitest run shared/lib/__tests__/report-cards.test.ts -t "PEG_MULTIPLIER_EXPONENT" --reporter=verbose 2>&1 | tail -10`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add shared/lib/report-card-core.ts shared/lib/report-cards.ts shared/lib/__tests__/report-cards.test.ts
git commit -m "feat(scoring): raise peg multiplier exponent to 0.4, add depeg cap constants"
```

---

### Task 3: Add activeDepegBps to RawDimensionInputs

**Files:**
- Modify: `shared/types/report-cards.ts:72-97` (RawDimensionInputsSchema)
- Modify: `worker/src/lib/report-cards-snapshot.ts:356-381` (rawInputs construction)

- [ ] **Step 1: Add activeDepegBps field to the schema**

In `shared/types/report-cards.ts`, add `activeDepegBps` to `RawDimensionInputsSchema` after the `activeDepeg` field:

```ts
const RawDimensionInputsSchema = z.object({
  pegScore: z.number().nullable(),
  activeDepeg: z.boolean(),
  activeDepegBps: z.number().nullable().optional().default(null),
  depegEventCount: z.number(),
```

The field is `optional().default(null)` for wire compatibility with existing D1 snapshots that lack it.

- [ ] **Step 2: Populate activeDepegBps in worker snapshot builder**

In `worker/src/lib/report-cards-snapshot.ts`, find the `rawInputs` construction (around line 356). Add `activeDepegBps` after `activeDepeg`:

```ts
  const rawInputs: RawDimensionInputs = {
    pegScore: peg?.pegScore ?? null,
    activeDepeg: peg?.activeDepeg ?? false,
    activeDepegBps: peg?.activeDepeg && peg?.currentDeviationBps != null
      ? Math.abs(peg.currentDeviationBps)
      : null,
    depegEventCount: peg?.eventCount ?? 0,
```

- [ ] **Step 3: Run type check**

Run: `cd /Users/ahirice/Documents/git/stablecoin-dashboard && npx tsc --noEmit 2>&1 | tail -20`

Expected: no errors (optional field, existing callers unaffected).

- [ ] **Step 4: Commit**

```bash
git add shared/types/report-cards.ts worker/src/lib/report-cards-snapshot.ts
git commit -m "feat(scoring): add activeDepegBps to RawDimensionInputs"
```

---

### Task 4: Implement active depeg cap in computeOverallGrade

**Files:**
- Modify: `shared/lib/report-card-overall.ts:15-57`

- [ ] **Step 1: Write failing tests for the cap**

In `shared/lib/__tests__/report-cards.test.ts`, add a new describe block after the existing `computeOverallGrade` tests:

```ts
describe("computeOverallGrade — active depeg cap", () => {
  const makeDimension = (score: number | null) => ({
    grade: score !== null ? scoreToGrade(score) : ("NR" as const),
    score,
    detail: "test",
  });

  const highBaseDims = {
    pegStability: makeDimension(50),
    liquidity: makeDimension(90),
    resilience: makeDimension(90),
    decentralization: makeDimension(80),
    dependencyRisk: makeDimension(95),
  };

  it("caps at F (39) for active depeg >= 2500 bps", () => {
    const result = computeOverallGrade(highBaseDims as never, { activeDepegBps: 7600 });
    expect(result.score).toBeLessThanOrEqual(39);
    expect(result.grade).toBe("F");
  });

  it("caps at D (49) for active depeg >= 1000 bps but < 2500 bps", () => {
    const result = computeOverallGrade(highBaseDims as never, { activeDepegBps: 1500 });
    expect(result.score).toBeLessThanOrEqual(49);
    expect(result.grade).not.toBe("NR");
    // Grade must be D or F
    expect(["D", "F"]).toContain(result.grade);
  });

  it("does not cap for active depeg < 1000 bps", () => {
    const result = computeOverallGrade(highBaseDims as never, { activeDepegBps: 500 });
    const uncapped = computeOverallGrade(highBaseDims as never);
    expect(result.score).toBe(uncapped.score);
  });

  it("does not cap when activeDepegBps is null", () => {
    const result = computeOverallGrade(highBaseDims as never, { activeDepegBps: null });
    const uncapped = computeOverallGrade(highBaseDims as never);
    expect(result.score).toBe(uncapped.score);
  });

  it("does not cap when activeDepegBps is not provided", () => {
    const result = computeOverallGrade(highBaseDims as never);
    // Should compute normally without error
    expect(result.score).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/ahirice/Documents/git/stablecoin-dashboard && npx vitest run shared/lib/__tests__/report-cards.test.ts -t "active depeg cap" --reporter=verbose 2>&1 | tail -20`

Expected: FAIL — `computeOverallGrade` does not accept `activeDepegBps` option yet.

- [ ] **Step 3: Implement the cap in computeOverallGrade**

In `shared/lib/report-card-overall.ts`, update the imports and function signature:

```ts
import {
  DIMENSION_WEIGHTS,
  NO_LIQUIDITY_PENALTY,
  PEG_MULTIPLIER_EXPONENT,
  ACTIVE_DEPEG_CAP_F_BPS,
  ACTIVE_DEPEG_CAP_D_BPS,
  ACTIVE_DEPEG_CAP_F_SCORE,
  ACTIVE_DEPEG_CAP_D_SCORE,
  scoreToGrade,
} from "./report-card-core";
```

Update the function signature options type:

```ts
export function computeOverallGrade(
  dimensions: Record<DimensionKey, ReportCardDimension>,
  options?: { navToken?: boolean; activeDepegBps?: number | null },
): { grade: ReportCardGrade; score: number | null; baseScore: number | null; ratedDimensions: number } {
```

After the existing liquidity penalty block (line 51) and before the final clamping, add the cap:

```ts
  if (dimensions.liquidity.score === null) {
    score *= NO_LIQUIDITY_PENALTY;
  }

  // Active depeg cap: hard-cap overall score for severe ongoing depegs
  const depegBps = options?.activeDepegBps;
  if (depegBps != null) {
    if (depegBps >= ACTIVE_DEPEG_CAP_F_BPS) {
      score = Math.min(score, ACTIVE_DEPEG_CAP_F_SCORE);
    } else if (depegBps >= ACTIVE_DEPEG_CAP_D_BPS) {
      score = Math.min(score, ACTIVE_DEPEG_CAP_D_SCORE);
    }
  }

  const clamped = Math.max(0, Math.min(100, Math.round(score)));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/ahirice/Documents/git/stablecoin-dashboard && npx vitest run shared/lib/__tests__/report-cards.test.ts -t "active depeg cap" --reporter=verbose 2>&1 | tail -20`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add shared/lib/report-card-overall.ts shared/lib/__tests__/report-cards.test.ts
git commit -m "feat(scoring): add active depeg grade cap to computeOverallGrade"
```

---

### Task 5: Thread activeDepegBps through worker snapshot and stressed grades

**Files:**
- Modify: `worker/src/lib/report-cards-snapshot.ts:354` (pass option to computeOverallGrade)
- Modify: `shared/lib/report-card-overall.ts:93-101` (computeStressedGrades affected-coin recomputation)

- [ ] **Step 1: Pass activeDepegBps to computeOverallGrade in worker snapshot**

In `worker/src/lib/report-cards-snapshot.ts`, update the `computeOverallGrade` call (around line 354):

```ts
  const navToken = !!meta.flags.navToken;
  const activeDepegBps = peg?.activeDepeg && peg?.currentDeviationBps != null
    ? Math.abs(peg.currentDeviationBps)
    : null;
  const overall = computeOverallGrade(dimensions, { navToken, activeDepegBps });
```

- [ ] **Step 2: Thread activeDepegBps in computeStressedGrades**

In `shared/lib/report-card-overall.ts`, update the `computeStressedGrades` recomputation for affected cards to pass the cap through:

```ts
    if (affectedIds.has(card.id)) {
      const meta = {
        flags: { governance: card.rawInputs.governanceTier },
        dependencies: card.rawInputs.dependencies,
        reserves: undefined,
      };
      const dependencyRisk = scoreDependencyRisk(meta, overallScores);
      const dimensions = { ...card.dimensions, dependencyRisk };
      const overall = computeOverallGrade(dimensions, {
        navToken: card.rawInputs.navToken,
        activeDepegBps: card.rawInputs.activeDepegBps ?? null,
      });
```

- [ ] **Step 3: Run type checks**

Run: `cd /Users/ahirice/Documents/git/stablecoin-dashboard && npx tsc --noEmit 2>&1 | tail -10 && cd worker && npx tsc --noEmit 2>&1 | tail -10`

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add worker/src/lib/report-cards-snapshot.ts shared/lib/report-card-overall.ts
git commit -m "feat(scoring): thread activeDepegBps through snapshot and stressed grades"
```

---

### Task 6: Fix existing tests for exponent change

The exponent change from 0.2 to 0.4 will shift expected scores in existing tests. Update them.

**Files:**
- Modify: `shared/lib/__tests__/report-cards.test.ts` (computeOverallGrade tests)
- Modify: `src/lib/__tests__/report-cards.test.ts` (computeOverallGrade no-liquidity test)

- [ ] **Step 1: Run all report-card tests to identify failures**

Run: `cd /Users/ahirice/Documents/git/stablecoin-dashboard && npx vitest run --reporter=verbose 2>&1 | grep -E "(FAIL|PASS|✓|×|expected|received)" | head -40`

Identify which tests fail due to the exponent change. The key tests that compare exact scores:
- `src/lib/__tests__/report-cards.test.ts`: the no-liquidity penalty test compares ratio — this should still pass since the ratio is `NO_LIQUIDITY_PENALTY` regardless of exponent.
- `shared/lib/__tests__/report-cards.test.ts`: the `computeStressedGrades` test checks `stressedDependent.overallScore < dependent.overallScore` — relative comparison, should still pass.

- [ ] **Step 2: Fix any failing tests**

Update exact expected values if any assertions on absolute scores fail. The relative comparisons (`.toBeLessThan`, `.toBeGreaterThan`) should be stable since the exponent affects all equally.

- [ ] **Step 3: Run full test suite**

Run: `cd /Users/ahirice/Documents/git/stablecoin-dashboard && npm test 2>&1 | tail -20`

Expected: all tests pass.

- [ ] **Step 4: Commit if any fixes were needed**

```bash
git add -u
git commit -m "test: update expected values for peg multiplier exponent 0.4"
```

---

### Task 7: Update methodology page prose

**Files:**
- Modify: `src/app/methodology/sections/core/safety-scores-section.tsx:221-227`

- [ ] **Step 1: Update exponent and penalty description**

In `src/app/methodology/sections/core/safety-scores-section.tsx`, find the peg multiplier section (around line 221-227) and update:

```tsx
                  <h3 className="text-foreground font-medium">Peg Stability Multiplier</h3>
                  <p>
                    After computing the base score, peg stability is applied as a power-curve multiplier:
                    final&nbsp;=&nbsp;base&nbsp;&times;&nbsp;(pegScore&nbsp;/&nbsp;100)<sup>0.40</sup>. Coins with strong
                    pegs (90+) are barely affected (~4% penalty), while coins with broken pegs are sharply penalized (e.g.
                    pegScore&nbsp;10 &rarr; 60% penalty). NAV tokens (pegScore&nbsp;=&nbsp;NR) receive multiplier&nbsp;1.0
                    since peg tracking does not apply to them.
                  </p>
                  <p>
                    Additionally, coins with a severe active depeg are hard-capped: depegs &ge;&nbsp;2500&nbsp;bps
                    (25%+ off peg) cap the overall score at F, and depegs &ge;&nbsp;1000&nbsp;bps (10%+) cap at D,
                    regardless of how strong other dimensions are.
                  </p>
```

- [ ] **Step 2: Commit**

```bash
git add src/app/methodology/sections/core/safety-scores-section.tsx
git commit -m "docs(methodology): update peg multiplier prose for v6.93"
```

---

### Task 8: Final validation

- [ ] **Step 1: Run full test suite**

Run: `cd /Users/ahirice/Documents/git/stablecoin-dashboard && npm test 2>&1 | tail -20`

Expected: all pass.

- [ ] **Step 2: Run lint**

Run: `cd /Users/ahirice/Documents/git/stablecoin-dashboard && npm run lint 2>&1 | tail -10`

Expected: clean.

- [ ] **Step 3: Run frontend type check**

Run: `cd /Users/ahirice/Documents/git/stablecoin-dashboard && npx tsc --noEmit 2>&1 | tail -10`

Expected: no errors.

- [ ] **Step 4: Run worker type check**

Run: `cd /Users/ahirice/Documents/git/stablecoin-dashboard/worker && npx tsc --noEmit 2>&1 | tail -10`

Expected: no errors.

- [ ] **Step 5: Run build**

Run: `cd /Users/ahirice/Documents/git/stablecoin-dashboard && npm run build 2>&1 | tail -20`

Expected: successful build.

- [ ] **Step 6: Spot-check USR scenario**

Quick mental verification:
- USR: base score ~60, pegScore 13, active depeg -7579 bps
- Exponent 0.4: 60 x (13/100)^0.4 = 60 x 0.44 = 26
- Cap: 7579 >= 2500 -> cap at 39
- Final: min(26, 39) = 26 -> **F** (correct)
