# Dependency Type Classification with Score Ceilings — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `type` field (`wrapper` | `mechanism` | `collateral`) to dependency relationships and apply score ceilings so wrapper/mechanism-critical coins can't outscore their upstream dependencies.

**Architecture:** Extend `DependencyWeight` with an optional `type` field (default `collateral`). After the existing blended scoring, compute a ceiling from the most critical upstream dependency type and cap the score. Bump methodology version to 3.2.

**Tech Stack:** TypeScript, Next.js (static export), pure scoring functions in `src/lib/report-cards.ts`

---

### Task 1: Add `DependencyType` to the type system

**Files:**
- Modify: `src/lib/types.ts:66-69`

**Step 1: Add the type and update the interface**

In `src/lib/types.ts`, before `DependencyWeight`, add the type alias and update the interface:

```typescript
export type DependencyType = "wrapper" | "mechanism" | "collateral";

export interface DependencyWeight {
  id: string;      // DefiLlama ID of upstream stablecoin
  weight: number;  // 0-1, fraction of collateral from this source
  type?: DependencyType;  // default: 'collateral' — see docs/plans/2026-02-27-dependency-type-ceiling-design.md
}
```

**Step 2: Type-check**

Run: `npm run build`
Expected: Clean build (no consumers use `type` yet, field is optional)

**Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat(types): add DependencyType to DependencyWeight interface"
```

---

### Task 2: Add ceiling logic to `scoreDependencyRisk()`

**Files:**
- Modify: `src/lib/report-cards.ts:27` (methodology version)
- Modify: `src/lib/report-cards.ts:375-432` (scoring function)

**Step 1: Bump methodology version**

Change line 27:
```typescript
export const METHODOLOGY_VERSION = "3.2";
```

**Step 2: Add the ceiling constant and logic**

In `scoreDependencyRisk()`, the `resolved` array currently stores `{ id, weight, score }`. Extend it to include `type`:

Change line 389-393 from:
```typescript
  const resolved: { id: string; weight: number; score: number }[] = [];
  for (const dep of deps) {
    const s = overallScores.get(dep.id);
    if (s !== undefined) resolved.push({ id: dep.id, weight: dep.weight, score: s });
  }
```

To:
```typescript
  const resolved: { id: string; weight: number; score: number; type: DependencyType }[] = [];
  for (const dep of deps) {
    const s = overallScores.get(dep.id);
    if (s !== undefined) resolved.push({ id: dep.id, weight: dep.weight, score: s, type: dep.type ?? "collateral" });
  }
```

Add the `DependencyType` import at the top of the file (line 8-21) — add it to the existing import block:
```typescript
import type {
  // ... existing imports ...
  DependencyType,
} from "./types";
```

After the weak-dep penalty block (after line 420), before the `Math.round` clamp (line 422), add the ceiling logic:

```typescript
  // Ceiling: wrapper/mechanism deps cap the final score
  const WRAPPER_PENALTY = 3;
  let ceiling = Infinity;
  for (const d of resolved) {
    if (d.type === "wrapper") ceiling = Math.min(ceiling, d.score - WRAPPER_PENALTY);
    else if (d.type === "mechanism") ceiling = Math.min(ceiling, d.score);
  }
  if (ceiling < Infinity) score = Math.min(score, ceiling);
```

Update the detail text generation (lines 424-429) to include ceiling info. After the existing `parts.push` calls and before the return, add:

```typescript
  if (ceiling < Infinity) {
    const ceilingType = resolved.some(d => d.type === "wrapper") ? "wrapper" : "mechanism-critical";
    parts.push(`capped at ${Math.round(ceiling)} (${ceilingType} dependency ceiling)`);
  }
```

**Step 3: Type-check**

Run: `npm run build`
Expected: Clean build

**Step 4: Commit**

```bash
git add src/lib/report-cards.ts
git commit -m "feat(scoring): add dependency type ceiling to scoreDependencyRisk

