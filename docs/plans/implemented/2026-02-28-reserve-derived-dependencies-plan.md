# Reserve-Derived Dependencies — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Derive stablecoin dependency weights from curated reserve composition data, replacing manually-maintained `dependencies` arrays that have drifted from reality.

**Architecture:** Add `coinId` and `depType` fields to `ReserveSlice`. A new `deriveDependencies()` function in `reserve-templates.ts` converts reserve slices with `coinId` into `DependencyWeight[]` at runtime. All consumers of `meta.dependencies` switch to this function. Manual `dependencies` serves as fallback only for coins without reserve-linked data.

**Tech Stack:** TypeScript, Vitest, existing report-card scoring pipeline.

**Design doc:** `docs/plans/2026-02-28-reserve-derived-dependencies-design.md`

---

### Task 1: Extend ReserveSlice Type

**Files:**
- Modify: `src/lib/types.ts:76-80`

**Step 1: Add coinId and depType to ReserveSlice**

In `src/lib/types.ts`, the `ReserveSlice` interface is at lines 76-80. Add two optional fields:

```typescript
export interface ReserveSlice {
  name: string;
  pct: number;        // percentage of total reserves (should sum to ~100)
  risk: ReserveRisk;  // risk tier for coloring
  coinId?: string;           // DefiLlama ID of a tracked stablecoin (links to dependency graph)
  depType?: DependencyType;  // dependency type when coinId is set; defaults to "collateral"
}
```

**Step 2: Verify types compile**

Run: `npm run build`
Expected: PASS (no consumers use the new fields yet)

**Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat(types): add coinId and depType fields to ReserveSlice"
```

---

### Task 2: Implement deriveDependencies Function (TDD)

**Files:**
- Create: `src/lib/__tests__/reserve-templates.test.ts`
- Modify: `src/lib/reserve-templates.ts:1,103`

**Step 1: Write failing tests**

Create `src/lib/__tests__/reserve-templates.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { deriveDependencies } from "../reserve-templates";
import type { StablecoinMeta, DependencyWeight } from "../types";

// Minimal helper — only fields deriveDependencies reads
function makeMeta(overrides: Partial<StablecoinMeta> = {}): StablecoinMeta {
  return {
    id: "test",
    name: "Test",
    symbol: "TST",
    flags: { governance: "centralized", backing: "rwa-backed", pegCurrency: "USD", yieldBearing: false, rwa: true, navToken: false },
    ...overrides,
  } as StablecoinMeta;
}

