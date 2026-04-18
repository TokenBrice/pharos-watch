# Safety Score Audit Remediation Implementation Plan (2026-04-18)

> **For agentic workers:** use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove dead code, fix one real bug in the OG "Safety Scores" Market Pulse grade label, remove type/wire duplication in the Safety Score snapshot and yield loader, and add a golden-fixture test that pins the score contract of `buildReportCardsSnapshot` and `computeSafetyScoresSnapshot` end-to-end — without changing any live score.

**Architecture:** Changes are surgical. The core shared pipeline (`buildReportCardsSnapshot` → `computeSafetyScoresSnapshot` → consumers) is untouched; only the OG Market Pulse label path changes behavior. All other edits remove dead code, replace inline type duplication with the existing shared types, or add/update tests.

**Tech Stack:** TypeScript, Vitest, Cloudflare Workers, Next.js 16, Zod schemas, Tanstack Query on the client.

---

## Audit Summary

The Safety Score pipeline is well-architected and well-tested. The 2026-04-15 audit (`agents/audits/2026-04-15-safety-score-implementation-audit.md`) flagged the main structural concerns, and v6.97–v7.07 already landed the score-changing fixes (peg passthrough, open-event-peak `activeDepegBps`, partial dependency fallback, transitive stress, stale redemption suppression, cache ownership moved to `publish-report-card-cache`). What remains is a tight list of surgical cleanups plus one OG-image drift bug.

### Classification

| ID | Severity | Theme | Location |
|----|----------|-------|----------|
| B1 | Bug (real, OG only) | OG Market Pulse uses non-canonical grade thresholds so the label drifts from the site | `worker/src/api/og.tsx:323-337` |
| B2 | Bug (real, OG only) | `entry.score > 0` in the OG handler excludes legitimate F-grade coins (`overallScore === 0`) from both `pulseScore` and `bottomPerformers`, so the "bottom 3 riskiest" list hides the actual riskiest coins | `worker/src/api/og.tsx:296` |
| D1 | Dead code | Legacy peg "capped at C" warning can never fire after v6.97 | `src/components/report-card.tsx:151-156` |
| D2 | Dead code | OG week-ago trend path is always null by construction | `worker/src/api/og.tsx:284,314-316,344-345` |
| T1 | Type duplication | `YieldSyncLoadedState.safetySnapshot` re-declares `SafetyScoresResultMap` | `worker/src/cron/yield-sync/state-loading.ts:51-59` |
| T2 | Wire duplication | `ReportCard.dependencies` (top-level optional) duplicates `rawInputs.dependencies`; only one consumer reads the top-level field | `shared/types/report-cards.ts:127,135`, `worker/src/lib/report-cards-snapshot-card.ts:174-176`, `src/components/report-card.tsx:389,396` |
| T3 | Internal type export gap | `SafetyScoresResultMap`/`SafetyScoresResultFull` are non-exported so callers inline them; caused T1 | `worker/src/lib/safety-scores.ts:26,36` |
| S1 | Simplification | OG `totalCoins` is set twice (once from `ACTIVE_IDS.size`, once from the cache payload); collapse to one source | `worker/src/api/og.tsx:280,319-321` |
| S2 | Simplification | OG symbol resolution does `.find()` per cache entry inside a loop (O(N²)) | `worker/src/api/og.tsx:301-303` |
| S3 | Stale comment | `use-stress-test.ts` gradeToScore docstring claims "A+ has range 97-100" but canonical A+ is `>=87` | `src/hooks/use-stress-test.ts:77` |
| M1 | Maintainability | No single golden-fixture score-contract test pinning the full pipeline (peg multiplier, active-depeg caps, NAV neutrality, NAV-wrapper peg inheritance, DEX+redemption blend, queue-cap, eventual-only exclusion, wrapper vs mechanism ceilings, partial dependency availability). The 2026-04-15 audit recommendation "A" was only partially addressed. | new `worker/src/lib/__tests__/safety-score-golden.test.ts` |

### Explicitly out of scope

- **Do not change any score math.** Weights, the peg multiplier, active-depeg caps, dependency ceilings, liquidity blending, redemption eligibility gates — all stay as written.
- **Do not relocate scoring logic** (`shared/lib/report-card-*`, `worker/src/lib/report-cards-snapshot*.ts`). Surgical edits only.
- **Methodology version does not bump.** Nothing in this plan changes the scoring contract; version stays `v7.07`.
- **Do not touch `content-v6.tsx` vs `content-v7-0.tsx` file naming.** The split is confusing but touching it risks breaking the methodology-page route and brings no user-visible benefit. Note it in the audit and leave it alone.
- **No new runtime endpoints, no new cron jobs, no data migrations.**

---

## File Structure

