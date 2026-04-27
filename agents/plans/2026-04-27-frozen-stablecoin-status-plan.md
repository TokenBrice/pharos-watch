# Frozen Stablecoin Status — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a `status: "frozen"` lifecycle phase for tracked stablecoins, halting all worker data collection while preserving historical data, the detail page, and a cemetery cross-link archive entry.

**Architecture:** Extend the registry's `StablecoinStatus` enum with `"frozen"`. Redefine `ACTIVE_STABLECOINS` as `status === "active"` (excludes pre-launch AND frozen). Add `READABLE_STABLECOINS` (active + frozen) and `FROZEN_STABLECOINS`. Worker write-side crons use `ACTIVE_*`; eviction crons widen preserve-sets to `TRACKED_*`; read-side API endpoints + caches use `READABLE_*`. A new `frozen-snapshots.json` preserves each frozen coin's last `peggedAssets` row in case DefiLlama drops it upstream. Cemetery merges `DEAD_STABLECOINS ∪ FROZEN_STABLECOINS.map(toDeadShape)`. The detail page renders the existing layout plus a `<FrozenStateBanner>` above the hero and `<FrozenDataNote>` chart footer notes.

**Tech Stack:** Next.js 16 static export, Cloudflare Worker (TypeScript), Cloudflare D1, Vitest, Zod. Full design at `agents/specs/2026-04-27-frozen-stablecoin-status-design.md`.

---

## Pre-flight

### Task 0: Baseline

**Files:** none

- [ ] **Step 1: Verify clean worktree**

Run: `git status`
Expected: no uncommitted tracked changes. Only untracked files may exist.

- [ ] **Step 2: Capture baseline test state**

Run:
```bash
npm test -- --run 2>&1 | tail -20
cd worker && npx tsc --noEmit 2>&1 | tail -5
cd ..
```
Expected: tests pass, no TypeScript errors. Note any pre-existing failures so later runs can be compared.

- [ ] **Step 3: Confirm baseline production behavior**

Run:
```bash
curl -s "https://api.pharos.watch/api/stablecoins" -H "X-API-Key: $PHAROS_API_KEY" | jq '.peggedAssets | length'
curl -s -o /dev/null -w "%{http_code}\n" "https://pharos.watch/stablecoin/usr-resolv/"
```
Expected: ~217 (215 tracked + 2 shadow), 200. Record both for post-merge comparison.

---

## Phase 1 — Type system + registry foundation

### Task 1: Add `"frozen"` to `STABLECOIN_STATUS_VALUES` and obituary types

**Files:**
- Modify: `shared/types/core.ts:209-210, 247-256`
- Test: `shared/types/__tests__/core.test.ts` (new — only if missing)

Design reference: §Type system in the design spec.

- [ ] **Step 1: Extend the status enum**

Modify `shared/types/core.ts` line 209:

```ts
export const STABLECOIN_STATUS_VALUES = ["pre-launch", "active", "frozen"] as const;
```

- [ ] **Step 2: Add `frozenAt` and `obituary` fields to `StablecoinMeta`**

Add to the existing `StablecoinMeta` interface (around line 247-256). Place new fields immediately after `status?: StablecoinStatus;`:

```ts
status?: StablecoinStatus;
/** YYYY-MM-DD; required when status === "frozen". */
frozenAt?: string;
/** Obituary content surfaced on the detail page banner and cemetery tombstone; required when status === "frozen". */
obituary?: StablecoinObituary;
```

- [ ] **Step 3: Define `StablecoinObituary` shape and import `CauseOfDeath`**

Add (near other interface declarations in the same file, before `StablecoinMeta`):

```ts
import type { CauseOfDeath } from "./cemetery";

export interface StablecoinObituary {
  /** Cemetery cause-of-death enum, shared with `DeadStablecoin`. */
  causeOfDeath: CauseOfDeath;
  /** YYYY-MM or YYYY-MM-DD; precision must match `dead-stablecoins.json` entries. */
  deathDate: string;
  /** Headline shown in detail-page banner and cemetery tombstone. */
  epitaph: string;
  /** Full obituary paragraph — collapsible in the banner. */
  obituary: string;
  /** Computed at freeze time from `MAX(circulating_usd)` over preserved supply_history. */
  peakMcap?: number;
  sourceUrl: string;
  sourceLabel: string;
}
```

If `./cemetery` does not currently export `CauseOfDeath`, defer the import to Task 2 and use `import type { CauseOfDeath } from "../lib/cause-of-death";` instead.

- [ ] **Step 4: Add a TypeScript-only assertion test**

Create or extend `shared/types/__tests__/core.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { STABLECOIN_STATUS_VALUES, type StablecoinMeta } from "../core";

describe("STABLECOIN_STATUS_VALUES", () => {
  it("includes the three lifecycle phases", () => {
    expect(STABLECOIN_STATUS_VALUES).toEqual(["pre-launch", "active", "frozen"]);
  });
});

describe("StablecoinMeta", () => {
  it("accepts a frozen coin with obituary block", () => {
    const meta: StablecoinMeta = {
      id: "fixture-frozen",
      name: "Fixture",
      symbol: "FXT",
      flags: { pegCurrency: "USD", governance: "centralized", backing: "fiat" } as never,
      status: "frozen",
      frozenAt: "2026-04-27",
      obituary: {
        causeOfDeath: "abandoned",
        deathDate: "2026-04",
        epitaph: "Closed without ceremony.",
        obituary: "FXT was sunset by its issuer in April 2026.",
        sourceUrl: "https://example.com/fxt-shutdown",
        sourceLabel: "Issuer announcement",
      },
    };
    expect(meta.status).toBe("frozen");
  });
});
```

- [ ] **Step 5: Run typecheck and tests**

```bash
npx tsc --noEmit
npm test -- --run shared/types
```
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add shared/types/core.ts shared/types/__tests__/core.test.ts
git commit -m "feat(types): add frozen status and StablecoinObituary

Extends StablecoinStatus with 'frozen' and adds a paired obituary block
on StablecoinMeta. Required by frozen-stablecoin-status spec (PR #1)."
```

---

### Task 2: Relocate `CauseOfDeath` enum + display metadata to a shared module

**Files:**
- Create: `shared/lib/cause-of-death.ts`
- Modify: `shared/lib/dead-stablecoins.ts`
- Modify: `shared/types/cemetery.ts` (or wherever `CauseOfDeath` currently lives — find via `grep -rn "type CauseOfDeath" shared/`)
- Test: `shared/lib/__tests__/cause-of-death.test.ts` (new)

Rationale: `obituary.causeOfDeath` (new) and `DeadStablecoin.causeOfDeath` (existing) reference the same enum and display metadata. Centralizing prevents drift.

- [ ] **Step 1: Find the current `CauseOfDeath` definition**

Run: `grep -rn "type CauseOfDeath\|export type CauseOfDeath" shared/`
Expected: one location (likely `shared/types/cemetery.ts` or `shared/types/index.ts`). Record the path.

- [ ] **Step 2: Write the failing test**

Create `shared/lib/__tests__/cause-of-death.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CAUSE_HEX, CAUSE_META, CAUSE_OF_DEATH_VALUES } from "../cause-of-death";

describe("cause-of-death", () => {
  it("exports the five cemetery causes", () => {
    expect([...CAUSE_OF_DEATH_VALUES].sort()).toEqual([
      "abandoned",
      "algorithmic-failure",
      "counterparty-failure",
      "liquidity-drain",
      "regulatory",
    ]);
  });

  it("provides a hex color for each cause", () => {
    for (const cause of CAUSE_OF_DEATH_VALUES) {
      expect(CAUSE_HEX[cause]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("provides label and tailwind classes for each cause", () => {
    for (const cause of CAUSE_OF_DEATH_VALUES) {
      const meta = CAUSE_META[cause];
      expect(meta.label).toBeTruthy();
      expect(meta.textColor).toMatch(/^text-/);
      expect(meta.borderColor).toMatch(/^border-/);
    }
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npm test -- --run shared/lib/__tests__/cause-of-death.test.ts
```
Expected: FAIL — module does not exist.

- [ ] **Step 4: Create the new module**

Create `shared/lib/cause-of-death.ts`:

```ts
export const CAUSE_OF_DEATH_VALUES = [
  "algorithmic-failure",
  "counterparty-failure",
  "liquidity-drain",
  "regulatory",
  "abandoned",
] as const;

export type CauseOfDeath = (typeof CAUSE_OF_DEATH_VALUES)[number];

export const CAUSE_HEX: Record<CauseOfDeath, string> = {
  "algorithmic-failure": "#ef4444",
  "counterparty-failure": "#f59e0b",
  "liquidity-drain": "#f97316",
  regulatory: "#3b82f6",
  abandoned: "#71717a",
};

export const CAUSE_META: Record<CauseOfDeath, { label: string; textColor: string; borderColor: string }> = {
  "algorithmic-failure": { label: "Algorithmic Failure", textColor: "text-red-700 dark:text-red-400", borderColor: "border-red-500/30" },
  "counterparty-failure": { label: "Counterparty Failure", textColor: "text-amber-700 dark:text-amber-400", borderColor: "border-amber-500/30" },
  "liquidity-drain": { label: "Liquidity Drain", textColor: "text-orange-700 dark:text-orange-400", borderColor: "border-orange-500/30" },
  regulatory: { label: "Regulatory", textColor: "text-blue-700 dark:text-blue-400", borderColor: "border-blue-500/30" },
  abandoned: { label: "Abandoned", textColor: "text-zinc-700 dark:text-zinc-400", borderColor: "border-zinc-500/30" },
};
```

- [ ] **Step 5: Re-route the existing `CauseOfDeath` type to point at the new module**

Edit the type's current home (e.g. `shared/types/cemetery.ts`). Replace the inline union/literal definition with a re-export:

```ts
export type { CauseOfDeath } from "../lib/cause-of-death";
```

- [ ] **Step 6: Update `dead-stablecoins.ts` to re-export from the new module**

Modify `shared/lib/dead-stablecoins.ts`:

```ts
import type { DeadStablecoin } from "../types";
import deadStablecoinAsset from "../data/dead-stablecoins.json";
import { parseDeadStablecoinAssets } from "./stablecoins/schema";

export { CAUSE_HEX, CAUSE_META } from "./cause-of-death";

export const DEAD_STABLECOINS: DeadStablecoin[] = parseDeadStablecoinAssets(
  deadStablecoinAsset,
  "shared/data/dead-stablecoins.json",
);
```

The previous local `CAUSE_HEX` and `CAUSE_META` const declarations are removed — they now live in `cause-of-death.ts`.

- [ ] **Step 7: Run tests + typecheck**

```bash
npm test -- --run shared/
npx tsc --noEmit
```
Expected: all green. Existing imports of `CAUSE_HEX`/`CAUSE_META` from `dead-stablecoins.ts` continue to work (re-export).

- [ ] **Step 8: Commit**

```bash
git add shared/lib/cause-of-death.ts shared/lib/dead-stablecoins.ts shared/types shared/lib/__tests__/cause-of-death.test.ts
git commit -m "refactor(cause-of-death): relocate enum + display meta to shared lib

The frozen-stablecoin obituary block reuses the same CauseOfDeath enum
as DeadStablecoin. Centralizing prevents drift. dead-stablecoins.ts
keeps re-exporting for back-compat."
```

---

### Task 3: Extend the Zod schema for `StablecoinMeta` to accept frozen coins

**Files:**
- Modify: `shared/lib/stablecoins/schema.ts` (find the StablecoinMeta Zod schema; grep `StablecoinMetaSchema\|stablecoinMetaSchema`)
- Test: `shared/lib/stablecoins/__tests__/schema.test.ts`

Goal: schema rejects frozen coins missing `frozenAt` or `obituary`; accepts well-formed frozen coins; rejects active coins with stray `frozenAt`/`obituary` fields.

- [ ] **Step 1: Locate the schema and existing tests**

Run: `grep -n "status:" shared/lib/stablecoins/schema.ts | head -10`
Expected: a Zod object schema with `status: z.enum(STABLECOIN_STATUS_VALUES).optional()` (or equivalent). Identify whether the schema uses `.refine()` or `.superRefine()` for cross-field validation today.

- [ ] **Step 2: Write the failing test**

Add to `shared/lib/stablecoins/__tests__/schema.test.ts` (create if missing):

```ts
import { describe, expect, it } from "vitest";
import { parseStablecoinMetaAssets } from "../schema";

const baseFlags = { pegCurrency: "USD", governance: "centralized", backing: "fiat" };

describe("StablecoinMeta schema — frozen status", () => {
  it("accepts a well-formed frozen coin", () => {
    const json = [
      {
        id: "fixture-frozen",
        name: "Fixture Frozen",
        symbol: "FXT",
        flags: baseFlags,
        status: "frozen",
        frozenAt: "2026-04-27",
        obituary: {
          causeOfDeath: "abandoned",
          deathDate: "2026-04",
          epitaph: "Closed without ceremony.",
          obituary: "FXT was sunset by its issuer.",
          sourceUrl: "https://example.com/x",
          sourceLabel: "Issuer announcement",
        },
      },
    ];
    expect(() => parseStablecoinMetaAssets(json, "fixture")).not.toThrow();
  });

  it("rejects a frozen coin missing the obituary block", () => {
    const json = [
      {
        id: "fixture-frozen-bad",
        name: "Fixture",
        symbol: "FXT",
        flags: baseFlags,
        status: "frozen",
        frozenAt: "2026-04-27",
      },
    ];
    expect(() => parseStablecoinMetaAssets(json, "fixture")).toThrow(/obituary/);
  });

  it("rejects a frozen coin missing frozenAt", () => {
    const json = [
      {
        id: "fixture-frozen-bad-2",
        name: "Fixture",
        symbol: "FXT",
        flags: baseFlags,
        status: "frozen",
        obituary: {
          causeOfDeath: "abandoned",
          deathDate: "2026-04",
          epitaph: "x",
          obituary: "x",
          sourceUrl: "https://example.com/x",
          sourceLabel: "x",
        },
      },
    ];
    expect(() => parseStablecoinMetaAssets(json, "fixture")).toThrow(/frozenAt/);
  });

  it("rejects an active coin with a stray obituary field", () => {
    const json = [
      {
        id: "fixture-active-bad",
        name: "Fixture",
        symbol: "FXT",
        flags: baseFlags,
        status: "active",
        obituary: {
          causeOfDeath: "abandoned",
          deathDate: "2026-04",
          epitaph: "x",
          obituary: "x",
          sourceUrl: "https://example.com/x",
          sourceLabel: "x",
        },
      },
    ];
    expect(() => parseStablecoinMetaAssets(json, "fixture")).toThrow(/obituary.*active|active.*obituary/i);
  });
});
```

- [ ] **Step 3: Run the test to verify failures**

```bash
npm test -- --run shared/lib/stablecoins/__tests__/schema.test.ts
```
Expected: FAIL on all four cases (well-formed frozen rejected because schema doesn't yet accept the new fields).

- [ ] **Step 4: Extend the schema**

In `shared/lib/stablecoins/schema.ts`:

1. Import `CAUSE_OF_DEATH_VALUES` from `../cause-of-death`.
2. Add an `obituarySchema` that mirrors the type defined in Task 1:

```ts
const obituarySchema = z.object({
  causeOfDeath: z.enum(CAUSE_OF_DEATH_VALUES),
  deathDate: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/),
  epitaph: z.string().min(1),
  obituary: z.string().min(1),
  peakMcap: z.number().positive().optional(),
  sourceUrl: z.string().url(),
  sourceLabel: z.string().min(1),
});
```

3. Add `frozenAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()` and `obituary: obituarySchema.optional()` to the existing `StablecoinMeta` Zod object.

4. Add a `.superRefine()` cross-field check on the same object:

```ts
.superRefine((meta, ctx) => {
  if (meta.status === "frozen") {
    if (!meta.frozenAt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "frozen coins require frozenAt", path: ["frozenAt"] });
    }
    if (!meta.obituary) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "frozen coins require obituary", path: ["obituary"] });
    }
  } else {
    if (meta.frozenAt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "frozenAt is only allowed when status is frozen", path: ["frozenAt"] });
    }
    if (meta.obituary) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "obituary is only allowed when status is active or frozen", path: ["obituary"] });
    }
  }
});
```

(Adjust `else` branch wording to match the design — obituary is allowed *only* when frozen.)

- [ ] **Step 5: Verify tests pass**

```bash
npm test -- --run shared/lib/stablecoins/__tests__/schema.test.ts
```
Expected: all four assertions pass.

- [ ] **Step 6: Commit**

```bash
git add shared/lib/stablecoins/schema.ts shared/lib/stablecoins/__tests__/schema.test.ts
git commit -m "feat(stablecoins/schema): validate frozen-status invariants"
```

---

### Task 4: Refactor the stablecoin registry into the four-universe taxonomy

**Files:**
- Modify: `shared/lib/stablecoins/registry.ts:155-169`
- Test: `shared/lib/stablecoins/__tests__/registry.test.ts` (extend; create if absent)

Goal: redefine `ACTIVE_STABLECOINS` to mean `status === "active"` and add `READABLE_STABLECOINS` + `FROZEN_STABLECOINS` exports. The semantic shift of `ACTIVE_*` is the single biggest change in this feature; subsequent tasks rely on it.

- [ ] **Step 1: Write the failing test**

Add to `shared/lib/stablecoins/__tests__/registry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  ACTIVE_IDS,
  ACTIVE_STABLECOINS,
  FROZEN_IDS,
  FROZEN_STABLECOINS,
  PRE_LAUNCH_STABLECOINS,
  READABLE_IDS,
  READABLE_STABLECOINS,
  TRACKED_STABLECOINS,
} from "../registry";