describe("deriveDependencies", () => {
  it("returns empty array when no reserves and no dependencies", () => {
    const meta = makeMeta();
    expect(deriveDependencies(meta)).toEqual([]);
  });

  it("falls back to manual dependencies when reserves is empty", () => {
    const deps: DependencyWeight[] = [{ id: "2", weight: 0.5 }];
    const meta = makeMeta({ dependencies: deps, reserves: [] });
    expect(deriveDependencies(meta)).toEqual(deps);
  });

  it("falls back to manual dependencies when no reserve has coinId", () => {
    const deps: DependencyWeight[] = [{ id: "1", weight: 0.3 }];
    const meta = makeMeta({
      dependencies: deps,
      reserves: [
        { name: "U.S. Treasuries", pct: 80, risk: "very-low" },
        { name: "Cash", pct: 20, risk: "very-low" },
      ],
    });
    expect(deriveDependencies(meta)).toEqual(deps);
  });

  it("derives dependencies from reserve coinId, ignoring manual dependencies", () => {
    const meta = makeMeta({
      dependencies: [{ id: "2", weight: 0.1 }], // stale manual entry
      reserves: [
        { name: "USDtb", pct: 90, risk: "low", coinId: "221" },
        { name: "USDC buffer", pct: 10, risk: "low", coinId: "2" },
      ],
    });
    const result = deriveDependencies(meta);
    expect(result).toEqual([
      { id: "221", weight: 0.9, type: "collateral" },
      { id: "2", weight: 0.1, type: "collateral" },
    ]);
  });

  it("only includes slices with coinId, skips non-linked slices", () => {
    const meta = makeMeta({
      reserves: [
        { name: "ETH / stETH", pct: 45, risk: "low" },
        { name: "BTC", pct: 25, risk: "very-low" },
        { name: "SOL", pct: 10, risk: "high" },
        { name: "USDC", pct: 15, risk: "low", coinId: "2" },
        { name: "USDT", pct: 5, risk: "low", coinId: "1" },
      ],
    });
    const result = deriveDependencies(meta);
    expect(result).toEqual([
      { id: "2", weight: 0.15, type: "collateral" },
      { id: "1", weight: 0.05, type: "collateral" },
    ]);
  });

  it("preserves depType when set (wrapper)", () => {
    const meta = makeMeta({
      reserves: [
        { name: "USDe", pct: 100, risk: "low", coinId: "146", depType: "wrapper" },
      ],
    });
    const result = deriveDependencies(meta);
    expect(result).toEqual([
      { id: "146", weight: 1.0, type: "wrapper" },
    ]);
  });

  it("preserves depType when set (mechanism)", () => {
    const meta = makeMeta({
      reserves: [
        { name: "USDC PSM", pct: 30, risk: "low", coinId: "2", depType: "mechanism" },
        { name: "ETH / LSTs", pct: 70, risk: "low" },
      ],
    });
    const result = deriveDependencies(meta);
    expect(result).toEqual([
      { id: "2", weight: 0.3, type: "mechanism" },
    ]);
  });

  it("returns empty array when no reserves and no dependencies (undefined)", () => {
    const meta = makeMeta({ reserves: undefined, dependencies: undefined });
    expect(deriveDependencies(meta)).toEqual([]);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- src/lib/__tests__/reserve-templates.test.ts`
Expected: FAIL — `deriveDependencies` is not exported from `reserve-templates`

**Step 3: Implement deriveDependencies**

In `src/lib/reserve-templates.ts`, add the import for `DependencyWeight` at line 1 and the function after `getReserves` (after line 103):

At line 1, update the import:
```typescript
import type { DependencyWeight, ReserveSlice, StablecoinMeta } from "./types";
```

After line 103, add:
```typescript

// ── Dependency derivation from reserves ───────────────────────────────

/**
 * Derives dependency weights from reserve composition.
 * Reserve slices with `coinId` are converted to DependencyWeight entries.
 * Falls back to manual `meta.dependencies` when no reserves have coinId links.
 */
export function deriveDependencies(meta: StablecoinMeta): DependencyWeight[] {
  const reserves = meta.reserves;
  if (!reserves?.length) return meta.dependencies ?? [];

  const linked = reserves.filter((r) => r.coinId);
  if (linked.length === 0) return meta.dependencies ?? [];

  return linked.map((r) => ({
    id: r.coinId!,
    weight: r.pct / 100,
    type: r.depType ?? "collateral",
  }));
}
```

**Step 4: Run tests to verify they pass**

Run: `npm test -- src/lib/__tests__/reserve-templates.test.ts`
Expected: PASS — all 8 tests green

**Step 5: Commit**

```bash
git add src/lib/__tests__/reserve-templates.test.ts src/lib/reserve-templates.ts
git commit -m "feat: add deriveDependencies function with tests"
```

---

### Task 3: Wire deriveDependencies into Scoring Pipeline

**Files:**
- Modify: `src/lib/report-cards.ts:536`
- Modify: `worker/src/api/report-cards.ts:1,241-247,315,328,347`

**Step 1: Update scoreDependencyRisk to accept derived deps**

In `src/lib/report-cards.ts`, the function `scoreDependencyRisk` at line 536 reads `meta.dependencies` directly. Change it to use `deriveDependencies`:

Add the import at the top of the file (alongside existing imports from `./reserve-templates`):
```typescript
import { deriveDependencies } from "./reserve-templates";
```

At line 536, change:
```typescript
  const deps = meta.dependencies;
```
to:
```typescript
  const deps = deriveDependencies(meta);
```

**Step 2: Update worker report-cards API — graph edges**

In `worker/src/api/report-cards.ts`, add the import at the top:
```typescript
import { deriveDependencies } from "../../src/lib/reserve-templates";
```

At lines 241-247, change the edge-building loop:
```typescript
  for (const meta of TRACKED_STABLECOINS) {
    const deps = deriveDependencies(meta);
    for (const dep of deps) {
      edges.push({ from: dep.id, to: meta.id });
    }
  }
```

**Step 3: Update worker report-cards API — rawInputs**

At line 315, change:
```typescript
    dependencies: meta.dependencies ?? [],
```
to:
```typescript
    dependencies: deriveDependencies(meta),
```

**Step 4: Update worker report-cards API — card dependencies property**

At line 328, change:
```typescript
    ...(meta.dependencies && meta.dependencies.length > 0 ? { dependencies: meta.dependencies } : {}),
```
to:
```typescript
    ...(() => { const d = deriveDependencies(meta); return d.length > 0 ? { dependencies: d } : {}; })(),
```

**Step 5: Update worker report-cards API — topological sort**

At line 347, change:
```typescript
    for (const dep of meta.dependencies ?? []) {
```
to:
```typescript
    for (const dep of deriveDependencies(meta)) {
```

Add the import for `deriveDependencies` at the top of `worker/src/api/report-cards.ts` if not already done in step 2.

**Step 6: Verify everything compiles**

Run: `npm run build && cd worker && npx tsc --noEmit`
Expected: PASS — no type errors

**Step 7: Run existing tests**

Run: `npm test`
Expected: PASS — no behavior change yet (no coinId data populated)

**Step 8: Commit**

```bash
git add src/lib/report-cards.ts worker/src/api/report-cards.ts
git commit -m "feat: wire deriveDependencies into scoring and graph pipeline"
```

---

### Task 4: Add scoreDependencyRisk Tests for Reserve-Derived Dependencies

**Files:**
- Modify: `src/lib/__tests__/report-cards.test.ts`

**Step 1: Add test for reserve-derived scoring**

Append to `src/lib/__tests__/report-cards.test.ts`:

```typescript
import { scoreDependencyRisk } from "../report-cards";

describe("scoreDependencyRisk — reserve-derived dependencies", () => {
  it("scores 95 when no dependencies and no reserves", () => {
    const meta = makeMeta();
    const scores = new Map<string, number>();
    const result = scoreDependencyRisk(meta, scores);
    expect(result.score).toBe(95);
  });

  it("uses coinId-linked reserves instead of manual dependencies", () => {
    const meta = makeMeta({
      dependencies: [{ id: "2", weight: 0.1 }], // stale: only 10% USDC
      reserves: [
        { name: "USDtb", pct: 90, risk: "low", coinId: "221" },
        { name: "USDC", pct: 10, risk: "low", coinId: "2" },
      ],
    });
    const scores = new Map([["221", 85], ["2", 95]]);
    const result = scoreDependencyRisk(meta, scores);
    // Blended: 0.9 * 85 + 0.1 * 95 = 86, self-backed = 0
    expect(result.score).toBe(86);
    expect(result.detail).toContain("2 upstream");
  });

  it("falls back to manual dependencies when reserves have no coinId", () => {
    const meta = makeMeta({
      dependencies: [{ id: "2", weight: 0.5 }],
      reserves: [
        { name: "U.S. Treasuries", pct: 80, risk: "very-low" },
        { name: "Cash", pct: 20, risk: "very-low" },
      ],
    });
    const scores = new Map([["2", 90]]);
    const result = scoreDependencyRisk(meta, scores);
    // 50% USDC (90) + 50% self-backed (95 for centralized) = 92.5 → 93
    expect(result.score).toBe(93);
  });

  it("applies wrapper ceiling from reserve depType", () => {
    const meta = makeMeta({
      flags: { governance: "centralized-dependent", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false },
      reserves: [
        { name: "USDe", pct: 100, risk: "low", coinId: "146", depType: "wrapper" },
      ],
    });
    const scores = new Map([["146", 80]]);
    const result = scoreDependencyRisk(meta, scores);
    // Wrapper ceiling: 80 - 3 = 77
    expect(result.score).toBe(77);
    expect(result.detail).toContain("wrapper dependency ceiling");
  });
});
```

**Step 2: Run tests**

Run: `npm test -- src/lib/__tests__/report-cards.test.ts`
Expected: PASS — all tests green

**Step 3: Commit**

```bash
git add src/lib/__tests__/report-cards.test.ts
git commit -m "test: add scoreDependencyRisk tests for reserve-derived dependencies"
```

---

### Task 5: Populate coinId on Reserve Data — Batch 1 (High-Impact Mismatches)

**Files:**
- Modify: `src/lib/stablecoins.ts`

This is the data migration. Work through the 22 known mismatches first. For each coin, add `coinId` to the reserve slices that reference tracked stablecoins, and remove the now-redundant `dependencies` field.

**Reference: Tracked stablecoin IDs for linking:**
- USDT = `"1"`, USDC = `"2"`, DAI = `"5"`, FRAX = `"6"`, crvUSD = `"14"`, DOLA = `"15"`, GHO = `"118"`, USDe = `"146"`, BUIDL = `"173"`, USD0 = `"195"`, USDS = `"209"`, USDtb = `"221"`, USYC = `"237"`, FRXUSD = `"235"`, M0 = check ID

**Approach:** For each coin below, find its entry in `src/lib/stablecoins.ts`, add `coinId` (and `depType` if non-collateral) to the relevant reserve slices, then delete the `dependencies` line.

**Coins to migrate (listed by ID — look up line numbers with grep):**

1. **JupUSD (335)**: reserves `USDtb → coinId: "221"`, `USDC → coinId: "2"`. Remove `dependencies: [{ id: "2", weight: 0.1 }]`.
2. **MegaUSD (342)**: reserves `USDtb → coinId: "221"`, `USDC/USDT → coinId: "2"` and `coinId: "1"` (split the 10% liquid stables if possible, or add coinId to the combined slice). Remove old dependencies.
3. **USD0 (195)**: reserves `USYC → coinId: "237"`, `M by M0 → check ID`, `USDtb → coinId: "221"`, `BUIDL → coinId: "173"`, `OUSG → check ID`, `USDC → coinId: "2"`. Remove old dependencies.
4. **FRAX (6)**: reserves that mention BUIDL → `coinId: "173"`, USDC → `coinId: "2"`. Adjust existing dependencies accordingly.
5. **FRXUSD (235)**: similar to FRAX. BUIDL → `coinId: "173"`, USDC → `coinId: "2"`.
6. **USDtb (221)**: reserves `BUIDL → coinId: "173"`, `USDC → coinId: "2"`. Add coinId (currently has no dependencies).
7. **USDO (241)**: reserves `BUIDL → coinId: "173"`, `USDC → coinId: "2"`. Add coinId.
8. **CASH (316)**: reserves mention tokenized treasuries (BUIDL). Add coinId.
9. **USDH (321)**: reserves mention tokenized treasuries (BUIDL). Add coinId.
10. **rwaUSDi (340)**: reserves mention BUIDL, USDY, OUSG. Add coinIds.
11. **CUSD (296)**: reserves mention BUIDL. Add coinId.

**For each coin:**
1. Grep for the coin ID in `src/lib/stablecoins.ts` to find exact line
2. Add `coinId` to relevant reserve slices
3. Delete the `dependencies` line
4. Verify the build passes

**Step (final): Verify build + tests**

Run: `npm run build && npm test`
Expected: PASS

**Commit:**

```bash
git add src/lib/stablecoins.ts
git commit -m "data: populate coinId on reserves for high-impact mismatch coins"
```

---

### Task 6: Populate coinId on Reserve Data — Batch 2 (Zero-Dependency Coins)

**Files:**
- Modify: `src/lib/stablecoins.ts`

**Coins with zero dependencies but reserves referencing tracked stablecoins:**

1. **GUSD (306)**: reserves mention USDT/USDC
2. **U (336)**: reserves mention USDC, USDT
3. **YLDS (272)**: reserves mention USDC, USDT
4. **ZeUSD (225)**: reserves mention USYC
5. **avUSD (271)**: reserves mention USDC
6. **cgUSD (166)**: reserves mention USDC/USDT
7. **pUSD (266)**: reserves mention USDC

For each coin, add `coinId` to the relevant reserve slices. These coins have no `dependencies` to remove.

**Step (final): Verify build + tests**

Run: `npm run build && npm test`
Expected: PASS

**Commit:**

```bash
git add src/lib/stablecoins.ts
git commit -m "data: populate coinId on reserves for coins with zero dependencies"
```

---

### Task 7: Populate coinId on Reserve Data — Batch 3 (Remaining Coins)

**Files:**
- Modify: `src/lib/stablecoins.ts`

Go through ALL remaining coins that have `reserves` and `dependencies` set. For each:
1. Add `coinId` to any reserve slice that references a tracked stablecoin
2. Add `depType: "wrapper"` for wrapper dependencies (check current `dependencies` entries with `type: "wrapper"`)
3. Add `depType: "mechanism"` for mechanism dependencies (check current `dependencies` entries with `type: "mechanism"`)
4. Remove the `dependencies` field

**Key wrapper coins to check:** sUSDe, sDAI, sUSDS, wUSDM, USDC.e, USDT.e, sFRAX, sfrxETH, and any coin with `type: "wrapper"` in current dependencies.

**Key mechanism coins to check:** USDS (209) has `{ id: "2", weight: 0.30, type: "mechanism" }`, DAI (5) has `{ id: "2", weight: 0.35, type: "mechanism" }`.

**Approach:**
1. First, grep for all `type: "wrapper"` entries to identify all wrapper coins
2. Then grep for all `type: "mechanism"` entries to identify all mechanism coins
3. Process each group, ensuring `depType` is set correctly on the reserve slice
4. Process remaining coins (all `type: "collateral"` or default) — just add `coinId`, no `depType` needed

**Step (final): Verify build + tests**

Run: `npm run build && npm test`
Expected: PASS

**Commit:**

```bash
git add src/lib/stablecoins.ts
git commit -m "data: populate coinId on all remaining reserves, remove redundant dependencies"
```

---

### Task 8: Build-Time Validation

**Files:**
- Create: `src/lib/__tests__/reserve-coinid-validation.test.ts`

Add a test that catches future drift:

```typescript
import { describe, it, expect } from "vitest";
import { TRACKED_STABLECOINS } from "../stablecoins";

// Known stablecoin tickers that should be linked when referenced in reserves
const KNOWN_TICKERS = ["USDC", "USDT", "DAI", "FRAX", "USDe", "USDtb", "BUIDL", "USDS", "USYC", "OUSG", "DOLA", "GHO", "crvUSD", "FRXUSD", "USD0"];

describe("reserve coinId validation", () => {
  it("no coin has both dependencies and reserve-linked coinIds", () => {
    const conflicts: string[] = [];
    for (const meta of TRACKED_STABLECOINS) {
      const hasManualDeps = meta.dependencies && meta.dependencies.length > 0;
      const hasLinkedReserves = meta.reserves?.some((r) => r.coinId);
      if (hasManualDeps && hasLinkedReserves) {
        conflicts.push(`${meta.symbol} (${meta.id}): has both dependencies and reserve coinIds`);
      }
    }
    expect(conflicts).toEqual([]);
  });

  it("warns about reserve names that look like tracked stablecoins without coinId", () => {
    const warnings: string[] = [];
    for (const meta of TRACKED_STABLECOINS) {
      if (!meta.reserves) continue;
      for (const slice of meta.reserves) {
        if (slice.coinId) continue; // already linked
        const upperName = slice.name.toUpperCase();
        for (const ticker of KNOWN_TICKERS) {
          if (upperName.includes(ticker.toUpperCase()) && !upperName.includes("NON-" + ticker.toUpperCase())) {
            warnings.push(`${meta.symbol} (${meta.id}): reserve "${slice.name}" mentions ${ticker} but has no coinId`);
          }
        }
      }
    }
    // This test intentionally logs warnings rather than failing hard,
    // to catch newly added reserves that forgot coinId.
    // If you see warnings here, add coinId to the relevant reserve slice.
    if (warnings.length > 0) {
      console.warn("Reserve slices that may need coinId:\n" + warnings.join("\n"));
    }
    // Fail if more than a reasonable threshold of unlinked references exist
    // Adjust threshold as more reserves get linked
    expect(warnings.length).toBeLessThan(10);
  });
});
```

**Step 1: Run test**

Run: `npm test -- src/lib/__tests__/reserve-coinid-validation.test.ts`
Expected: PASS (after tasks 5-7 populated coinIds)

**Step 2: Commit**

```bash
git add src/lib/__tests__/reserve-coinid-validation.test.ts
git commit -m "test: add build-time validation for reserve coinId completeness"
```

---

### Task 9: Update Documentation

**Files:**
- Modify: `docs/report-cards.md` — dependency-risk section
- Modify: `docs/architecture.md` — note ReserveSlice type changes

**Step 1: Update docs/report-cards.md**

Find the dependency-risk section and add a note explaining that dependencies are now derived from reserve composition data via `coinId` links on `ReserveSlice`, with fallback to manual `dependencies` for coins without reserves.

**Step 2: Update docs/architecture.md**

Note the new `coinId` and `depType` fields on `ReserveSlice` in the types section.

**Step 3: Commit**

```bash
git add docs/report-cards.md docs/architecture.md
git commit -m "docs: update report-cards and architecture docs for reserve-derived dependencies"
```

---

### Task 10: Migration Verification — Before/After Score Comparison

**Files:**
- One-off verification, no permanent files

**Step 1: Capture current scores**

Before the data migration tasks (5-7), use the live API to capture current dependency-risk scores:

Run: `curl -s https://api.pharos.watch/api/report-cards | jq '[.cards[] | {id, symbol: .name, depRisk: .dimensions.dependencyRisk.score}]' > /tmp/scores-before.json`

**Step 2: After migration, run local worker and capture new scores**

Run: `cd worker && npx wrangler dev` (in background)
Then: `curl -s http://localhost:8787/api/report-cards | jq '[.cards[] | {id, symbol: .name, depRisk: .dimensions.dependencyRisk.score}]' > /tmp/scores-after.json`

**Step 3: Diff the scores**

Run: `jq -s '.[0] as $before | .[1] as $after | [$after[] | . as $a | ($before[] | select(.id == $a.id)) as $b | select($b.depRisk != $a.depRisk) | {id: $a.id, name: $a.symbol, before: $b.depRisk, after: $a.depRisk, delta: ($a.depRisk - $b.depRisk)}] | sort_by(.delta)' /tmp/scores-before.json /tmp/scores-after.json`

**Step 4: Review the diff**

Review the output. Expected changes:
- Coins that gained new dependencies (e.g., JupUSD gaining USDtb) will see score changes
- Coins where weights changed significantly will show deltas
- No coin should drop to 0 or spike to 100 unexpectedly

This is a review artifact — no commit needed.

---

### Task 11: Final Verification

**Step 1: Full build**

Run: `npm run build`
Expected: PASS

**Step 2: Full test suite**

Run: `npm test`
Expected: PASS

**Step 3: Lint**

Run: `npm run lint`
Expected: PASS

**Step 4: Worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: PASS
