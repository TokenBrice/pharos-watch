# Score Explainability — Progressive Disclosure

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Surface the "why" behind DEWS, Liquidity, and Report Card scores using progressive disclosure — collapsed by default, expandable on demand — so power users can interrogate scores without overwhelming casual visitors.

**Architecture:** The data already exists in the pipeline. DEWS sub-signals are persisted as `signals_json` and returned via the `/api/stress-signals` endpoint. Liquidity sub-components are persisted as `score_components_json` and returned via the `/api/dex-liquidity` endpoint as `scoreComponents`. The only missing data point is the report card base score (before peg multiplier), which is computed transiently in `computeOverallGrade()` but not returned. The work is: (1) expose base score in report card output, (2) build three small expandable breakdown panels in the frontend, (3) fill methodology page gaps.

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4, shadcn/ui, shared/lib scoring modules

**Design principle — progressive disclosure, not information flooding:**
- All breakdown panels are **collapsed by default** using `<details>` elements (same pattern as methodology page's `<MethodologyDetails>`)
- The trigger is a small "Show breakdown" text link beneath the existing score, not a button or icon
- Breakdown content uses a compact horizontal bar + label format, not verbose paragraphs
- No tooltips, popovers, or modals — just inline expansion that pushes content down

---

### Task 1: Expose base score in report card output

**Files:**
- Modify: `shared/lib/report-cards.ts` (line ~680, `computeOverallGrade`)
- Modify: `shared/types/report-card.ts` (or wherever `ReportCard` / `OverallGrade` type is defined)
- Test: `worker/src/lib/__tests__/report-cards-snapshot.test.ts`

**Context:**
Currently `computeOverallGrade()` computes `base` (weighted average of 4 non-peg dimensions) at line ~660, applies peg multiplier at line ~679 (`final = base * (pegScore/100)^0.20`), then applies no-liquidity penalty at ~689. Only `final` is returned as `overallScore`. We need to also return `baseScore` (before peg multiplier) so the frontend can show "Base: 78 -> Final: 74 (peg penalty: 4pts)".

**Step 1: Add `baseScore` to the return type**

In the type definition for the overall grade result (check exact location — likely in `shared/types/` or inline in `report-cards.ts`), add:

```typescript
baseScore: number;  // weighted average before peg multiplier and no-liquidity penalty
```

**Step 2: Return `baseScore` from `computeOverallGrade()`**

In `computeOverallGrade()`, the `base` variable already exists at line ~660. After computing `final`, include `baseScore: Math.round(base * 10) / 10` in the return object alongside `overallScore`.

**Step 3: Update snapshot tests**

Existing snapshot tests in `report-cards-snapshot.test.ts` will fail because the output shape changed. Update snapshots to include the new `baseScore` field.

**Step 4: Run tests**

Run: `npm test -- --run report-cards`
Expected: All tests pass with updated snapshots.

**Step 5: Commit**

```bash
git add shared/lib/report-cards.ts shared/types/ worker/src/lib/__tests__/report-cards-snapshot.test.ts
git commit -m "feat(report-cards): expose baseScore before peg multiplier"
```

---

### Task 2: Report card peg multiplier breakdown panel

**Files:**
- Modify: `src/components/report-card.tsx` (lines ~76-90, overall grade display area)

**Context:**
The report card component already shows the overall grade + numeric score. Below this, we add a collapsed `<details>` element showing the peg multiplier impact. The `dews-detail.tsx` component already implements a similar pattern with signal breakdowns and progress bars — reference that for style consistency.

The component receives `reportCard` which contains `overallScore` (final) and now `baseScore` (pre-multiplier). The peg dimension's score is available as `reportCard.dimensions.pegStability.score`.

**Step 1: Add the breakdown panel**

Below the existing overall score display (around line ~87), add:

```tsx
{reportCard.baseScore != null && reportCard.dimensions.pegStability.score != null && (
  <details className="mt-2 text-xs text-muted-foreground">
    <summary className="cursor-pointer hover:text-foreground transition-colors">
      Show score breakdown
    </summary>
    <div className="mt-2 space-y-1.5 pl-1">
      <div className="flex items-center justify-between">
        <span>Base score (weighted dimensions)</span>
        <span className="font-mono">{reportCard.baseScore.toFixed(1)}</span>
      </div>
      <div className="flex items-center justify-between">
        <span>Peg multiplier ({reportCard.dimensions.pegStability.score.toFixed(0)}/100)</span>
        <span className="font-mono">
          {reportCard.baseScore !== reportCard.overallScore
            ? `−${(reportCard.baseScore - reportCard.overallScore).toFixed(1)}pts`
            : "none"}
        </span>
      </div>
      <div className="flex items-center justify-between font-medium text-foreground">
        <span>Final score</span>
        <span className="font-mono">{reportCard.overallScore.toFixed(1)}</span>
      </div>
    </div>
  </details>
)}
```

**Step 2: Verify in dev**

Run: `npm run dev`
Navigate to any stablecoin detail page (e.g., `/stablecoin/tether`). Verify:
- "Show score breakdown" appears below the overall score
- Clicking it expands to show base score, peg multiplier impact, final score
- Collapsing it hides the breakdown
- Layout doesn't shift other elements

**Step 3: Commit**

```bash
git add src/components/report-card.tsx
git commit -m "feat(report-card): add collapsible peg multiplier breakdown"
```

---

### Task 3: Liquidity score sub-component breakdown panel

**Files:**
- Modify: `src/components/report-card.tsx` (lines ~95-156, dimension list area)
- Read first: `src/components/dews-detail.tsx` (for progress bar pattern reference)

**Context:**
The report card shows each dimension with a grade and score. For the Liquidity dimension, we add a collapsed breakdown showing the 6 sub-components. The data is available from the `/api/dex-liquidity` endpoint as `scoreComponents` — check how the coin detail page fetches liquidity data (likely via a TanStack Query hook in `src/hooks/`). The sub-components are:

| Component | Weight | Key in scoreComponents |
|-----------|--------|----------------------|
| TVL Depth | 30% | `tvlDepth` |
| Volume Activity | 20% | `volumeActivity` |
| Pool Quality | 20% | `poolQuality` |
| Durability | 15% | `durability` |
| Pair Diversity | 7.5% | `pairDiversity` |
| Cross-chain | 7.5% | `crossChain` |

**Step 1: Identify data flow**

Read the liquidity hook in `src/hooks/` (likely `use-dex-liquidity.ts` or similar) to confirm the `scoreComponents` field is available in the query response. If the report card component doesn't currently have access to liquidity sub-components, you'll need to pass them down from the coin detail page.

**Step 2: Add the breakdown panel**

Within the Liquidity dimension row in report-card.tsx, after the grade/score display, add a `<details>` element:

```tsx
{dim.key === "liquidity" && liquidityComponents && (
  <details className="mt-1.5 text-xs text-muted-foreground">
    <summary className="cursor-pointer hover:text-foreground transition-colors">
      Show components
    </summary>
    <div className="mt-2 space-y-1">
      {[
        { label: "TVL Depth", key: "tvlDepth", weight: 30 },
        { label: "Volume Activity", key: "volumeActivity", weight: 20 },
        { label: "Pool Quality", key: "poolQuality", weight: 20 },
        { label: "Durability", key: "durability", weight: 15 },
        { label: "Pair Diversity", key: "pairDiversity", weight: 7.5 },
        { label: "Cross-chain", key: "crossChain", weight: 7.5 },
      ].map(({ label, key, weight }) => {
        const value = liquidityComponents[key];
        return value != null ? (
          <div key={key} className="flex items-center gap-2">
            <span className="w-28 shrink-0">{label}</span>
            <div className="h-1.5 flex-1 rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-foreground/40"
                style={{ width: `${Math.min(100, value)}%` }}
              />
            </div>
            <span className="w-8 text-right font-mono">{value.toFixed(0)}</span>
            <span className="w-8 text-right text-muted-foreground/60">{weight}%</span>
          </div>
        ) : null;
      })}
    </div>
  </details>
)}
```

**Step 3: Pass data through**

If `report-card.tsx` doesn't currently receive liquidity sub-components, add an optional `liquidityComponents` prop and pass it from the coin detail page where the liquidity hook is called.

**Step 4: Verify in dev**

Run: `npm run dev`
Check a coin with liquidity data (e.g., `/stablecoin/tether`). Verify:
- "Show components" appears under the Liquidity dimension
- Expanding shows 6 bars with labels, mini progress bars, scores, and weights
- Coins without liquidity data don't show the trigger

**Step 5: Commit**

```bash
git add src/components/report-card.tsx src/app/stablecoin/
git commit -m "feat(report-card): add collapsible liquidity sub-component breakdown"
```

---

### Task 4: DEWS sub-signal breakdown on coin detail

**Files:**
- Read first: `src/components/dews-detail.tsx` (lines 130-151)
- Modify: `src/components/dews-detail.tsx` OR the component that shows DEWS on the coin detail page

**Context:**
Research revealed that `dews-detail.tsx` ALREADY implements sub-signal breakdowns with progress bars (lines 130-151). Verify whether this component is actually rendered on the coin detail page, and if so, whether the signal breakdown section is visible or hidden behind a condition.

**Step 1: Verify current rendering**

Read `src/app/stablecoin/[id]/client.tsx` to confirm how DEWS is shown. Check:
- Is `dews-detail.tsx` imported and rendered?
- Is the signal breakdown section conditionally hidden?
- Does the coin detail page pass the `signals` data to the component?

If DEWS sub-signals are already visible on coin detail pages, this task is done (skip to verification).

**Step 2: If signals are hidden or missing, expose them**

If the coin detail page uses a simpler DEWS widget (just score + band), either:
- Replace it with the full `<DEWSDetail>` component, or
- Add a `<details>` wrapper around the signal breakdown section

The design should match Tasks 2 and 3: collapsed by default, "Show signals" trigger, inline expansion.

**Step 3: Verify in dev**

Run: `npm run dev`
Check a coin with DEWS data. Verify:
- DEWS score and band are visible
- Sub-signal breakdown is accessible (either always visible or via expand)
- Each of the 8 signals shows: name, score, availability status

**Step 4: Commit**

```bash
git add src/components/dews-detail.tsx src/app/stablecoin/
git commit -m "feat(dews): ensure sub-signal breakdown visible on coin detail"
```

---

### Task 5: Fill methodology page gaps

**Files:**
- Modify: `src/app/methodology/page.tsx`

**Context:**
The methodology page has three documentation gaps identified by the audit:

1. **Liquidity component weights** (lines ~929-1154): The section exists but the sub-component weight table and quality multiplier examples could be more prominent
2. **Dependency ceiling logic**: Wrapper ceiling (upstream - 3), mechanism ceiling (= upstream) are in the code but not explained on the methodology page
3. **Blacklist inheritance threshold** (25%): Not mentioned on methodology page

**Step 1: Add dependency ceiling section**

In the Safety Scores section (lines ~456-924), after the dimension weights table, add a `<MethodologyDetails>` block:

```tsx
<MethodologyDetails summary="Dependency ceilings">
  <p>
    When a stablecoin depends on another (wrapper, mechanism, or collateral relationship),
    its score is capped relative to its upstream:
  </p>
  <ul className="list-disc pl-6 space-y-1 mt-2">
    <li><strong>Wrapper dependency:</strong> capped at upstream score minus 3 points</li>
    <li><strong>Mechanism dependency:</strong> capped at upstream score</li>
    <li><strong>Collateral dependency:</strong> blended into dependency risk dimension</li>
  </ul>
  <p className="mt-2">
    If any upstream scores below 75, a 10-point penalty is applied.
    These ceilings prevent a wrapped token from outscoring its underlying asset.
  </p>
</MethodologyDetails>
```

**Step 2: Add blacklist inheritance note**

In the blacklist section of the methodology page, add a brief note:

```tsx
<p>
  Stablecoins where the issuer has blacklist capability on at least 25% of
  tracked chains are flagged as having possible inherited blacklist risk.
</p>
```

**Step 3: Verify the methodology page renders correctly**

Run: `npm run dev`
Navigate to `/methodology`. Verify:
- New sections appear in the correct positions
- `<MethodologyDetails>` expand/collapse works
- No layout shifts or broken styling

**Step 4: Commit**

```bash
git add src/app/methodology/page.tsx
git commit -m "docs(methodology): add dependency ceilings and blacklist threshold"
```

---

### Task 6: Build, type-check, lint

**Step 1: Full build**

Run: `npm run build`
Expected: Clean build, no type errors.

**Step 2: Lint**

Run: `npm run lint`
Expected: No new warnings.

**Step 3: Tests**

Run: `npm test`
Expected: All tests pass.

**Step 4: Final commit if any fixes needed**

```bash
git add -A
git commit -m "chore: fix build/lint issues from explainability feature"
```
