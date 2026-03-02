# Inherited Blacklist Risk Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Surface "Possible (inherited)" blacklist risk for coins whose reserves contain ≥25% blacklistable stablecoins, instead of incorrectly scoring them "No (100)".

**Architecture:** Export `isBlacklistable` and `INHERITED_BLACKLIST_THRESHOLD_PCT` from the shared `src/lib/report-cards.ts` lib. All three call sites (API handler, two cron jobs) import the shared function and pass a pre-built `ReadonlySet<string>` of first-order blacklistable coin IDs. Type `"possible-inherited"` lives only on the computed output side — never in the authored `StablecoinMeta.canBeBlacklisted` field.

**Tech Stack:** TypeScript strict, Vitest, `src/lib/report-cards.ts` (shared frontend+worker lib), Cloudflare Workers crons.

---

### Task 1: Widen `RawDimensionInputs.canBeBlacklisted` in types

**Files:**
- Modify: `src/lib/types.ts:443`

**Step 1: Make the change**

Find line 443:
```ts
canBeBlacklisted: boolean | "possible";
```
Change to:
```ts
canBeBlacklisted: boolean | "possible" | "possible-inherited";
```

**Step 2: Verify TypeScript still compiles**

```bash
npm run build
```
Expected: build succeeds (no narrowing errors yet — `scoreResilience` still accepts the old type, so no callers break).

**Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat(types): add possible-inherited to canBeBlacklisted union"
```

---

### Task 2: Write failing tests for the new behavior

**Files:**
- Modify: `src/lib/__tests__/report-cards.test.ts`

**Step 1: Add the new import**

The import block at line 2 currently imports `scoreResilience` and others. Add `isBlacklistable` and `INHERITED_BLACKLIST_THRESHOLD_PCT` to it — they don't exist yet, so the test file will fail to compile, which is the desired red state:

```ts
import {
  scoreResilience,
  isBlacklistable,
  INHERITED_BLACKLIST_THRESHOLD_PCT,
  resolveGovernanceQuality,
  GOVERNANCE_QUALITY_SCORE,
  scoreDependencyRisk,
  computeOverallGrade,
  NO_LIQUIDITY_PENALTY,
} from "../report-cards";
```

**Step 2: Append new describe block at the end of the file**

```ts
describe("scoreResilience — possible-inherited blacklist label", () => {
  it("scores 66 and labels Possible (inherited) for possible-inherited", () => {
    const result = scoreResilience(makeMeta(), "possible-inherited");
    expect(result.detail).toContain("Blacklist: Possible (inherited) (66)");
  });
});

