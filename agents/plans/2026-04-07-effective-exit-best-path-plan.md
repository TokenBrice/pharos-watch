# Effective Exit Best-Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the weighted-blend effective exit formula with a best-path + diversification bonus model so that a weak secondary exit path never drags down a strong primary exit.

**Architecture:** Single formula change in `computeEffectiveExitScore()` ripples through tests, version metadata, methodology docs, and the API methodology response. The function signature is unchanged — all callers are unaffected.

**Tech Stack:** TypeScript, Vitest, Next.js (methodology page JSX), Cloudflare Worker

**Spec:** `agents/specs/2026-04-07-effective-exit-best-path-design.md`

---

### Task 1: Update tests for `computeEffectiveExitScore`

**Files:**
- Modify: `shared/lib/__tests__/redemption-backstop-scoring.test.ts:8-54`

The existing `computeEffectiveExitScore` describe block (lines 8-55) tests the old blend formula. Replace it entirely with tests for the new best-path + diversification model.

- [ ] **Step 1: Replace the test block**

Replace lines 8-55 of `shared/lib/__tests__/redemption-backstop-scoring.test.ts` — the entire `describe("computeEffectiveExitScore", ...)` block — with:

```typescript
describe("computeEffectiveExitScore", () => {
  it("returns null when both inputs are null", () => {
    expect(computeEffectiveExitScore(null, null)).toBeNull();
  });

  it("returns liquidity score when only liquidity available", () => {
    expect(computeEffectiveExitScore(80, null)).toBe(80);
    expect(computeEffectiveExitScore(0, null)).toBe(0);
  });

  it("returns redemption score directly when only redemption available (no cap)", () => {
    expect(computeEffectiveExitScore(null, 90)).toBe(90);
    expect(computeEffectiveExitScore(null, 100)).toBe(100);
    expect(computeEffectiveExitScore(null, 40)).toBe(40);
    // Route family caps (65/70) are applied upstream, not here
    expect(computeEffectiveExitScore(null, 70)).toBe(70);
  });

  it("uses best path + diversification bonus when both exist", () => {
    // dex=80, redemption=60 → best=80, bonus=60*0.10=6 → 86
    expect(computeEffectiveExitScore(80, 60)).toBe(86);
    // dex=40, redemption=90 → best=90, bonus=40*0.10=4 → 94
    expect(computeEffectiveExitScore(40, 90)).toBe(94);
    // dex=51, redemption=90 → best=90, bonus=51*0.10=5.1 → 95
    expect(computeEffectiveExitScore(51, 90)).toBe(95);
  });

  it("caps effective score at 100", () => {
    // dex=95, redemption=98 → best=98, bonus=95*0.10=9.5 → 107.5 → capped at 100
    expect(computeEffectiveExitScore(95, 98)).toBe(100);
    expect(computeEffectiveExitScore(100, 100)).toBe(100);
  });

  it("is monotonic — adding any path never lowers the score", () => {
    // Strong redemption, adding weak DEX should only help
    const redeemOnly = computeEffectiveExitScore(null, 80)!;
    const withWeakDex = computeEffectiveExitScore(15, 80)!;
    expect(withWeakDex).toBeGreaterThanOrEqual(redeemOnly);

    // Strong DEX, adding weak redemption should only help
    const dexOnly = computeEffectiveExitScore(70, null)!;
    const withWeakRedeem = computeEffectiveExitScore(70, 20)!;
    expect(withWeakRedeem).toBeGreaterThanOrEqual(dexOnly);
  });

  it("clamps inputs to 0-100", () => {
    expect(computeEffectiveExitScore(150, null)).toBe(100);
    expect(computeEffectiveExitScore(-10, null)).toBe(0);
  });

  it("handles non-finite inputs as null", () => {
    expect(computeEffectiveExitScore(NaN, null)).toBeNull();
    expect(computeEffectiveExitScore(null, Infinity)).toBeNull();
    expect(computeEffectiveExitScore(undefined, undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests — they should FAIL**

Run: `npm test -- --run shared/lib/__tests__/redemption-backstop-scoring.test.ts`

Expected: failures on tests like "returns redemption score directly when only redemption available" and "uses best path + diversification bonus when both exist" because the old formula is still in place.

---

### Task 2: Implement the new formula

**Files:**
- Modify: `shared/lib/redemption-backstop-scoring.ts:18-21` (constants)
- Modify: `shared/lib/redemption-backstop-scoring.ts:198-224` (function)

- [ ] **Step 1: Replace the constant**

In `shared/lib/redemption-backstop-scoring.ts`, replace lines 18-21:

```typescript
export const EFFECTIVE_EXIT_WEIGHTS = {
  liquidity: 0.55,
  redemption: 0.45,
} as const;
```

with:

```typescript
export const EFFECTIVE_EXIT_DIVERSIFICATION_FACTOR = 0.10;
```

- [ ] **Step 2: Replace the function**

In the same file, replace lines 198-224 (the `computeEffectiveExitScore` function):

```typescript
export function computeEffectiveExitScore(
  liquidityScore: number | null | undefined,
  redemptionBackstopScore: number | null | undefined,
): number | null {
  const liquidity =
    liquidityScore != null && Number.isFinite(liquidityScore)
      ? Math.max(0, Math.min(100, liquidityScore))
      : null;
  const redemption =
    redemptionBackstopScore != null && Number.isFinite(redemptionBackstopScore)
      ? Math.max(0, Math.min(100, redemptionBackstopScore))
      : null;

  if (liquidity != null && redemption != null) {
    return Math.round(
      Math.max(
        liquidity,
        (liquidity * EFFECTIVE_EXIT_WEIGHTS.liquidity) +
          (redemption * EFFECTIVE_EXIT_WEIGHTS.redemption),
      ),
    );
  }

  if (liquidity != null) return Math.round(liquidity);
  if (redemption != null) return Math.round(Math.min(70, redemption * 0.75));
  return null;
}
```

with:

```typescript
export function computeEffectiveExitScore(
  liquidityScore: number | null | undefined,
  redemptionBackstopScore: number | null | undefined,
): number | null {
  const liquidity =
    liquidityScore != null && Number.isFinite(liquidityScore)
      ? Math.max(0, Math.min(100, liquidityScore))
      : null;
  const redemption =
    redemptionBackstopScore != null && Number.isFinite(redemptionBackstopScore)
      ? Math.max(0, Math.min(100, redemptionBackstopScore))
      : null;

  if (liquidity != null && redemption != null) {
    const bestPath = Math.max(liquidity, redemption);
    const bonus = Math.min(liquidity, redemption) * EFFECTIVE_EXIT_DIVERSIFICATION_FACTOR;
    return Math.round(Math.min(100, bestPath + bonus));
  }

  if (liquidity != null) return Math.round(liquidity);
  if (redemption != null) return Math.round(redemption);
  return null;
}
```

- [ ] **Step 3: Run tests — they should PASS**

Run: `npm test -- --run shared/lib/__tests__/redemption-backstop-scoring.test.ts`

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add shared/lib/redemption-backstop-scoring.ts shared/lib/__tests__/redemption-backstop-scoring.test.ts
git commit -m "feat(exit-liquidity): replace blend with best-path + diversification model

The effective exit score now uses max(dex, redemption) + min(dex, redemption) × 0.10
instead of the old weighted blend max(dex, dex×0.55 + redemption×0.45).

Redemption-only coins use the raw redemption score with no cap or discount.
Route family caps (offchain-issuer ≤ 65, queue-redeem ≤ 70) remain the guardrails."
```

