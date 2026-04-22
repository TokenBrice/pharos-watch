# Wrapper / Staked Variant Framework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a first-class variant framework on the Pharos dashboard: typed archetypes (`variantKind`), explicit parent pointer (`variantOf`), dimension-split scoring inheritance with per-archetype overlays, hard parent-ceiling on overall grade (enforced in both base and stressed-grade paths), and a complete UI package.

**Architecture:** New schema fields + inverse-index helper + explicit variantOf predecessor in `topologicalOrder()`; refactor of 5 scoring files to make wrapper-parent inheritance explicit and archetype-driven; migration of 18 existing wrapper JSON entries; addition of ~13 UI affordances. Dual-branch PegScore resolution preserves 7 standalone NAV RWAs that use the legacy `navToken + pegReferenceId` path.

**Tech Stack:** Next.js 16 static export; Cloudflare Pages + Worker + D1; Zod schemas; TanStack Query; Tailwind; shadcn primitives; Vitest; Playwright; wrangler.

Date: 2026-04-22 (revised post-review)

Source spec: `agents/specs/2026-04-22-wrapper-variant-framework-design.md` (revised).

Source audits (2026-04-21):
- `agents/staked-wrapped-assets-methodology-audit-2026-04-21.md`
- `agents/stablecoin-additions-risk-wrappers-2026-04-21.md`

Plan reviewers (2026-04-22): data-model, scoring, UI, integration. All findings incorporated.

---

## Scope

Applies to all 18 existing first-class wrappers. Does NOT retrofit the ~25 yield-only variants in `YIELD_VARIANT_MAP` (follow-up). Does NOT implement aggregate-market-cap dedup (separate methodology concern). Methodology version bump: Report Cards v7.08 → **v7.10** (substantial — new taxonomy + scoring + ceiling). `v7.1` would be numerically less than `v7.08` per `compareMethodologyVersions()` in `shared/lib/methodology-version.ts:47-58`; use v7.10 or v8.0.

## Assumptions

- Single feature branch; may ship as one PR or phased PRs at implementer discretion.
- Multi-PR path honors deploy-concurrency rule from `agents/plans/2026-04-20-phase-1-3-audit-remediation-plan.md:17`.
- Wrapper grades will change post-migration (expected recalibration, not regression). Document per-wrapper grade diff in PR body (see Task 2.12).
- No D1 schema migration required. Storage shape of `report_cards_cache` confirmed as JSON blob (re-verify in Task 1.10).
- Methodology v7.10 bump coordinated with `/methodology` page update in Phase 4.
- `navToken` flag stays authored on all 11 inheriting wrappers per spec §2.6.

## Success Criteria

- `npm run test:merge-gate` passes on final branch.
- `npm run check:doc-counts` passes.
- `npm run check:doc-sync` passes (version label match).
- `cd worker && npx tsc --noEmit` passes.
- `npm test` passes, including new wrapper-variant unit + integration tests.
- `npm run build` passes.
- `npm run seo:check` passes (new sitemap routes present).
- All 18 wrappers validate against schema with `variantOf + variantKind` set.
- `ACTIVE_STABLECOINS.filter(c => c.variantOf).length === 18` (count invariant).
- Every surface in spec §4 renders variant affordances in Playwright for at least one wrapper + parent pair.
- Classification of borderline coins (sBOLD, stcUSD, syrupUSDC/T) signed off by @tokenbrice before merge.

---

## Phase 1 — Foundation (types, schema, helper, data, reconciliations)

Blocks Phase 2 and Phase 3. Intended as a single PR.

### Task 1.1: Define `VariantKind` enum and extend `StablecoinMeta`

**Files:**
- Modify: `shared/types/core.ts`
- Modify: `shared/lib/stablecoins/schema.ts`

**Steps:**

- [ ] Add enum + field to `shared/types/core.ts` (near existing enum definitions):

```ts
export const VARIANT_KIND_VALUES = [
  "savings-passthrough",
  "strategy-vault",
  "risk-absorption",
  "bond-maturity",
] as const;
export type VariantKind = typeof VARIANT_KIND_VALUES[number];
```

Add two fields to `StablecoinMeta` near `pegReferenceId`:

```ts
variantOf?: string;
variantKind?: VariantKind;
```

- [ ] Add to Zod schema in `shared/lib/stablecoins/schema.ts`:

```ts
variantOf: z.string().optional(),
variantKind: z.enum(VARIANT_KIND_VALUES).optional(),
```

- [ ] Add co-require refinement at the object level (with explicit `path` for actionable error messages):

```ts
.refine(
  (meta) => (meta.variantOf === undefined) === (meta.variantKind === undefined),
  {
    message: "variantOf and variantKind must both be set or both be absent",
    path: ["variantOf"],
  }
)
```

- [ ] Run: `cd worker && npx tsc --noEmit` → expected PASS.
- [ ] Commit: `feat(stablecoins): add variantOf + variantKind schema fields`

### Task 1.2: Write failing tests for `variants.ts` helper

**Files:**
- Create: `shared/lib/stablecoins/__tests__/variants.test.ts`

**Steps:**

- [ ] First verify the alias resolution: `grep '@shared' tsconfig.json vitest.config.ts` — confirm `@shared/lib/stablecoins/variants` resolves. If the alias only maps to directory index, plan to re-export from `shared/lib/stablecoins/index.ts`.

- [ ] Write the test file:

```ts
import { describe, it, expect } from "vitest";
import {
  getVariantOf,
  getVariants,
  getVariantRelationship,
} from "@shared/lib/stablecoins/variants";

describe("variants helpers", () => {
  it("getVariantOf returns parent for a tracked wrapper", () => {
    expect(getVariantOf("susds-sky")?.id).toBe("usds-sky");
  });
  it("getVariantOf returns null for a base coin", () => {
    expect(getVariantOf("usds-sky")).toBeNull();
  });
  it("getVariants returns all tracked wrappers of a parent", () => {
    const ids = getVariants("usds-sky").map((v) => v.id).sort();
    expect(ids).toContain("susds-sky");
    expect(ids).toContain("stusds-sky");
  });
  it("getVariantRelationship returns parent, kind, siblings", () => {
    const rel = getVariantRelationship("susds-sky");
    expect(rel?.parent.id).toBe("usds-sky");
    expect(rel?.kind).toBe("savings-passthrough");
    expect(rel?.siblings.some((s) => s.id === "stusds-sky")).toBe(true);
  });
  it("getVariantRelationship is null for non-variants", () => {
    expect(getVariantRelationship("usds-sky")).toBeNull();
  });
});
```

- [ ] Run: `npm test variants.test.ts` → expected FAIL (module not found — intentional TDD ordering; file created in Task 1.3).

### Task 1.3: Implement `variants.ts` helper + extend `topologicalOrder()`

**Files:**
- Create: `shared/lib/stablecoins/variants.ts`
- Modify: `shared/lib/stablecoins/index.ts` (re-export)
- Modify: `worker/src/lib/report-cards-snapshot-card.ts` (extend `topologicalOrder()`)

**Steps:**

- [ ] Implement `shared/lib/stablecoins/variants.ts`:

```ts
import { ACTIVE_STABLECOINS } from "./registry";
import type { StablecoinMeta, VariantKind } from "@shared/types/core";

export function getVariantOf(id: string): StablecoinMeta | null {
  const coin = ACTIVE_STABLECOINS.find((c) => c.id === id);
  if (!coin?.variantOf) return null;
  return ACTIVE_STABLECOINS.find((c) => c.id === coin.variantOf) ?? null;
}

export function getVariants(parentId: string): StablecoinMeta[] {
  return ACTIVE_STABLECOINS.filter((c) => c.variantOf === parentId);
}

export function getVariantRelationship(id: string): {
  parent: StablecoinMeta;
  kind: VariantKind;
  siblings: StablecoinMeta[];
} | null {
  const coin = ACTIVE_STABLECOINS.find((c) => c.id === id);
  if (!coin?.variantOf || !coin.variantKind) return null;
  const parent = ACTIVE_STABLECOINS.find((c) => c.id === coin.variantOf);
  if (!parent) return null;
  const siblings = ACTIVE_STABLECOINS.filter(
    (c) => c.variantOf === coin.variantOf && c.id !== id
  );
  return { parent, kind: coin.variantKind, siblings };
}
```