Wrapper deps cap score at upstream-3, mechanism deps cap at upstream score.
Bumps methodology to v3.2."
```

---

### Task 3: Classify existing dependencies in `stablecoins.ts`

**Files:**
- Modify: `src/lib/stablecoins.ts` (multiple lines — each dependency entry that needs reclassification)

**Step 1: Add `type` to wrapper dependencies**

These coins are thin wrappers around their upstream — add `type: "wrapper"` to each dependency entry:

| Line | Coin | Upstream | Rationale |
|------|------|----------|-----------|
| 876 | IUSD (infiniFi) | USDC 1.0 | USDC deployed into DeFi yield strategies |
| 899 | USDF (Astherus) | USDT 1.0 | USDT held by custodian, delta-neutral strategies |
| 1083 | PUSD (Pleasing) | USDT 1.0 | 1:1 USDT mint/redeem |
| 1231 | FPI | FRAX 1.0 | 100% FRAX-collateralized |
| 2008 | UTY (XSY) | USDC 1.0 | USDC deposit, delta-neutral hedging |
| 2270 | MSUSD (Main Street) | USDC 1.0 | 1:1 USDC reserve backing |
| 2444 | OUSD (Origin) | USDC 1.0 | USDC deployed into DeFi strategies |
| 3085 | syrupUSDC | USDC 1.0 | ERC-4626 vault wrapping USDC |
| 3108 | syrupUSDT | USDT 1.0 | ERC-4626 vault wrapping USDT |
| 748 | USDAI | USDT 0.5, USDC 0.5 | Wraps stables via M0 |
| 922 | sDAI (Savings DAI) | USDT 0.5, USDC 0.5 | (check — may be wrapper of DAI, not direct USDT/USDC) |
| 3057 | PHT | USDT 0.9 | apcxUSDT wrapper in CDP vaults |

Example change for syrupUSDC (line 3085):
```typescript
    dependencies: [{ id: "2", weight: 1.0, type: "wrapper" }],
```

Example change for USDAI (line 748):
```typescript
    dependencies: [{ id: "1", weight: 0.5, type: "wrapper" }, { id: "2", weight: 0.5, type: "wrapper" }],
```

**Step 2: Add `type` to mechanism-critical dependencies**

These coins depend on their upstream for peg maintenance, even though collateral weight < 100%:

| Line | Coin | Upstream | Rationale |
|------|------|----------|-----------|
| 195 | DAI | USDC 0.35 | LitePSM is the primary peg keeper |
| 792 | FRAX | USDC 0.35 | USDC backing + AMO peg mechanism |
| 2538 | scUSD | USDC 0.7 | Heavy USDC reliance for minting |
| 2095 | (check coin at line 2095) | USDT 0.7 | If mechanism-critical |

Example change for DAI (line 195):
```typescript
    dependencies: [{ id: "2", weight: 0.35, type: "mechanism" }],
```

Example change for FRAX (line 792):
```typescript
    dependencies: [{ id: "2", weight: 0.35, type: "mechanism" }],
```

**Important:** Review each coin at the listed lines before classifying. Read the `collateral` and `pegMechanism` fields to confirm the relationship type. When unsure, leave as default (`collateral` — no `type` field needed).

**Step 3: Type-check**

Run: `npm run build`
Expected: Clean build

**Step 4: Commit**

```bash
git add src/lib/stablecoins.ts
git commit -m "data: classify dependency types (wrapper/mechanism) for ~15 stablecoins

Wrapper: syrupUSDC, syrupUSDT, IUSD, USDF, PUSD, FPI, UTY, MSUSD, OUSD, USDAI, PHT
Mechanism: DAI (PSM), FRAX (AMO)"
```

---

### Task 4: Update the report-card UI to show dependency type

**Files:**
- Modify: `src/components/report-card.tsx:148-177`

**Step 1: Add type label to the dependency callout**

The current callout at lines 149-177 lists dependencies as plain links. Update it to show the dependency type. Import `DependencyType` and show a label for non-collateral types.

In the dependency map block (line 156-172), after the `<Link>` for each dep, add a type badge when the type is not `collateral`:

Change the mapping at lines 156-172 to:

```tsx
              {card.dependencies.map((dep, i) => {
                const depMeta = TRACKED_STABLECOINS.find(
                  (s) => s.id === dep.id,
                );
                const name = depMeta?.name ?? dep.id;
                const typeLabel = dep.type === "wrapper" ? " (wrapper)"
                  : dep.type === "mechanism" ? " (mechanism-critical)"
                  : "";
                return (
                  <span key={dep.id}>
                    {i > 0 && ", "}
                    <Link
                      href={`/stablecoin/${dep.id}`}
                      className="font-medium text-blue-500 underline underline-offset-2 hover:text-blue-400 transition-colors"
                    >
                      {name}
                    </Link>
                    {typeLabel && (
                      <span className="text-xs text-blue-500/70">{typeLabel}</span>
                    )}
                  </span>
                );
              })}