- Modified: `worker/src/lib/safety-scores.ts` — export `SafetyScoresResultMap` and `SafetyScoresResultFull` types (no runtime change).
- Modified: `worker/src/cron/yield-sync/state-loading.ts` — replace inline `safetySnapshot` interface shape with the imported `SafetyScoresResultMap` type; no runtime change.
- Modified: `worker/src/api/og.tsx` — fix Market Pulse grade (use `scoreToGrade` from shared), remove dead week-ago trend plumbing, collapse `totalCoins`, build a one-shot symbol map.
- Modified: `src/components/report-card.tsx` — delete the dead "capped at C" warning block; switch the dependency callout to `card.rawInputs.dependencies`.
- Modified: `shared/types/report-cards.ts` — drop the redundant optional `dependencies` field from `ReportCardSchema` / `ReportCard` (wire-bloat cleanup).
- Modified: `worker/src/lib/report-cards-snapshot-card.ts` — stop emitting the top-level `dependencies` alongside `rawInputs.dependencies`.
- Modified (test-only): `worker/src/lib/__tests__/report-cards-snapshot.test.ts` — drop any lingering assertion on the top-level `dependencies` field (if present).
- Created: `worker/src/lib/__tests__/safety-score-golden.test.ts` — full-pipeline golden fixture covering listed scenarios.
- Created (helper): `worker/src/lib/__tests__/helpers/safety-score-golden-inputs.ts` — deterministic inputs (DEX map, redemption map, live reserves, bluechip ratings, peg analytics, coin metas) shared between tests.
- Modified (conditional): `docs/report-cards.md` — the current "Key types" section describes `dependencies` only under `RawDimensionInputs`, so no edit is expected. If a future edit introduces a reference to a top-level `ReportCard.dependencies`, remove it here. Task 7 Step 6 handles this conditionally.

---

## Task 1: Export internal result types from `safety-scores.ts`

**Files:**
- Modify: `worker/src/lib/safety-scores.ts:26,36`

**Why:** `SafetyScoresResultMap` is currently file-local, so the yield loader hand-wrote the same shape. Exporting is a zero-behavior change that enables T1 in Task 2.

- [ ] **Step 1: Read the current type declarations**

Read `worker/src/lib/safety-scores.ts` lines 26-47 to confirm the current shape.

- [ ] **Step 2: Add `export` to both result types**

```ts
// worker/src/lib/safety-scores.ts (change lines 26, 36)
-type SafetyScoresResultMap = {
+export type SafetyScoresResultMap = {
   kind: "ok" | "degraded";
   mode: "map";
   reason?: string;
   coveredCount: number;
   trackedCount: number;
   coverageRatio: number;
   scores: Map<string, SafetyResult>;
 };

-type SafetyScoresResultFull = {
+export type SafetyScoresResultFull = {
   kind: "ok" | "degraded";
   mode: "full-grades";
   reason?: string;
   coveredCount: number;
   trackedCount: number;
   coverageRatio: number;
   scores: Map<string, SafetyResult>;
   grades: SafetyGradeRow[];
 };
```

- [ ] **Step 3: Type-check and tests**

Run:
```bash
cd worker && npx tsc --noEmit && cd -
npm test -- worker/src/lib/__tests__/safety-scores.test.ts
```
Expected: typecheck passes, 4 safety-score tests pass.

- [ ] **Step 4: Commit**

```bash
git add worker/src/lib/safety-scores.ts
git commit -m "refactor(safety-scores): export result types so callers can reuse them"
```

---

## Task 2: Replace the inline `YieldSyncLoadedState.safetySnapshot` shape

**Files:**
- Modify: `worker/src/cron/yield-sync/state-loading.ts:1-63`

**Why:** The loader inlines `{ kind, mode: "map", reason?, coveredCount, trackedCount, coverageRatio, scores }` — exactly `SafetyScoresResultMap`. After Task 1 we can import it, removing a drift risk if the helper shape ever evolves.

- [ ] **Step 1: Update imports**

```ts
// worker/src/cron/yield-sync/state-loading.ts (top of file)
-import { computeSafetyScoresSnapshot } from "../../lib/safety-scores";
+import {
+  computeSafetyScoresSnapshot,
+  type SafetyScoresResultMap,
+} from "../../lib/safety-scores";
```

- [ ] **Step 2: Replace the inline shape**

```ts
// worker/src/cron/yield-sync/state-loading.ts (replace inline safetySnapshot on YieldSyncLoadedState)
 export interface YieldSyncLoadedState {
   // ... unchanged fields above ...
-  safetySnapshot: {
-    kind: "ok" | "degraded";
-    mode: "map";
-    reason?: string;
-    coveredCount: number;
-    trackedCount: number;
-    coverageRatio: number;
-    scores: Map<string, { score: number; grade: string }>;
-  };
+  safetySnapshot: SafetyScoresResultMap;
   safetyScores: Map<string, { score: number; grade: string }>;
   safetyCoverageRatio: number;
   safetySnapshotDegraded: boolean;
 }
```

- [ ] **Step 3: Type-check and run the affected yield tests**

```bash
cd worker && npx tsc --noEmit && cd -
npm test -- worker/src/cron/__tests__/sync-yield-data.test.ts worker/src/cron/__tests__/yield-resolve.test.ts
```
Expected: typecheck passes, yield tests pass. If any mock in those tests builds the shape inline, verify it still satisfies `SafetyScoresResultMap`.

- [ ] **Step 4: Commit**

```bash
git add worker/src/cron/yield-sync/state-loading.ts
git commit -m "refactor(yield-sync): use exported SafetyScoresResultMap instead of inline shape"
```

---

## Task 3: Fix OG Market Pulse grade thresholds and F-grade filter (two real bugs)

**Files:**
- Modify: `worker/src/api/og.tsx:296,323-337`

**Why (B1):** The handler computes `pulseGrade` from `avgScore` using its own staircase (`>=90 A+`, `>=80 A`, `>=70 B+`, `>=60 B`, `>=50 C`, `>=40 D`, else F). The canonical `GRADE_THRESHOLDS` is `>=87 A+`, `>=83 A`, `>=80 A-`, `>=75 B+`, `>=70 B`, `>=65 B-`, `>=60 C+`, `>=55 C`, `>=50 C-`, `>=40 D`. Result: for any avg in [80,82], [75,79], [70,74], [65,69], [60,64], [55,59], or [50,54], the OG image shows a grade the site does not. `scoreToGrade` already exists in `shared/lib/report-cards` and returns the full enum.