describe("isBlacklistable — inherited risk from reserves", () => {
  it("exports INHERITED_BLACKLIST_THRESHOLD_PCT as 25", () => {
    expect(INHERITED_BLACKLIST_THRESHOLD_PCT).toBe(25);
  });

  it("returns true for centralized governance (no index needed)", () => {
    const meta = makeMeta({ flags: { governance: "centralized", backing: "rwa-backed", pegCurrency: "USD", yieldBearing: false, rwa: true, navToken: false } });
    expect(isBlacklistable(meta)).toBe(true);
  });

  it("returns false for decentralized governance with no reserves", () => {
    const meta = makeMeta({ flags: { governance: "decentralized", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false } });
    expect(isBlacklistable(meta)).toBe(false);
  });

  it("returns possible-inherited when ≥25% of reserves link to blacklistable coinIds", () => {
    const meta = makeMeta({
      flags: { governance: "decentralized", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false },
      reserves: [
        { name: "USDC via PSM", pct: 33, risk: "low", coinId: "2" },
        { name: "ETH", pct: 67, risk: "medium" },
      ],
    });
    const blacklistableIds = new Set(["2"]);
    expect(isBlacklistable(meta, blacklistableIds)).toBe("possible-inherited");
  });

  it("returns false when blacklistable reserve share is below threshold (24%)", () => {
    const meta = makeMeta({
      flags: { governance: "decentralized", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false },
      reserves: [
        { name: "USDC buffer", pct: 24, risk: "low", coinId: "2" },
        { name: "ETH", pct: 76, risk: "medium" },
      ],
    });
    const blacklistableIds = new Set(["2"]);
    expect(isBlacklistable(meta, blacklistableIds)).toBe(false);
  });

  it("explicit canBeBlacklisted: false override wins even with heavy blacklistable reserves", () => {
    const meta = makeMeta({
      canBeBlacklisted: false,
      flags: { governance: "decentralized", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false },
      reserves: [
        { name: "USDC", pct: 100, risk: "low", coinId: "2" },
      ],
    });
    const blacklistableIds = new Set(["2"]);
    expect(isBlacklistable(meta, blacklistableIds)).toBe(false);
  });

  it("returns false when reserves have coinIds but none are in the blacklistable index", () => {
    const meta = makeMeta({
      flags: { governance: "decentralized", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false },
      reserves: [
        { name: "sDAI", pct: 50, risk: "low", coinId: "5" },
        { name: "ETH", pct: 50, risk: "medium" },
      ],
    });
    const blacklistableIds = new Set(["2", "1"]); // DAI not in the set
    expect(isBlacklistable(meta, blacklistableIds)).toBe(false);
  });

  it("ignores reserve slices without coinId when computing inherited share", () => {
    const meta = makeMeta({
      flags: { governance: "decentralized", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false },
      reserves: [
        // 30% USDC but no coinId → should NOT count
        { name: "USDC (unlabelled)", pct: 30, risk: "low" },
        { name: "ETH", pct: 70, risk: "medium" },
      ],
    });
    const blacklistableIds = new Set(["2"]);
    expect(isBlacklistable(meta, blacklistableIds)).toBe(false);
  });
});
```

**Step 3: Run the tests — expect compile failure**

```bash
npm test
```
Expected: compilation error — `isBlacklistable` and `INHERITED_BLACKLIST_THRESHOLD_PCT` are not exported from `report-cards`.

---

### Task 3: Implement `isBlacklistable` and constant in shared lib

**Files:**
- Modify: `src/lib/report-cards.ts`

**Step 1: Add the constant and function**

Find the comment block before `scoreResilience` (around line 405). Insert before it:

```ts
// ---------------------------------------------------------------------------
// Blacklist capability helpers
// ---------------------------------------------------------------------------

/** Minimum % of reserves backed by blacklistable coinIds to trigger inherited risk. */
export const INHERITED_BLACKLIST_THRESHOLD_PCT = 25;

/**
 * Resolves the blacklist risk tier for a coin.
 *
 * Resolution order:
 *   1. Explicit meta.canBeBlacklisted override
 *   2. Centralized governance → true
 *   3. Inherited: ≥ INHERITED_BLACKLIST_THRESHOLD_PCT of reserves are backed
 *      by first-order blacklistable coins (matched by coinId)
 *   4. false
 *
 * Pass `blacklistableIds` built from first-order coins only (explicit + centralized,
 * no index arg) to avoid recursive/circular inheritance.
 */
export function isBlacklistable(
  meta: StablecoinMeta,
  blacklistableIds?: ReadonlySet<string>,
): boolean | "possible" | "possible-inherited" {
  if (meta.canBeBlacklisted !== undefined) return meta.canBeBlacklisted;
  if (meta.flags.governance === "centralized") return true;
  if (blacklistableIds && meta.reserves) {
    const inheritedPct = meta.reserves
      .filter(r => r.coinId !== undefined && blacklistableIds.has(r.coinId))
      .reduce((sum, r) => sum + r.pct, 0);
    if (inheritedPct >= INHERITED_BLACKLIST_THRESHOLD_PCT) return "possible-inherited";
  }
  return false;
}
```

**Step 2: Run the tests — expect only scoreResilience tests to fail**

```bash
npm test
```
Expected: `isBlacklistable` tests pass. The `scoreResilience — possible-inherited` test still fails because `scoreResilience` doesn't handle the new value yet.

---

### Task 4: Update `scoreResilience` to handle `"possible-inherited"`

**Files:**
- Modify: `src/lib/report-cards.ts:412-416`

**Step 1: Widen the parameter type**

Line 412, change:
```ts
  canBeBlacklisted: boolean | "possible",
```
to:
```ts
  canBeBlacklisted: boolean | "possible" | "possible-inherited",
```

**Step 2: Update the score and label ternaries**

Line 415-416, change:
```ts
  const blacklistScore = canBeBlacklisted === true ? 33 : canBeBlacklisted === "possible" ? 66 : 100;
  const blacklistLabel = canBeBlacklisted === true ? "Yes" : canBeBlacklisted === "possible" ? "Possible (mutable contract)" : "No";