```

**Step 2: Type-check**

Run: `npm run build`
Expected: Clean build

**Step 3: Commit**

```bash
git add src/components/report-card.tsx
git commit -m "feat(ui): show dependency type label in report card callout"
```

---

### Task 5: Update About page methodology docs

**Files:**
- Modify: `src/app/about/page.tsx:540-558`

**Step 1: Update the Dependency Risk Scoring section**

Replace the content at lines 540-558 to document the ceiling mechanic:

```tsx
          {/* Dependency Risk scoring */}
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Dependency Risk Scoring</h3>
            <p>
              Two-phase computation ensures upstream scores are available before dependent coins are graded.
              Phase 1 grades independent coins (centralized &amp; decentralized), then Phase 2 grades CeFi-Dependent coins using Phase 1 results.
            </p>
            <ul className="list-disc list-inside space-y-1">
              <li><span className="text-foreground">Non-dependent coins</span> &mdash; score 95 (no upstream risk)</li>
              <li>
                <span className="text-foreground">CeFi-Dependent with mapped dependencies</span> &mdash; blended score:
                each upstream&apos;s grade is weighted by its collateral fraction, and the self-backed portion (non-stablecoin collateral) scores 75.
                A &minus;10 penalty applies if any upstream dependency scores below 75
              </li>
              <li><span className="text-foreground">CeFi-Dependent, unmapped</span> &mdash; falls back to 70 when dependencies aren&apos;t mapped or scores are unavailable</li>
            </ul>
            <p className="mt-2">
              <span className="text-foreground font-medium">Dependency type ceilings</span> &mdash; each dependency is classified as <em>wrapper</em>, <em>mechanism-critical</em>, or <em>collateral</em> (default).
              Wrappers (e.g., syrupUSDC &rarr; USDC) are thin layers around the upstream &mdash; their score is capped at <code className="text-xs">upstream &minus; 3</code>.
              Mechanism-critical dependencies (e.g., DAI &rarr; USDC via PSM) are essential to the peg &mdash; score is capped at the upstream&apos;s score.
              Collateral dependencies use the blended formula with no ceiling.
            </p>
            <p className="text-xs">
              The self-backed portion scores 75 (not 95) because CeFi-Dependent coins still carry systemic coupling risk &mdash; their peg mechanisms depend on upstream stablecoin infrastructure even for non-stablecoin collateral.
            </p>
          </div>
```

**Step 2: Type-check**

Run: `npm run build`
Expected: Clean build

**Step 3: Commit**

```bash
git add src/app/about/page.tsx
git commit -m "docs(about): document dependency type ceiling methodology"
```

---

### Task 6: Update `docs/report-cards.md` documentation

**Files:**
- Modify: `docs/report-cards.md`

**Step 1: Add dependency type ceiling section**

Find the Dependency Risk section in `docs/report-cards.md` and add a subsection documenting the type classification and ceiling logic. Include the type table, ceiling formula, and examples from the design doc (`docs/plans/2026-02-27-dependency-type-ceiling-design.md`).

**Step 2: Commit**

```bash
git add docs/report-cards.md
git commit -m "docs: update report-cards.md with dependency type ceiling methodology"
```

---

### Task 7: Final verification

**Step 1: Full build**

Run: `npm run build`
Expected: Clean build with no type errors

**Step 2: Worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: Clean (worker imports `src/lib/types.ts` — the new optional field is backward-compatible)

**Step 3: Manual spot-check**

Run `npm run dev` and navigate to `/safety-scores`. Verify:
1. syrupUSDC shows "(wrapper)" in its dependency callout
2. DAI shows "(mechanism-critical)" in its dependency callout
3. USDe (collateral-only deps) shows no type label

Check the about page `/about` and verify the dependency risk methodology section includes the ceiling explanation.