---

### Task 3: Update the API methodology response

**Files:**
- Modify: `worker/src/lib/redemption-backstops-store.ts:27,429-432`

- [ ] **Step 1: Update the import**

In `worker/src/lib/redemption-backstops-store.ts`, replace the import at line 27:

```typescript
  EFFECTIVE_EXIT_WEIGHTS,
```

with:

```typescript
  EFFECTIVE_EXIT_DIVERSIFICATION_FACTOR,
```

- [ ] **Step 2: Update the methodology object**

In the same file, replace lines 429-432:

```typescript
      effectiveExitWeights: {
        liquidity: EFFECTIVE_EXIT_WEIGHTS.liquidity,
        redemption: EFFECTIVE_EXIT_WEIGHTS.redemption,
      },
```

with:

```typescript
      effectiveExitModel: {
        model: "best-path",
        diversificationFactor: EFFECTIVE_EXIT_DIVERSIFICATION_FACTOR,
      },
```

- [ ] **Step 3: Run worker type-check**

Run: `cd worker && npx tsc --noEmit`

Expected: no type errors (the methodology object is untyped / inline).

- [ ] **Step 4: Commit**

```bash
git add worker/src/lib/redemption-backstops-store.ts
git commit -m "feat(api): update methodology response for best-path exit model"
```

---

### Task 4: Update the snapshot test

**Files:**
- Modify: `worker/src/lib/__tests__/report-cards-snapshot.test.ts:228,264-265`