```
to:
```ts
  const blacklistScore = canBeBlacklisted === true ? 33
    : (canBeBlacklisted === "possible" || canBeBlacklisted === "possible-inherited") ? 66
    : 100;
  const blacklistLabel = canBeBlacklisted === true ? "Yes"
    : canBeBlacklisted === "possible" ? "Possible (mutable contract)"
    : canBeBlacklisted === "possible-inherited" ? "Possible (inherited)"
    : "No";
```

**Step 3: Run all tests — expect full green**

```bash
npm test
```
Expected: all tests pass, including:
- `"Blacklist: Possible (inherited) (66)"` — new test
- `"Blacklist: Possible (mutable contract) (66)"` — existing test unchanged
- `"Blacklist: No (100)"` — existing test unchanged

**Step 4: Commit**

```bash
git add src/lib/types.ts src/lib/report-cards.ts src/lib/__tests__/report-cards.test.ts
git commit -m "feat(report-cards): add inherited blacklist risk detection

Coins with >=25% of reserves backed by blacklistable stablecoins
(matched via coinId) now score Possible (inherited) (66) instead of
No (100). Exports isBlacklistable and INHERITED_BLACKLIST_THRESHOLD_PCT
from shared lib for use by worker call sites.

Affected coins at current threshold: DAI (33% USDC), USDS (30% USDC)."
```

---

### Task 5: Update `worker/src/api/report-cards.ts`

Remove the local `isBlacklistable` function and replace with the shared import + index build.

**Files:**
- Modify: `worker/src/api/report-cards.ts`

**Step 1: Add `isBlacklistable` and `INHERITED_BLACKLIST_THRESHOLD_PCT` to the import from `src/lib/report-cards`**

The existing import block (lines 11-24) imports from `../../../src/lib/report-cards`. Add `isBlacklistable` to it:

```ts
import {
  METHODOLOGY_VERSION,
  DIMENSION_WEIGHTS,
  PEG_MULTIPLIER_EXPONENT,
  GRADE_THRESHOLDS,
  isBlacklistable,
  scorePegStability,
  scoreLiquidity,
  scoreResilience,
  scoreDecentralization,
  scoreDependencyRisk,
  computeOverallGrade,
  resolveResilienceFactors,
  resolveGovernanceQuality,
} from "../../../src/lib/report-cards";
```

**Step 2: Delete the local `isBlacklistable` block**

Remove lines 44–51 entirely (the `// Blacklistability helper` comment block and function).

**Step 3: Build the index once before the per-coin loop**

In `handleReportCards`, find where the coin loop starts (the `for` loop over coins, around line 140+). Immediately before it, insert:

```ts
  // Build first-order blacklistable index once. Uses isBlacklistable without
  // the index arg → only explicit overrides + centralized governance, no recursion.
  const blacklistableIds: ReadonlySet<string> = new Set(
    TRACKED_STABLECOINS
      .filter(m => isBlacklistable(m) === true)
      .map(m => m.id)
  );
```

**Step 4: Pass index to every `isBlacklistable(meta)` call in the handler**

Find the line (around line 276):
```ts
  const canBeBlacklisted = isBlacklistable(meta);
```
Change to:
```ts
  const canBeBlacklisted = isBlacklistable(meta, blacklistableIds);
```

**Step 5: Type-check the worker**

```bash
cd worker && npx tsc --noEmit
```
Expected: no errors.

**Step 6: Commit**

```bash
git add worker/src/api/report-cards.ts
git commit -m "feat(worker): use shared isBlacklistable with reserve inheritance in report-cards handler"
```

---

### Task 6: Update `worker/src/cron/daily-digest.ts`

Replace the two inline `canBl` computations with the shared function + index.

**Files:**
- Modify: `worker/src/cron/daily-digest.ts`

**Step 1: Add `isBlacklistable` to the import from `src/lib/report-cards`**

The existing import block (lines 6-14). Add `isBlacklistable`:

```ts
import {
  scorePegStability,
  scoreLiquidity,
  scoreResilience,
  scoreDecentralization,
  scoreDependencyRisk,
  computeOverallGrade,
  scoreToGrade,
  isBlacklistable,
} from "../../../src/lib/report-cards";
```

**Step 2: Build the index once before Phase 1 loop**