**Why (B2):** The `if (entry.score > 0)` guard at line 296 excludes legitimate F-grade coins — `overallScore === 0` is a real rated grade (e.g. severe active depeg + 0 dependency score). Skipping them means (a) the pulse average is computed over a biased subset, (b) F-grade coins never appear in `bottomPerformers`, so the "bottom 3 riskiest" list is wrong in exactly the case it matters. `NR` (unrated) maps to `score === 0` too in the cache payload, so we need to filter on `entry.grade !== "NR"`, not `entry.score > 0`.

- [ ] **Step 1: Update imports**

```ts
// worker/src/api/og.tsx (near existing shared imports)
+import { scoreToGrade } from "@shared/lib/report-cards";
```

- [ ] **Step 2: Replace the `entry.score > 0` filter**

Inside `handleSafetyScoresOg`, where the code walks `Object.entries(reportCardCache.payload.scores)`:

```ts
-      if (entry.score > 0) {
+      if (entry.grade !== "NR") {
         pulseScore += entry.score;
         ratedCount++;
         // ... push to allScores as before ...
       }
```

This counts F-grade coins (score 0) as rated, which they are, and still excludes NR coins. Defunct coins are already excluded upstream because `writeReportCardCache` in `worker/src/lib/report-card-cache.ts:78` skips them.

- [ ] **Step 3: Replace the grade staircase with `scoreToGrade`**

```ts
// worker/src/api/og.tsx (inside handleSafetyScoresOg, replace lines 324-337)
-  const avgScore = ratedCount > 0 ? pulseScore / ratedCount : 0;
-  const pulseGrade =
-    avgScore >= 90
-      ? "A+"
-      : avgScore >= 80
-        ? "A"
-        : avgScore >= 70
-          ? "B+"
-          : avgScore >= 60
-            ? "B"
-            : avgScore >= 50
-              ? "C"
-              : avgScore >= 40
-                ? "D"
-                : "F";
+  const avgScore = ratedCount > 0 ? pulseScore / ratedCount : 0;
+  const pulseGrade = ratedCount > 0 ? scoreToGrade(Math.round(avgScore)) : "NR";
```

`scoreToGrade` clamps internally; `Math.round` keeps the threshold check integer-aligned (thresholds themselves are integers, so fractional averages still grade the same bucket — rounding is cosmetic but consistent with how `computeOverallGrade` produces the per-coin overall score).

- [ ] **Step 4: Type-check**

```bash
cd worker && npx tsc --noEmit
```
Expected: pass (the `pulseGrade` field on `SafetyScoresCardData` is `string`, so any grade works).

- [ ] **Step 5: Manual sanity check of the OG endpoint**

With wrangler dev:
```bash
cd worker && npx wrangler dev --local &
sleep 3
curl -s -o /tmp/safety-pulse.png http://127.0.0.1:8787/api/og/safety-scores
file /tmp/safety-pulse.png
kill %1
```
Expected: `PNG image data, 1200 x 628` (or similar). Visually skim the grade letter.

- [ ] **Step 6: Commit**

```bash
git add worker/src/api/og.tsx
git commit -m "fix(og): use canonical grade thresholds and include F-grade coins in safety-scores pulse"
```

---

## Task 4: Remove dead week-ago trend plumbing in OG handler

**Files:**
- Modify: `worker/src/api/og.tsx:284-317,344-345`
- Modify: `worker/src/lib/og-templates/safety-scores-card.tsx` — only if the `trend` prop is still used anywhere; leave the prop in the type to avoid touching the template if unused.

**Why:** `weekAgoScore` is `let`-declared, initialized to `null`, and the code then explicitly reassigns it to `null` ("For now, use a simple approximation or set to null"). The `trend = weekAgoScore !== null ? ... : null` expression is always `null`. The card template renders the trend arrow only when `data.trend !== null`, so a permanent `null` is a no-op — but the plumbing is dead and misleading.

Keep this task scope tight: remove the dead local variable and simplify `trend: null` at the call site. Do NOT redesign the template, do NOT compute a real trend, do NOT add a new DB query. (Computing a real trend is a separate feature proposal and out of scope.)

- [ ] **Step 1: Remove dead variable and trend computation at the call site**

```ts
// worker/src/api/og.tsx (inside handleSafetyScoresOg)
-  // For top/bottom performers and trend
-  const allScores: Array<{ symbol: string; grade: string; score: number }> = [];
-  let weekAgoScore: number | null = null;
-
-  const reportCardCache = await loadReportCardCache(db);
+  const allScores: Array<{ symbol: string; grade: string; score: number }> = [];
+
+  const reportCardCache = await loadReportCardCache(db);
   if (reportCardCache.kind === "ok") {
     // ... scan cache entries as before, but drop the `weekAgoScore = null;` line ...
-    weekAgoScore = null;
   }

-  // Calculate trend (week over week change)
-  const trend = weekAgoScore !== null ? ((avgScore - weekAgoScore) / weekAgoScore) * 100 : null;
-
   const data: SafetyScoresCardData = {
     gradeDistribution,
     pulseGrade,
     pulseScore: avgScore,
     coverageRatio: totalCoins > 0 ? ratedCount / totalCoins : 0,
     totalCoins,
     topPerformers,
     bottomPerformers,
-    trend,
+    trend: null,
     lastUpdated: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC",
   };
```