The snapshot test at line 196 feeds dex=29, redemption=88 (basket-redeem, no route cap). Under the new formula: `max(29, 88) + min(29, 88) × 0.10 = 88 + 2.9 = 90.9 → 91`.

- [ ] **Step 1: Update the mock input (cosmetic)**

In `worker/src/lib/__tests__/report-cards-snapshot.test.ts`, update line 228 to match the new formula output:

```typescript
        effectiveExitScore: 56,
```

→

```typescript
        effectiveExitScore: 91,
```

This value is the pre-computed cron output in the mock. It's not used by the snapshot builder (which recomputes via `scoreLiquidity()`), but keeping it consistent avoids confusion.

- [ ] **Step 2: Update the assertions**

In the same file, update lines 264-265:

```typescript
    expect(card?.rawInputs.effectiveExitScore).toBe(56);
    expect(card?.dimensions.liquidity.score).toBe(56);
```

→

```typescript
    expect(card?.rawInputs.effectiveExitScore).toBe(91);
    expect(card?.dimensions.liquidity.score).toBe(91);
```

- [ ] **Step 3: Run tests**

Run: `npm test -- --run worker/src/lib/__tests__/report-cards-snapshot.test.ts`

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add worker/src/lib/__tests__/report-cards-snapshot.test.ts
git commit -m "test: update snapshot test expectations for best-path exit formula"
```

---

### Task 5: Bump redemption backstop methodology version

**Files:**
- Modify: `shared/lib/redemption-backstop-version.ts:3-6`

- [ ] **Step 1: Bump version and add changelog entry**

In `shared/lib/redemption-backstop-version.ts`, change line 4:

```typescript
  currentVersion: "3.6",
```

→

```typescript
  currentVersion: "3.7",
```

Then add a new entry at the top of the `changelog` array (after line 6, before the current `version: "3.6"` entry). The `effectiveAt` timestamp should be `1775570400` (2026-04-07 00:00 UTC):

```typescript
    {
      version: "3.7",
      title: "Best-path effective exit model replaces weighted blend",
      date: "2026-04-07",
      effectiveAt: 1775570400,
      summary:
        "The effective exit score now uses max(dex, redemption) + diversification bonus instead of a weighted blend that penalized coins with one strong exit path and one weak one.",
      impact: [
        "Effective exit formula changed from `max(dex, dex × 0.55 + redemption × 0.45)` to `max(dex, redemption) + min(dex, redemption) × 0.10` — the best exit path dominates and a second path earns a modest diversification bonus",
        "Redemption-only coins now use the raw redemption backstop score with no cap or discount, removing the previous `min(70, score × 0.75)` penalty; route family caps (offchain-issuer ≤ 65, queue-redeem ≤ 70) remain as guardrails",
        "Coins with strong permissionless redemption (DAI, GHO, frxUSD, LUSD, BOLD) see the largest uplift; DEX-only coins are unaffected; CeFi offchain-issuer coins see modest improvement bounded by route family caps",
      ],
      commits: [],
      reconstructed: false,
    },
```

- [ ] **Step 2: Run tests**

Run: `npm test -- --run`

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add shared/lib/redemption-backstop-version.ts
git commit -m "chore: bump redemption backstop methodology to v3.7"
```

---

### Task 6: Update methodology page

**Files:**
- Modify: `src/app/methodology/sections/core/safety-scores-section.tsx:197-216`

- [ ] **Step 1: Update the formula display and prose**

In `src/app/methodology/sections/core/safety-scores-section.tsx`, replace lines 197-217 — the entire `<div className="space-y-2">` block containing "Redemption Backstop and Effective Exit":

```tsx
                <div className="space-y-2">
                  <h3 className="text-foreground font-medium">Redemption Backstop and Effective Exit</h3>
                  <p>
                    The standalone Liquidity Score remains a pure DEX market-depth metric. Safety Scores use an
                    <span className="text-foreground font-medium"> effective exit score</span> for the Liquidity dimension,
                    built on a best-path model: exit quality equals the best available exit path, with a modest
                    diversification bonus for having a second viable path.
                  </p>
                  <p className="font-mono">
                    effectiveExit = min(100, max(dex, redemption) + min(dex, redemption) × 0.10)
                  </p>
                  <p>
                    If only DEX liquidity exists, it is used directly. If only a redemption backstop exists, its score
                    is used directly — route family caps (offchain-issuer ≤ 65, queue-redeem ≤ 70) and component scoring
                    remain the guardrails against inflation.
                  </p>
                  <p>
                    Redemption backstops are scored across access, settlement, execution certainty, capacity, output-asset
                    quality, and cost. Low-confidence redemption routes stay visible on the site but do not uplift the Safety Score
                    liquidity dimension, stale DEX inputs are not used for effective exit, and stale live reserve metadata ages out instead of staying resolved indefinitely.
                  </p>
                </div>
```