- [ ] Re-export from `shared/lib/stablecoins/index.ts`: `export * from "./variants";`

- [ ] Extend `topologicalOrder()` at `worker/src/lib/report-cards-snapshot-card.ts:205-225` to treat `meta.variantOf` as an explicit predecessor (guarantees parent-first scoring for strategy-vault wrappers that don't have a parent reserve slice):

```ts
function visit(id: string) {
  if (visited.has(id)) return;
  visited.add(id);
  const meta = metaById.get(id);
  if (!meta) return;
  for (const dep of deriveDependencies(meta)) {
    visit(dep.id);
  }
  // NEW: variantOf as explicit topological predecessor
  if (meta.variantOf) {
    visit(meta.variantOf);
  }
  order.push(id);
}
```

- [ ] Run: `cd worker && npx tsc --noEmit` → expected PASS. Note: `variants.test.ts` will still fail until Task 1.4 migrates data — expected.
- [ ] Commit: `feat(stablecoins): inverse-index helper and variant-aware topological order`

### Task 1.4: Migrate 18 JSON entries + update existing tests + reconcile

**Files:**
- Modify: `shared/data/stablecoins/usd-major.json`
- Modify: `shared/data/stablecoins/usd-minor.json`
- Modify: `shared/lib/__tests__/stablecoins.test.ts` (line 245 breaks; update)
- Modify: `worker/src/cron/yield-config-variants.ts` (YIELD_VARIANT_MAP reconciliation)

**Steps:**

- [ ] For each entry below, add `variantOf` + `variantKind` adjacent to the `flags` block. Strip `pegReferenceId` where column says STRIP.

**Savings-passthrough (7 — keep `pegReferenceId`):**

| ID | variantOf | variantKind |
|---|---|---|
| `susde-ethena` | `usde-ethena` | `savings-passthrough` |
| `susds-sky` | `usds-sky` | `savings-passthrough` |
| `sdai-sky` | `dai-makerdao` | `savings-passthrough` |
| `sfrxusd-frax` | `frxusd-frax` | `savings-passthrough` |
| `scrvusd-curve` | `crvusd-curve` | `savings-passthrough` |
| `cusdo-openeden` | `usdo-openeden` | `savings-passthrough` |
| `syusd-aegis` | `yusd-aegis` | `savings-passthrough` |

**Strategy-vault (7 — STRIP `pegReferenceId`):**

| ID | variantOf | variantKind | pegReferenceId |
|---|---|---|---|
| `susdai-usd-ai` | `usdai-usd-ai` | `strategy-vault` | STRIP |
| `msy-main-street` | `msusd-main-street` | `strategy-vault` | STRIP |
| `yusd-yieldfi` | `usdc-circle` | `strategy-vault` | STRIP |
| `said-gaib` | `aid-gaib` | `strategy-vault` | STRIP |
| `stcusd-cap` | `cusd-cap` | `strategy-vault` | STRIP |
| `syrupusdc-maple` | `usdc-circle` | `strategy-vault` | (already absent) |
| `syrupusdt-maple` | `usdt-tether` | `strategy-vault` | (already absent) |

**Risk-absorption (3 — keep `pegReferenceId`):**

| ID | variantOf | variantKind |
|---|---|---|
| `stusds-sky` | `usds-sky` | `risk-absorption` |
| `stkgho-umbrella-aave` | `gho-aave` | `risk-absorption` |
| `sbold-k3-capital` | `bold-liquity` | `risk-absorption` |

**Bond-maturity (1 — STRIP `pegReferenceId`):**

| ID | variantOf | variantKind | pegReferenceId |
|---|---|---|---|
| `busd0-usual` | `usd0-usual` | `bond-maturity` | STRIP |

- [ ] Update existing test at `shared/lib/__tests__/stablecoins.test.ts:245`:

```ts
// BEFORE:
// expect(susdai?.pegReferenceId).toBe("usdai-usd-ai");
// AFTER:
expect(susdai?.variantOf).toBe("usdai-usd-ai");
expect(susdai?.variantKind).toBe("strategy-vault");
expect(susdai?.pegReferenceId).toBeUndefined();
```

- [ ] Reconcile `YIELD_VARIANT_MAP` at `worker/src/cron/yield-config-variants.ts`: delete entries for the 18 first-class wrappers' parents where a duplicate encoding exists (e.g. `usds-sky → sUSDS`, `dai-makerdao → sDAI`, `crvusd-curve → scrvUSD`, `frxusd-frax → sfrxUSD`, `usde-ethena → sUSDe`). Add a test in `worker/src/cron/__tests__/yield-config-registry.test.ts` asserting no entry in `YIELD_VARIANT_MAP` has a parent id that matches any tracked wrapper's `variantOf`.

- [ ] Add count assertion to `shared/lib/__tests__/stablecoins.test.ts`:

```ts
it("exactly 18 first-class variants are tracked", () => {
  expect(ACTIVE_STABLECOINS.filter((c) => c.variantOf != null).length).toBe(18);
});

it("every variant's parent exists in ACTIVE_STABLECOINS", () => {
  const ids = new Set(ACTIVE_STABLECOINS.map((c) => c.id));
  for (const c of ACTIVE_STABLECOINS.filter((c) => c.variantOf)) {
    expect(ids.has(c.variantOf!)).toBe(true);
  }
});
```

- [ ] Run: `npm test shared/lib/__tests__/stablecoins.test.ts` → PASS.
- [ ] Run: `npm test variants.test.ts` → PASS.
- [ ] Run: `npm run check:doc-counts` → PASS.
- [ ] Commit: `feat(stablecoins): annotate 18 wrappers with variantOf + variantKind; reconcile YIELD_VARIANT_MAP`

### Task 1.5: Fix reserve-slice data bugs + audit 12 non-strategy-vault entries + invariant

**Files:**
- Modify: `shared/data/stablecoins/usd-major.json` (stusds-sky, susdai-usd-ai, and any others failing audit)
- Modify: `shared/data/stablecoins/usd-minor.json` (if any audit failures)
- Modify: `shared/lib/stablecoins/schema.ts` (add invariant refine)

**Steps:**

- [ ] Fix `stusds-sky` slice: change `"depType": "collateral"` → `"depType": "wrapper"`.

- [ ] Replace `susdai-usd-ai` reserves array with:

```json
"reserves": [
  {
    "name": "USDai held 1:1 in staking vault",
    "pct": 100,
    "risk": "low",
    "coinId": "usdai-usd-ai",
    "depType": "wrapper"
  }
]
```

- [ ] **Audit step** — for each of the 12 non-strategy-vault wrappers (susde-ethena, susds-sky, sdai-sky, sfrxusd-frax, scrvusd-curve, cusdo-openeden, syusd-aegis, stusds-sky, stkgho-umbrella-aave, sbold-k3-capital, busd0-usual), grep for their reserves array and confirm exactly one slice has `coinId === variantOf` AND `depType === "wrapper"`. Repair any that don't.

- [ ] Add schema refine to `shared/lib/stablecoins/schema.ts`:

```ts
.refine(
  (meta) => {
    const needsSlice =
      meta.variantKind === "savings-passthrough" ||
      meta.variantKind === "risk-absorption" ||
      meta.variantKind === "bond-maturity";
    if (!needsSlice) return true;
    return (meta.reserves ?? []).some(
      (s) => s.coinId === meta.variantOf && s.depType === "wrapper"
    );
  },
  {
    message:
      "savings-passthrough, risk-absorption, and bond-maturity variants must declare at least one reserve slice with coinId === variantOf and depType === 'wrapper'",
    path: ["reserves"],
  }
)
```

- [ ] Run: `npm test shared/lib/__tests__/stablecoins.test.ts` → PASS.
- [ ] Commit: `fix(stablecoins): correct wrapper reserve slices and enforce invariant`

### Task 1.6: Extend `RedemptionBackstopConfig` + thread through `RedemptionBackstopEntry`

**Files:**
- Modify: `shared/lib/redemption-backstop-configs/shared.ts` (`RedemptionBackstopConfig` type + Zod)
- Modify: `shared/lib/redemption-backstop-scoring.ts` (or wherever `buildRedemptionBackstopEntry` lives — grep to confirm)
- Modify: `shared/types/` redemption-backstop type (if separate file)

**Steps:**

- [ ] Extend the **input** type `RedemptionBackstopConfig` at `shared/lib/redemption-backstop-configs/shared.ts:51`:

```ts
inheritsFromVariantOf?: {
  legHaircut: number;
  cooldownDays?: number;
  floorRatio?: number;
};
```

- [ ] Add to Zod:

```ts
inheritsFromVariantOf: z
  .object({
    legHaircut: z.number().min(0).max(1),
    cooldownDays: z.number().int().min(0).optional(),
    floorRatio: z.number().min(0).max(1).optional(),
  })
  .optional(),
```

- [ ] Thread through the **emitted** `RedemptionBackstopEntry` in `shared/lib/redemption-backstop-scoring.ts` — `buildRedemptionBackstopEntry()` must copy `config.inheritsFromVariantOf` into the output entry so the scoring pipeline can read it at `shared/lib/report-card-peg-liquidity.ts` (Task 2.3).

- [ ] Run: `cd worker && npx tsc --noEmit` → PASS.
- [ ] Commit: `feat(redemption): add inheritsFromVariantOf to config and emitted entry`

### Task 1.7: Populate `inheritsFromVariantOf` on 10 wrapper redemption configs

**Files:**
- Modify: `shared/lib/redemption-backstop-configs/stablecoin-redeem.ts` (5 entries)
- Modify: `shared/lib/redemption-backstop-configs/queue-redeem.ts` (5 entries — 3 + Maple pair)

**Steps:**

Use the following values (tune per issuer docs if needed). Values derived from `notes` fields + linked docs.

| Wrapper | File | legHaircut | cooldownDays | floorRatio |
|---|---|---|---|---|
| `susds-sky` | stablecoin-redeem.ts:169 | 0.95 | 0 | — |
| `sdai-sky` | stablecoin-redeem.ts:183 | 0.95 | 0 | — |
| `sfrxusd-frax` | stablecoin-redeem.ts:197 | 0.90 | 0 | — |
| `scrvusd-curve` | stablecoin-redeem.ts:211 | 0.92 | 0 | — |
| `cusdo-openeden` | stablecoin-redeem.ts:225 | 0.88 | 1 | — |
| `susde-ethena` | queue-redeem.ts:149 | 0.85 | 7 | — |
| `syusd-aegis` | queue-redeem.ts:167 | 0.80 | 7 | — |
| `susdai-usd-ai` | queue-redeem.ts:140 | 0.70 | 30 | — |
| `syrupusdc-maple` | queue-redeem.ts:72 | 0.70 | 1 | — |
| `syrupusdt-maple` | queue-redeem.ts:96 | 0.70 | 1 | — |

- [ ] Apply to each entry:

```ts
inheritsFromVariantOf: {
  legHaircut: 0.95,
  cooldownDays: 0,
},
```

- [ ] Run: `npm test shared/lib/redemption-backstop-configs` → PASS.
- [ ] Commit: `feat(redemption): populate two-leg inheritance on 10 wrapper configs`

### Task 1.8: Canonical-order adjacency documentation + D1 storage audit + API audit

**Files:**
- Modify: `shared/data/stablecoins/canonical-order.json` (comments / ordering if decisions need locking in)
- Read-only audit: `worker/src/lib/report-card-cache.ts`, `worker/src/api/*.ts`

**Steps:**

- [ ] Verify each variant's position in `canonical-order.json` is adjacent to its parent where applicable. Accepted non-adjacent cases (fiat-anchor parents): `yusd-yieldfi`, `syrupusdc-maple`, `syrupusdt-maple` — document in the file header comment.

- [ ] D1 storage audit: grep `worker/src/lib/report-card-cache.ts` + `worker/migrations/` for the persistence shape of `report_cards_cache`. Confirm JSON blob (not columnar). If columnar, add a backward-compatible `ALTER TABLE` migration. Expected: JSON blob; no migration needed.

- [ ] API contract audit: `grep -rn 'pegReferenceId' worker/src/api/` — document any public emission sites. If `/api/peg-summary` or `/api/report-card-snapshot` include `pegReferenceId` in their payload, the removal from 7 entries is a breaking API contract change. Document in `docs/api-reference.md` Phase 4 update.

- [ ] Commit (if any changes): `chore(stablecoins): verify canonical-order adjacency and document API contract change`

---

## Phase 2 — Scoring

Can develop in parallel with Phase 3 after Phase 1 lands.

### Task 2.1: `resolvePegInput()` — dual-branch resolution

**Files:**
- Modify: `worker/src/lib/report-cards-snapshot-card.ts` (around lines 54-86)

**Steps:**

- [ ] Rewrite `resolvePegInput()` with dual-branch (preserves 7 standalone NAV RWAs):

```ts
function resolvePegInput(
  meta: StablecoinMeta,
  directPeg: PegSummaryCoin | undefined,
  pegDataById: Map<string, PegSummaryCoin>,
  activeMetaById: Map<string, StablecoinMeta>
): {
  peg: PegSummaryCoin | null;
  pegReferenceMeta: StablecoinMeta | null;
  inheritedFromVariantOf: boolean;
  inheritedFromReference: boolean;
} {
  // Branch 1: direct data available
  if (directPeg?.pegScore != null) {
    return {
      peg: directPeg,
      pegReferenceMeta: null,
      inheritedFromVariantOf: false,
      inheritedFromReference: false,
    };
  }

  // Branch 2: variant path (new) — savings-passthrough, risk-absorption
  if (
    meta.variantOf &&
    (meta.variantKind === "savings-passthrough" ||
      meta.variantKind === "risk-absorption")
  ) {
    const parentMeta = activeMetaById.get(meta.variantOf);
    const parentPeg = pegDataById.get(meta.variantOf);
    if (parentMeta && parentPeg?.pegScore != null) {
      return {
        peg: parentPeg,
        pegReferenceMeta: parentMeta,
        inheritedFromVariantOf: true,
        inheritedFromReference: false,
      };
    }
  }

  // Branch 3: legacy NAV-RWA path (preserved for standalone NAV funds)
  if (meta.flags.navToken && meta.pegReferenceId) {
    const refMeta = activeMetaById.get(meta.pegReferenceId);
    const refPeg = pegDataById.get(meta.pegReferenceId);
    if (refMeta && refPeg?.pegScore != null) {
      return {
        peg: refPeg,
        pegReferenceMeta: refMeta,
        inheritedFromVariantOf: false,
        inheritedFromReference: true,
      };
    }
  }

  // Fall-through: no peg data
  return {
    peg: directPeg ?? null,
    pegReferenceMeta: null,
    inheritedFromVariantOf: false,
    inheritedFromReference: false,
  };
}
```

- [ ] Update call site at `worker/src/lib/report-cards-snapshot-card.ts:111-113`:

```ts
const inheritedKey = pegResolution.inheritedFromVariantOf
  ? meta.variantOf
  : pegResolution.inheritedFromReference
  ? meta.pegReferenceId
  : meta.id;
const activeDepegBps = activeDepegPeakBpsById.get(inheritedKey!) ?? null;
```

- [ ] Add regression test: for each of 7 standalone NAV RWAs (USYC, USDY, USTB, OUSG, mTBILL, tbill-openeden, thbill-theo), assert `resolvePegInput` still substitutes the referenced peg via Branch 3.

- [ ] Add archetype tests: for each of 4 archetypes, confirm the correct branch fires.

- [ ] Add `activeDepegBps` cascade test: given parent has `activeDepegPeakBpsById.get('usds-sky') = 1200`, wrapper `susds-sky`'s `activeDepegBps` resolves to `1200` via Branch 2.

- [ ] Run: `npm test shared/lib/__tests__/report-card-peg-liquidity.test.ts` → PASS.
- [ ] Commit: `refactor(report-cards): dual-branch peg resolution and activeDepegBps cascade`

### Task 2.2: Peg cap for direct-path variants

**Files:**
- Modify: `shared/lib/report-card-peg-liquidity.ts` (`scorePegStability()`)

**Steps:**

- [ ] In `scorePegStability()`, after computing the wrapper's peg score, apply cap ONLY when Branch 1 (direct data) fires for a variant:

```ts
// After score computation — cap only when wrapper has direct peg data.
// (Branch-2 substitutions already have score === parent.pegScore; cap is no-op there.)
if (options.variantMeta?.variantKind && options.parentPegScore != null) {
  if (score > options.parentPegScore) {
    score = options.parentPegScore;
  }
}
```

- [ ] Pass `variantMeta` + `parentPegScore` from the snapshot-card caller. Parent's peg score comes from `pegDataById.get(meta.variantOf)?.pegScore`.

- [ ] Add unit test: variant with artificially high direct score + parent's score of 82 → result ≤ 82.

- [ ] Commit: `feat(report-cards): cap variant pegScore at parent for direct-data path`

### Task 2.3: `scoreLiquidity()` — signature change + two-leg synthesis

**Files:**
- Modify: `shared/lib/report-card-peg-liquidity.ts` (`scoreLiquidity()` at lines 247-317)
- Modify: `worker/src/lib/report-cards-snapshot-card.ts` (caller at line 128)
- Modify: `shared/lib/__tests__/report-cards.test.ts` (~19 call sites)

**Steps:**

- [ ] Extend signature:

```ts
export function scoreLiquidity(
  liq: DexLiquidityData | undefined,
  redemption: RedemptionBackstopEntry | undefined,
  options?: {
    activeDepegBps?: number | null;
    variantContext?: {
      meta: StablecoinMeta;
      parentMeta: StablecoinMeta | null;
      parentLiquidityScore: number | null;
    };
  }
): LiquidityDimension { ... }
```

- [ ] Implement two-leg blend helper:

```ts
function synthesizeVariantLiquidityLeg(
  meta: StablecoinMeta,
  parentMeta: StablecoinMeta | null,
  parentLiquidityScore: number | null,
  inherits: RedemptionBackstopEntry["inheritsFromVariantOf"]
): number | null {
  if (!meta.variantKind || !parentMeta || parentLiquidityScore == null) return null;
  const haircut = inherits?.legHaircut ?? 0.9;
  const cooldownDays = inherits?.cooldownDays ?? 0;
  const cooldownHaircut = 1 - Math.min(cooldownDays / 30, 0.5);
  const FLOOR = {
    "savings-passthrough": 0,
    "strategy-vault": 60,
    "risk-absorption": 35,
    "bond-maturity": 40,
  }[meta.variantKind];
  const rawSynth = Math.round(parentLiquidityScore * haircut * cooldownHaircut);
  switch (meta.variantKind) {
    case "savings-passthrough":
      return rawSynth;
    case "strategy-vault":
      return Math.max(rawSynth, FLOOR);
    case "risk-absorption":
      return Math.max(rawSynth, FLOOR);
    case "bond-maturity":
      return FLOOR;  // pre-maturity; refine when maturityDate stored
    default:
      return null;
  }
}
```

- [ ] Blend into existing score: if `variantContext` present, compute both wrapper-leg (from dex/redemption) and parent-leg (from synthesis); final = `min(wrapperLeg ?? Infinity, parentLeg ?? Infinity)`. If both null → null (then `NO_LIQUIDITY_PENALTY` applies as today).

- [ ] Update call site at `worker/src/lib/report-cards-snapshot-card.ts:128` to pass `variantContext` (extract `parentMeta` from `activeMetaById` and `parentLiquidityScore` from `liquidityScoresById` map — latter needs to be populated during the topological pass).

- [ ] Update all test call sites at `shared/lib/__tests__/report-cards.test.ts:221-563` — bulk find-replace adding optional `options` arg where needed; most will be no-op.

- [ ] Add archetype liquidity tests — 4 archetypes × (wrapper-leg present / absent, cooldown 0/7/30).

- [ ] Run: `npm test shared/lib/__tests__/report-card-peg-liquidity.test.ts report-cards.test.ts` → PASS.
- [ ] Commit: `feat(report-cards): two-leg liquidity synthesis for variants`

### Task 2.4: Resilience — real-enum `downgradeTier` + strategy-vault floor

**Files:**
- Modify: `shared/lib/report-card-resilience.ts` (`resolveResilienceFactors()` at lines 175-188)

**Steps:**

- [ ] Add `parentMeta?: StablecoinMeta` parameter.

- [ ] Implement `downgradeTier()` using actual enum values from `shared/types/core.ts:89, 113`:

```ts
const COLLATERAL_TIER_ORDER: readonly CollateralQuality[] = [
  "native",
  "eth-lst",
  "rwa",
  "alt-lst-bridged-or-mixed",
  "exotic",
] as const;

function downgradeTier(q: CollateralQuality | undefined): CollateralQuality | undefined {
  if (!q) return undefined;
  const idx = COLLATERAL_TIER_ORDER.indexOf(q);
  if (idx < 0) return q;
  return COLLATERAL_TIER_ORDER[Math.min(idx + 1, COLLATERAL_TIER_ORDER.length - 1)];
}
```

- [ ] Apply archetype inheritance logic:

```ts
if (parentMeta && meta.variantKind) {
  switch (meta.variantKind) {
    case "savings-passthrough":
      collateralQuality ??= parentMeta.collateralQuality;
      custodyModel ??= parentMeta.custodyModel;
      break;
    case "risk-absorption":
    case "bond-maturity":
      collateralQuality = downgradeTier(
        meta.collateralQuality ?? parentMeta.collateralQuality
      );
      custodyModel ??= parentMeta.custodyModel;
      break;
    case "strategy-vault": {
      // Independent — but clamp floor when reserves empty or self-referential
      const hasSubstantiveReserves = (meta.reserves ?? []).some(
        (r) => r.coinId !== meta.variantOf
      );
      if (!hasSubstantiveReserves) {
        collateralQuality = collateralQuality ?? "rwa";  // floor, not native
      }
      break;
    }
  }
}
```

- [ ] Update sole caller in `worker/src/lib/report-cards-snapshot-card.ts` to pass `parentMeta`.

- [ ] Add tests per archetype: inherit, downgrade, independent + floor case.

- [ ] Run: `npm test shared/lib/__tests__/report-card-resilience.test.ts` → PASS.
- [ ] Commit: `feat(report-cards): archetype-driven resilience inheritance with strategy-vault floor`

### Task 2.5: Decentralization — use parent's computed score

**Files:**
- Modify: `shared/lib/report-card-governance.ts`
- Modify: `worker/src/lib/report-cards-snapshot-card.ts` (add `decentralizationScoreById` map)

**Steps:**

- [ ] Add new resolver:

```ts
import { VARIANT_GOVERNANCE_OVERLAY, MIN_VARIANT_GOVERNANCE_SCORE } from "./variant-overlays";

export function resolveVariantGovernanceScore(
  meta: StablecoinMeta,
  parentDecentralizationScore: number
): number {
  if (!meta.variantKind) return parentDecentralizationScore;
  const overlay = VARIANT_GOVERNANCE_OVERLAY[meta.variantKind];
  return Math.max(parentDecentralizationScore + overlay, MIN_VARIANT_GOVERNANCE_SCORE);
}
```

- [ ] In `scoreDecentralization()`, branch on `variantKind` — use parent's **computed** score (already includes chain penalty), not raw `GOVERNANCE_QUALITY_SCORE[quality]`:

```ts
if (meta.variantOf && parentDecentralizationScore != null) {
  const score = resolveVariantGovernanceScore(meta, parentDecentralizationScore);
  return { score, inheritedFromVariantOf: true };
}
// existing path
```

- [ ] In `worker/src/lib/report-cards-snapshot-card.ts`, populate a new `decentralizationScoreById: Map<string, number>` during the topological loop (parent scored first via extended `topologicalOrder()` from Task 1.3). Pass `parentDecentralizationScore = decentralizationScoreById.get(meta.variantOf)` into `scoreDecentralization()`.

- [ ] Keep `GOVERNANCE_QUALITY_VALUES["wrapper"]` in the enum for schema backward-compat. Document deprecation in code comment.

- [ ] Add tests: 4 archetypes × parent-score-present / parent-NR → correct inheritance behavior.

- [ ] Run: `npm test shared/lib/__tests__/report-card-governance.test.ts` → PASS.
- [ ] Commit: `feat(report-cards): variant decentralization inherits parent's computed score`

### Task 2.6: Extract overlay magnitudes to `variant-overlays.ts`

**Files:**
- Create: `shared/lib/variant-overlays.ts`

**Steps:**

- [ ] Create module:

```ts
import type { VariantKind } from "@shared/types/core";

export const VARIANT_GOVERNANCE_OVERLAY: Record<VariantKind, number> = {
  "savings-passthrough": -3,
  "strategy-vault": -10,
  "risk-absorption": -8,
  "bond-maturity": -5,
};

export const VARIANT_DEPENDENCY_PENALTY: Record<VariantKind, number> = {
  "savings-passthrough": 3,
  "strategy-vault": 5,
  "risk-absorption": 5,
  "bond-maturity": 8,
};

export const VARIANT_LIQUIDITY_FLOOR: Record<VariantKind, number> = {
  "savings-passthrough": 0,
  "strategy-vault": 60,
  "risk-absorption": 35,
  "bond-maturity": 40,
};

export const MIN_VARIANT_GOVERNANCE_SCORE = 10;
```

- [ ] Update Tasks 2.3, 2.5, 2.7 consumers to import from this module.

- [ ] Commit: `feat(report-cards): extract variant overlay magnitudes to shared module`

### Task 2.7: Dependency Risk — archetype-keyed penalty

**Files:**
- Modify: `shared/lib/report-card-dependency.ts` (around lines 100-108)

**Steps:**

- [ ] Replace flat `wrapperPenalty = 3` with:

```ts
import { VARIANT_DEPENDENCY_PENALTY } from "./variant-overlays";

const penalty = meta.variantKind
  ? VARIANT_DEPENDENCY_PENALTY[meta.variantKind]
  : 3;  // legacy default for depType:"wrapper" slices without variantKind
```

- [ ] Add stacking test: if wrapper has multiple wrapper-type slices, min ceiling wins.

- [ ] Run: `npm test shared/lib/__tests__/report-card-dependency.test.ts` → PASS.
- [ ] Commit: `feat(report-cards): archetype-keyed wrapper dependency penalty`

### Task 2.8: Overall grade ceiling — base + stressed paths + ReportCard type

**Files:**
- Modify: `shared/types/report-card.ts` (or wherever `ReportCard` is declared; grep to confirm)
- Modify: `shared/lib/report-card-overall.ts` (`computeOverallGrade()` at lines 54-57 AND `computeStressedGrades()` at line 150)
- Modify: `worker/src/lib/report-cards-snapshot-card.ts` (thread `parentOverallGrade`)

**Steps:**

- [ ] Add `overallCapped?: boolean` to the top-level `ReportCard` type (NOT just per-dimension).

- [ ] Update `computeOverallGrade()` signature:

```ts
export function computeOverallGrade(
  dimensions: ReportCardDimensions,
  options: {
    navToken: boolean;
    activeDepegBps: number | null;
    parentOverallGrade: number | null;
  }
): { grade: number; score: number; capped: boolean } {
  const raw = /* existing math */;
  if (options.parentOverallGrade != null && raw > options.parentOverallGrade) {
    console.info("[report-card] overall capped", {
      wrapperId: /* pass through via new param */,
      raw,
      parentGrade: options.parentOverallGrade,
    });
    return { grade: options.parentOverallGrade, score, capped: true };
  }
  return { grade: raw, score, capped: false };
}
```

- [ ] Apply identical logic inside `computeStressedGrades()` at line 150 — retrieve parent's stressed grade from the stressed-scores map and pass through.

- [ ] Thread `parentOverallGrade = overallScores.get(meta.variantOf) ?? null` from snapshot-card caller at `worker/src/lib/report-cards-snapshot-card.ts:135`.

- [ ] Surface `capped` in the final ReportCard assembly.

- [ ] Parent-NR behavior: if `parentOverallGrade == null`, skip cap (no-op).

- [ ] Add tests: (a) variant with high dimensions gets capped at parent; (b) stress-mode cap fires; (c) parent-NR doesn't cap.

- [ ] Run: `npm test shared/lib/__tests__/report-card-overall.test.ts` → PASS.
- [ ] Commit: `feat(report-cards): enforce parent ceiling in base and stressed grade paths`

### Task 2.9: Propagate `inheritedFromVariantOf` flags + `overallCapped` to UI state

**Files:**
- Modify: `shared/types/report-card.ts`
- Modify: `worker/src/lib/report-cards-snapshot-card.ts`

**Steps:**

- [ ] Add `inheritedFromVariantOf?: boolean` to each of the 5 dimension shapes.

- [ ] In `report-cards-snapshot-card.ts`, set the flag per-dimension based on the return values from Tasks 2.1-2.7.

- [ ] Add `overallCapped` plumbing to the top-level `ReportCard`.

- [ ] Run: `cd worker && npx tsc --noEmit` → PASS.
- [ ] Commit: `feat(report-cards): surface inheritedFromVariantOf per dimension + overallCapped`

### Task 2.10: Integration test — end-to-end wrapper scoring

**Files:**
- Create: `worker/src/lib/__tests__/report-cards-variant-integration.test.ts`

**Steps:**

- [ ] Write a test that builds the snapshot card for `usds-sky` + `susds-sky` + `stusds-sky` and asserts:
  - Parent is scored before children (topological order).
  - `susds-sky.overallGrade <= usds-sky.overallGrade`.
  - `stusds-sky.overallGrade <= usds-sky.overallGrade`.
  - `inheritedFromVariantOf` flags set on correct dimensions.
  - `overallCapped` flag set on at least one wrapper if cap would fire.
  - `activeDepegBps` cascades from parent to wrapper.

- [ ] Write a second test that passes for `yusd-yieldfi` + `usdc-circle` (fiat-anchor case): wrapper grade capped at `usdc-circle`'s grade.

- [ ] Run: `npm test report-cards-variant-integration` → PASS.
- [ ] Commit: `test(report-cards): end-to-end variant scoring integration tests`

### Task 2.11: Pre-merge grade-diff table

**Files:** N/A — manual step, output goes into PR description.

**Steps:**

- [ ] Run `npm run build`.
- [ ] Extract old vs new overall grades for the 18 wrappers from `_site-data/report-cards.json` (or equivalent snapshot).
- [ ] Produce markdown table `{id, oldGrade, newGrade, inheritedDims[], capped}`.
- [ ] Paste into PR body. Reviewer verifies each diff is expected.

### Phase 2 Verification

- [ ] `npm test` — PASS.
- [ ] `cd worker && npx tsc --noEmit` — PASS.
- [ ] Snapshot-diff table reviewed; no unexpected regressions.

---

## Phase 3 — UI

Can develop in parallel with Phase 2 after Phase 1 lands.

### Task 3.1: Variant display primitive (CSS tokens + Badge wrapper)

**Files:**
- Modify: `src/styles/tokens/semantic.css` — add `--variant-*` tokens
- Create: `src/lib/variant-display.ts`
- Create (or colocate): `src/components/stablecoin-detail/variant-badge.tsx`

**Steps:**

- [ ] Add semantic tokens to `src/styles/tokens/semantic.css` (light + dark):

```css
/* Savings passthrough */
--variant-savings-bg: oklch(0.95 0.05 200);
--variant-savings-text: oklch(0.35 0.12 200);
/* Strategy vault */
--variant-strategy-bg: oklch(0.96 0.08 80);
--variant-strategy-text: oklch(0.40 0.14 80);
/* Risk absorption */
--variant-risk-abs-bg: oklch(0.95 0.07 290);
--variant-risk-abs-text: oklch(0.40 0.16 290);
/* Bond maturity */
--variant-bond-bg: oklch(0.94 0.02 250);
--variant-bond-text: oklch(0.35 0.05 250);

.dark {
  --variant-savings-bg: oklch(0.25 0.08 200);
  --variant-savings-text: oklch(0.78 0.14 200);
  /* ... etc for dark variants of all four */
}
```

- [ ] Implement `src/lib/variant-display.ts`:

```ts
import type { VariantKind } from "@shared/types/core";

export const VARIANT_DISPLAY: Record<VariantKind, {
  short: string;
  long: string;
  bgVar: string;
  textVar: string;
}> = {
  "savings-passthrough": {
    short: "Savings",
    long: "Savings passthrough",
    bgVar: "--variant-savings-bg",
    textVar: "--variant-savings-text",
  },
  "strategy-vault": {
    short: "Strategy",
    long: "Strategy vault",
    bgVar: "--variant-strategy-bg",
    textVar: "--variant-strategy-text",
  },
  "risk-absorption": {
    short: "Risk-Abs",
    long: "Risk absorption",
    bgVar: "--variant-risk-abs-bg",
    textVar: "--variant-risk-abs-text",
  },
  "bond-maturity": {
    short: "Bond",
    long: "Bond maturity",
    bgVar: "--variant-bond-bg",
    textVar: "--variant-bond-text",
  },
};
```

- [ ] Implement `variant-badge.tsx` using shadcn `Badge` primitive at `src/components/ui/badge.tsx`:

```tsx
import { Badge } from "@/components/ui/badge";
import { VARIANT_DISPLAY } from "@/lib/variant-display";
import type { VariantKind } from "@shared/types/core";

export function VariantBadge({ kind, variant = "short" }: {
  kind: VariantKind;
  variant?: "short" | "long";
}) {
  const d = VARIANT_DISPLAY[kind];
  return (
    <Badge
      variant="outline"
      style={{ background: `var(${d.bgVar})`, color: `var(${d.textVar})` }}
    >
      {variant === "short" ? d.short : d.long}
    </Badge>
  );
}
```

- [ ] Commit: `feat(ui): variant display primitive with semantic tokens`

### Task 3.2: Wrapper detail page — hero chip, Underlying section, KeyInfoCard chip

**Files:**
- Modify: `src/components/stablecoin-detail/hero-card.tsx`
- Create: `src/components/stablecoin-detail/underlying-asset-section.tsx`
- Modify: `src/components/key-info-card.tsx`
- Modify: `src/app/stablecoin/[id]/client.tsx` (insertion at line 297)

**Steps:**

- [ ] In `hero-card.tsx` `HeroClassificationLine` at lines 223-251, append a "Variant of [parent]" pill when `meta.variantOf && meta.variantKind` — use existing `pharos-focus-ring` + pill classes consistent with `InfrastructureChip` at line 141. Click → `buildStablecoinUrl(meta.variantOf)`.

- [ ] Create `underlying-asset-section.tsx`:

```tsx
import Link from "next/link";
import { buildStablecoinUrl } from "@/lib/stablecoin-url";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { VariantBadge } from "@/components/stablecoin-detail/variant-badge";
import { VARIANT_DISPLAY } from "@/lib/variant-display";
import type { StablecoinMeta, VariantKind } from "@shared/types/core";

export function UnderlyingAssetSection({ parent, kind }: {
  parent: StablecoinMeta;
  kind: VariantKind;
}) {
  const display = VARIANT_DISPLAY[kind];
  return (
    <section id="underlying-asset" className="...">
      <h3>Underlying asset</h3>
      <Link href={buildStablecoinUrl(parent.id)} className="pharos-focus-ring ...">
        <StablecoinLogo meta={parent} />
        <div>
          <div>{parent.symbol} <span className="text-muted-foreground">{parent.name}</span></div>
          <div className="text-sm text-muted-foreground">
            {display.long} · safety inherited per §3 of methodology
          </div>
        </div>
        <VariantBadge kind={kind} />
      </Link>
    </section>
  );
}
```

- [ ] In `src/app/stablecoin/[id]/client.tsx:297`, insert `<UnderlyingAssetSection />` **above `<NoticesAndSummarySection />`** (not above `KeyInfoCard`) when `viewModel.isVariant`.

- [ ] In `key-info-card.tsx:91-99`, append a `<VariantBadge kind={meta.variantKind!} />` chip in the existing pill row (same slot as the `Yield-Bearing` emerald chip).

- [ ] Extend `useStablecoinDetailViewModel` to expose `isVariant: boolean` and `hasVariants: boolean` derived from `meta.variantOf` and `getVariants(meta.id)`.

- [ ] Run: `npm run build` on a subset; Playwright smoke on `/stablecoin/susds-sky/`.
- [ ] Commit: `feat(ui): wrapper hero chip, underlying-asset section, KeyInfoCard chip`

### Task 3.3: Scrollspy entries + dimension inheritance chips + overallCapped chip

**Files:**
- Modify: `src/app/stablecoin/[id]/client.tsx` (`DETAIL_SECTION_DEFS` at lines 90-102)
- Modify: `src/components/report-card.tsx`

**Steps:**

- [ ] Add two new entries to `DETAIL_SECTION_DEFS`:

```ts
const DETAIL_SECTION_DEFS = {
  // ... existing
  underlying: { id: "underlying-asset", label: "Underlying" },
  variants: { id: "variants-card", label: "Variants" },
};
```

- [ ] Filter section visibility per `viewModel.isVariant` / `viewModel.hasVariants` at lines 196-210.

- [ ] In `report-card.tsx`, for each of the 5 dimension cards, render `<Chip>inherited from {parentSymbol}</Chip>` below the score when `dimension.inheritedFromVariantOf`.

- [ ] For the Overall summary card, render `<Chip>Overall capped at {parentSymbol}'s grade</Chip>` when `card.overallCapped`.

- [ ] Commit: `feat(ui): scrollspy variant entries + dimension inheritance + overall cap chips`

### Task 3.4: Reserve treemap SVG hyperlinks

**Files:**
- Modify: `src/components/reserve-treemap.tsx` (`TreemapCell` around lines 36-104)

**Steps:**

- [ ] Wrap the `<g>` element inside `TreemapCell` with an SVG-native `<a>`:

```tsx
function TreemapCell(props: TreemapCellProps) {
  const { slice, ... } = props;
  const href = slice.coinId ? buildStablecoinUrl(slice.coinId) : null;
  const content = (
    <g>
      <rect /* ... */ />
      <text /* ... */ />
    </g>
  );
  if (!href) return content;
  return (
    <a
      xlinkHref={href}
      href={href}
      tabIndex={0}
      aria-label={`${slice.name}, ${slice.pct}%. Click to view ${slice.coinId} details.`}
    >
      {content}
    </a>
  );
}
```

Note: `xlinkHref` is the legacy SVG attribute; modern browsers accept `href` directly on `<a>` inside `<svg>`. Both recommended for compat.

- [ ] Run: Playwright — click a tile on sUSDe's detail page, confirm navigation to usde-ethena's page.
- [ ] Commit: `feat(ui): SVG-native hyperlinks on reserve-treemap tiles`

### Task 3.5: Parent "Variants" card + `CollateralUsageSection` partition

**Files:**
- Create: `src/components/stablecoin-detail/variants-card.tsx`
- Modify: `src/components/stablecoin-detail/collateral-usage-section.tsx`
- Modify: `src/app/stablecoin/[id]/client.tsx`

**Steps:**

- [ ] Implement `VariantsCard` **reusing the `CollateralUsageItem` row template**:

```tsx
export function VariantsCard({ parent }: { parent: StablecoinMeta }) {
  const variants = getVariants(parent.id);
  if (variants.length === 0) return null;
  return (
    <section id="variants-card" className="...">
      <h3>Variants of {parent.symbol}</h3>
      <ul>
        {variants.map((v) => (
          <li key={v.id}>
            <Link href={buildStablecoinUrl(v.id)} className="pharos-focus-ring ...">
              <StablecoinLogo meta={v} />
              <span>{v.symbol}</span>
              <VariantBadge kind={v.variantKind!} />
              <OverallGradeChip id={v.id} />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

- [ ] In `collateral-usage-section.tsx`, filter out `entry.type === "wrapper"` entries. They now belong to `VariantsCard`.

- [ ] In `client.tsx`, render `<VariantsCard parent={meta} />` **independently** (not conditional on `CollateralUsageSection`'s visibility). Position in the Context & details zone above `<CollateralUsageSection />` (which remains gated on `hasCollateralUsage`).

- [ ] Commit: `feat(ui): parent variants card and collateral-usage partition`

### Task 3.6: Directory table — archetype badge + parent subtitle + terse peg column

**Files:**
- Modify: `src/components/stablecoin-table-row.tsx`

**Steps:**

- [ ] In the Symbol column, when `meta.variantKind`, render:
  - The symbol
  - A small parent-symbol subtitle below (resolving `meta.variantOf` to parent symbol)
  - `<VariantBadge kind={meta.variantKind} />` with `onClick={(e) => { e.stopPropagation(); router.push(...); }}` to prevent row double-click-navigation

- [ ] Replace the peg column (lines 191-201) with terse, archetype-aware labels:

```tsx
function renderPegColumn(meta: StablecoinMeta, parent?: StablecoinMeta): { value: string; title: string } {
  if (!meta.variantKind) {
    if (meta.flags.navToken) {
      return { value: meta.flags.pegCurrency === "VAR" ? "CPI" : "NAV", title: "NAV token" };
    }
    return /* existing deviation rendering */;
  }
  switch (meta.variantKind) {
    case "savings-passthrough":
    case "risk-absorption":
      return {
        value: "→ P",
        title: `Peg inherits from ${parent?.symbol ?? "parent"}`,
      };
    case "strategy-vault":
      return { value: "Strat.", title: "NAV-priced strategy vault" };
    case "bond-maturity":
      return { value: "Bond", title: "Bond with maturity redemption" };
  }
}
```

- [ ] Playwright smoke on `/stablecoins/` directory — confirm badges render, no column overflow.
- [ ] Commit: `feat(ui): directory table variant badges and terse peg labels`

### Task 3.7: Filter bar — 6-col grid + FilterTag enum extension

**Files:**
- Modify: `shared/types/core.ts` (`FilterTag` at line 253; `getFilterTags()` at line 435)
- Modify: `src/hooks/use-homepage-filters.ts` (FILTER_GROUPS at lines 12-33)
- Modify: `src/components/filter-bar.tsx` (grid template at line 78)

**Steps:**

- [ ] Extend `FilterTag` union at `shared/types/core.ts:253`:

```ts
export type FilterTag =
  | /* existing */
  | "variant-base"
  | "variant-savings-passthrough"
  | "variant-strategy-vault"
  | "variant-risk-absorption"
  | "variant-bond-maturity";
```

- [ ] Update `getFilterTags(meta)` at line 435 to emit variant tags:

```ts
tags.push(meta.variantKind ? `variant-${meta.variantKind}` : "variant-base");
```

- [ ] Add filter group to `use-homepage-filters.ts:12-33`:

```ts
{
  key: "variant",
  label: "Variant",
  options: [
    "variant-base",
    "variant-savings-passthrough",
    "variant-strategy-vault",
    "variant-risk-absorption",
    "variant-bond-maturity",
  ],
},
```

- [ ] Update grid template at `filter-bar.tsx:78` from 5 to 6 tracks (or restructure to two rows at `lg` breakpoint):

```tsx
className="... lg:grid-cols-[1fr_1.2fr_0.6fr_1fr_1.2fr_0.9fr]"
```

- [ ] Playwright: toggle each variant filter and verify table filters correctly.
- [ ] Commit: `feat(ui): variant filter group + FilterTag plumbing`

### Task 3.8: Taxonomy hub routes + StablecoinTaxonomyPage extension + nav entry

**Files:**
- Modify: `src/components/stablecoin-taxonomy-page.tsx` (extend `kind` union at lines 14-18)
- Modify: `src/lib/stablecoin-taxonomy.ts`
- Create: `src/app/stablecoins/variants/page.tsx` (index)
- Create: `src/app/stablecoins/variants/[parent]/page.tsx` (per-parent)
- Modify: `src/lib/nav-config.ts` (TRACK group)
- Modify: `src/app/sitemap.ts` (if it generates routes; otherwise robots.txt)

**Steps:**

- [ ] Extend `StablecoinTaxonomyPage.kind` union at `src/components/stablecoin-taxonomy-page.tsx:14-18`:

```ts
kind: "backing" | "governance" | "infrastructure" | "variant";
```

- [ ] Update `stablecoin-taxonomy.ts` to include variant taxonomy pages. Implement VARIANT_TAXONOMY_PAGES helper.

- [ ] Implement `/stablecoins/variants/page.tsx` as the index (hub-of-hubs) using `StablecoinTaxonomyHub` with `pages: VARIANT_TAXONOMY_PAGES` (one `StablecoinTaxonomyPage<"variant">` per parent with ≥1 variant).

- [ ] Implement `/stablecoins/variants/[parent]/page.tsx` (param name `[parent]`, not `[parent-id]`) with `generateStaticParams()`:

```tsx
import { ACTIVE_IDS } from "@shared/lib/stablecoins";

export async function generateStaticParams() {
  const parents = Array.from(new Set(
    ACTIVE_STABLECOINS
      .filter((c) => c.variantOf && ACTIVE_IDS.has(c.variantOf))
      .map((c) => c.variantOf!)
  ));
  return parents.map((id) => ({ parent: id }));
}
```

- [ ] Per-parent page uses extended `StablecoinTaxonomyPage` with `kind: "variant"` and `filterTag: variant-${variantKind}` via `StablecoinFilteredTable`.

- [ ] Add nav entry to `src/lib/nav-config.ts` under the `TRACK` group (existing taxonomy routes like `/backing`, `/peg`, `/governance`, `/infrastructure` are NOT currently in the sidebar — Variants is a standalone addition alongside `/chains`, `/liquidity`, `/depeg`).

- [ ] Extend `src/app/sitemap.ts` to enumerate `/stablecoins/variants/` and each `/stablecoins/variants/[parent]/` route.

- [ ] Run: `npm run build`, `npm run seo:check` → PASS.
- [ ] Playwright smoke on `/stablecoins/variants/` and `/stablecoins/variants/usds-sky/`.
- [ ] Commit: `feat(ui): taxonomy hub for variants with per-parent pages, nav, sitemap`

### Task 3.9: Command palette grouping

**Files:**
- Modify: `src/components/command-palette.tsx` (around lines 140-163, 273-292, 473)

**Steps:**

- [ ] Extend section model to support dynamic sub-label groups. Implementation sketch:
  - Add a `subGroup?: string` field to the result item shape.
  - In the filter-and-group pipeline (around lines 140-163), compute per-parent sub-groups when any matched results share a `variantOf` that matches the parent's id.
  - In `sectionOrder` at line 273, keep `"Stablecoins"` but render variant groups as nested headers inside that section.
  - Update `flatResults` for keyboard nav at line 473 so arrow keys traverse the grouped items correctly.

- [ ] Commit: `feat(ui): command palette groups variant results under parent`

### Task 3.10: Yield leaderboard — double-logo overlay

**Files:**
- Modify: `src/components/yield-leaderboard-table-row.tsx` (not yield-leaderboard.tsx — verified the actual render file)

**Steps:**

- [ ] In the coin column, when `meta.variantOf`, render the wrapper's logo with a small parent-logo corner overlay. New sub-component (no existing double-logo pattern to reuse).

- [ ] Fallback: if visual QA rejects the double-logo, replace with a small "V" pill with `title` = parent symbol. Keep fallback code commented.

- [ ] Commit: `feat(ui): yield leaderboard parent-logo overlay for variants`

### Task 3.11: Comparison page inheritance row + divergence highlight

**Files:**
- Modify: `src/lib/compare-pages.ts`
- Modify: `src/components/comparison-table.tsx`

**Steps:**

- [ ] In `compare-pages.ts`, detect wrapper↔parent pairs: if one has `variantOf` === other.id. Render an "Inheritance" row describing inherited vs independent dimensions.

- [ ] When both sides have same `variantOf`: highlight divergent rows (different `variantKind`, different dimension scores).

- [ ] Commit: `feat(ui): comparison inheritance row and sibling-variant divergence`

### Task 3.12: Contagion graph — variants focus mode

**Files:**
- Modify: `src/components/contagion-graph.tsx` (around line 64 `focusMode`)

**Steps:**

- [ ] Extend `focusMode` state at line 64 from `"all" | "neighborhood"` to `"all" | "neighborhood" | "variants"`.

- [ ] Add a ToggleGroup entry labeled "Variants" with tooltip "Click a parent to zoom into its variant cluster."

- [ ] When mode is `"variants"` and a node is clicked, highlight all edges with `type === "wrapper"` leaving that node; fade others.

- [ ] Update `aria-label` and keyboard nav (`handleNodeKeyDown` at `client.tsx:184` already handles generic node keyboarding).

- [ ] Commit: `feat(ui): contagion graph variants focus mode`

### Task 3.13: OG image + JSON-LD `isBasedOn` + `identifier` PropertyValue

**Files:**
- Modify: `src/app/api/og/stablecoin/[id]/route.ts` (or equivalent OG renderer; grep `ShareButton` at `hero-card.tsx:659` confirms endpoint)
- Modify: `src/app/stablecoin/[id]/page.tsx` (JSON-LD emission around lines 148-203)

**Steps:**

- [ ] In OG renderer, draw a corner badge reading "Variant of [parent]" when `meta.variantOf`.

- [ ] In JSON-LD `Dataset` payload at `src/app/stablecoin/[id]/page.tsx:148-203`:

```tsx
const dataset = {
  "@context": "https://schema.org",
  "@type": "Dataset",
  /* existing fields */,
  ...(parent && {
    isBasedOn: `${SITE_URL}${buildStablecoinUrl(parent.id)}#dataset`,
  }),
  identifier: [
    /* existing identifier entries */,
    ...(meta.variantKind ? [{
      "@type": "PropertyValue",
      propertyID: "variantKind",
      value: meta.variantKind,
    }] : []),
  ],
};
```

- [ ] Run: `npm run seo:check` → PASS.
- [ ] Commit: `feat(seo): variant-of Schema.org metadata and OG badge`

### Task 3.14: Playwright coverage — variant affordances

**Files:**
- Create or modify: Playwright test file covering variant UI (grep existing Playwright directory for convention)

**Steps:**

- [ ] Add tests:
  - Wrapper detail page (`/stablecoin/susds-sky/`): hero variant chip visible + links to parent; "Underlying" section present; report card shows inheritance chips.
  - Parent detail page (`/stablecoin/usds-sky/`): "Variants" card lists susds-sky + stusds-sky; collateral-usage section doesn't contain them.
  - Directory table: wrapper rows show archetype badges; peg column renders `"→ P"` with tooltip.
  - Filter bar: toggling each variant chip filters the table.
  - Taxonomy hub: `/stablecoins/variants/` renders parent list; `/stablecoins/variants/usds-sky/` renders variant list.

- [ ] Commit: `test(ui): Playwright coverage for variant affordances`

### Phase 3 Verification

- [ ] `npm run build` — PASS.
- [ ] `npm run seo:check` — PASS.
- [ ] Playwright suite — PASS.
- [ ] Visual QA on variant chip unification across hero/KeyInfoCard/directory.

---

## Phase 4 — Documentation & Methodology

### Task 4.1: Methodology version bump to v7.10 + variants page

**Files:**
- Modify: `shared/lib/safety-score-version-data.ts` (`currentVersion: "7.08"` → `"7.10"`)
- Modify: `docs/report-cards.md` (heading `## Overall Grade (v7.08)` → `(v7.10)`)
- Create: `src/app/methodology/variants/page.tsx` (if routed under `src/app/methodology/`) or doc at `docs/methodology/variants.md`

**Steps:**

- [ ] Bump `currentVersion` in `safety-score-version-data.ts:4` to `"7.10"`. Add a new entry to the version history array with description.

- [ ] Update `docs/report-cards.md` heading + add a "Variant Inheritance" section with the archetype/inheritance tables from spec §1 + scoring rules from §3.

- [ ] Create `methodology/variants` page. Mirror the existing methodology route convention in `src/app/methodology/`.

- [ ] Run: `npm run check:doc-sync` → PASS.
- [ ] Commit: `docs(methodology): v7.10 variant inheritance framework`

### Task 4.2: Input reference + architecture + process + skill docs

**Files:**
- Modify: `docs/report-cards-input-reference.md`
- Modify: `docs/architecture.md`
- Modify: `agents/process/adding-a-stablecoin.md`
- Modify: `resilience-classify` skill (if it's at `.claude/skills/` or similar — grep to confirm)
- Modify: `docs/api-reference.md`

**Steps:**

- [ ] `report-cards-input-reference.md`: document `variantOf`, `variantKind`, and their role in scoring.

- [ ] `architecture.md`: add Variant Topology section describing the inverse-index pattern and `topologicalOrder()` extension.

- [ ] `adding-a-stablecoin.md`: update wrapper promotion section with:
  - Required `variantOf` + `variantKind`.
  - Required reserve slice `{coinId: variantOf, depType: "wrapper"}` for savings-passthrough, risk-absorption, bond-maturity.
  - Optional `inheritsFromVariantOf` on redemption backstop.
  - Archetype classification rubric (link to spec §1).
  - Note that wrapper `collateralQuality` may be runtime-downgraded.

- [ ] `resilience-classify` skill: note that authored `collateralQuality` on wrappers is an input; runtime may downgrade per archetype rules.

- [ ] `api-reference.md`: document `pegReferenceId` removal from 7 entries as a breaking field removal. List affected IDs. Coordinate with external consumers (e.g. bluechip.org).

- [ ] Commit: `docs: variantOf/variantKind in input reference, architecture, process, skill, API`

### Task 4.3: About page + changelog entry

**Files:**
- Modify: `src/app/about/page.tsx` (or equivalent)
- Create: `src/data/changelogs/2026-04-22.ts` (correct path — NOT `changelog/`)

**Steps:**

- [ ] Add a short note on About page: "Pharos models variant stablecoins (staked, wrapped, strategy vaults) with a typed archetype system; see methodology/variants for details."

- [ ] Create changelog entry at `src/data/changelogs/YYYY-MM-DD.ts` (date = ship date). Reference `src/data/changelogs/types.ts` for shape. Summarize: new taxonomy, new schema fields, scoring inheritance + ceiling, UI changes, `pegReferenceId` API contract change.

- [ ] Commit: `docs: about-page note and changelog entry for variant framework`

### Task 4.4: Final verification + merge gate

**Files:** N/A.

**Steps:**

- [ ] `npm run check:doc-counts` → PASS.
- [ ] `npm run check:doc-sync` → PASS.
- [ ] `npm run test:merge-gate` → PASS.
- [ ] `cd worker && npx tsc --noEmit` → PASS.
- [ ] Grade-diff table (Task 2.11) attached to PR body.
- [ ] Classification sign-off received for sBOLD, stcUSD, syrupUSDC/T.
- [ ] Snapshot-safety-grade-history cron alert mute prepared for deploy window.
- [ ] Rollback playbook documented in PR body.
- [ ] Ready for merge.

---

## Risks & mitigations

- **Wrapper grade shifts on ship.** All 18 wrappers may have pre/post grade deltas. Task 2.11 produces a diff table; reviewer verifies each delta is expected.
- **Fiat-anchor parent ceilings** (yUSD-YieldFi, syrupUSDC, syrupUSDT capped at USDC/USDT grades) — philosophically correct but operator may want per-archetype override later. Flagged in PR body.
- **snapshot-safety-grade-history daily cron** persists the wrapper grade diffs on first fire post-deploy → Telegram alert volume spike. Mitigation: one-time alert mute around deploy.
- **pegReferenceId API contract change** — breaking field removal on 7 entries. Document in `api-reference.md` + changelog. Coordinate with bluechip.org if they scrape.
- **Strategy-vault reserves empty** → `collateralQuality` clamp to `"rwa"` prevents over-scoring. Authors can override with explicit reserves.
- **Archetype borderline classifications** (sBOLD, stcUSD, syrupUSDC/T) — sign-off by @tokenbrice before merge.
- **Double-logo overlay visual quality on yield leaderboard** — fallback to "V" pill if QA rejects (Task 3.10).

## Rollback playbook

If post-deploy wrapper grades are clearly wrong:

1. Revert merge commit on `main`.
2. Worker rollback: automated via existing CI (`deploy-cloudflare.yml:156-184`) + `wrangler rollback`.
3. Pages rolls back with a re-deploy of prior build artifact.
4. D1 untouched (no migration in this plan).
5. `snapshot-safety-grade-history` rows from the bad deploy remain as audit trail — do not purge.
6. Document the incident + root cause; file a follow-up ticket for calibration.

## Out of scope (follow-ups)

- Promoting ~25 yield-only variants in `YIELD_VARIANT_MAP` to first-class or lightweight-variant representation.
- Aggregate market-cap dedup (distinct vs raw on homepage and chain aggregates).
- Automated archetype classification via a `variant-classify`-style skill.
- Per-coin overlay-magnitude tuning after Phase 2 data lands (tunable via `shared/lib/variant-overlays.ts`).
- Deprecating `GOVERNANCE_QUALITY_VALUES["wrapper"]` enum value (retained for backward compat this round).
- Removing `pegReferenceId` from external API payload after a deprecation window (if consumers need time to migrate).