Find the Phase 1 loop (`// Phase 1:` comment, before the first `canBl` at line ~502). Insert the index build immediately before it:

```ts
    const blacklistableIds: ReadonlySet<string> = new Set(
      TRACKED_STABLECOINS
        .filter(m => isBlacklistable(m) === true)
        .map(m => m.id)
    );
```

**Step 3: Replace both inline `canBl` expressions**

There are exactly two occurrences of the inline expression. Replace each:

```ts
// BEFORE (line ~502 and ~542):
const canBl = meta.canBeBlacklisted !== undefined ? meta.canBeBlacklisted : (meta.flags.governance as string) === "centralized";

// AFTER (both occurrences):
const canBl = isBlacklistable(meta, blacklistableIds);
```

**Step 4: Type-check**

```bash
cd worker && npx tsc --noEmit
```
Expected: no errors.

**Step 5: Commit**

```bash
git add worker/src/cron/daily-digest.ts
git commit -m "feat(worker): use shared isBlacklistable with reserve inheritance in daily-digest"
```

---

### Task 7: Update `worker/src/cron/sync-yield-data.ts`

Same pattern as Task 6.

**Files:**
- Modify: `worker/src/cron/sync-yield-data.ts`

**Step 1: Add `isBlacklistable` to the import from `src/lib/report-cards`**

Existing import block (lines 20-23):
```ts
import {
  computeOverallGrade, scoreDecentralization, scoreDependencyRisk,
  scoreLiquidity, scorePegStability, scoreResilience,
  isBlacklistable,
} from "../../../src/lib/report-cards";
```

**Step 2: Build the index once before the Phase 1 loop**

Find the Phase 1 coin loop (look for the first `canBl` near line ~532). Insert before it:

```ts
    const blacklistableIds: ReadonlySet<string> = new Set(
      TRACKED_STABLECOINS
        .filter(m => isBlacklistable(m) === true)
        .map(m => m.id)
    );
```

**Step 3: Replace both inline `canBl` expressions**

Same as Task 6 — two occurrences:
```ts
// BEFORE:
const canBl = meta.canBeBlacklisted !== undefined ? meta.canBeBlacklisted : (meta.flags.governance as string) === "centralized";

// AFTER:
const canBl = isBlacklistable(meta, blacklistableIds);
```

**Step 4: Type-check the full worker**

```bash
cd worker && npx tsc --noEmit
```
Expected: no errors.

**Step 5: Run frontend tests one final time**

```bash
npm test
```
Expected: all pass.

**Step 6: Full build check**

```bash
npm run build
```
Expected: builds cleanly.

**Step 7: Commit**

```bash
git add worker/src/cron/sync-yield-data.ts
git commit -m "feat(worker): use shared isBlacklistable with reserve inheritance in sync-yield-data"
```

---

### Task 8: Update `docs/report-cards.md`

**Files:**
- Modify: `docs/report-cards.md`

**Step 1: Find the Resilience / Blacklist section**

Search for "Blacklist" in the doc. There will be a description of the three tiers (Yes / Possible / No). Add the fourth tier and threshold:

```markdown
| Value | Score | Condition |
|---|---|---|
| Yes | 33 | `canBeBlacklisted: true` (explicit) or `governance === "centralized"` |
| Possible (mutable contract) | 66 | `canBeBlacklisted: "possible"` (explicit override) |
| Possible (inherited) | 66 | ≥25% of reserves backed by blacklistable coins (via `coinId` lookup) |
| No | 100 | None of the above |
```

Also note: `"possible-inherited"` is a **computed** value only — it never appears as a manual override in `stablecoins.ts`.

**Step 2: Lint check**

```bash
npm run lint
```
Expected: no errors.

**Step 3: Commit**

```bash
git add docs/report-cards.md
git commit -m "docs(report-cards): document inherited blacklist tier and 25% threshold"
```

---

## Verification Checklist

- [ ] `npm test` — all tests green
- [ ] `npm run build` — no TypeScript errors
- [ ] `cd worker && npx tsc --noEmit` — no worker type errors
- [ ] `npm run lint` — clean
- [ ] DAI detail page shows "Possible (inherited)" in Resilience breakdown
- [ ] USDS detail page shows "Possible (inherited)"
- [ ] USDC/USDT still show "Yes (33)" (not affected)
- [ ] GHO still shows "No (100)" (13% < 25% threshold)