- [ ] **Step 2: Type-check**

```bash
cd worker && npx tsc --noEmit
```
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add worker/src/api/og.tsx
git commit -m "chore(og): drop dead week-ago trend plumbing from safety-scores handler"
```

---

## Task 5: Collapse OG `totalCoins` and precompute the symbol map

**Files:**
- Modify: `worker/src/api/og.tsx` inside `handleSafetyScoresOg`

**Why:** `totalCoins` is assigned twice — once from `ACTIVE_IDS.size` before loading the cache, once from `stablecoinsPayload.peggedAssets.length` after. The first assignment is overwritten in the happy path and only matters when the stablecoins cache is missing — in which case we have no data to render performer lists anyway. Collapse to a single source. Separately, `.find(a => a.id === id)` inside the cache iteration is O(N²) — turn it into a Map lookup.

Important ordering note: this task runs **after Task 3 and Task 4**, so the pre-state below already reflects Task 3's `entry.grade !== "NR"` filter and Task 4's removed `weekAgoScore` and trend-comment lines. Do not revert those changes; the `+` block preserves them.

- [ ] **Step 1: Collapse `totalCoins` and build the symbol map once**

```ts
// worker/src/api/og.tsx (inside handleSafetyScoresOg, replace the relevant block)
-  let pulseScore = 0;
-  let ratedCount = 0;
-  let totalCoins = ACTIVE_IDS.size;
-
-  const allScores: Array<{ symbol: string; grade: string; score: number }> = [];
-
-  const reportCardCache = await loadReportCardCache(db);
-  if (reportCardCache.kind === "ok") {
-    for (const [id, entry] of Object.entries(reportCardCache.payload.scores)) {
-      const grade = entry.grade;
-      if (grade in gradeDistribution) {
-        gradeDistribution[grade]++;
-      } else {
-        gradeDistribution["NR"]++;
-      }
-      if (entry.grade !== "NR") {
-        pulseScore += entry.score;
-        ratedCount++;
-
-        const meta = stablecoinsPayload.kind === "ok"
-          ? stablecoinsPayload.payload.peggedAssets.find(a => a.id === id)
-          : undefined;
-        if (meta) {
-          allScores.push({
-            symbol: meta.symbol,
-            grade,
-            score: entry.score,
-          });
-        }
-      }
-    }
-  }
-
-  if (hasUsableStablecoinsPayload(stablecoinsPayload)) {
-    totalCoins = stablecoinsPayload.payload.peggedAssets.length;
-  }
+  let pulseScore = 0;
+  let ratedCount = 0;
+  const allScores: Array<{ symbol: string; grade: string; score: number }> = [];
+
+  const symbolById = new Map<string, string>();
+  if (hasUsableStablecoinsPayload(stablecoinsPayload)) {
+    for (const asset of stablecoinsPayload.payload.peggedAssets) {
+      symbolById.set(asset.id, asset.symbol);
+    }
+  }
+  const totalCoins = symbolById.size > 0 ? symbolById.size : ACTIVE_IDS.size;
+
+  const reportCardCache = await loadReportCardCache(db);
+  if (reportCardCache.kind === "ok") {
+    for (const [id, entry] of Object.entries(reportCardCache.payload.scores)) {
+      const grade = entry.grade;
+      if (grade in gradeDistribution) {
+        gradeDistribution[grade]++;
+      } else {
+        gradeDistribution["NR"]++;
+      }
+      if (entry.grade !== "NR") {
+        pulseScore += entry.score;
+        ratedCount++;
+        const symbol = symbolById.get(id);
+        if (symbol) {
+          allScores.push({ symbol, grade, score: entry.score });
+        }
+      }
+    }
+  }
```

- [ ] **Step 2: Type-check**

```bash
cd worker && npx tsc --noEmit
```
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add worker/src/api/og.tsx
git commit -m "refactor(og): precompute symbol map and collapse totalCoins in safety-scores handler"
```

---

## Task 6: Delete dead "capped at C" peg warning in the detail report card

**Files:**
- Modify: `src/components/report-card.tsx:151-156`

**Why:** Before v6.97, `scorePegStability` could include `"capped at C"` in the detail string when there was an active depeg. v6.97 removed that legacy cap and the detail string no longer contains the substring (`buildPegStabilityDimension` in `shared/lib/report-card-peg-liquidity.ts:40-66` never emits it). The UI branch is permanently dead and references a cap that does not apply.

- [ ] **Step 1: Confirm the string is not emitted anywhere**

```bash
```
Then use Grep with pattern `capped at C` restricted to `shared/lib/**` and `worker/src/**` to confirm no production scorer emits it. Expected: only audit/plan docs reference the string; no source file does.

- [ ] **Step 2: Remove the dead branch**

```tsx
// src/components/report-card.tsx (remove lines 151-156)
-      {/* Peg stability cap warning - always visible */}
-      {dimKey === "pegStability" && dim.detail.includes("capped at C") && (
-        <p className="ml-4 mt-1 text-xs text-amber-700 dark:text-amber-400">
-          Capped — active depeg in progress
-        </p>
-      )}
```

- [ ] **Step 3: Run component tests**

```bash
npm test -- src/components/__tests__/ src/components/stablecoin-detail/__tests__/
```
Expected: all tests pass (none reference the removed branch).

