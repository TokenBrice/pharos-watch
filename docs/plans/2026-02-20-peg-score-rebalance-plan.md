# Peg Score Rebalance Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the peg score less generous to centralized stables by steepening the severity curve (sqrt -> linear) and adding a deviation spread penalty.

**Architecture:** Two changes to the pure `computePegScore()` function in `src/lib/peg-score.ts`: (1) replace `sqrt(peakBps/100)` with `peakBps/100` in the severity loop, (2) add a spread penalty computed from the standard deviation of absolute peak deviations across all events. The `PegScoreResult` interface and `PegSummaryCoin` type gain a `spreadPenalty` field. The about page methodology text is updated.

**Tech Stack:** TypeScript, Next.js (static export)

---

### Task 1: Update `PegScoreResult` interface

**Files:**
- Modify: `src/lib/peg-score.ts:4-21`

**Step 1: Add `spreadPenalty` field to the `PegScoreResult` interface**

Add after the `severityScore` field (line 10):

```typescript
/** Deviation spread penalty (0-15) — stddev of peak deviations across events */
spreadPenalty: number;
```

**Step 2: Type-check**

Run: `npm run build`
Expected: FAIL — `computePegScore` return doesn't include `spreadPenalty` yet

---

### Task 2: Update `PegSummaryCoin` type

**Files:**
- Modify: `src/lib/types.ts:417-434`

**Step 1: Add `spreadPenalty` to `PegSummaryCoin`**

Add after the `severityScore` field (line 427):

```typescript
spreadPenalty: number;
```

---

### Task 3: Implement linear severity curve + spread penalty

**Files:**
- Modify: `src/lib/peg-score.ts:31-111`

**Step 1: Change severity penalty from sqrt to linear**

In the severity loop (line 75), change:

```typescript
// OLD
totalPenalty += Math.sqrt(peakBps / 100) * (durationDays / 30) * recencyWeight;
```

to:

```typescript
// NEW — linear curve: large deviations penalize proportionally
totalPenalty += (peakBps / 100) * (durationDays / 30) * recencyWeight;
```

**Step 2: Add spread penalty computation after the severity loop**

After line 77 (`const severityScore = ...`), before the active depeg penalty section, add:

```typescript
// --- Spread penalty (deviation variance proxy) ---
// Coins with erratic, unpredictable depeg magnitudes get penalized.
// stddev of |peakDeviationBps| scaled into 0-15 range.
let spreadPenalty = 0;
if (events.length >= 2) {
  const absBpsList = events.map((e) => Math.abs(e.peakDeviationBps));
  const mean = absBpsList.reduce((s, v) => s + v, 0) / absBpsList.length;
  const variance = absBpsList.reduce((s, v) => s + (v - mean) ** 2, 0) / absBpsList.length;
  const stdDev = Math.sqrt(variance);
  spreadPenalty = Math.min(15, (stdDev / 1000) * 15);
}
```

**Step 3: Update composite formula**

Change line 93:

```typescript
// OLD
const raw = 0.5 * pegPct + 0.5 * severityScore - activeDepegPenalty;
```

to:

```typescript
// NEW — includes spread penalty
const raw = 0.5 * pegPct + 0.5 * severityScore - activeDepegPenalty - spreadPenalty;
```

**Step 4: Add `spreadPenalty` to return object**

In the return object (after line 101 `pegPct,`), add:

```typescript
spreadPenalty,
```

**Step 5: Update the no-data early return** (line 46-56)

Add `spreadPenalty: 0,` to the early return object (after `severityScore: 100,`).

---

### Task 4: Pass `spreadPenalty` through peg-summary API

**Files:**
- Modify: `worker/src/api/peg-summary.ts:58-81` (coins type) and `137-154` (push block)

**Step 1: Add `spreadPenalty` to the coins array type**

In the inline type definition around line 68, after `severityScore: number;`, add:

```typescript
spreadPenalty: number;
```

**Step 2: Add `spreadPenalty` to the push call**

In the `coins.push({...})` block around line 148, after `severityScore: scoreResult.severityScore,`, add:

```typescript
spreadPenalty: scoreResult.spreadPenalty,
```

---

### Task 5: Update about page methodology

**Files:**
- Modify: `src/app/about/page.tsx:226-244`

**Step 1: Update component count and add spread penalty description**

Change "The score combines three components:" to "The score combines four components:".

After the "Active Depeg" `<li>` (line 243), add a new list item:

```tsx
<li className="flex gap-2">
  <span className="text-foreground font-medium shrink-0">Deviation Spread</span>
  <span>penalizes coins whose depeg events vary widely in magnitude (up to 15 points) — a coin with erratic deviations ranging from 100 to 5000 bps is less predictable than one with consistent small breaches</span>
</li>
```

**Step 2: Update the FAQ structured data**

Update the FAQ answer text (line 65) to:

```
"The Peg Score ranges from 0 to 100 and combines two equally-weighted components: Time at Peg (50%) measures the percentage of the tracking window where the coin stayed within its peg threshold. Severity (50%) penalizes based on each depeg event's peak deviation (linear scale), duration (capped at 90 days), and recency (recent events weigh more via exponential decay). An ongoing depeg applies an additional penalty of up to 50 points. A deviation spread penalty (up to 15 points) further penalizes coins whose depeg magnitudes are erratic and unpredictable."
```

---

### Task 6: Build and verify

**Step 1: Run type-check and build**

Run: `npm run build`
Expected: PASS — clean build with no type errors

**Step 2: Also type-check worker**

Run: `cd worker && npx tsc --noEmit`
Expected: PASS