- [ ] **Step 2: Also update line 172 table description**

In the same file, replace line 172:

```tsx
                          <td className="py-2">Uses effective exit: DEX liquidity stays the floor, redemption can improve the dimension when a direct exit path exists</td>
```

with:

```tsx
                          <td className="py-2">Best-path model: exit quality = best available path (DEX or redemption) + diversification bonus for having both</td>
```

- [ ] **Step 3: Build to verify no JSX errors**

Run: `npm run build`

Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/app/methodology/sections/core/safety-scores-section.tsx
git commit -m "docs(methodology): update effective exit section for best-path model"
```

---

### Task 7: Update documentation

**Files:**
- Modify: `docs/redemption-backstops.md:84-95`
- Modify: `docs/report-cards.md:43-61`

- [ ] **Step 1: Update `docs/redemption-backstops.md`**

Replace lines 84-95 (the "Effective Exit Score" subsection):

```markdown
### Effective Exit Score

`computeEffectiveExitScore()` uses a best-path model to combine modeled redemption quality with observable DEX liquidity:

- If both exist: `min(100, max(dexLiquidity, redemptionScore) + min(dexLiquidity, redemptionScore) × 0.10)`
- If only DEX liquidity exists: passthrough DEX liquidity
- If only redemption exists: passthrough redemption score (route family caps are the guardrails)
- If neither exists: `null`

The redemption-backstop cron only materializes `effectiveExitScore` on resolved rows when the reused DEX liquidity input is fresh. Report cards then apply their own confidence gating on top, so low-confidence redemption routes stay visible but do not uplift Safety Score liquidity.

The effective exit model parameters are surfaced by `/api/redemption-backstops.methodology.effectiveExitModel` and reused by report cards.
```

- [ ] **Step 2: Update `docs/report-cards.md`**

Replace lines 43-61 (the "Liquidity / Exit Details" subsection):

```markdown
### Liquidity / Exit Details

- The public DEX liquidity dataset stays unchanged and fully market-based (see [DEX Liquidity Score](./dex-liquidity.md))
- Report cards use `effectiveExitScore`, not raw `liquidityScore`
- `effectiveExitScore` uses a best-path model:
  - `effectiveExitScore = round(min(100, max(liquidityScore, redemptionBackstopScore) + min(liquidityScore, redemptionBackstopScore) × 0.10))`
- If only DEX liquidity exists, `effectiveExitScore = liquidityScore`
- If only redemption exists, `effectiveExitScore = redemptionBackstopScore` (route family caps are the guardrails — offchain-issuer ≤ 65, queue-redeem ≤ 70)
- Redemption uplift is only used when the redemption route is resolved and above the low-confidence / heuristic tier
- Low-confidence redemption routes stay visible in the dimension detail, but they do not improve the Safety Score liquidity score
- Formula-based routes with live on-chain fee telemetry can use the current redemption fee bps for cost scoring while remaining labeled as formula models
- When DEX liquidity is stale, report cards do not reuse it for effective-exit scoring; the dimension falls back to redemption-only or `NR`
- If the DEX liquidity snapshot is temporarily unavailable at read time, `/api/report-cards` degrades in place the same way: liquidity inputs are suppressed for that snapshot instead of failing the whole response
- If a redemption route is configured but currently unrated, the dimension stays `NR` without pretending the route is absent; the detail string calls out the configured-but-unrated state explicitly
- High concentration (HHI > 0.5) remains descriptive context, not an extra penalty
- See [Redemption Backstops](./redemption-backstops.md) for redemption component scoring and route-family caps
```

- [ ] **Step 3: Commit**

```bash
git add docs/redemption-backstops.md docs/report-cards.md
git commit -m "docs: update exit liquidity docs for best-path model"
```

---

### Task 8: Full validation

- [ ] **Step 1: Run full test suite**

Run: `npm test -- --run`

Expected: all tests pass.

- [ ] **Step 2: Run lint**

Run: `npm run lint`

Expected: no lint errors.

- [ ] **Step 3: Run build**

Run: `npm run build`

Expected: build succeeds (confirms methodology page JSX is valid).

- [ ] **Step 4: Run worker type-check**

Run: `cd worker && npx tsc --noEmit`

Expected: no type errors.

- [ ] **Step 5: Run merge gate**

Run: `npm run test:merge-gate`

Expected: passes.