- [ ] **Step 4: Commit**

```bash
git add src/components/report-card.tsx
git commit -m "chore(report-card): remove legacy 'capped at C' warning that never renders"
```

---

## Task 7: Drop redundant top-level `ReportCard.dependencies` field

**Files:**
- Modify: `shared/types/report-cards.ts:127,135` — remove the optional top-level `dependencies` from schema and interface.
- Modify: `worker/src/lib/report-cards-snapshot-card.ts:174-176` — stop emitting the top-level spread.
- Modify: `src/components/report-card.tsx:389,396` — read from `card.rawInputs.dependencies` instead of `card.dependencies`.
- Modify: `docs/report-cards.md` "Key types" section — drop the mention of the top-level field.

**Why:** Every card already carries `rawInputs.dependencies` (required array). The top-level optional `dependencies` is identical data on the wire; only `src/components/report-card.tsx` consumes the top-level. Removing the duplicate shrinks `/api/report-cards` payload slightly and eliminates the "two-truths" shape that makes client-side logic ambiguous. Wire-compat: the Zod schema treats the field as `.optional()`, so older cached responses with or without the field still parse.

- [ ] **Step 1: Update the one consumer first (before dropping the field)**

```tsx
// src/components/report-card.tsx (replace lines 389-422 around the dependency callout)
-        {card.dependencies && card.dependencies.length > 0 && (
+        {card.rawInputs.dependencies.length > 0 && (
           <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 px-4 py-3">
             <p className="mb-2 text-sm font-medium text-blue-700 dark:text-blue-400">
               Dependencies
             </p>
             <p className="text-sm text-muted-foreground">
               This stablecoin has exposure to{" "}
-              {card.dependencies.map((dep, i) => {
+              {card.rawInputs.dependencies.map((dep, i) => {
                 const depMeta = TRACKED_STABLECOINS.find(
                   (s) => s.id === dep.id,
                 );
                 // ...unchanged body...
               })}
               . Its dependency risk score reflects the health and stability of
               these assets.
             </p>
           </div>
         )}
```

- [ ] **Step 2: Run the report-card component test to confirm render stays stable**

```bash
npm test -- src/components/__tests__/ src/components/stablecoin-detail/__tests__/
```
Expected: pass.

- [ ] **Step 3: Stop emitting the top-level field in the snapshot**

```ts
// worker/src/lib/report-cards-snapshot-card.ts (replace return block lines 165-177)
   return {
     id: meta.id,
     name: meta.name,
     symbol: meta.symbol,
     overallGrade: overall.grade,
     overallScore: overall.score,
     baseScore: overall.baseScore,
     dimensions,
     ratedDimensions: overall.ratedDimensions,
     rawInputs,
-    ...(deps.length > 0 ? { dependencies: deps } : {}),
     isDefunct: false,
   };
```

- [ ] **Step 4: Remove the field from schema and interface**

```ts
// shared/types/report-cards.ts (ReportCardSchema)
 export const ReportCardSchema = z.object({
   // ...
   rawInputs: RawDimensionInputsSchema,
-  dependencies: z.array(DependencyWeightSchema).optional(),
   isDefunct: z.boolean(),
 });

 export interface ReportCard extends z.infer<typeof ReportCardSchema> {
   overallGrade: ReportCardGrade;
   dimensions: Record<DimensionKey, ReportCardDimension>;
   rawInputs: RawDimensionInputs;
-  dependencies?: DependencyWeight[];
 }
```

- [ ] **Step 5: Remove or update the buildDefunctReportCards defunct builder if it sets `dependencies`**

Check `worker/src/lib/report-cards-snapshot-finalize.ts` — the defunct cards builder does NOT set `dependencies` today (verified: only `rawInputs.dependencies: []`). If it did, remove it. Otherwise no change.

- [ ] **Step 6: Update docs**

```markdown
# docs/report-cards.md (inside "Key types" bullets, no mention of the top-level field)
- **`RawDimensionInputs`**: Raw scoring inputs per card (..., `dependencies`, `navToken`, `collateralFromLive`) — enables client-side stress test recomputation.
```

If `docs/report-cards.md` currently enumerates `dependencies` as a top-level card field, remove that mention. If it only documents it under `rawInputs`, no change.

- [ ] **Step 7: Full type-check and test sweep**

```bash
cd worker && npx tsc --noEmit && cd -
npm test -- worker/src/lib/__tests__/report-cards-snapshot.test.ts worker/src/lib/__tests__/safety-scores.test.ts worker/src/api/__tests__/report-cards.test.ts src/components/__tests__/ src/components/stablecoin-detail/__tests__/ src/hooks/__tests__/use-stress-test.test.ts
```
Expected: all pass. If any test asserts `card.dependencies` directly, update it to read `card.rawInputs.dependencies`.

- [ ] **Step 8: Verify no other consumer reads the top-level field**

Use Grep with pattern `\.dependencies\b` restricted to `src/**/*.tsx`, `src/**/*.ts`, `worker/src/**/*.ts`, and `shared/lib/**/*.ts`. Expected reads: `card.rawInputs.dependencies` (many), `meta.dependencies` (in metas), `reserve-templates` / `dependency-graph` internals. No `card.dependencies` or `reportCard.dependencies` should remain.

- [ ] **Step 9: Run the merge gate**

```bash
npm run test:merge-gate
```
Expected: pass.