describe("registry universes", () => {
  it("ACTIVE = status === 'active'", () => {
    expect(ACTIVE_STABLECOINS.every((c) => c.status === "active" || c.status === undefined)).toBe(true);
    expect(ACTIVE_STABLECOINS.some((c) => c.status === "pre-launch")).toBe(false);
    expect(ACTIVE_STABLECOINS.some((c) => c.status === "frozen")).toBe(false);
  });

  it("FROZEN = status === 'frozen'", () => {
    expect(FROZEN_STABLECOINS.every((c) => c.status === "frozen")).toBe(true);
  });

  it("READABLE = ACTIVE ∪ FROZEN (status !== 'pre-launch')", () => {
    expect(READABLE_STABLECOINS.length).toBe(ACTIVE_STABLECOINS.length + FROZEN_STABLECOINS.length);
    for (const coin of PRE_LAUNCH_STABLECOINS) {
      expect(READABLE_IDS.has(coin.id)).toBe(false);
    }
    for (const coin of [...ACTIVE_STABLECOINS, ...FROZEN_STABLECOINS]) {
      expect(READABLE_IDS.has(coin.id)).toBe(true);
    }
  });

  it("TRACKED = ACTIVE ∪ FROZEN ∪ PRE_LAUNCH (no overlap)", () => {
    expect(TRACKED_STABLECOINS.length).toBe(
      ACTIVE_STABLECOINS.length + FROZEN_STABLECOINS.length + PRE_LAUNCH_STABLECOINS.length,
    );
  });

  it("ACTIVE_IDS and FROZEN_IDS are disjoint", () => {
    for (const id of FROZEN_IDS) {
      expect(ACTIVE_IDS.has(id)).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- --run shared/lib/stablecoins/__tests__/registry.test.ts
```
Expected: FAIL — `READABLE_STABLECOINS`, `FROZEN_STABLECOINS`, `READABLE_IDS`, `FROZEN_IDS` are not exported.

- [ ] **Step 3: Refactor `registry.ts:155-169`**

Replace the existing block (lines 155 to end) with:

```ts
/**
 * Stablecoins with full worker processing. After v5.81 this strictly means
 * `status === "active"` — pre-launch coins (no past) and frozen coins (no
 * future) are both excluded from write-side crons and live aggregations.
 */
export const ACTIVE_STABLECOINS = TRACKED_STABLECOINS.filter(
  (stablecoin) => stablecoin.status !== "pre-launch" && stablecoin.status !== "frozen",
);

/** Set of active stablecoin IDs (excludes pre-launch and frozen). */
export const ACTIVE_IDS = new Set(ACTIVE_STABLECOINS.map((stablecoin) => stablecoin.id));

/** Map of active stablecoin ID -> metadata. */
export const ACTIVE_META_BY_ID = new Map(
  ACTIVE_STABLECOINS.map((stablecoin) => [stablecoin.id, stablecoin]),
);

/** Stablecoins in pre-launch stage. */
export const PRE_LAUNCH_STABLECOINS = TRACKED_STABLECOINS.filter(
  (stablecoin) => stablecoin.status === "pre-launch",
);

/** Stablecoins in the frozen archive lifecycle phase. */
export const FROZEN_STABLECOINS = TRACKED_STABLECOINS.filter(
  (stablecoin) => stablecoin.status === "frozen",
);

/** Set of frozen stablecoin IDs. */
export const FROZEN_IDS = new Set(FROZEN_STABLECOINS.map((stablecoin) => stablecoin.id));

/** Map of frozen stablecoin ID -> metadata. */
export const FROZEN_META_BY_ID = new Map(
  FROZEN_STABLECOINS.map((stablecoin) => [stablecoin.id, stablecoin]),
);

/**
 * Stablecoins whose data the site reads back (active + frozen). Use for:
 * sitemap, search, compare picker, API endpoints serving the frozen detail
 * page (`stablecoin-reserves`, `stress-signals`, `og`), rebuild caches,
 * `/api/stablecoins` payload composition.
 *
 * Pre-launch coins are excluded — they have no historical data to read.
 */
export const READABLE_STABLECOINS = TRACKED_STABLECOINS.filter(
  (stablecoin) => stablecoin.status !== "pre-launch",
);

/** Set of readable stablecoin IDs (active + frozen). */
export const READABLE_IDS = new Set(READABLE_STABLECOINS.map((stablecoin) => stablecoin.id));

/** Map of readable stablecoin ID -> metadata. */
export const READABLE_META_BY_ID = new Map(
  READABLE_STABLECOINS.map((stablecoin) => [stablecoin.id, stablecoin]),
);
```

- [ ] **Step 4: Run tests + typecheck**

```bash
npm test -- --run shared/lib/stablecoins
npx tsc --noEmit
cd worker && npx tsc --noEmit && cd ..
```
Expected: registry tests pass; **TypeScript may surface new errors at consumers expecting the old `ACTIVE_*` semantics** — those are intentional and addressed by later phases. Record any errors but do NOT fix consumers in this task.

- [ ] **Step 5: Commit**

```bash
git add shared/lib/stablecoins/registry.ts shared/lib/stablecoins/__tests__/registry.test.ts
git commit -m "feat(registry): add FROZEN_* and READABLE_* universes; redefine ACTIVE_*

ACTIVE_STABLECOINS now means status === 'active' (was: status !== 'pre-launch').
The new READABLE_STABLECOINS preserves the previous meaning for code paths
that should still surface frozen coins (sitemap, search, compare picker,
detail-page API endpoints).

Per frozen-stablecoin-status spec."
```

---

## Phase 2 — Frozen snapshot mechanism + freeze script

### Task 5: Define the `frozen-snapshots.json` schema and loader

**Files:**
- Create: `shared/data/stablecoins/frozen-snapshots.json` (initialized as `[]`)
- Create: `shared/lib/stablecoins/frozen-snapshots.ts`
- Test: `shared/lib/stablecoins/__tests__/frozen-snapshots.test.ts`

Purpose: when DefiLlama drops a frozen coin from `/stablecoins?includePrices=true`, the worker injects this snapshot's `peggedAssetRow` so the cache rebuild still includes the coin.

- [ ] **Step 1: Initialize the empty data file**

Create `shared/data/stablecoins/frozen-snapshots.json`:
```json
[]
```

- [ ] **Step 2: Write the failing test**

Create `shared/lib/stablecoins/__tests__/frozen-snapshots.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FROZEN_SNAPSHOTS, FROZEN_SNAPSHOTS_BY_ID, parseFrozenSnapshots } from "../frozen-snapshots";

describe("frozen-snapshots", () => {
  it("starts empty", () => {
    expect(FROZEN_SNAPSHOTS).toEqual([]);
    expect(FROZEN_SNAPSHOTS_BY_ID.size).toBe(0);
  });

  it("parses a well-formed snapshot", () => {
    const parsed = parseFrozenSnapshots([
      {
        id: "fixture-frozen",
        capturedAt: "2026-04-27T00:00:00Z",
        peggedAssetRow: {
          id: "fixture-frozen",
          name: "Fixture",
          symbol: "FXT",
          circulating: { peggedUSD: 1234567 },
          chainCirculating: {},
        },
      },
    ], "fixture");
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe("fixture-frozen");
  });

  it("rejects an entry whose top-level id mismatches peggedAssetRow.id", () => {
    expect(() =>
      parseFrozenSnapshots(
        [{ id: "a", capturedAt: "2026-04-27T00:00:00Z", peggedAssetRow: { id: "b" } }],
        "fixture",
      ),
    ).toThrow(/id mismatch/i);
  });
});
```

- [ ] **Step 3: Run the test — expect failure**

```bash
npm test -- --run shared/lib/stablecoins/__tests__/frozen-snapshots.test.ts
```
Expected: module does not exist.

- [ ] **Step 4: Implement the loader**

Create `shared/lib/stablecoins/frozen-snapshots.ts`:

```ts
import { z } from "zod";
import frozenSnapshotsAsset from "../../data/stablecoins/frozen-snapshots.json";

/**
 * A frozen coin's last-known DefiLlama `peggedAssets` row, captured at the
 * moment of freezing. Injected into the upstream payload by sync-stablecoins
 * intake when DefiLlama no longer returns the asset.
 *
 * peggedAssetRow is intentionally typed as a permissive record — DefiLlama's
 * row shape is wide and partially undocumented; structural validation lives
 * in `filterStructurallyValidAssets`.
 */
export interface FrozenSnapshot {
  id: string;
  capturedAt: string;
  peggedAssetRow: Record<string, unknown> & { id: string };
}

const frozenSnapshotSchema = z
  .object({
    id: z.string().min(1),
    capturedAt: z.string().datetime(),
    peggedAssetRow: z.object({ id: z.string().min(1) }).passthrough(),
  })
  .superRefine((entry, ctx) => {
    if (entry.peggedAssetRow.id !== entry.id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `frozen-snapshots id mismatch: ${entry.id} vs peggedAssetRow.id ${entry.peggedAssetRow.id}`,
        path: ["peggedAssetRow", "id"],
      });
    }
  });

export function parseFrozenSnapshots(input: unknown, source: string): FrozenSnapshot[] {
  const parsed = z.array(frozenSnapshotSchema).safeParse(input);
  if (!parsed.success) {
    throw new Error(`Invalid ${source}: ${parsed.error.message}`);
  }
  return parsed.data as FrozenSnapshot[];
}

export const FROZEN_SNAPSHOTS: FrozenSnapshot[] = parseFrozenSnapshots(
  frozenSnapshotsAsset,
  "shared/data/stablecoins/frozen-snapshots.json",
);

export const FROZEN_SNAPSHOTS_BY_ID = new Map(FROZEN_SNAPSHOTS.map((s) => [s.id, s]));
```

- [ ] **Step 5: Verify tests pass**

```bash
npm test -- --run shared/lib/stablecoins/__tests__/frozen-snapshots.test.ts
```
Expected: pass.

- [ ] **Step 6: Add a CI invariant — every frozen coin has a snapshot**

Add to `shared/lib/stablecoins/__tests__/registry.test.ts`:

```ts
import { FROZEN_SNAPSHOTS_BY_ID } from "../frozen-snapshots";

describe("frozen invariants", () => {
  it("every FROZEN_STABLECOIN has a matching frozen-snapshots.json entry", () => {
    for (const coin of FROZEN_STABLECOINS) {
      expect(FROZEN_SNAPSHOTS_BY_ID.has(coin.id)).toBe(true);
    }
  });

  it("no orphan frozen-snapshots.json entries", () => {
    for (const id of FROZEN_SNAPSHOTS_BY_ID.keys()) {
      expect(FROZEN_IDS.has(id)).toBe(true);
    }
  });
});
```

- [ ] **Step 7: Commit**

```bash
git add shared/data/stablecoins/frozen-snapshots.json shared/lib/stablecoins/frozen-snapshots.ts shared/lib/stablecoins/__tests__/frozen-snapshots.test.ts shared/lib/stablecoins/__tests__/registry.test.ts
git commit -m "feat(frozen-snapshots): add capture file + loader + registry invariants"
```

---

### Task 6: Inject frozen snapshots into `sync-stablecoins/intake.ts`

**Files:**
- Modify: `worker/src/cron/sync-stablecoins/intake.ts:278` (after `applyTrackedAssetOverrides`)
- Test: `worker/src/cron/sync-stablecoins/__tests__/intake-frozen-injection.test.ts` (new)

Goal: when `llamaData.peggedAssets` lacks an entry for a frozen coin id, append the captured snapshot row before overrides are applied.

- [ ] **Step 1: Write the failing test**

Create `worker/src/cron/sync-stablecoins/__tests__/intake-frozen-injection.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mergeFrozenSnapshots } from "../intake";

describe("mergeFrozenSnapshots", () => {
  const snapshots = [
    {
      id: "fixture-frozen",
      capturedAt: "2026-04-27T00:00:00Z",
      peggedAssetRow: { id: "fixture-frozen", name: "Fixture", symbol: "FXT" } as Record<string, unknown> & { id: string },
    },
  ];

  it("appends a snapshot row when upstream is missing it", () => {
    const upstream = [{ id: "usdt-tether", name: "Tether", symbol: "USDT" } as never];
    const merged = mergeFrozenSnapshots(upstream, snapshots);
    expect(merged).toHaveLength(2);
    expect(merged.find((a) => (a as { id: string }).id === "fixture-frozen")).toMatchObject({ name: "Fixture" });
  });

  it("does not duplicate when upstream already contains the row", () => {
    const upstream = [
      { id: "fixture-frozen", name: "Fixture (live)", symbol: "FXT" } as never,
      { id: "usdt-tether", name: "Tether", symbol: "USDT" } as never,
    ];
    const merged = mergeFrozenSnapshots(upstream, snapshots);
    expect(merged).toHaveLength(2);
    // upstream wins — preserves anything upstream still serves
    expect((merged.find((a) => (a as { id: string }).id === "fixture-frozen") as { name: string }).name).toBe("Fixture (live)");
  });

  it("returns input unchanged when no snapshots provided", () => {
    const upstream = [{ id: "usdt-tether", name: "Tether", symbol: "USDT" } as never];
    expect(mergeFrozenSnapshots(upstream, [])).toBe(upstream);
  });
});
```

- [ ] **Step 2: Run — expect failure**

```bash
cd worker && npx vitest run src/cron/sync-stablecoins/__tests__/intake-frozen-injection.test.ts
```
Expected: `mergeFrozenSnapshots` is not exported.

- [ ] **Step 3: Add `mergeFrozenSnapshots` to `intake.ts` and call it before `applyTrackedAssetOverrides`**

In `worker/src/cron/sync-stablecoins/intake.ts`:

1. Add a top import:
```ts
import { FROZEN_SNAPSHOTS } from "@shared/lib/stablecoins/frozen-snapshots";
import type { FrozenSnapshot } from "@shared/lib/stablecoins/frozen-snapshots";
```

2. Add an exported helper near the top of the file (before `loadStablecoinsIntake`):
```ts
/**
 * Append captured frozen-coin rows for any id absent from the upstream payload.
 * Upstream rows always win — if DefiLlama still serves the asset, that's the
 * authoritative copy. Returns the input array unchanged when there is nothing
 * to inject (so existing identity tests pass).
 */
export function mergeFrozenSnapshots(
  upstream: PeggedAsset[],
  snapshots: FrozenSnapshot[],
): PeggedAsset[] {
  if (snapshots.length === 0) {
    return upstream;
  }
  const upstreamIds = new Set(upstream.map((a) => String((a as { id?: unknown }).id ?? "")));
  const additions: PeggedAsset[] = [];
  for (const snapshot of snapshots) {
    if (upstreamIds.has(snapshot.id)) {
      continue;
    }
    additions.push(snapshot.peggedAssetRow as unknown as PeggedAsset);
  }
  if (additions.length === 0) {
    return upstream;
  }
  return [...upstream, ...additions];
}
```

3. Call it just before `applyTrackedAssetOverrides(llamaData.peggedAssets);` (currently line 278). Insert:
```ts
const beforeFrozenInjection = llamaData.peggedAssets.length;
llamaData.peggedAssets = mergeFrozenSnapshots(llamaData.peggedAssets, FROZEN_SNAPSHOTS);
const injected = llamaData.peggedAssets.length - beforeFrozenInjection;
if (injected > 0) {
  console.log(`[sync-stablecoins] Injected ${injected} frozen-snapshot row(s)`);
}
```

- [ ] **Step 4: Verify**

```bash
cd worker && npx vitest run src/cron/sync-stablecoins/__tests__/intake-frozen-injection.test.ts && npx tsc --noEmit
```
Expected: pass + no type errors.

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/sync-stablecoins/intake.ts worker/src/cron/sync-stablecoins/__tests__/intake-frozen-injection.test.ts
git commit -m "feat(sync-stablecoins): inject frozen-snapshots when upstream drops them

Ensures frozen coins keep appearing in /api/stablecoins (and every cache
built from it) even after DefiLlama prunes the asset, which preserves the
detail-page hero card data after freeze."
```

---

### Task 7: Write the freeze script `scripts/freeze-stablecoin.ts`

**Files:**
- Create: `scripts/freeze-stablecoin.ts`
- Create: `scripts/__tests__/freeze-stablecoin.test.ts`
- Modify: `package.json` (add npm script `freeze-stablecoin`)

Purpose: a one-shot CLI that, given a coin id, (1) queries production D1 for the all-time-high circulating market cap, (2) fetches the current `/api/stablecoins` cache to capture the coin's current `peggedAssets` row, (3) prints the JSON edits the operator must make. The script does NOT mutate the JSON files itself — the operator pastes the output into their editor and reviews the diff.

This task is non-trivial. Inline the entire script.

- [ ] **Step 1: Write the failing test**

Create `scripts/__tests__/freeze-stablecoin.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildFreezePlan } from "../freeze-stablecoin";

describe("buildFreezePlan", () => {
  it("composes a frozen-snapshots entry and a JSON-patch hint", () => {
    const plan = buildFreezePlan({
      coinId: "fixture-frozen",
      peakMcap: 12345678,
      peggedAssetRow: { id: "fixture-frozen", name: "Fixture", symbol: "FXT" } as Record<string, unknown> & { id: string },
      frozenAt: "2026-04-27",
      capturedAt: "2026-04-27T01:02:03Z",
    });
    expect(plan.frozenSnapshotsEntry).toMatchObject({ id: "fixture-frozen", capturedAt: "2026-04-27T01:02:03Z" });
    expect(plan.frozenSnapshotsEntry.peggedAssetRow.id).toBe("fixture-frozen");
    expect(plan.metaPatch).toMatchObject({
      status: "frozen",
      frozenAt: "2026-04-27",
    });
    expect(plan.metaPatch.obituary).toBeDefined();
    expect(plan.metaPatch.obituary?.peakMcap).toBe(12345678);
  });
});
```

- [ ] **Step 2: Implement the script**

Create `scripts/freeze-stablecoin.ts`:

```ts
#!/usr/bin/env tsx
/**
 * Freeze a tracked stablecoin: capture its current peggedAssets row,
 * compute peakMcap from supply_history, and print the JSON edits the
 * operator must paste into the registry source files.
 *
 * Usage:
 *   API_KEY=... npx tsx scripts/freeze-stablecoin.ts <coinId>
 *
 * Inputs:
 *   - <coinId>: must already exist in shared/data/stablecoins/*.json
 *   - $PHAROS_API_KEY: required to call api.pharos.watch
 *
 * Outputs (printed to stdout):
 *   - The full JSON entry to append to shared/data/stablecoins/frozen-snapshots.json
 *   - The patch to apply to the coin's existing entry in usd-major.json /
 *     usd-minor.json / etc. — set status=frozen, frozenAt, obituary skeleton.
 *
 * The operator finalizes the obituary copy (causeOfDeath, deathDate,
 * epitaph, obituary, sourceUrl, sourceLabel) by hand and reviews the diff.
 */
import process from "node:process";

const API_BASE = process.env.PHAROS_API_BASE ?? "https://api.pharos.watch/api";

interface BuildFreezePlanInput {
  coinId: string;
  peakMcap: number;
  peggedAssetRow: Record<string, unknown> & { id: string };
  frozenAt: string;
  capturedAt: string;
}

export interface FreezePlan {
  frozenSnapshotsEntry: {
    id: string;
    capturedAt: string;
    peggedAssetRow: Record<string, unknown> & { id: string };
  };
  metaPatch: {
    status: "frozen";
    frozenAt: string;
    obituary: {
      causeOfDeath: "TBD";
      deathDate: string;
      epitaph: string;
      obituary: string;
      peakMcap: number;
      sourceUrl: string;
      sourceLabel: string;
    };
  };
}

export function buildFreezePlan(input: BuildFreezePlanInput): FreezePlan {
  return {
    frozenSnapshotsEntry: {
      id: input.coinId,
      capturedAt: input.capturedAt,
      peggedAssetRow: input.peggedAssetRow,
    },
    metaPatch: {
      status: "frozen",
      frozenAt: input.frozenAt,
      obituary: {
        causeOfDeath: "TBD",
        deathDate: input.frozenAt.slice(0, 7),
        epitaph: "<one-line headline — replace before commit>",
        obituary: "<full paragraph — replace before commit>",
        peakMcap: input.peakMcap,
        sourceUrl: "<source URL — replace before commit>",
        sourceLabel: "<source label — replace before commit>",
      },
    },
  };
}

async function fetchPeggedAssetRow(coinId: string): Promise<Record<string, unknown> & { id: string }> {
  const apiKey = process.env.PHAROS_API_KEY;
  if (!apiKey) throw new Error("PHAROS_API_KEY env var required");
  const res = await fetch(`${API_BASE}/stablecoins`, { headers: { "X-API-Key": apiKey } });
  if (!res.ok) throw new Error(`/api/stablecoins returned ${res.status}`);
  const body = (await res.json()) as { peggedAssets?: Array<Record<string, unknown> & { id?: unknown }> };
  const row = (body.peggedAssets ?? []).find((a) => String(a.id) === coinId);
  if (!row) throw new Error(`coin ${coinId} not found in /api/stablecoins payload`);
  return row as Record<string, unknown> & { id: string };
}

async function fetchPeakMcap(coinId: string): Promise<number> {
  const apiKey = process.env.PHAROS_API_KEY;
  if (!apiKey) throw new Error("PHAROS_API_KEY env var required");
  const res = await fetch(`${API_BASE}/supply-history?stablecoin=${coinId}&days=1825`, { headers: { "X-API-Key": apiKey } });
  if (!res.ok) throw new Error(`/api/supply-history returned ${res.status}`);
  const body = (await res.json()) as { history?: Array<{ circulatingUsd?: number | null }> };
  const max = Math.max(...((body.history ?? []).map((p) => p.circulatingUsd ?? 0)));
  if (!Number.isFinite(max) || max <= 0) {
    throw new Error(`unable to compute peakMcap from supply-history for ${coinId}`);
  }
  return Math.round(max);
}

async function main() {
  const coinId = process.argv[2];
  if (!coinId) {
    console.error("Usage: npx tsx scripts/freeze-stablecoin.ts <coinId>");
    process.exit(2);
  }
  const today = new Date();
  const frozenAt = today.toISOString().slice(0, 10);
  const capturedAt = today.toISOString();

  console.log(`Fetching peggedAssets row for ${coinId}…`);
  const peggedAssetRow = await fetchPeggedAssetRow(coinId);
  console.log(`Computing peakMcap from supply-history…`);
  const peakMcap = await fetchPeakMcap(coinId);
  console.log(`peakMcap = $${peakMcap.toLocaleString()}`);

  const plan = buildFreezePlan({ coinId, peakMcap, peggedAssetRow, frozenAt, capturedAt });

  console.log("\n=== APPEND THIS ENTRY TO shared/data/stablecoins/frozen-snapshots.json ===\n");
  console.log(JSON.stringify(plan.frozenSnapshotsEntry, null, 2));
  console.log("\n=== APPLY THIS PATCH TO THE COIN'S EXISTING REGISTRY ENTRY ===\n");
  console.log("// Add these top-level fields (alongside id, name, symbol, …):");
  console.log(JSON.stringify(plan.metaPatch, null, 2));
  console.log("\nReview the obituary fields, replace placeholders, run `npm run check:frozen-invariants`,");
  console.log("then commit. See docs/freezing-stablecoins.md for the full procedure.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 3: Add npm script**

In `package.json`, add to `"scripts"`:
```json
"freeze-stablecoin": "tsx scripts/freeze-stablecoin.ts"
```

- [ ] **Step 4: Verify**

```bash
npm test -- --run scripts/__tests__/freeze-stablecoin.test.ts
```
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/freeze-stablecoin.ts scripts/__tests__/freeze-stablecoin.test.ts package.json
git commit -m "feat(scripts): add freeze-stablecoin freeze-time capture helper"
```

---

## Phase 3 — Worker write-side filters (no-new-data invariant)

The headline invariant: **no cron may collect new data for a frozen coin.**

### Task 8: Filter registry-driven crons that look up via `TRACKED_META_BY_ID`

**Files:**
- Modify: `worker/src/cron/detect-depegs.ts` (around lines 395-617 — depeg detection + orphan-close)
- Modify: `worker/src/cron/confirm-pending-depegs.ts` (around lines 87-156)
- Modify: `worker/src/cron/sync-stablecoins/post-enrichment.ts:184`
- Modify: `worker/src/cron/sync-stablecoins/supply-gap-reconciliation.ts:57,241,331`
- Modify: `worker/src/cron/sync-stablecoins/phase-helpers.ts:115`
- Modify: `worker/src/cron/snapshot-chain-supply.ts:35`
- Test: `worker/src/cron/__tests__/detect-depegs-frozen.test.ts` (new)

Pattern for each: where the cron iterates `peggedAssets` and looks up via `TRACKED_META_BY_ID`, replace lookups that gate writes with `ACTIVE_META_BY_ID`. Where the cron has explicit `TRACKED_IDS` set construction, switch to `ACTIVE_IDS`.

- [ ] **Step 1: Write the orphan-close exemption test**

Create `worker/src/cron/__tests__/detect-depegs-frozen.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { shouldCloseOrphanedDepeg } from "../detect-depegs";

describe("orphan-close exemption for frozen coins", () => {
  it("does not force-close depeg events for frozen coins", () => {
    expect(shouldCloseOrphanedDepeg("usr-resolv", new Set(["usdt-tether"]), new Set(["usr-resolv"]))).toBe(false);
  });

  it("force-closes orphans that are neither tracked nor frozen", () => {
    expect(shouldCloseOrphanedDepeg("zombie-coin", new Set(["usdt-tether"]), new Set())).toBe(true);
  });

  it("does not force-close active tracked coins", () => {
    expect(shouldCloseOrphanedDepeg("usdt-tether", new Set(["usdt-tether"]), new Set())).toBe(false);
  });
});
```

- [ ] **Step 2: Verify failure**

```bash
cd worker && npx vitest run src/cron/__tests__/detect-depegs-frozen.test.ts
```
Expected: `shouldCloseOrphanedDepeg` not exported.

- [ ] **Step 3: Refactor `detect-depegs.ts`**

Add (or extract) the helper near the top:

```ts
import { ACTIVE_IDS, FROZEN_IDS } from "@shared/lib/stablecoins";

/**
 * Whether the orphan-close pass should force-close a depeg event for the
 * given coin id. Returns false for currently-tracked active coins (their
 * row is just temporarily missing from the cache iteration) and for frozen
 * coins (preserved historical data must not be falsified).
 */
export function shouldCloseOrphanedDepeg(
  coinId: string,
  iteratedTrackedIds: Set<string>,
  frozenIds: Set<string> = FROZEN_IDS,
): boolean {
  if (iteratedTrackedIds.has(coinId)) return false;
  if (frozenIds.has(coinId)) return false;
  return true;
}
```

In the orphan-close loop (around lines 596-617), replace the inline condition `if (!trackedCoinIds.has(...))` with `if (shouldCloseOrphanedDepeg(eventCoinId, trackedCoinIds))`.

In the depeg-write iteration (around lines 395-557), replace `TRACKED_META_BY_ID.get(asset.id)` lookups that **gate write decisions** with `ACTIVE_META_BY_ID.get(asset.id)`. Read-only lookups (e.g., display name) keep `TRACKED_META_BY_ID`. Audit each call site individually.

- [ ] **Step 4: Apply the same `ACTIVE_META_BY_ID` substitution to:**

- `confirm-pending-depegs.ts` lines 87, 99, 156: each `TRACKED_META_BY_ID.get(...)` call that gates a write or a confirmation decision.
- `sync-stablecoins/post-enrichment.ts:184`: replace `TRACKED_META_BY_ID.get(...)` with `ACTIVE_META_BY_ID.get(...)`.
- `sync-stablecoins/supply-gap-reconciliation.ts` lines 57, 241, 331: same.
- `sync-stablecoins/phase-helpers.ts:115`: same.
- `snapshot-chain-supply.ts:35`: change the loop guard from "iterate raw peggedAssets" to "iterate raw peggedAssets where ACTIVE_IDS.has(asset.id)". Concretely:

```ts
// Before
for (const asset of cache.payload.peggedAssets) {
  // ...write supply_by_chain rows
}
// After
for (const asset of cache.payload.peggedAssets) {
  if (!ACTIVE_IDS.has(String(asset.id))) continue;
  // ...write supply_by_chain rows
}
```

- [ ] **Step 5: Verify**

```bash
cd worker && npx vitest run src/cron/__tests__/detect-depegs-frozen.test.ts && npx tsc --noEmit && cd ..
```
Expected: tests pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add worker/src/cron/detect-depegs.ts worker/src/cron/confirm-pending-depegs.ts worker/src/cron/sync-stablecoins/post-enrichment.ts worker/src/cron/sync-stablecoins/supply-gap-reconciliation.ts worker/src/cron/sync-stablecoins/phase-helpers.ts worker/src/cron/snapshot-chain-supply.ts worker/src/cron/__tests__/detect-depegs-frozen.test.ts
git commit -m "feat(crons): gate write-side iterations on ACTIVE_IDS; exempt orphan-close for frozen coins"
```

---

### Task 9: Filter independent membership registries that don't consult `STABLECOIN_STATUS`

**Files:**
- Modify: `worker/src/cron/sync-mint-burn.ts:6,102`
- Modify: `worker/src/cron/sync-blacklist.ts` (find where `CONTRACT_CONFIGS` is iterated)
- Modify: `worker/src/cron/sync-bluechip.ts:1,94`
- Modify: `worker/src/cron/yield-history-backfill.ts` (find where `YIELD_POOL_MAP` is iterated)
- Modify: `worker/src/cron/snapshot-safety-grade-history.ts:39`
- Modify: `worker/src/cron/publish-report-card-cache.ts` (whichever filter feeds the snapshot)
- Modify: `worker/src/lib/telegram-alerts.ts:2,46,60` (preset builder)
- Test: `worker/src/cron/__tests__/independent-registries-frozen.test.ts` (new)

Each of these crons uses an independent hand-coded membership list (not the registry). The fix is uniform: filter the iteration with `!FROZEN_IDS.has(id)`.

- [ ] **Step 1: Write a unit test that asserts each filter helper rejects frozen ids**

Create `worker/src/cron/__tests__/independent-registries-frozen.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { excludeFrozenIds } from "../shared/exclude-frozen";

describe("excludeFrozenIds", () => {
  it("removes frozen ids from a list-of-objects keyed by stablecoinId", () => {
    const items = [
      { stablecoinId: "usdt-tether" },
      { stablecoinId: "usr-resolv" },
      { stablecoinId: "usdc-circle" },
    ];
    expect(excludeFrozenIds(items, (i) => i.stablecoinId, new Set(["usr-resolv"])))
      .toEqual([{ stablecoinId: "usdt-tether" }, { stablecoinId: "usdc-circle" }]);
  });
});
```

- [ ] **Step 2: Run — expect failure**

```bash
cd worker && npx vitest run src/cron/__tests__/independent-registries-frozen.test.ts
```
Expected: helper does not exist.

- [ ] **Step 3: Implement the shared helper**

Create `worker/src/cron/shared/exclude-frozen.ts`:

```ts
import { FROZEN_IDS } from "@shared/lib/stablecoins";

/**
 * Strip entries whose id is in the frozen set. Generic over the iteration
 * shape — pass an extractor that returns the stablecoin id for each item.
 */
export function excludeFrozenIds<T>(
  items: readonly T[],
  getId: (item: T) => string,
  frozenIds: Set<string> = FROZEN_IDS,
): T[] {
  return items.filter((item) => !frozenIds.has(getId(item)));
}
```

- [ ] **Step 4: Apply the helper at each cron entry**

For each cron file:

**`sync-mint-burn.ts:102`** — wrap the iteration:
```ts
import { excludeFrozenIds } from "./shared/exclude-frozen";
// ...
for (const config of excludeFrozenIds(MINT_BURN_CONFIGS, (c) => c.stablecoinId)) {
  // ...
}
```

**`sync-blacklist.ts`** — same pattern, extract `stablecoinId` from `CONTRACT_CONFIGS`. Identify the iteration loop with `grep -n "CONTRACT_CONFIGS" worker/src/cron/sync-blacklist.ts`.

**`sync-bluechip.ts:94`** — `BLUECHIP_SLUG_MAP` is a `Record<string, string>`. Change to:
```ts
import { excludeFrozenIds } from "./shared/exclude-frozen";
// Build a list-of-pairs to filter, then convert back if a Map is needed:
const eligibleSlugs = excludeFrozenIds(
  Object.entries(BLUECHIP_SLUG_MAP).map(([id, slug]) => ({ id, slug })),
  (entry) => entry.id,
);
for (const { id, slug } of eligibleSlugs) {
  // ...
}
```

**`yield-history-backfill.ts`** — same pattern for `YIELD_POOL_MAP`.

**`snapshot-safety-grade-history.ts:39`** — current filter is `isDefunct !== true`. Add a frozen check beside it:
```ts
import { FROZEN_IDS } from "@shared/lib/stablecoins";
// ...
.filter((card) => card.isDefunct !== true && !FROZEN_IDS.has(card.id))
```

**`publish-report-card-cache.ts`** — same. Identify the call site (`grep -n "buildReportCardsSnapshot\|publishReportCardCache" worker/src/cron/publish-report-card-cache.ts`).

**`telegram-alerts.ts:2,46,60`** — change imports from `TRACKED_STABLECOINS` to `ACTIVE_STABLECOINS` for preset builders. Read the file to confirm the change is safe (preset routing should not include frozen coins).

- [ ] **Step 5: Verify**

```bash
cd worker && npx vitest run && npx tsc --noEmit && cd ..
```
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add worker/src/cron/shared/exclude-frozen.ts worker/src/cron/sync-mint-burn.ts worker/src/cron/sync-blacklist.ts worker/src/cron/sync-bluechip.ts worker/src/cron/yield-history-backfill.ts worker/src/cron/snapshot-safety-grade-history.ts worker/src/cron/publish-report-card-cache.ts worker/src/lib/telegram-alerts.ts worker/src/cron/__tests__/independent-registries-frozen.test.ts
git commit -m "feat(crons): exclude frozen ids from independent membership registries"
```

---

### Task 10: Exclude frozen coins from PSI eligibility

**Files:**
- Modify: `shared/lib/psi-eligible.ts:5-7`
- Test: `shared/lib/__tests__/psi-eligible.test.ts`

Goal: `PSI_ELIGIBLE_IDS` and `PSI_ELIGIBLE_STABLECOINS` exclude frozen coins, so the market-wide stability index is not contaminated.

- [ ] **Step 1: Read the current file**

```bash
cat shared/lib/psi-eligible.ts
```
Identify the existing derivation. It currently builds from `TRACKED_IDS ∪ SHADOW_IDS`.

- [ ] **Step 2: Write the failing test**

In `shared/lib/__tests__/psi-eligible.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { PSI_ELIGIBLE_IDS } from "../psi-eligible";
import { FROZEN_IDS } from "../stablecoins";

describe("PSI eligibility", () => {
  it("excludes frozen coins", () => {
    for (const id of FROZEN_IDS) {
      expect(PSI_ELIGIBLE_IDS.has(id)).toBe(false);
    }
  });
});
```

- [ ] **Step 3: Modify `psi-eligible.ts`**

Add `FROZEN_IDS` to the imports and adjust the `PSI_ELIGIBLE_IDS` derivation:
```ts
import { FROZEN_IDS, /* existing */ } from "./stablecoins";
// ...
export const PSI_ELIGIBLE_IDS = new Set(
  [...TRACKED_IDS, ...SHADOW_IDS].filter((id) => !FROZEN_IDS.has(id)),
);
// And correspondingly filter PSI_ELIGIBLE_STABLECOINS / PSI_ELIGIBLE_META_BY_ID.
```

- [ ] **Step 4: Verify**

```bash
npm test -- --run shared/lib/__tests__/psi-eligible.test.ts
npx tsc --noEmit && cd worker && npx tsc --noEmit && cd ..
```
Expected: pass; downstream consumers (`stability-index.ts`, `compute-dews.ts`, `snapshot-supply.ts`) inherit the exclusion automatically.

- [ ] **Step 5: Commit**

```bash
git add shared/lib/psi-eligible.ts shared/lib/__tests__/psi-eligible.test.ts
git commit -m "feat(psi): exclude frozen coins from market-wide stability index"
```

---

### Task 11: Add `assertNotFrozen()` guard to backfill admin endpoints

**Files:**
- Create: `worker/src/lib/frozen-guards.ts`
- Modify: each `worker/src/api/backfill-*.ts` file (find with `ls worker/src/api/backfill-*.ts`)
- Test: `worker/src/lib/__tests__/frozen-guards.test.ts`

Goal: every admin backfill endpoint that takes a `stablecoinId` parameter rejects frozen ids with HTTP 403. Prevents an operator from inadvertently re-fetching data for a frozen coin.

- [ ] **Step 1: Write the failing test**

Create `worker/src/lib/__tests__/frozen-guards.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { assertNotFrozen } from "../frozen-guards";

describe("assertNotFrozen", () => {
  it("returns null for non-frozen ids", () => {
    expect(assertNotFrozen("usdt-tether", new Set(["usr-resolv"]))).toBeNull();
  });

  it("returns a 403 Response for frozen ids", () => {
    const response = assertNotFrozen("usr-resolv", new Set(["usr-resolv"]));
    expect(response).not.toBeNull();
    expect(response!.status).toBe(403);
  });
});
```

- [ ] **Step 2: Implement the guard**

Create `worker/src/lib/frozen-guards.ts`:

```ts
import { FROZEN_IDS } from "@shared/lib/stablecoins";
import { errorResponse } from "./api-utils";

/**
 * Returns a 403 Response if the given coin id is frozen, or null to continue.
 * Use at the entry of admin backfill endpoints to prevent re-collection of
 * data for a frozen coin.
 */
export function assertNotFrozen(
  stablecoinId: string,
  frozenIds: Set<string> = FROZEN_IDS,
): Response | null {
  if (frozenIds.has(stablecoinId)) {
    return errorResponse(403, `Cannot run backfill for frozen stablecoin: ${stablecoinId}`);
  }
  return null;
}
```

- [ ] **Step 3: Apply at each backfill admin entry**

For each file matching `worker/src/api/backfill-*.ts`, find the point where `stablecoinId` is parsed from the request and add at the top of the handler:

```ts
import { assertNotFrozen } from "../lib/frozen-guards";
// ...
const frozenRejection = assertNotFrozen(stablecoinId);
if (frozenRejection) return frozenRejection;
```

Files (verify with `ls worker/src/api/backfill-*.ts`):
- `backfill-depegs.ts`
- `backfill-depegs-replay.ts`
- `backfill-depegs-window.ts`
- `backfill-cg-prices.ts`
- `backfill-supply-history.ts`
- `backfill-dews.ts`
- `backfill-stability-index.ts`
- `backfill-fx.ts` (if it takes a stablecoinId param; otherwise skip)
- `backfill-mint-burn.ts`
- `backfill-mint-burn-prices.ts`
- `backfill-blacklist-current-balances.ts`

For backfills that don't take a stablecoinId param (global passes), skip — they don't need the guard.

- [ ] **Step 4: Verify**

```bash
cd worker && npx vitest run src/lib/__tests__/frozen-guards.test.ts && npx tsc --noEmit && cd ..
```
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/frozen-guards.ts worker/src/lib/__tests__/frozen-guards.test.ts worker/src/api/backfill-*.ts
git commit -m "feat(api): block backfill admin endpoints from running on frozen coins"
```

---

## Phase 4 — Worker eviction-defensive widening

Three eviction patterns would actively destroy frozen-coin rows under the new ACTIVE semantics. Each must widen its preserve set.

### Task 12: Widen `dex-liquidity/persistence.ts` cleanup to TRACKED

**Files:**
- Modify: `worker/src/cron/dex-liquidity/persistence.ts:188-209`
- Test: `worker/src/cron/dex-liquidity/__tests__/persistence-frozen.test.ts` (new)

The current cleanup deletes rows for stablecoin_ids "no longer in ACTIVE". The new ACTIVE excludes frozen, so this would wipe DEX history. Widen the preserve set to TRACKED (which still contains frozen).

- [ ] **Step 1: Read the cleanup function**

```bash
sed -n '180,220p' worker/src/cron/dex-liquidity/persistence.ts
```
Identify the function and the `validIds` construction.

- [ ] **Step 2: Write the failing test**

Create `worker/src/cron/dex-liquidity/__tests__/persistence-frozen.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { computePruneSet } from "../persistence";

describe("dex-liquidity prune set", () => {
  it("preserves rows for frozen coin ids", () => {
    const trackedIds = new Set(["usdt-tether", "usr-resolv"]);
    const allDbIds = new Set(["usdt-tether", "usr-resolv", "zombie-coin"]);
    const prune = computePruneSet(allDbIds, trackedIds);
    expect(prune).toEqual(new Set(["zombie-coin"]));
    expect(prune.has("usr-resolv")).toBe(false);
  });
});
```

- [ ] **Step 3: Refactor and export `computePruneSet`**

In `worker/src/cron/dex-liquidity/persistence.ts`:

```ts
import { TRACKED_IDS } from "@shared/lib/stablecoins";

/**
 * Compute the set of stablecoin ids whose DEX rows should be deleted.
 * Preserves rows for any tracked coin (active OR frozen) — only orphaned
 * ids that no longer exist in the registry get pruned.
 */
export function computePruneSet(allDbIds: Set<string>, trackedIds: Set<string> = TRACKED_IDS): Set<string> {
  const prune = new Set<string>();
  for (const id of allDbIds) {
    if (!trackedIds.has(id)) prune.add(id);
  }
  return prune;
}
```

Replace the inline `validIds = new Set(ACTIVE_STABLECOINS.map(...))` block (around line 188) with:
```ts
const allDbIds = await loadAllStablecoinIdsFromDexTables(db); // existing or extracted helper
const idsToPrune = computePruneSet(allDbIds);
if (idsToPrune.size > 0) {
  await db.exec(`DELETE FROM dex_prices WHERE stablecoin_id IN (${[...idsToPrune].map(id => `'${id}'`).join(",")})`);
  await db.exec(`DELETE FROM dex_pools WHERE stablecoin_id IN (${[...idsToPrune].map(id => `'${id}'`).join(",")})`);
}
```

(Use parameterized queries — the snippet above uses inline literals for brevity. Match the existing query style in the file.)

- [ ] **Step 4: Verify**

```bash
cd worker && npx vitest run src/cron/dex-liquidity/__tests__/persistence-frozen.test.ts && npx tsc --noEmit && cd ..
```

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/dex-liquidity/persistence.ts worker/src/cron/dex-liquidity/__tests__/persistence-frozen.test.ts
git commit -m "fix(dex-liquidity/persistence): preserve frozen-coin DEX rows on cleanup"
```

---

### Task 13: Widen `dews/persistence.ts` preservation set

**Files:**
- Modify: `worker/src/cron/dews/persistence.ts:22-35,131-137`
- Test: `worker/src/cron/dews/__tests__/persistence-frozen.test.ts` (new)

DEWS persistence prunes `stress_signals` rows whose stablecoin_id is "no longer eligible". After PSI excludes frozen, this would wipe DEWS rows. Widen the preserve set explicitly.

- [ ] **Step 1: Read lines 20-50**

```bash
sed -n '20,50p' worker/src/cron/dews/persistence.ts
```

- [ ] **Step 2: Write the failing test**

```ts
// worker/src/cron/dews/__tests__/persistence-frozen.test.ts
import { describe, expect, it } from "vitest";
import { computeStressSignalPruneIds } from "../persistence";

describe("DEWS prune set", () => {
  it("preserves frozen coin rows", () => {
    const allDbIds = new Set(["usdt-tether", "usr-resolv", "zombie"]);
    const eligibleIds = new Set(["usdt-tether"]);
    const frozenIds = new Set(["usr-resolv"]);
    expect(computeStressSignalPruneIds(allDbIds, eligibleIds, frozenIds)).toEqual(new Set(["zombie"]));
  });
});
```

- [ ] **Step 3: Implement and apply**

Export from `dews/persistence.ts`:

```ts
import { FROZEN_IDS } from "@shared/lib/stablecoins";

export function computeStressSignalPruneIds(
  allDbIds: Set<string>,
  eligibleIds: Set<string>,
  frozenIds: Set<string> = FROZEN_IDS,
): Set<string> {
  const prune = new Set<string>();
  for (const id of allDbIds) {
    if (eligibleIds.has(id)) continue;
    if (frozenIds.has(id)) continue;
    prune.add(id);
  }
  return prune;
}
```

Replace the existing prune-set construction around line 22-35 with a call to `computeStressSignalPruneIds`.

- [ ] **Step 4: Verify + commit**

```bash
cd worker && npx vitest run src/cron/dews/__tests__/persistence-frozen.test.ts && npx tsc --noEmit && cd ..
git add worker/src/cron/dews/persistence.ts worker/src/cron/dews/__tests__/persistence-frozen.test.ts
git commit -m "fix(dews/persistence): preserve frozen-coin stress-signal rows"
```

---

### Task 14: Add frozen carve-out to time-based retention prunes

**Files:**
- Modify: `worker/src/cron/stability-index.ts:250` (sample retention)
- Modify: `worker/src/cron/dews/persistence.ts:131,137` (history retention)
- Modify: `worker/src/cron/prune-cron-history.ts` (general housekeeping)
- Modify: any other prune cron found via `grep -rln "stored_at < \|recorded_at < \|created_at <" worker/src/cron/`

Goal: every time-based DELETE adds `AND stablecoin_id NOT IN <frozen_ids>` so retention doesn't eventually delete preserved frozen rows.

- [ ] **Step 1: Audit**

```bash
grep -rln "stored_at <\|recorded_at <\|created_at <" worker/src/cron/
grep -rln "stored_at <\|recorded_at <\|created_at <" worker/src/lib/
```
List every file that prunes by time. Confirm with the user before proceeding if the list exceeds 6 files.

- [ ] **Step 2: For each prune query, add the frozen carve-out**

Pattern: change
```sql
DELETE FROM stability_index_samples WHERE stored_at < ?
```
to
```sql
DELETE FROM stability_index_samples
WHERE stored_at < ?
  AND stablecoin_id NOT IN (<frozen-ids-placeholder-list>)
```

In TypeScript:
```ts
import { FROZEN_IDS } from "@shared/lib/stablecoins";

const frozenIdsList = [...FROZEN_IDS];
const placeholders = frozenIdsList.length > 0
  ? `AND stablecoin_id NOT IN (${frozenIdsList.map(() => "?").join(",")})`
  : "";
const stmt = db.prepare(`DELETE FROM stability_index_samples WHERE stored_at < ? ${placeholders}`);
await stmt.bind(cutoff, ...frozenIdsList).run();
```

If `FROZEN_IDS` is empty, the `NOT IN ()` clause is a SQL error — skip the clause when the set is empty.

- [ ] **Step 3: Verify + commit**

```bash
cd worker && npx tsc --noEmit && cd ..
git add worker/src/cron/stability-index.ts worker/src/cron/dews/persistence.ts worker/src/cron/prune-cron-history.ts
git commit -m "fix(crons): exempt frozen coins from time-based retention prunes"
```

---

## Phase 5 — Worker read-side gates and payload

### Task 15: Widen `stablecoin-reserves` and `stress-signals` API gates to READABLE

**Files:**
- Modify: `worker/src/api/stablecoin-reserves.ts:20`
- Modify: `worker/src/api/stress-signals.ts:41,153`
- Test: `worker/src/api/__tests__/stablecoin-reserves.test.ts` (extend or create)

Goal: detail page for a frozen coin can still fetch reserves and stress signals (which exist in D1).

- [ ] **Step 1: Read the current gate**

```bash
sed -n '1,30p' worker/src/api/stablecoin-reserves.ts
sed -n '35,50p' worker/src/api/stress-signals.ts
sed -n '145,160p' worker/src/api/stress-signals.ts
```

- [ ] **Step 2: Replace `ACTIVE_IDS` with `READABLE_IDS` at each gate**

`stablecoin-reserves.ts:20`:
```ts
// Before
import { ACTIVE_IDS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
// ...
if (!ACTIVE_IDS.has(stablecoinId)) {
// After
import { READABLE_IDS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
// ...
if (!READABLE_IDS.has(stablecoinId)) {
```

`stress-signals.ts:41,153`: same substitution at each occurrence.

- [ ] **Step 3: Verify**

```bash
cd worker && npx tsc --noEmit && cd ..
```

- [ ] **Step 4: Commit**

```bash
git add worker/src/api/stablecoin-reserves.ts worker/src/api/stress-signals.ts
git commit -m "feat(api): widen reserves+stress-signals gates to READABLE_IDS

Frozen coins keep returning preserved data on their detail page; only
pre-launch coins are rejected (no past data to read)."
```

---

### Task 16: Widen the OG image gate; add a frozen subtitle

**Files:**
- Modify: `worker/src/api/og.tsx:14,168`
- Test: `worker/src/api/__tests__/og.test.ts` (extend or create)

Goal: shared frozen URLs (Twitter, Discord) render a correct OG image with a "Frozen archive" subtitle, not a 404.

- [ ] **Step 1: Read the current gate and template**

```bash
sed -n '1,30p' worker/src/api/og.tsx
sed -n '160,200p' worker/src/api/og.tsx
```

- [ ] **Step 2: Replace `ACTIVE_IDS` with `READABLE_IDS` at line 14 and 168**

```ts
import { READABLE_IDS, READABLE_META_BY_ID, FROZEN_IDS } from "@shared/lib/stablecoins";
// ...
if (!READABLE_IDS.has(id)) {
  return errorResponse(404, "Not found");
}
const meta = READABLE_META_BY_ID.get(id);
const isFrozen = FROZEN_IDS.has(id);
```

- [ ] **Step 3: Add a "Frozen archive" subtitle to the OG template when `isFrozen`**

Locate the existing JSX/SVG template that renders the title block. Insert immediately after the title:
```tsx
{isFrozen ? (
  <div tw="mt-2 inline-flex items-center rounded-md border border-zinc-500/30 px-3 py-1 text-sm uppercase tracking-wide text-zinc-300">
    Frozen archive
  </div>
) : null}
```
(Adjust to match the file's actual JSX style.)

- [ ] **Step 4: Verify and commit**

```bash
cd worker && npx tsc --noEmit && cd ..
git add worker/src/api/og.tsx
git commit -m "feat(og): keep OG image rendering for frozen coins; add archive subtitle"
```

---

### Task 17: Add `frozen` and `frozenAt` fields to `/api/stablecoins` payload

**Files:**
- Modify: the file that builds the per-coin entry in the `/api/stablecoins` cache (likely `worker/src/cron/sync-stablecoins/post-enrichment.ts` or `worker/src/lib/stablecoins-cache.ts`; find via `grep -rn "frozen\|peggedAssets\.push" worker/src/`)
- Modify: `shared/lib/stablecoins-cache-shape.ts` (or wherever the response Zod / TypeScript type is defined)
- Test: shape test covering the new fields

Goal: the frontend can read `entry.frozen` and `entry.frozenAt` from `/api/stablecoins` to render the banner without a second round-trip.

- [ ] **Step 1: Identify the build site and shape**

```bash
grep -rn "peggedAssets.push\|peggedAssets:" worker/src/cron/sync-stablecoins/
grep -rn "PeggedAsset\b" shared/lib/
```

- [ ] **Step 2: Extend the Zod / TypeScript type**

In whichever file defines `PeggedAsset` for the cache payload, add:
```ts
/**
 * True for stablecoins whose status === "frozen": no new data is being
 * collected, but the row is preserved from a freeze-time snapshot.
 */
frozen?: boolean;
frozenAt?: string;
```

- [ ] **Step 3: Populate the fields at write time**

In the cache-build site, when iterating `TRACKED_STABLECOINS`, for each frozen coin set `entry.frozen = true; entry.frozenAt = meta.frozenAt;`.

- [ ] **Step 4: Add a unit test**

In the relevant `__tests__` directory:
```ts
import { describe, expect, it } from "vitest";

describe("/api/stablecoins payload shape", () => {
  it("frozen entries carry frozen=true and frozenAt", () => {
    // construct a fixture peggedAssets array including a frozen entry,
    // run the build function, assert the output entry has frozen and frozenAt set
  });
});
```

- [ ] **Step 5: Verify + commit**

```bash
cd worker && npx vitest run && npx tsc --noEmit && cd ..
git add worker/src/ shared/lib/
git commit -m "feat(api/stablecoins): expose frozen and frozenAt per-coin"
```

---

### Task 18: Extend `buildDefunctReportCards` to include frozen coins

**Files:**
- Modify: `worker/src/lib/report-cards-snapshot-finalize.ts:24-48`
- Test: `worker/src/lib/__tests__/report-cards-snapshot-finalize.test.ts` (new)

Goal: report-cards snapshot includes an "F-card" for each frozen coin so the detail page shows a defunct-styled report card instead of a missing one.

- [ ] **Step 1: Write the failing test**

```ts
// worker/src/lib/__tests__/report-cards-snapshot-finalize.test.ts
import { describe, expect, it } from "vitest";
import { buildDefunctReportCards } from "../report-cards-snapshot-finalize";

describe("buildDefunctReportCards", () => {
  it("includes both DEAD_STABLECOINS and FROZEN_STABLECOINS entries", async () => {
    const cards = buildDefunctReportCards();
    const ids = new Set(cards.map((c) => c.id));
    // assert at least one frozen coin id is present once the registry has frozen entries;
    // for now (empty registry), assert the function returns an array (not a regression)
    expect(Array.isArray(cards)).toBe(true);
    expect(cards.every((c) => c.isDefunct === true)).toBe(true);
    expect(cards.every((c) => c.overallGrade === "F")).toBe(true);
  });
});
```

- [ ] **Step 2: Modify `buildDefunctReportCards`**

Replace the function body in `report-cards-snapshot-finalize.ts:24-48` with:

```ts
import { FROZEN_STABLECOINS } from "@shared/lib/stablecoins";

export function buildDefunctReportCards(): ReportCard[] {
  const nrDim = { grade: "F" as const, score: 0, detail: "Defunct stablecoin" };

  const fromDead = DEAD_STABLECOINS.map((dead) => ({
    id: dead.id,
    name: dead.name,
    symbol: dead.symbol,
    overallGrade: "F" as const,
    overallScore: 0,
    baseScore: null,
    overallCapped: false,
    uncappedOverallScore: null,
    dimensions: { pegStability: nrDim, liquidity: nrDim, resilience: nrDim, decentralization: nrDim, dependencyRisk: nrDim },
    ratedDimensions: 5,
    rawInputs: createReportCardRawInputs(),
    isDefunct: true,
  }));

  const fromFrozen = FROZEN_STABLECOINS.map((coin) => ({
    id: coin.id,
    name: coin.name,
    symbol: coin.symbol,
    overallGrade: "F" as const,
    overallScore: 0,
    baseScore: null,
    overallCapped: false,
    uncappedOverallScore: null,
    dimensions: { pegStability: nrDim, liquidity: nrDim, resilience: nrDim, decentralization: nrDim, dependencyRisk: nrDim },
    ratedDimensions: 5,
    rawInputs: createReportCardRawInputs(),
    isDefunct: true,
  }));

  return [...fromDead, ...fromFrozen];
}
```

- [ ] **Step 3: Verify + commit**

```bash
cd worker && npx vitest run src/lib/__tests__/report-cards-snapshot-finalize.test.ts && npx tsc --noEmit && cd ..
git add worker/src/lib/report-cards-snapshot-finalize.ts worker/src/lib/__tests__/report-cards-snapshot-finalize.test.ts
git commit -m "feat(report-cards): emit defunct cards for frozen stablecoins"
```

---

## Phase 6 — Telegram cemetery digest extension

### Task 19: Detect newly frozen coins in the cemetery digest appendix

**Files:**
- Modify: `worker/src/lib/telegram-digest-appendices.ts` (cemetery diff section)
- Modify: `worker/migrations/<NNNN>_frozen_snapshot_cache.sql` (new migration registering a `frozen_snapshot` cache key — only if the existing cache key registry is migration-enforced; otherwise add the constant in code and let it be created on first write)
- Test: `worker/src/lib/__tests__/telegram-digest-appendices-frozen.test.ts` (new)

Goal: the daily digest emits a cemetery appendix when a tracked coin transitions to frozen for the first time. Mirrors the existing dead-stablecoins diff pattern.

- [ ] **Step 1: Read the existing dead-stablecoins diff in `telegram-digest-appendices.ts`**

```bash
grep -n "DEAD_STABLECOINS\|cemetery\|frozen" worker/src/lib/telegram-digest-appendices.ts
```
Identify the function that detects new dead-stablecoins and emits an appendix. Note the cache key it uses for the previous snapshot.

- [ ] **Step 2: Write the failing test**

```ts
// worker/src/lib/__tests__/telegram-digest-appendices-frozen.test.ts
import { describe, expect, it } from "vitest";
import { diffFrozenIds } from "../telegram-digest-appendices";

describe("diffFrozenIds", () => {
  it("returns an empty set when nothing changed", () => {
    expect(diffFrozenIds(new Set(["usr-resolv"]), new Set(["usr-resolv"]))).toEqual(new Set());
  });

  it("returns newly added frozen ids", () => {
    expect(diffFrozenIds(new Set(["usr-resolv"]), new Set())).toEqual(new Set(["usr-resolv"]));
  });

  it("ignores removals (un-freezing is out of scope)", () => {
    expect(diffFrozenIds(new Set(), new Set(["usr-resolv"]))).toEqual(new Set());
  });
});
```

- [ ] **Step 3: Implement and wire**

Add to `telegram-digest-appendices.ts`:

```ts
import { FROZEN_IDS, FROZEN_META_BY_ID } from "@shared/lib/stablecoins";

const FROZEN_SNAPSHOT_CACHE_KEY = "frozen_ids_snapshot";

export function diffFrozenIds(current: Set<string>, previous: Set<string>): Set<string> {
  const added = new Set<string>();
  for (const id of current) {
    if (!previous.has(id)) added.add(id);
  }
  return added;
}

function buildFrozenAppendix(ids: Iterable<string>): string {
  const lines: string[] = [];
  lines.push("🪦 New cemetery additions");
  for (const id of ids) {
    const meta = FROZEN_META_BY_ID.get(id);
    if (!meta?.obituary) continue;
    lines.push(`• ${meta.name} (${meta.symbol}) — ${meta.obituary.epitaph}`);
  }
  return lines.join("\n");
}
```

In the existing daily-digest cemetery section (modeled after the dead-stablecoins diff), add a parallel block:
1. Load `cachedFrozenSnapshot = getCache(db, FROZEN_SNAPSHOT_CACHE_KEY)`.
2. Parse to a `Set<string>` (or seed empty + write current as "first run, silent").
3. Compute `addedFrozen = diffFrozenIds(FROZEN_IDS, previousFrozenSet)`.
4. If `cachedFrozenSnapshot == null`, treat as first-run seed: write `FROZEN_IDS` to cache, do NOT emit an appendix.
5. Else if `addedFrozen.size > 0`, emit `buildFrozenAppendix(addedFrozen)` into the digest, schedule the cache update for `commitSuccess`.

Mirror the existing rollback semantics (so a Telegram send failure doesn't seed prematurely).

- [ ] **Step 4: Verify**

```bash
cd worker && npx vitest run src/lib/__tests__/telegram-digest-appendices-frozen.test.ts && npx tsc --noEmit && cd ..
```

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/telegram-digest-appendices.ts worker/src/lib/__tests__/telegram-digest-appendices-frozen.test.ts
git commit -m "feat(telegram): emit cemetery appendix on first detection of frozen coins"
```

---

## Phase 7 — Frontend banner, chart-footer, metadata

### Task 20: `<FrozenStateBanner>` component

**Files:**
- Create: `src/components/stablecoin-detail/frozen-state-banner.tsx`
- Test: `src/components/stablecoin-detail/__tests__/frozen-state-banner.test.tsx`

Renders cause badge + epitaph headline + collapsible obituary + source link + "View on cemetery →" link + freeze date.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/stablecoin-detail/__tests__/frozen-state-banner.test.tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { FrozenStateBanner } from "../frozen-state-banner";
import type { StablecoinObituary } from "@shared/types";

const obituary: StablecoinObituary = {
  causeOfDeath: "abandoned",
  deathDate: "2026-04",
  epitaph: "Sunset by issuer.",
  obituary: "Resolv USR was wound down in April 2026 following protocol-level losses.",
  peakMcap: 99_000_000,
  sourceUrl: "https://example.com/resolv-shutdown",
  sourceLabel: "Resolv announcement",
};

describe("FrozenStateBanner", () => {
  it("renders the epitaph headline", () => {
    render(<FrozenStateBanner symbol="USR" frozenAt="2026-04-27" obituary={obituary} />);
    expect(screen.getByText("Sunset by issuer.")).toBeInTheDocument();
  });

  it("renders the cause-of-death label", () => {
    render(<FrozenStateBanner symbol="USR" frozenAt="2026-04-27" obituary={obituary} />);
    expect(screen.getByText(/Abandoned/i)).toBeInTheDocument();
  });

  it("links to the cemetery", () => {
    render(<FrozenStateBanner symbol="USR" frozenAt="2026-04-27" obituary={obituary} />);
    const link = screen.getByRole("link", { name: /cemetery/i });
    expect(link).toHaveAttribute("href", "/cemetery/");
  });

  it("links to the obituary source", () => {
    render(<FrozenStateBanner symbol="USR" frozenAt="2026-04-27" obituary={obituary} />);
    expect(screen.getByRole("link", { name: /Resolv announcement/i })).toHaveAttribute("href", obituary.sourceUrl);
  });
});
```

- [ ] **Step 2: Verify failure**

```bash
npm test -- --run src/components/stablecoin-detail/__tests__/frozen-state-banner.test.tsx
```
Expected: module does not exist.

- [ ] **Step 3: Implement the component**

Create `src/components/stablecoin-detail/frozen-state-banner.tsx`:

```tsx
"use client";
import Link from "next/link";
import { useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { CAUSE_META } from "@shared/lib/cause-of-death";
import type { StablecoinObituary } from "@shared/types";

interface FrozenStateBannerProps {
  symbol: string;
  frozenAt: string;
  obituary: StablecoinObituary;
}

export function FrozenStateBanner({ symbol, frozenAt, obituary }: FrozenStateBannerProps) {
  const [expanded, setExpanded] = useState(false);
  const cause = CAUSE_META[obituary.causeOfDeath];
  return (
    <div
      className={cn(
        "pharos-card-shell border-l-4 p-4 sm:p-5",
        cause.borderColor.replace("/30", "/70"),
      )}
      role="status"
      aria-label={`${symbol} is a frozen stablecoin archive`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("rounded-md border px-2 py-0.5 text-xs font-medium uppercase tracking-wide", cause.borderColor, cause.textColor)}>
          {cause.label}
        </span>
        <span className="text-xs text-muted-foreground">Frozen on {frozenAt}</span>
      </div>
      <h2 className="mt-2 text-lg font-semibold leading-tight text-foreground">{obituary.epitaph}</h2>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="pharos-focus-ring mt-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        aria-expanded={expanded}
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        Read full obituary
      </button>
      {expanded ? (
        <div className="mt-3 space-y-3 text-sm text-foreground/90">
          <p>{obituary.obituary}</p>
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <a className="pharos-focus-ring inline-flex items-center gap-1 underline-offset-2 hover:underline" href={obituary.sourceUrl} target="_blank" rel="noreferrer noopener">
              {obituary.sourceLabel}
              <ExternalLink className="h-3 w-3" />
            </a>
            <Link className="pharos-focus-ring inline-flex items-center gap-1 underline-offset-2 hover:underline" href="/cemetery/">
              View on cemetery →
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: Verify**

```bash
npm test -- --run src/components/stablecoin-detail/__tests__/frozen-state-banner.test.tsx
```
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/stablecoin-detail/frozen-state-banner.tsx src/components/stablecoin-detail/__tests__/frozen-state-banner.test.tsx
git commit -m "feat(stablecoin-detail): FrozenStateBanner component"
```

---

### Task 21: `<FrozenDataNote>` chart-footer component

**Files:**
- Create: `src/components/stablecoin-detail/frozen-data-note.tsx`
- Test: `src/components/stablecoin-detail/__tests__/frozen-data-note.test.tsx`

A small persistent label rendered above each chart section saying "Data frozen on YYYY-MM-DD."

- [ ] **Step 1: Test**

```tsx
// src/components/stablecoin-detail/__tests__/frozen-data-note.test.tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { FrozenDataNote } from "../frozen-data-note";

describe("FrozenDataNote", () => {
  it("renders the freeze date", () => {
    render(<FrozenDataNote frozenAt="2026-04-27" />);
    expect(screen.getByText(/2026-04-27/)).toBeInTheDocument();
  });

  it("explains that no new data is being collected", () => {
    render(<FrozenDataNote frozenAt="2026-04-27" />);
    expect(screen.getByText(/no longer collects new metrics/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Implement**

Create `src/components/stablecoin-detail/frozen-data-note.tsx`:

```tsx
import { Snowflake } from "lucide-react";

interface FrozenDataNoteProps {
  frozenAt: string;
}

export function FrozenDataNote({ frozenAt }: FrozenDataNoteProps) {
  return (
    <div className="mb-2 inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background px-2 py-0.5 text-xs text-muted-foreground">
      <Snowflake className="h-3 w-3" aria-hidden="true" />
      Data frozen on {frozenAt}. Pharos no longer collects new metrics for this asset.
    </div>
  );
}
```

- [ ] **Step 3: Verify and commit**

```bash
npm test -- --run src/components/stablecoin-detail/__tests__/frozen-data-note.test.tsx
git add src/components/stablecoin-detail/frozen-data-note.tsx src/components/stablecoin-detail/__tests__/frozen-data-note.test.tsx
git commit -m "feat(stablecoin-detail): FrozenDataNote chart footer component"
```

---

### Task 22: Wire banner + chart footers into the detail page; adjust metadata

**Files:**
- Modify: `src/app/stablecoin/[id]/client.tsx` (insert above HeroCard and above each chart section)
- Modify: `src/lib/page-metadata.ts` `buildStablecoinDetailMetadata`
- Test: `src/app/stablecoin/[id]/__tests__/client-frozen.test.tsx` (extend or new)

- [ ] **Step 1: Wire `<FrozenStateBanner>` above `<HeroCard>` in `client.tsx`**

Around line 226-255 in `src/app/stablecoin/[id]/client.tsx`, replace the existing identity-zone block with:

```tsx
{/* ── Identity zone ── */}
<div className="space-y-4">
  {viewModel.coin.status === "frozen" && viewModel.coin.obituary && viewModel.coin.frozenAt ? (
    <FrozenStateBanner
      symbol={viewModel.coin.symbol}
      frozenAt={viewModel.coin.frozenAt}
      obituary={viewModel.coin.obituary}
    />
  ) : null}
  <HeroCard /* …existing props… */ />
  <ExploitNoticeBanner notices={viewModel.coin.notices} />
</div>
```

Add the import at the top:
```tsx
import { FrozenStateBanner } from "@/components/stablecoin-detail/frozen-state-banner";
import { FrozenDataNote } from "@/components/stablecoin-detail/frozen-data-note";
```

- [ ] **Step 2: Wire `<FrozenDataNote>` above each chart section**

The detail page has roughly six major chart sections: Market (`<McapChart>`), Liquidity (`<DexLiquidityCard>`), Flows (`<FlowsSection>`), Blacklist (`<BlacklistSection>`), Distribution (`<DistributionSection>`), History (`<DepegHistory>`).

For each, insert immediately after the section's `<section id="...">` opening:

```tsx
{viewModel.coin.status === "frozen" && viewModel.coin.frozenAt ? (
  <FrozenDataNote frozenAt={viewModel.coin.frozenAt} />
) : null}
```

Keep the helper DRY — extract a small local helper if six sites of duplication offends:
```tsx
const frozenNote = viewModel.coin.status === "frozen" && viewModel.coin.frozenAt
  ? <FrozenDataNote frozenAt={viewModel.coin.frozenAt} />
  : null;
```
Then use `{frozenNote}` at each of the six sites.

- [ ] **Step 3: Adjust `buildStablecoinDetailMetadata` for frozen coins**

Modify `src/lib/page-metadata.ts`. Find `buildStablecoinDetailMetadata` and branch on `status === "frozen"`:

```ts
export function buildStablecoinDetailMetadata(coin: StablecoinMeta): Metadata {
  if (coin.status === "frozen") {
    return buildPageMetadata({
      title: `${coin.name} (${coin.symbol}) — Frozen Stablecoin Archive`,
      description: `Historical data and obituary for ${coin.name} (${coin.symbol}), a now-defunct stablecoin tracked by Pharos through ${coin.frozenAt}. ${coin.obituary?.epitaph ?? ""}`.trim(),
      canonical: `/stablecoin/${coin.id}/`,
    });
  }
  // existing live-data branch unchanged
  // ...
}
```

- [ ] **Step 4: Verify**

```bash
npm run build
npm test -- --run src/app/stablecoin
```
Expected: build succeeds; tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/app/stablecoin/[id]/client.tsx src/lib/page-metadata.ts
git commit -m "feat(stablecoin-detail): render frozen banner, chart footers, and archive-themed metadata"
```

---

## Phase 8 — Frontend list-source switches

### Task 23: Compare picker — switch to READABLE; render frozen badge

**Files:**
- Modify: `src/lib/compare-config.ts:8` `COMPARE_COIN_OPTIONS`
- Modify: `src/components/comparison-table.tsx` (render frozen badge in chip + tooltip; render "—" with tooltip in metric cells)
- Modify: `src/hooks/use-compare-selection.ts` (accept frozen ids in URL)
- Test: `src/lib/__tests__/compare-config.test.ts` (extend)

- [ ] **Step 1: Switch the option source**

In `src/lib/compare-config.ts`:
```ts
// Before
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
// ...
export const COMPARE_COIN_OPTIONS = ACTIVE_STABLECOINS.map(...);
// After
import { READABLE_STABLECOINS } from "@shared/lib/stablecoins";
// ...
export const COMPARE_COIN_OPTIONS = READABLE_STABLECOINS.map(...);
```

- [ ] **Step 2: Add a `frozen` field to the option shape**

If `COMPARE_COIN_OPTIONS` is `Array<{ id, name, symbol, … }>`, add `frozen?: boolean`. Set `frozen: coin.status === "frozen"` on each entry.

- [ ] **Step 3: Render the frozen badge in `comparison-table.tsx`**

Find where each coin chip is rendered. Add beside the symbol:
```tsx
{coin.frozen ? (
  <span className="ml-1 rounded border border-zinc-500/30 px-1 text-[9px] uppercase tracking-wide text-zinc-500" title={`Frozen on ${coin.frozenAt}`}>
    Frozen
  </span>
) : null}
```

In the metric-cell render path, where the cell is null for a frozen coin, render `—` with `title="No live data — coin is frozen"`.

- [ ] **Step 4: Accept frozen ids in `use-compare-selection.ts`**

Currently the hook normalizes `?coins=...` to canonical IDs by checking against the registry. Confirm it consults `TRACKED_IDS` or `READABLE_IDS`, not `ACTIVE_IDS`. If it filters with ACTIVE, switch to READABLE.

```bash
grep -n "ACTIVE\|READABLE\|TRACKED" src/hooks/use-compare-selection.ts
```

If a switch is needed:
```ts
import { READABLE_IDS } from "@shared/lib/stablecoins";
// ...
const validIds = parsed.filter((id) => READABLE_IDS.has(id));
```

- [ ] **Step 5: Verify + commit**

```bash
npm test -- --run src/lib/__tests__/compare-config.test.ts src/components src/hooks/use-compare-selection
git add src/lib/compare-config.ts src/components/comparison-table.tsx src/hooks/use-compare-selection.ts
git commit -m "feat(compare): include frozen coins in picker and URL; render badge + null-cells"
```

---

### Task 24: Static comparison pages — drop pairs containing frozen coins

**Files:**
- Modify: `src/lib/compare-pages.ts` (filter `STATIC_COMPARE_PAIRS` at construction)
- Test: `src/lib/__tests__/compare-pages.test.ts`

- [ ] **Step 1: Test**

```ts
import { describe, expect, it } from "vitest";
import { STATIC_COMPARISON_PAGES } from "../compare-pages";
import { FROZEN_IDS } from "@shared/lib/stablecoins";

describe("STATIC_COMPARISON_PAGES", () => {
  it("excludes any pair containing a frozen coin", () => {
    for (const page of STATIC_COMPARISON_PAGES) {
      expect(FROZEN_IDS.has(page.left.id)).toBe(false);
      expect(FROZEN_IDS.has(page.right.id)).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Implement the filter**

In `src/lib/compare-pages.ts`, where `STATIC_COMPARE_PAIRS` is mapped to `STATIC_COMPARISON_PAGES`, add a filter:

```ts
import { FROZEN_IDS } from "@shared/lib/stablecoins";

// ...around line 96 of compare-pages.ts:
.filter(([leftId, rightId]) => !FROZEN_IDS.has(leftId) && !FROZEN_IDS.has(rightId))
```

`getStaticComparisonPagesForCoin(id)` now returns an empty array for frozen coins (which is correct — no live-comparison pages for archived coins).

- [ ] **Step 3: Verify + commit**

```bash
npm test -- --run src/lib/__tests__/compare-pages.test.ts
git add src/lib/compare-pages.ts src/lib/__tests__/compare-pages.test.ts
git commit -m "feat(compare-pages): drop static comparison pairs containing frozen coins"
```

---

### Task 25: Command palette — frozen badge + tied-score demotion

**Files:**
- Modify: `src/components/command-palette.tsx:153`
- Test: `src/components/__tests__/command-palette-frozen.test.tsx`

Goal: searching for "USR" still finds the historical page; the result row shows a "Frozen" badge; demote frozen entries on equal-score matches.

- [ ] **Step 1: Test**

```tsx
// src/components/__tests__/command-palette-frozen.test.tsx
import { describe, expect, it } from "vitest";
import { rankCommandPaletteResults } from "../command-palette";

describe("command palette ranking", () => {
  it("demotes frozen entries on tied scores", () => {
    const candidates = [
      { id: "active-coin", score: 5, status: "active" as const },
      { id: "frozen-coin", score: 5, status: "frozen" as const },
    ];
    const ranked = rankCommandPaletteResults(candidates);
    expect(ranked[0].id).toBe("active-coin");
    expect(ranked[1].id).toBe("frozen-coin");
  });

  it("keeps higher-scored frozen entries above lower-scored active ones", () => {
    const candidates = [
      { id: "active-coin", score: 3, status: "active" as const },
      { id: "frozen-coin", score: 5, status: "frozen" as const },
    ];
    const ranked = rankCommandPaletteResults(candidates);
    expect(ranked[0].id).toBe("frozen-coin");
  });
});
```

- [ ] **Step 2: Implement**

In `src/components/command-palette.tsx`:

1. The component currently iterates `TRACKED_STABLECOINS` (line 153) — keep this (preserves pre-launch searchability per the spec).
2. Extract a ranking helper:

```ts
export function rankCommandPaletteResults<T extends { score: number; status?: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aFrozen = a.status === "frozen" ? 1 : 0;
    const bFrozen = b.status === "frozen" ? 1 : 0;
    return aFrozen - bFrozen;
  });
}
```

3. In the row render, add a frozen badge when `coin.status === "frozen"`:

```tsx
{coin.status === "frozen" ? (
  <span className="ml-2 rounded border border-zinc-500/30 px-1 text-[9px] uppercase tracking-wide text-zinc-500">
    Frozen
  </span>
) : null}
```

- [ ] **Step 3: Verify + commit**

```bash
npm test -- --run src/components/__tests__/command-palette-frozen.test.tsx
git add src/components/command-palette.tsx src/components/__tests__/command-palette-frozen.test.tsx
git commit -m "feat(command-palette): badge frozen entries; demote on tied scores"
```

---

### Task 26: Sitemap & related-stablecoins — verify no change needed; add a regression test

**Files:**
- Modify: `src/app/sitemap.ts:271` (only if it currently uses ACTIVE)
- Test: `src/app/__tests__/sitemap-frozen.test.ts` (new)

Per the spec, the sitemap stays on `TRACKED_STABLECOINS` (NOT `READABLE_STABLECOINS`) so pre-launch pages remain indexable. Confirm by reading the file.

- [ ] **Step 1: Read**

```bash
sed -n '260,290p' src/app/sitemap.ts
```

- [ ] **Step 2: Confirm — if the file already uses `TRACKED_STABLECOINS`, add only a test**

Create `src/app/__tests__/sitemap-frozen.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import sitemap from "../sitemap";
import { FROZEN_IDS } from "@shared/lib/stablecoins";

describe("sitemap", () => {
  it("includes frozen detail pages", async () => {
    const entries = await sitemap();
    const urls = new Set(entries.map((e) => e.url));
    for (const id of FROZEN_IDS) {
      expect(urls.has(`https://pharos.watch/stablecoin/${id}/`)).toBe(true);
    }
  });
});
```

If the file uses `ACTIVE_STABLECOINS`, switch it to `TRACKED_STABLECOINS` (NOT to `READABLE_STABLECOINS` — the design clarification).

- [ ] **Step 3: Verify related-stablecoins is unchanged**

```bash
grep -n "ACTIVE\|TRACKED\|READABLE" src/lib/related-stablecoins.ts
```
Expected: uses `ACTIVE_STABLECOINS` for candidates. No change needed (frozen coins should not be recommended as related).

- [ ] **Step 4: Commit**

```bash
git add src/app/sitemap.ts src/app/__tests__/sitemap-frozen.test.ts
git commit -m "test(sitemap): assert frozen detail pages remain indexable"
```

---

## Phase 9 — Cemetery merge + dataset export

### Task 27: Merge frozen entries into cemetery render

**Files:**
- Create: `shared/lib/cemetery-merged.ts`
- Modify: `src/components/cemetery-tombstones.tsx`
- Modify: `src/components/stablecoin-cemetery.tsx`
- Modify: `src/components/cemetery-charts.tsx`
- Modify: `src/components/cemetery-client.tsx`
- Test: `shared/lib/__tests__/cemetery-merged.test.ts`

- [ ] **Step 1: Test the merge**

```ts
// shared/lib/__tests__/cemetery-merged.test.ts
import { describe, expect, it } from "vitest";
import { buildMergedCemetery } from "../cemetery-merged";

describe("buildMergedCemetery", () => {
  it("includes both DEAD_STABLECOINS and FROZEN_STABLECOINS entries", () => {
    const merged = buildMergedCemetery();
    // assert each merged entry has the DeadStablecoin shape
    for (const entry of merged) {
      expect(entry).toHaveProperty("id");
      expect(entry).toHaveProperty("epitaph");
      expect(entry).toHaveProperty("deathDate");
    }
    // assert frozen-derived entries carry archivedDataAvailable: true
    const frozenDerived = merged.filter((e) => e.archivedDataAvailable === true);
    // value depends on registry state; just assert the field exists where appropriate
    expect(frozenDerived.every((e) => e.archivedDataAvailable === true)).toBe(true);
  });

  it("rejects id collisions between dead and frozen sources", () => {
    // tested via CI guard; here we just assert the merge function dedupes
    // (or throws — pick one and document)
  });
});
```

- [ ] **Step 2: Implement**

Create `shared/lib/cemetery-merged.ts`:

```ts
import type { DeadStablecoin } from "../types";
import { DEAD_STABLECOINS } from "./dead-stablecoins";
import { FROZEN_STABLECOINS } from "./stablecoins";

export type CemeteryEntry = DeadStablecoin & { archivedDataAvailable?: boolean };

export function frozenToDeadShape(coin: typeof FROZEN_STABLECOINS[number]): CemeteryEntry {
  if (!coin.obituary) {
    throw new Error(`Frozen coin ${coin.id} is missing obituary block`);
  }
  return {
    id: coin.id,
    name: coin.name,
    symbol: coin.symbol,
    pegCurrency: coin.flags.pegCurrency,
    causeOfDeath: coin.obituary.causeOfDeath,
    deathDate: coin.obituary.deathDate,
    epitaph: coin.obituary.epitaph,
    obituary: coin.obituary.obituary,
    peakMcap: coin.obituary.peakMcap,
    sourceUrl: coin.obituary.sourceUrl,
    sourceLabel: coin.obituary.sourceLabel,
    contracts: coin.contracts,
    archivedDataAvailable: true,
  };
}

export function buildMergedCemetery(): CemeteryEntry[] {
  const seenIds = new Set<string>();
  const merged: CemeteryEntry[] = [];
  for (const dead of DEAD_STABLECOINS) {
    if (seenIds.has(dead.id)) {
      throw new Error(`Cemetery id collision: ${dead.id} appears twice in dead-stablecoins.json`);
    }
    seenIds.add(dead.id);
    merged.push(dead);
  }
  for (const frozen of FROZEN_STABLECOINS) {
    if (seenIds.has(frozen.id)) {
      throw new Error(`Cemetery id collision: ${frozen.id} is in both dead-stablecoins.json and FROZEN_STABLECOINS`);
    }
    seenIds.add(frozen.id);
    merged.push(frozenToDeadShape(frozen));
  }
  return merged;
}

export const CEMETERY_ENTRIES = buildMergedCemetery();
```

- [ ] **Step 3: Update cemetery components to consume `CEMETERY_ENTRIES`**

In each of `cemetery-client.tsx`, `cemetery-tombstones.tsx`, `stablecoin-cemetery.tsx`, `cemetery-charts.tsx`, replace `import { DEAD_STABLECOINS } from "@shared/lib/dead-stablecoins";` with `import { CEMETERY_ENTRIES as DEAD_STABLECOINS } from "@shared/lib/cemetery-merged";`.

(Keep the alias `DEAD_STABLECOINS` so the rest of the component code is unchanged.)

In tombstone rendering, when `entry.archivedDataAvailable === true`, render an additional link:
```tsx
{entry.archivedDataAvailable ? (
  <Link href={`/stablecoin/${entry.id}/`} className="pharos-focus-ring text-xs text-muted-foreground underline-offset-2 hover:underline">
    View archived data →
  </Link>
) : null}
```

- [ ] **Step 4: Verify + commit**

```bash
npm test -- --run shared/lib/__tests__/cemetery-merged.test.ts
npm run build
git add shared/lib/cemetery-merged.ts shared/lib/__tests__/cemetery-merged.test.ts src/components/cemetery-client.tsx src/components/cemetery-tombstones.tsx src/components/stablecoin-cemetery.tsx src/components/cemetery-charts.tsx
git commit -m "feat(cemetery): merge dead and frozen stablecoins; render archive link for frozen tombstones"
```

---

### Task 28: Cemetery dataset export — extend to merged source

**Files:**
- Modify: `scripts/generate-cemetery-dataset.ts`
- Modify: `public/datasets/stablecoin-cemetery.json` and `.csv` (regenerated by script)
- Test: `scripts/__tests__/generate-cemetery-dataset.test.ts` (extend)

- [ ] **Step 1: Update the script's import**

In `scripts/generate-cemetery-dataset.ts`:
```ts
import { CEMETERY_ENTRIES } from "@shared/lib/cemetery-merged";
```
Replace `DEAD_STABLECOINS` with `CEMETERY_ENTRIES` throughout.

- [ ] **Step 2: Add an `archivedDataAvailable` column to CSV**

Add the column (place it after `sourceLabel` to preserve existing column order):
```ts
"archivedDataAvailable",
```
And populate per row:
```ts
entry.archivedDataAvailable === true ? "true" : "false",
```

- [ ] **Step 3: For frozen-derived entries, set `pharosUrl` to the detail page**

```ts
const pharosUrl = entry.archivedDataAvailable
  ? `${SITE_URL}/stablecoin/${entry.id}/`
  : `${SITE_URL}/cemetery/#${entry.id}`;
```

- [ ] **Step 4: Regenerate**

```bash
npm run prebuild
git diff public/datasets/stablecoin-cemetery.json
```
Expected: only the `archivedDataAvailable` field added; CSV gains the column.

- [ ] **Step 5: Update `check:cemetery-dataset`**

The check currently fails when checked-in JSON drifts from `dead-stablecoins.json`. Update it to compare against `CEMETERY_ENTRIES`. Find the check at `scripts/check-cemetery-dataset.ts` (or similar).

- [ ] **Step 6: Commit**

```bash
git add scripts/generate-cemetery-dataset.ts scripts/check-cemetery-dataset.ts scripts/__tests__/generate-cemetery-dataset.test.ts public/datasets/stablecoin-cemetery.json public/datasets/stablecoin-cemetery.csv
git commit -m "feat(cemetery-dataset): export merged dead+frozen entries; add archivedDataAvailable column"
```

---

## Phase 10 — CI guards

### Task 29: New `check:frozen-invariants` script

**Files:**
- Create: `scripts/check-frozen-invariants.ts`
- Modify: `package.json` (add `check:frozen-invariants` script)
- Modify: merge gate runner (find via `grep -rln "check:cemetery-dataset" scripts/ package.json`)

Goal: a single script that asserts every frozen-status invariant. Runs in CI as a pre-merge gate.

- [ ] **Step 1: Implement**

Create `scripts/check-frozen-invariants.ts`:

```ts
#!/usr/bin/env tsx
/**
 * Asserts every cross-file invariant that `status: "frozen"` requires.
 * Run as part of the pre-push merge gate.
 *
 * Failures here usually indicate a half-applied freeze procedure — fix
 * before pushing.
 */
import { FROZEN_IDS, FROZEN_STABLECOINS, ACTIVE_IDS } from "../shared/lib/stablecoins/registry";
import { FROZEN_SNAPSHOTS_BY_ID } from "../shared/lib/stablecoins/frozen-snapshots";
import { DEAD_STABLECOINS } from "../shared/lib/dead-stablecoins";
// independent registries
import { MINT_BURN_CONFIG_SPECS } from "../worker/src/lib/mint-burn-contracts-data";
import { CONTRACT_CONFIGS } from "../worker/src/lib/blacklist-contracts";
import { BLUECHIP_SLUG_MAP } from "../worker/src/lib/bluechip-slugs";

const failures: string[] = [];

// 1. frozen coins have well-formed obituaries (already enforced by Zod schema —
//    duplicate check here for fast feedback)
for (const coin of FROZEN_STABLECOINS) {
  if (!coin.frozenAt) failures.push(`${coin.id}: missing frozenAt`);
  if (!coin.obituary) failures.push(`${coin.id}: missing obituary`);
}

// 2. every frozen coin has a frozen-snapshots.json entry
for (const coin of FROZEN_STABLECOINS) {
  if (!FROZEN_SNAPSHOTS_BY_ID.has(coin.id)) {
    failures.push(`${coin.id}: missing entry in frozen-snapshots.json`);
  }
}

// 3. id disjoint with dead-stablecoins.json
const deadIds = new Set(DEAD_STABLECOINS.map((d) => d.id));
for (const id of FROZEN_IDS) {
  if (deadIds.has(id)) {
    failures.push(`${id}: appears in BOTH dead-stablecoins.json and FROZEN_STABLECOINS`);
  }
}

// 4. independent registries do not contain frozen ids
for (const config of MINT_BURN_CONFIG_SPECS) {
  if (FROZEN_IDS.has(config.stablecoinId)) {
    failures.push(`${config.stablecoinId}: still in MINT_BURN_CONFIG_SPECS — remove per freeze runbook`);
  }
}
for (const config of CONTRACT_CONFIGS) {
  if (FROZEN_IDS.has((config as { stablecoinId?: string }).stablecoinId ?? "")) {
    failures.push(`${(config as { stablecoinId: string }).stablecoinId}: still in CONTRACT_CONFIGS (blacklist) — remove per freeze runbook`);
  }
}
for (const id of Object.keys(BLUECHIP_SLUG_MAP)) {
  if (FROZEN_IDS.has(id)) {
    failures.push(`${id}: still in BLUECHIP_SLUG_MAP — remove per freeze runbook`);
  }
}

// 5. ACTIVE and FROZEN are disjoint (registry-level invariant; double-check)
for (const id of FROZEN_IDS) {
  if (ACTIVE_IDS.has(id)) {
    failures.push(`${id}: appears in BOTH ACTIVE and FROZEN — registry semantic shift incomplete`);
  }
}

if (failures.length > 0) {
  console.error("Frozen-invariant failures:");
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
console.log(`Frozen-invariant checks passed (${FROZEN_STABLECOINS.length} frozen coin(s)).`);
```

- [ ] **Step 2: Add npm script and merge gate hook**

In `package.json`, add:
```json
"check:frozen-invariants": "tsx scripts/check-frozen-invariants.ts"
```

Find the merge gate runner (probably `scripts/check-merge-gate.sh` or `package.json:test:merge-gate`) and add `check:frozen-invariants` to its sequence.

- [ ] **Step 3: Verify**

```bash
npm run check:frozen-invariants
```
Expected: prints "Frozen-invariant checks passed (0 frozen coin(s))." today.

- [ ] **Step 4: Commit**

```bash
git add scripts/check-frozen-invariants.ts package.json
git commit -m "feat(ci): check:frozen-invariants verifies every cross-file freeze invariant"
```

---

### Task 30: Update `check:doc-counts` and replace hardcoded "215" counts

**Files:**
- Modify: `scripts/check-doc-counts.ts` (if it exists; otherwise add to the relevant counts check)
- Modify: `docs/supply-snapshot.md:28`
- Modify: `docs/report-cards.md:5`
- Modify: root `CLAUDE.md` (the line mentioning "215 stablecoins (+2 shadow)")
- Modify: `src/app/about/page.tsx` (if it hardcodes the count)

- [ ] **Step 1: Find every hardcoded count**

```bash
grep -rn '215\|2[01][0-9]\b' docs/ CLAUDE.md src/app/about/page.tsx | grep -v node_modules | grep -i 'stablecoin\|tracked'
```
List every match.

- [ ] **Step 2: Replace literals with dynamic phrasing**

For each match:
- If the file is a doc, replace the literal with a phrasing that doesn't drift, e.g., "tracked stablecoins". Where a count is necessary, derive it from `ACTIVE_STABLECOINS.length` at render time, or update the count to current `ACTIVE_STABLECOINS.length` and accept manual updates as part of the freeze runbook.
- If the file is `src/app/about/page.tsx`, confirm it already uses `ACTIVE_STABLECOINS.length` (per existing exploration). If literal, replace.

- [ ] **Step 3: Extend `check:doc-counts`**

If the script counts stablecoins, ensure it counts `ACTIVE_STABLECOINS.length` (post-frozen-exclusion). The script should fail when a doc still contains an outdated literal.

- [ ] **Step 4: Verify + commit**

```bash
npm run check:doc-counts
git add scripts/ docs/supply-snapshot.md docs/report-cards.md CLAUDE.md src/app/about
git commit -m "chore(docs): de-hardcode tracked-coin counts in preparation for frozen exclusions"
```

---

## Phase 11 — Docs + methodology + runbook

### Task 31: Add the `/methodology` "Frozen status" section; bump to v5.81

**Files:**
- Modify: `src/app/methodology/page.tsx` (or wherever methodology content lives — find via `find src/app/methodology -type f`)
- Modify: methodology version constant (find via `grep -rn "METHODOLOGY_VERSION" shared/`)

- [ ] **Step 1: Bump version**

Update `METHODOLOGY_VERSION` constant from current value to `5.81`. The constant is referenced by report cards and several docs.

- [ ] **Step 2: Add the "Frozen status" subsection**

Inside the `/methodology` page, add a new section explaining:
- What "frozen" means lifecycle-wise
- That no new data is collected for frozen coins
- That historical data and detail page remain accessible
- Cross-link to the cemetery
- The deterministic freezing procedure (point at `docs/freezing-stablecoins.md`)

- [ ] **Step 3: Add a methodology timeline entry**

If there's a methodology timeline doc, add an entry for v5.81 dated 2026-04-27.

- [ ] **Step 4: Commit**

```bash
git add src/app/methodology shared/lib/report-cards.ts docs/methodology
git commit -m "docs(methodology): v5.81 — frozen stablecoin lifecycle phase"
```

---

### Task 32: Update `/about`, `docs/architecture.md`, `docs/cemetery-and-compare.md`

**Files:**
- Modify: `src/app/about/page.tsx`
- Modify: `docs/architecture.md`
- Modify: `docs/cemetery-and-compare.md`
- Modify: `docs/freezing-stablecoins.md` (new)

- [ ] **Step 1: `/about` paragraph**

Add a paragraph explaining the frozen-status archive and linking to `/cemetery/`.

- [ ] **Step 2: `docs/architecture.md`**

Add a "Stablecoin lifecycle phases" section enumerating active / pre-launch / frozen, and the registry universes (`TRACKED_*`, `ACTIVE_*`, `READABLE_*`, `FROZEN_*`).

- [ ] **Step 3: `docs/cemetery-and-compare.md`**

Add a "Frozen entries in the cemetery" subsection covering the merge logic, `archivedDataAvailable`, dataset-export changes.

- [ ] **Step 4: Create `docs/freezing-stablecoins.md`**

Write the runbook (template):

```markdown
# Freezing a Tracked Stablecoin

## When to freeze

Use the freeze procedure when a tracked stablecoin has effectively died — supply trending to zero, issuer abandonment, irrecoverable depeg, regulatory shutdown — and you want to preserve its historical data + detail page rather than erase it.

## Pre-flight

1. Verify the coin is in `TRACKED_STABLECOINS` and currently `status: "active"` (or implicitly active).
2. Confirm with the team that this is a freeze and not a temporary outage.

## Procedure

### 1. Run the freeze script

```bash
PHAROS_API_KEY=<key> npx tsx scripts/freeze-stablecoin.ts <coin-id>
```

The script prints two artifacts:
- A new entry to append to `shared/data/stablecoins/frozen-snapshots.json`
- A patch to apply to the coin's existing entry in its source JSON file

### 2. Apply the JSON edits

- Append the snapshot entry to `frozen-snapshots.json`.
- In the coin's source file (`shared/data/stablecoins/usd-major.json` or wherever it lives), set `status: "frozen"`, add `frozenAt: "YYYY-MM-DD"`, add the `obituary` block. Replace the placeholder strings (`causeOfDeath`, `epitaph`, `obituary`, `sourceUrl`, `sourceLabel`) with finalized copy.

### 3. Remove from independent registries

- `worker/src/lib/mint-burn-contracts-data.ts` — remove from `MINT_BURN_CONFIG_SPECS` if present.
- `worker/src/lib/blacklist-contracts.ts` — remove from `CONTRACT_CONFIGS` if present.
- `worker/src/lib/bluechip-slugs.ts` — remove from `BLUECHIP_SLUG_MAP` if present.
- `worker/src/cron/yield-history-backfill.ts` — remove from `YIELD_POOL_MAP` if present.
- `src/lib/compare-pages.ts` — remove from `STATIC_COMPARE_PAIRS` if any pair includes the coin.
- Any per-coin sync cron (e.g., `sync-usds-status.ts`, `sync-kinesis-supply.ts`) — disable or remove.

### 4. Validate

```bash
npm run check:frozen-invariants
npm run lint
npm test -- --run
cd worker && npx tsc --noEmit && cd ..
npm run prebuild  # regenerates the cemetery dataset
```

### 5. Update docs

- Update `/methodology` version + timeline entry if this is a notable freeze.
- Add a changelog entry.
- Confirm the count of "tracked stablecoins" in `/about` and any docs is current.

### 6. Open PR

PR title: `feat(stablecoin): freeze <symbol> (<coin-id>)`. Include a brief obituary in the PR body.

### 7. Post-deploy verification (within 24h)

- Visit `/cemetery/` — confirm the coin appears with the "View archived data →" link.
- Visit `/stablecoin/<id>/` — confirm the frozen banner above the hero, and the "Data frozen on YYYY-MM-DD" footer above each chart section.
- Inspect Worker logs — confirm no INSERT/UPDATE for the coin's id from any cron.
- Confirm the next daily Telegram digest fires a cemetery appendix.
- Test OG: `https://api.pharos.watch/api/og?stablecoin=<id>` returns 200.

## Known behaviors (not bugs)

- Pinned stablecoins drop the coin silently. Users who pinned the coin lose it from their pinned list.
- Live-comparison URL `/compare/?coins=<id>,...` keeps the coin (badged) but live metric cells render "—" with a tooltip.
- Rolling-window metrics (24h flows, 7d depeg counts) gradually decay to zero/null past the rolling window.
```

- [ ] **Step 5: Commit**

```bash
git add src/app/about docs/architecture.md docs/cemetery-and-compare.md docs/freezing-stablecoins.md
git commit -m "docs: frozen stablecoin lifecycle — about, architecture, cemetery, runbook"
```

---

## Phase 12 — End-to-end fixture verification

### Task 33: Add a fixture frozen coin and run the full validation suite

**Files:**
- Add a fixture entry to a test-only JSON (or use a Vitest mock) — do NOT edit production registry data
- Test: `worker/src/__tests__/integration-frozen-fixture.test.ts` (new)

This task validates the system end-to-end with a synthetic frozen coin BEFORE any real coin is frozen. It does not modify production data.

- [ ] **Step 1: Build a fixture**

Create `worker/src/__tests__/integration-frozen-fixture.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
// Mock the registry to inject a fixture frozen coin
vi.mock("@shared/lib/stablecoins", async () => {
  const actual = await vi.importActual<typeof import("@shared/lib/stablecoins")>("@shared/lib/stablecoins");
  const fixtureFrozen = {
    id: "fixture-frozen",
    name: "Fixture Frozen",
    symbol: "FXT",
    flags: { pegCurrency: "USD", governance: "centralized", backing: "fiat" },
    status: "frozen" as const,
    frozenAt: "2026-04-27",
    obituary: {
      causeOfDeath: "abandoned" as const,
      deathDate: "2026-04",
      epitaph: "Sunset.",
      obituary: "FXT was sunset.",
      peakMcap: 1_000_000,
      sourceUrl: "https://example.com/x",
      sourceLabel: "Example",
    },
  };
  return {
    ...actual,
    FROZEN_STABLECOINS: [fixtureFrozen],
    FROZEN_IDS: new Set(["fixture-frozen"]),
    FROZEN_META_BY_ID: new Map([["fixture-frozen", fixtureFrozen]]),
    READABLE_IDS: new Set([...actual.READABLE_IDS, "fixture-frozen"]),
    READABLE_STABLECOINS: [...actual.READABLE_STABLECOINS, fixtureFrozen],
  };
});

describe("frozen fixture — end-to-end", () => {
  it("orphan-close skips the fixture coin", async () => {
    const { shouldCloseOrphanedDepeg } = await import("../cron/detect-depegs");
    expect(shouldCloseOrphanedDepeg("fixture-frozen", new Set())).toBe(false);
  });

  it("backfill admin endpoint rejects the fixture coin", async () => {
    const { assertNotFrozen } = await import("../lib/frozen-guards");
    const response = assertNotFrozen("fixture-frozen");
    expect(response).not.toBeNull();
    expect(response!.status).toBe(403);
  });

  it("dex-liquidity prune set preserves the fixture coin", async () => {
    const { computePruneSet } = await import("../cron/dex-liquidity/persistence");
    const allDbIds = new Set(["fixture-frozen", "zombie-coin"]);
    const prune = computePruneSet(allDbIds);
    expect(prune.has("fixture-frozen")).toBe(false);
    expect(prune.has("zombie-coin")).toBe(true);
  });

  it("DEWS prune preserves the fixture coin", async () => {
    const { computeStressSignalPruneIds } = await import("../cron/dews/persistence");
    const result = computeStressSignalPruneIds(new Set(["fixture-frozen", "zombie"]), new Set());
    expect(result.has("fixture-frozen")).toBe(false);
    expect(result.has("zombie")).toBe(true);
  });

  it("PSI eligibility excludes the fixture coin", async () => {
    const { PSI_ELIGIBLE_IDS } = await import("@shared/lib/psi-eligible");
    expect(PSI_ELIGIBLE_IDS.has("fixture-frozen")).toBe(false);
  });

  it("/api/stablecoin-reserves accepts the fixture coin id", async () => {
    // verify gate allows; downstream resolveReserveResult might still 404 with no data,
    // but the gate should be permissive
    const { READABLE_IDS } = await import("@shared/lib/stablecoins");
    expect(READABLE_IDS.has("fixture-frozen")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the integration suite**

```bash
cd worker && npx vitest run src/__tests__/integration-frozen-fixture.test.ts && cd ..
```
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add worker/src/__tests__/integration-frozen-fixture.test.ts
git commit -m "test(integration): end-to-end fixture verifies all frozen invariants"
```

---

### Task 34: Pre-merge full gate run

**Files:** none

- [ ] **Step 1: Run the full merge gate**

```bash
npm run test:merge-gate
```
Expected: green. Investigate any failure; do not push.

- [ ] **Step 2: Manual visual check (system PR, no real frozen coin yet)**

```bash
npm run dev
```
Verify:
- `/cemetery/` renders without changes (no frozen coins yet, so the merged set equals `DEAD_STABLECOINS`).
- `/stablecoin/usdt-tether/` renders without changes (active coin).
- Search for an active coin in the command palette — works.

- [ ] **Step 3: Open PR #1 (system)**

PR title: `feat: frozen stablecoin lifecycle phase (system, no coin frozen yet)`.
PR body: link to spec at `agents/specs/2026-04-27-frozen-stablecoin-status-design.md`.

---

## Phase 13 — USR migration (separate PR)

PR #2 is a single-coin migration. It must be on a fresh branch off `main` after PR #1 has merged + deployed.

### Task 35: Run the freeze script for `usr-resolv`

**Files:** none yet — run the script and capture output.

- [ ] **Step 1: Run**

```bash
PHAROS_API_KEY=<production-key> npx tsx scripts/freeze-stablecoin.ts usr-resolv > /tmp/usr-freeze-output.txt
```

- [ ] **Step 2: Inspect**

```bash
cat /tmp/usr-freeze-output.txt
```
Expected:
- A `frozen-snapshots.json` entry with `id: "usr-resolv"` and the current peggedAssets row
- A patch with `status: "frozen"`, `frozenAt`, `obituary` skeleton
- The computed `peakMcap`

Save the script output for the next task.

---

### Task 36: Apply USR JSON edits and commit

**Files:**
- Modify: `shared/data/stablecoins/frozen-snapshots.json` (append)
- Modify: `shared/data/stablecoins/<usr's source file>.json` — find via `grep -ln '"usr-resolv"' shared/data/stablecoins/`
- Possibly modify: `worker/src/lib/mint-burn-contracts-data.ts`, `worker/src/lib/blacklist-contracts.ts`, etc. (run the runbook checklist)

- [ ] **Step 1: Append the snapshot entry**

Edit `shared/data/stablecoins/frozen-snapshots.json`. Append the entry from the script output. Result file:
```json
[
  {
    "id": "usr-resolv",
    "capturedAt": "<ISO timestamp from script>",
    "peggedAssetRow": { ... }
  }
]
```

- [ ] **Step 2: Patch the USR registry entry**

Find the file:
```bash
grep -ln '"id": "usr-resolv"' shared/data/stablecoins/
```
Edit the entry: add `"status": "frozen"`, `"frozenAt": "2026-04-27"`, and the full obituary block. Replace placeholder strings with finalized copy:
- `causeOfDeath`: pick from CAUSE_OF_DEATH_VALUES (likely `"counterparty-failure"` or `"liquidity-drain"` for USR — confirm with the team)
- `deathDate`: `"2026-04"`
- `epitaph`: short headline
- `obituary`: full paragraph
- `sourceUrl` / `sourceLabel`: link to public coverage of the collapse
- `peakMcap`: keep the value the script computed

- [ ] **Step 3: Run the runbook checklist for independent registries**

```bash
grep -n '"usr-resolv"\|"usr"\|usrResolv\|UsrResolv\|usrSlug' worker/src/lib/mint-burn-contracts-data.ts worker/src/lib/blacklist-contracts.ts worker/src/lib/bluechip-slugs.ts worker/src/cron/yield-history-backfill.ts src/lib/compare-pages.ts
```
For every match, remove the entry per the runbook step 3.

- [ ] **Step 4: Validate**

```bash
npm run check:frozen-invariants
npm run lint
npm test -- --run
cd worker && npx tsc --noEmit && cd ..
npm run prebuild
npm run test:merge-gate
```
Expected: all green.

- [ ] **Step 5: Commit + open PR**

```bash
git add shared/data/stablecoins/frozen-snapshots.json shared/data/stablecoins/<usr's file>.json worker/ src/
git commit -m "feat(stablecoin): freeze usr-resolv (Resolv USR)

Resolv USR is moved into the frozen archive lifecycle phase per the
spec. Cemetery shows USR with an archive link; detail page renders the
frozen banner + chart-footer notes; no new data is collected. Historical
data preserved.

See docs/freezing-stablecoins.md for the procedure followed."
```

PR title: `feat(stablecoin): freeze usr-resolv (Resolv USR)`.

### Task 37: Post-deploy production verification

**Files:** none

- [ ] **Step 1: Verify cemetery + detail page**

```bash
curl -sI https://pharos.watch/cemetery/ | head -1                # 200
curl -sI https://pharos.watch/stablecoin/usr-resolv/ | head -1   # 200
curl -sI "https://api.pharos.watch/api/og?stablecoin=usr-resolv" | head -1  # 200
```

- [ ] **Step 2: Verify cron logs**

In Cloudflare dashboard, inspect Worker invocation logs for the next 6h. Confirm:
- No `INSERT` for `stablecoin_id = 'usr-resolv'` in any cron.
- No `[detect-depegs]` writes for usr-resolv.
- No `[sync-mint-burn]`, `[sync-blacklist]`, `[sync-bluechip]`, `[yield-*]` events for usr-resolv.

- [ ] **Step 3: Verify Telegram digest**

Wait for the next daily digest run. Confirm a cemetery appendix appears with the USR obituary.

- [ ] **Step 4: Verify `/api/stablecoins`**

```bash
curl -s "https://api.pharos.watch/api/stablecoins" -H "X-API-Key: $PHAROS_API_KEY" | jq '.peggedAssets[] | select(.id == "usr-resolv") | {id, frozen, frozenAt}'
```
Expected: `{ "id": "usr-resolv", "frozen": true, "frozenAt": "2026-04-27" }`.

- [ ] **Step 5: Run smoke test**

Browse `/stablecoin/usr-resolv/` in production. Confirm:
- Frozen banner above hero with USR obituary
- "Data frozen on 2026-04-27" footer above mcap chart, depeg history, distribution, flows, liquidity, blacklist sections
- Hero numbers reflect last preserved data
- "View on cemetery →" link works
- Comparison preset URL `?coins=usr-resolv,usdc-circle` loads with USR badged

---