- [ ] **Step 10: Clean up any newly-unused imports**

Removing the optional schema field can leave `DependencyWeightSchema` or `DependencyWeight` imported but unused in `shared/types/report-cards.ts`. If so, remove the import. Equivalent check for any other file that only referenced the top-level `dependencies` field. `npm run check:unused-code` in Task 10 Step 4 will also catch this if missed.

- [ ] **Step 11: Commit**

```bash
git add shared/types/report-cards.ts worker/src/lib/report-cards-snapshot-card.ts src/components/report-card.tsx docs/report-cards.md
git commit -m "refactor(report-cards): drop redundant top-level ReportCard.dependencies (use rawInputs.dependencies)"
```

---

## Task 8: Add a golden-fixture score-contract test

**Files:**
- Create: `worker/src/lib/__tests__/safety-score-golden.test.ts`

**Why:** The 2026-04-15 audit flagged that the pipeline lacks a single test that locks the full score contract end-to-end. Existing tests cover individual scorers and the snapshot mechanics, but not the composition. Without a golden test, a future refactor can quietly shift scores.

### Scope (deliberately trimmed — this is a smoke-level contract lock, not an exhaustive matrix)

Six scenarios, six real tracked coin IDs. Each scenario maps to one coin we can target with deterministic inputs via the same input-boundary mocks that `worker/src/lib/__tests__/report-cards-snapshot.test.ts` already uses:

1. **Active-depeg D cap** — coin with a 1200 bps open-event peak; final overall clamped to 49 (grade D).
2. **Active-depeg F cap + severe redemption impairment** — coin with a 2700 bps peak plus a non-live-direct redemption route; overall clamped to 39 (grade F) and redemption uplift disabled per v6.96.
3. **NAV-wrapper peg inheritance** — a NAV wrapper with `pegReferenceId` pointing at a coin whose `pegScore` is lower than neutral; peg dimension inherits the reference score.
4. **Wrapper vs mechanism dependency ceilings** — a coin that depends on an upstream with a `mechanism` relationship and a separate wrapper coin; both ceilings apply deterministically.
5. **DEX + redemption blend with queue-cap** — a coin with DEX liquidity and a `queue-redeem` route; the effective-exit score reflects the 70-point queue cap before the best-path blend.
6. **No-liquidity penalty** — a coin with no DEX snapshot and no redemption route; overall score multiplied by `NO_LIQUIDITY_PENALTY = 0.9`.

If you can map a scenario onto a real stablecoin ID already in `ACTIVE_STABLECOINS`, use it (so the test documents behavior for a real coin). Otherwise, pick a tracked ID whose meta already fits the scenario's dependency shape and override only the inputs (peg summary, dex liquidity row, redemption entry, open-event peak).

**Budget note:** a faithful version of this fixture is ~250–400 lines across one test file (input constants, mocks, assertions). That is acceptable for a contract lock on the crown-jewel metric. If the file grows past ~600 lines, split the input constants into `worker/src/lib/__tests__/helpers/safety-score-golden-inputs.ts`; otherwise keep everything in the test file for readability.

### Mock strategy (copy from `worker/src/lib/__tests__/report-cards-snapshot.test.ts`)

Do **not** mock `@shared/lib/stablecoins`. Mock only the input boundary:

- `vi.mock("../report-cards-snapshot-inputs", ...)` to supply a deterministic `loadReportCardsSnapshotInputs` that returns `stablecoinsCached`, `bluechipCached`, `dexLiquiditySnapshot`, `redemptionBackstopMap`, `liveReserveMap`, `liquidityStale`, `redemptionStale`, `inputFreshness` — same shape as the existing file; or
- Mock the four loaders that `loadReportCardsSnapshotInputs` itself calls: `loadStablecoinsCache`, `loadDexLiquiditySnapshot`, `loadRedemptionBackstopSnapshot`, `loadFreshIndependentLiveReserveMap`, plus `derivePegAnalyticsSnapshot` from `../peg-analytics`.

The existing stale-dex regression test at `worker/src/lib/__tests__/report-cards-snapshot.test.ts` uses this exact pattern. Read it first before writing the golden test.

### Steps

- [ ] **Step 1: Read the existing snapshot test and pattern-match**

Open `worker/src/lib/__tests__/report-cards-snapshot.test.ts` and the mock-helpers. Identify exactly which functions it mocks and how it builds the mocked peg analytics map. Reuse that structure.

- [ ] **Step 2: Pick six real tracked IDs — one per scenario**

Run this to enumerate candidate IDs:
```bash
```
Then use Grep (`pegReferenceId`, `dependencies`, `collateralQuality`, `custodyModel`) in `shared/data/stablecoins/` to pick IDs that fit each scenario's shape. Prefer well-known IDs (e.g. `usdc-circle`, `dai-makerdao`, `frxusd-frax`) so the test reads like live documentation.

Commit the scenario-to-ID mapping as a comment at the top of the test file.

- [ ] **Step 3: Write the test and the six scenarios**

Each scenario asserts:
- `card.overallGrade`
- `card.overallScore`
- `card.dimensions.pegStability.score`
- `card.dimensions.liquidity.score`
- `card.dimensions.resilience.score`
- `card.dimensions.decentralization.score`
- `card.dimensions.dependencyRisk.score`

Use `expect(card).toMatchObject({...})` to make the failure diff readable.

For the active-depeg scenarios, include `effectiveAt` / `peakDeviationBps` in the mocked `derivePegAnalyticsSnapshot` return so `activeDepegPeakBpsById` is populated correctly by `buildReportCardsSnapshot`.

- [ ] **Step 4: Lock the expected values by running once**

The test asserts the *current* pipeline output. Run the test once with placeholder expected values, copy the actual outputs from the failure diff into `GOLDEN_EXPECTED` / inline assertions, re-run until green. This is a lock, not an independently-derived oracle.

When updating the locked values after an intentional methodology bump in the future, add a one-line version comment above the updated block so the diff stays auditable (e.g. `// Locked against methodology v7.08 after <change>`).

- [ ] **Step 5: Run the new test twice to confirm determinism**

```bash
npm test -- worker/src/lib/__tests__/safety-score-golden.test.ts
npm test -- worker/src/lib/__tests__/safety-score-golden.test.ts
```
Expected: both pass with identical output.

- [ ] **Step 6: Run the whole Safety Score test suite**

```bash
npm test -- worker/src/lib/__tests__/safety-scores.test.ts worker/src/lib/__tests__/report-cards-snapshot.test.ts worker/src/lib/__tests__/safety-score-golden.test.ts worker/src/cron/__tests__/snapshot-safety-grade-history.test.ts worker/src/api/__tests__/safety-score-history.test.ts
```
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add worker/src/lib/__tests__/safety-score-golden.test.ts
git commit -m "test(safety-scores): add 6-scenario golden-fixture score contract"
```

---

## Task 9: Fix stale `gradeToScore` docstring in `use-stress-test.ts`

**Files:**
- Modify: `src/hooks/use-stress-test.ts:74-78`

**Why:** The docstring says "A+ has range 97-100, midpoint = 99 (capped at 100)". The canonical `GRADE_THRESHOLDS` in `shared/lib/report-card-core.ts:34-45` puts A+ at `>= 87`, so A+'s range is 87-100 with midpoint ~93. The docstring is stale and actively misleads future readers. The implementation is correct (it reads `GRADE_THRESHOLDS` dynamically), only the comment is wrong.

- [ ] **Step 1: Update the docstring**

```ts
// src/hooks/use-stress-test.ts (replace lines 74-78)
-/**
- * Convert a target grade to a numeric score (midpoint of grade range).
- * For example: D has range 50-59, midpoint = 55.
- * F has range 0-49, midpoint = 25.
- * A+ has range 97-100, midpoint = 99 (capped at 100).
- */
+/**
+ * Convert a target grade to a numeric score (midpoint of that grade's range).
+ * The range is derived from GRADE_THRESHOLDS, so this tracks methodology bumps
+ * automatically. For example with v7.07 thresholds: D (40-49, midpoint 44),
+ * A+ (87-100, midpoint 93).
+ */
```

- [ ] **Step 2: Run the stress-test hook tests**

```bash
npm test -- src/hooks/__tests__/use-stress-test.test.ts
```
Expected: pass (docstring-only change).

- [ ] **Step 3: Commit**

```bash
git add src/hooks/use-stress-test.ts
git commit -m "docs(stress-test): correct stale gradeToScore docstring"
```

---

## Task 10: Final verification

- [ ] **Step 1: Merge gate**

```bash
npm run test:merge-gate
```
Expected: pass.

- [ ] **Step 2: Targeted test sweep**

```bash
npm test -- worker/src/lib/__tests__/safety-scores.test.ts worker/src/lib/__tests__/report-cards-snapshot.test.ts worker/src/lib/__tests__/safety-score-golden.test.ts worker/src/cron/__tests__/snapshot-safety-grade-history.test.ts worker/src/cron/__tests__/sync-yield-data.test.ts worker/src/cron/__tests__/yield-resolve.test.ts worker/src/cron/__tests__/daily-digest.test.ts worker/src/api/__tests__/report-cards.test.ts worker/src/api/__tests__/safety-score-history.test.ts worker/src/api/__tests__/yield-rankings.test.ts src/components/__tests__/safety-score-history-section.test.tsx src/components/stablecoin-detail/__tests__/hero-card.test.tsx src/hooks/__tests__/use-stress-test.test.ts src/app/safety-scores/view-model.test.ts src/app/safety-scores/client.test.tsx
```
Expected: all pass.

- [ ] **Step 3: Types and lint**

```bash
cd worker && npx tsc --noEmit && cd -
npm run lint
```
Expected: pass.

- [ ] **Step 4: Doc-sync, doc-counts, unused code**

```bash
npm run check:doc-sync
npm run check:doc-counts
npm run check:unused-code
```
Expected: pass. The removed `ReportCard.dependencies` field should not be referenced in any doc after Task 7.

- [ ] **Step 5: Final commit (docs or cleanup only)**

If any incidental fix-up is needed (e.g., a stray docs reference), commit it separately:

```bash
git add <files>
git commit -m "docs(report-cards): reflect removed top-level dependencies field"
```

---

## Score Impact Disclosure

No live Safety Score should change. Task 3 changes only the OG image's "Market Pulse" label and pulse average, not stored or served scores. Specifically:

- `/api/report-cards`, `/api/safety-score-history`, `/api/yield-rankings`, `/api/redemption-backstops`: unchanged.
- `report_card_cache` contents: unchanged.
- `safety_grade_history` rows: unchanged.
- `/safety-scores`, `/stablecoin/[id]`, methodology calculator: unchanged.
- `/api/og/safety-scores`: two changes:
  1. The "Market Pulse" letter may shift to the canonical grade. Examples: average 72 was `B+` (old OG staircase used `>=70`), now `B` (canonical uses `>=75`). Average 66 was `B` (old `>=60`), now `B-` (canonical `>=65`). Average 52 was `C` (old `>=50`), now `C-` (canonical `>=50`).
  2. The average itself will include F-grade (score 0) coins that were previously skipped, which may pull the average down slightly on a typical day and will populate `bottomPerformers` correctly even when the worst coins have score 0.

Task 4 drops dead plumbing; `trend` was already always null in rendered OG images.

If any golden-fixture value differs from the current pipeline output during Task 8 Step 4, that is a signal you invented expected values instead of locking the current contract. Update the fixture to match the current pipeline. Do not change the pipeline to make a hand-authored fixture happy.

## Non-Goals (documented so future reviewers do not re-open them)

- Splitting `content-v7-0.tsx` or renaming it. The file houses v6.91–v7.07 entries and is imported by `content-v6.tsx`. Renaming is cosmetic and risks breaking the methodology route's static export. Leave as-is.
- Adding a real week-over-week trend to the OG card. That is a feature, not a cleanup; propose separately with a plan for where the week-ago aggregate is sourced.
- Changing `DEFAULT_SAFETY_SCORE` (40). Yield pipeline concern, not Safety Score.
- Centralizing grade staircase logic beyond `scoreToGrade`. The existing helper is already the canonical entry point; Task 3 wires OG to it.
- Methodology version bump. Nothing here changes the scoring contract.
- Removing `writeReportCardCache(db, snapshot.cards, snapshot.updatedAt)` from `snapshot-safety-grade-history.ts:121` even though `publish-report-card-cache` now publishes the same cache every 15 minutes. The daily write is a redundant belt-and-suspenders fallback that the prior remediation plan explicitly kept. If the quarter-hourly cron were ever accidentally disabled, the daily snapshot would still refresh `report_card_cache`. Touching this requires an operational tradeoff decision out of scope here. Track as a separate audit item.

---

## Review Loop Log

### Pass 1

Findings:

- **M-1** — Task 8's mock strategy (`vi.mock("@shared/lib/stablecoins", …)` with synthetic metas) contradicts the existing `report-cards-snapshot.test.ts` pattern and would require re-implementing many meta fields to drive `deriveDependencies`, `resolveBlacklistStatuses`, `resolveResilienceFactors`, `resolveGovernanceQuality`. Should instead mock only the input boundary and use real tracked IDs.
- **M-2** — Score Impact example used `average 77 → B+ vs B`, but 77 is `B+` under both staircases. Wrong example.
- **M-3** — The OG handler's `entry.score > 0` filter excludes legitimate F-grade coins from both the pulse average and `bottomPerformers`. Adjacent to the other OG edits; should be fixed or explicitly deferred.
- **M-4** — The golden scenario list as written is ~13 coins; the plan understated the fixture-writing effort. Trim to 5–6 high-value scenarios or honestly budget the helper size.
- **N-5** — Task 8 should mention how to regenerate `GOLDEN_EXPECTED` after intentional methodology bumps.
- **N-6** — Task 7 may orphan imports; add a clean-up step.
- **C-2** — `src/hooks/use-stress-test.ts:77` docstring has a wrong A+ range (stale pre-v5.1). Not blocking but a tiny in-scope fix.
- **C-1** — `publish-report-card-cache` and `snapshot-safety-grade-history` both write the same cache daily. Out of scope; note as separate audit item.

Fixes applied:

- Rewrote Task 8 with the correct input-boundary mock strategy, trimmed scope to 6 real-ID scenarios, budgeted the fixture size honestly, and added the regeneration-on-methodology-bump note.
- Replaced the wrong "average 77" example with three correct examples (72 → B, 66 → B-, 52 → C-).
- Added B2 to the findings table and extended Task 3 with a second fix step for the `entry.score > 0` filter; renamed the task and its commit message accordingly.
- Added Task 9 for the `gradeToScore` docstring fix (S3), renumbered Final Verification to Task 10.
- Added Step 10 to Task 7 for cleaning up newly-unused imports.
- Added a Non-Goals bullet documenting why we leave the duplicate daily `writeReportCardCache` call alone.

Status: revised after pass 1; ready for pass 2 review.

### Pass 2

Findings:

- **[major]** Task 5 Step 1 pre-state showed `entry.score > 0` (pre-Task-3 state), which when applied in sequence after Task 3 would fail to match and would conceptually revert Task 3's B2 fix.
- **[minor]** File Structure bullet overstated what `docs/report-cards.md` currently says about the top-level `dependencies` field (the doc only mentions it under `RawDimensionInputs`, so Task 7's doc edit is a no-op in practice).

Fixes applied:

- Updated Task 5 Step 1's `-` (pre-state) block to show `entry.grade !== "NR"` (post-Task-3 state) and its `+` (post-state) block to keep the same filter. Added an explicit ordering note at the top of Task 5.
- Reworded the File Structure entry for `docs/report-cards.md` as conditional, consistent with Task 7 Step 6's body.

Status: revised after pass 2; ready for pass 3 review.

### Pass 3

Findings: none. Reviewer verified all Pass 2 fixes landed cleanly, sequence consistency across Tasks 3-5 holds, commit messages are coherent, task sizes are reasonable, and Score Impact Disclosure correctly captures the only behavior change (OG Market Pulse).

Status: plan is ready for execution. Exit review loop.
