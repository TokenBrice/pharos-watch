# Infrastructure Tagging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalise the Liquity-fork taxonomy into a flat `infrastructures: Infrastructure[]` axis with three siblings (`liquity-v1`, `liquity-v2`, `m0`), migrate the existing 14 Liquity coins and 11 already-tracked M0 coins, and rewire every UI surface (badge, filter group, taxonomy pages, methodology) to read from the new field.

**Architecture:** Phased additive-then-switch-then-remove migration. Phase A adds the new types/schema and writes the new field alongside the old fields so nothing breaks. Phase B switches all consumers to read the new field and renames helpers/components. Phase C removes the old `protocolFamily` / `protocolVariant` fields entirely. Phase D handles methodology copy, docs, and verification.

**Tech Stack:** TypeScript strict, Zod validation, Vitest, React 19, Next.js 16 static export, Cloudflare Pages `_redirects`, Tailwind CSS v4.

---

## Context — what changed since the spec was written

The spec was committed at `5a679668` and described **7 already-tracked M0 coins**. Two subsequent commits on `main` added more M0 coverage:

- `16ba080d Add 4 M0-infrastructure stablecoins: wM, USDnr (Nerona), USDK (KAST), XO Cash`
- `0fcb4687 docs: bump tracked/active counts to 192/182 after M0 additions`

So the **current** count of M0 coins to tag is **11** (5 originally in `usd-minor.json` + 4 newly added in `usd-minor.json` + 2 in `usd-major.json`). The Liquity coin set is unchanged at 14.

---

## Spec corrections (factual fixes from research, no design changes)

The brainstorming spec at `agents/specs/2026-04-09-infrastructure-tagging-design.md` was written from a fast research pass and missed five files. The decisions are unchanged; the file inventory is updated below:

1. **14 Liquity coins, not 13.** A 14th coin `cjpy-yamato` (Convertible JPY Token / Yamato Protocol) lives in `shared/data/stablecoins/non-usd.json` with `protocolFamily: "liquity"` / `protocolVariant: "v1"`. The spec listed only the 13 in `usd-minor.json`.
2. **`shared/lib/stablecoins/schema.ts`** has Zod validation (`PROTOCOL_FAMILY_VALUES` / `PROTOCOL_VARIANT_VALUES` constants near line 44, schema fields near line 167). The schema is `.strict()` so adding a new JSON field without updating the schema first will fail validation. **Order matters: schema first, then data.**
3. **`src/components/key-info-card.tsx`** is a second consumer of `getProtocolFamilyLabel` / `getProtocolFamilySummary` and renders its own frost-blue Liquity chip. The spec only listed `hero-card.tsx`.
4. **`src/components/stablecoin-taxonomy-page.tsx`** imports the `ProtocolTaxonomyValue` type alias and needs renaming.
5. **`src/components/__tests__/stablecoin-table-logic.test.ts`** has an explicit test against the `liquity-family` filter tag that needs rewriting against the new tag set.
6. **Path references in docs** — `README.md`, `CLAUDE.md`, `docs/architecture.md`, `docs/README.md`, `docs/stablecoin-detail-page.md`, `docs/classification.md` — name the old `/stablecoins/protocol/[protocol]/` route. Update for the rename.

---

## File structure

### Files modified

| File | Responsibility | Phase |
|---|---|---|
| `shared/types/core.ts` | Add `Infrastructure` type, `INFRASTRUCTURE_LABELS`, `infrastructures?` field on `StablecoinMeta`, new `FilterTag` union members, updated `getFilterTags()`; later remove `ProtocolFamily` / `ProtocolVariant` types and old field | A, B, C |
| `shared/lib/stablecoins/schema.ts` | Add `infrastructures` Zod array, later remove `protocolFamily` / `protocolVariant` schema fields | A, C |
| `shared/data/stablecoins/usd-minor.json` | Add `infrastructures` to 13 Liquity + 9 M0 entries; later remove old fields | A, C |
| `shared/data/stablecoins/usd-major.json` | Add `infrastructures` to 2 M0 entries (`usd0-usual`, `usdai-usd-ai`) | A |
| `shared/data/stablecoins/non-usd.json` | Add `infrastructures` to 1 Liquity entry (`cjpy-yamato`); later remove old fields | A, C |
| `shared/lib/protocol-family.ts` → `shared/lib/infrastructure.ts` | File rename + new `getInfrastructureLabel()` / `getInfrastructureSummary()` helpers | B |
| `src/components/stablecoin-detail/hero-card.tsx` | Rename `LiquityForkBadge` → `InfrastructureBadge`, render one chip per array element with violet for M0, drop the `LIQUITY_ORIGINALS` exclusion | B |
| `src/components/stablecoin-detail/__tests__/hero-card.test.tsx` | Update fixture from old field to new field; add M0 case | B |
| `src/components/key-info-card.tsx` | Switch to `getInfrastructureLabel`/`Summary`, render one chip per array element, replace "Protocol Lineage" section with one summary per infrastructure | B |
| `src/components/stablecoin-detail/explore-next-section.tsx` | Switch to new helper, rename builder, link to first infrastructure | B |
| `src/hooks/use-homepage-filters.ts` | Rename "Liquity Forks" filter group → "Infrastructure", add `infrastructure-m0` option | B |
| `src/hooks/__tests__/use-homepage-filters.test.ts` | Replace Liquity Forks assertions with Infrastructure assertions | B |
| `src/components/filter-bar.tsx` | Drop `liquity-v1` / `liquity-v2` label overrides | B |
| `src/lib/stablecoin-taxonomy.ts` | Rewrite `PROTOCOL_*` → `INFRASTRUCTURE_*` constants/helpers/types; drop `liquity-family`; add `m0` | B |
| `src/components/stablecoin-taxonomy-page.tsx` | Rename `ProtocolTaxonomyValue` import to `InfrastructureTaxonomyValue` | B |
| `src/components/__tests__/stablecoin-table-logic.test.ts` | Rewrite the Liquity-family test against the new tag set | B |
| `src/app/stablecoins/protocol/[protocol]/page.tsx` | Move file to new route directory and update imports/dynamic segment | B |
| `public/_redirects` | Add 6 new 301 redirect lines from old paths to new | B |
| `src/app/methodology/sections/core-sections.tsx` | Register the new `<InfrastructureMethodologySection />` in the section list | D |
| `src/app/about/page.tsx` | Add a one-line mention of M0's GraphQL subgraph in the data sources block | D |
| `README.md`, `CLAUDE.md`, `docs/architecture.md`, `docs/README.md`, `docs/stablecoin-detail-page.md`, `docs/classification.md` | Update path references and any `protocolFamily` mentions to the new field/path | D |

### Files created

| File | Responsibility |
|---|---|
| `shared/lib/infrastructure.ts` | New helper module (replaces `protocol-family.ts`) |
| `src/app/stablecoins/infrastructure/[infrastructure]/page.tsx` | New dynamic route (move target of the protocol route) |
| `shared/types/__tests__/core.test.ts` | New unit tests for `getFilterTags()` covering empty, single, and multi-element `infrastructures` arrays |
| `src/app/methodology/sections/core/infrastructure-section.tsx` | New methodology section component for the Infrastructure axis |

### Files deleted

| File | Reason |
|---|---|
| `shared/lib/protocol-family.ts` | Renamed to `infrastructure.ts` |
| `src/app/stablecoins/protocol/[protocol]/page.tsx` | Moved to `infrastructure/[infrastructure]/` |

---

## Phase A — Additive (types, schema, data)

### Task 1: Add `Infrastructure` type, `INFRASTRUCTURE_LABELS`, and `INFRASTRUCTURE_VALUES` to `core.ts`

**Files:**
- Modify: `shared/types/core.ts` (insert immediately after the existing `ProtocolFamily` / `ProtocolVariant` lines, currently around line 96-97)

- [ ] **Step 1: Add the type, constants, and label map**

In `shared/types/core.ts`, immediately after the `export type ProtocolVariant = ...` line, insert:

```ts
export type Infrastructure = "liquity-v1" | "liquity-v2" | "m0";

export const INFRASTRUCTURE_VALUES = ["liquity-v1", "liquity-v2", "m0"] as const;

export const INFRASTRUCTURE_LABELS: Record<Infrastructure, string> = {
  "liquity-v1": "Liquity v1",
  "liquity-v2": "Liquity v2",
  "m0": "M0",
};
```

- [ ] **Step 2: Run frontend and worker type-checks**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard && npx tsc --noEmit
cd /Users/ahirice/Documents/git/stablecoin-dashboard/worker && npx tsc --noEmit
```

Expected: both pass.

- [ ] **Step 3: Commit**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard
git add shared/types/core.ts
git commit -m "feat(types): add Infrastructure type and labels"
```

---

### Task 2: Add `infrastructures` field to `StablecoinMeta` and new `FilterTag` union members

**Files:**
- Modify: `shared/types/core.ts` (`StablecoinMeta` interface, `FilterTag` union, `FILTER_TAG_LABELS`)

- [ ] **Step 1: Add the `infrastructures` field to `StablecoinMeta`**

In `shared/types/core.ts`, find the `protocolVariant?: ProtocolVariant;` line inside the `StablecoinMeta` interface and insert this on the next line, before `reserves?: ReserveSlice[];`:

```ts
  infrastructures?: Infrastructure[];
```

Leave `protocolFamily` and `protocolVariant` in place — they will be removed in Phase C.

- [ ] **Step 2: Add the new tags to the `FilterTag` union**

Find the `| "liquity-style"` line and immediately after it (before `| "grade-a"`), add:

```ts
  | "infrastructure-liquity-v1"
  | "infrastructure-liquity-v2"
  | "infrastructure-m0"
```

Leave the old `liquity-family` / `liquity-v1` / `liquity-v2` / `liquity-style` entries in place — they will be removed in Phase B.

- [ ] **Step 3: Add labels for the new tags in `FILTER_TAG_LABELS`**

Find the `"liquity-style": "Liquity-Style",` line and immediately after it, add:

```ts
  "infrastructure-liquity-v1": "Liquity v1",
  "infrastructure-liquity-v2": "Liquity v2",
  "infrastructure-m0": "M0",
```

- [ ] **Step 4: Run type-checks**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard && npx tsc --noEmit
cd /Users/ahirice/Documents/git/stablecoin-dashboard/worker && npx tsc --noEmit
```

Expected: both pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard
git add shared/types/core.ts
git commit -m "feat(types): add infrastructures field and FilterTag members"
```

---

### Task 3: Update `getFilterTags()` to also emit `infrastructure-*` tags from the new field

**Files:**
- Modify: `shared/types/core.ts` (`getFilterTags()` function)

- [ ] **Step 1: Append the new emission logic at the end of `getFilterTags()`**

Find the `getFilterTags` function and locate the final `return tags;` line. Immediately before that line, insert:

```ts
  for (const infra of meta.infrastructures ?? []) {
    tags.push(`infrastructure-${infra}` as FilterTag);
  }
```

The cast is required because the template-literal expansion isn't automatically narrowed against the `FilterTag` union; the three concrete members were added in Task 2 so the cast is sound at runtime.

Leave the existing `if (meta.protocolFamily === "liquity") { ... }` block in place — it stays through Phase A so old consumers keep working.

- [ ] **Step 2: Run existing tests**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard && npm test -- --run
```

Expected: pass. **Note:** the green signal here only proves the code compiles and the new branch is reachable. No coin sets `infrastructures` yet, so the new loop is a runtime no-op. Real coverage of the new emission path comes from the data migration in Tasks 5-8 and the cohort tests in Task 11.

- [ ] **Step 3: Commit**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard
git add shared/types/core.ts
git commit -m "feat(types): emit infrastructure-* tags in getFilterTags"
```

---

### Task 4: Add `infrastructures` to the Zod schema (additive)

**Files:**
- Modify: `shared/lib/stablecoins/schema.ts`

- [ ] **Step 1: Import the new constant**

Find the existing imports block (currently lines 4-13) that imports from `../../types/core` and add `INFRASTRUCTURE_VALUES` to the list:

```ts
import {
  DEPENDENCY_TYPE_VALUES,
  GOVERNANCE_TYPE_VALUES,
  CHAIN_TIER_VALUES,
  DEPLOYMENT_MODEL_VALUES,
  COLLATERAL_QUALITY_VALUES,
  CUSTODY_MODEL_VALUES,
  GOVERNANCE_QUALITY_VALUES,
  YIELD_TYPE_VALUES,
  INFRASTRUCTURE_VALUES,
} from "../../types/core";
```

- [ ] **Step 2: Add the schema field**

Find the `protocolVariant: z.enum(PROTOCOL_VARIANT_VALUES).optional(),` line in `StablecoinMetaAssetSchema` and insert this immediately after it:

```ts
  infrastructures: z.array(z.enum(INFRASTRUCTURE_VALUES)).optional(),
```

- [ ] **Step 3: Run schema-driven tests**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard && npm test -- --run shared/lib
```

Expected: pass. The existing JSON entries don't carry `infrastructures` yet, so the optional field is a no-op.

- [ ] **Step 4: Commit**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard
git add shared/lib/stablecoins/schema.ts
git commit -m "feat(schema): accept infrastructures field on stablecoin meta"
```

---

### Task 5: Migrate 13 Liquity entries in `usd-minor.json`

**Files:**
- Modify: `shared/data/stablecoins/usd-minor.json`

For each of the 13 Liquity entries below, immediately after the existing `"protocolVariant": "v1"` or `"protocolVariant": "v2"` line, insert a new line at the same 4-space indentation:

```json
    "infrastructures": ["liquity-v1"],
```

or

```json
    "infrastructures": ["liquity-v2"],
```

depending on the variant.

| Coin id | Variant |
|---|---|
| `satusd-river` | v1 |
| `bold-liquity` | v2 |
| `lusd-liquity` | v1 |
| `nect-beraborrow` | v2 |
| `meusd-mezo` | v1 |
| `usdaf-asymmetry` | v2 |
| `usnd-nerite` | v2 |
| `usdq-quill` | v2 |
| `usdk-orki` | v2 |
| `ebusd-ebisu` | v2 |
| `feusd-felix` | v2 |
| `btcusd-btcfi` | v1 |
| `usbd-bima` | v1 |

- [ ] **Step 1: For each coin id in the table, find its entry by `id` and add the `infrastructures` line directly after `protocolVariant`**

Use Edit tool with surrounding context (e.g., `"id": "satusd-river"` and the entry's `protocolVariant` line) to make each match unique. Repeat for all 13 entries.

After every fourth coin, run the schema validation as a checkpoint to catch any JSON breakage early instead of waiting until all 13 are done:

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard && npm test -- --run shared/lib/__tests__/stablecoins.test.ts
```

If validation fails mid-batch, fix the malformed entry before continuing.

- [ ] **Step 2: Final schema validation**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard && npm test -- --run shared/lib
```

Expected: pass.

- [ ] **Step 3: Verify counts**

```bash
git -C /Users/ahirice/Documents/git/stablecoin-dashboard grep -c '"infrastructures": \["liquity-v1"\]' shared/data/stablecoins/usd-minor.json
git -C /Users/ahirice/Documents/git/stablecoin-dashboard grep -c '"infrastructures": \["liquity-v2"\]' shared/data/stablecoins/usd-minor.json
```

Expected: 5 and 8 (5 v1 + 8 v2 = 13 total).

- [ ] **Step 4: Commit**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard
git add shared/data/stablecoins/usd-minor.json
git commit -m "data: add infrastructures field to 13 Liquity coins in usd-minor.json"
```

---

### Task 6: Migrate 1 Liquity entry in `non-usd.json`

**Files:**
- Modify: `shared/data/stablecoins/non-usd.json`

- [ ] **Step 1: Add the `infrastructures` line for `cjpy-yamato`**

Find the entry with `"id": "cjpy-yamato"`. Locate its `"protocolVariant": "v1"` line and insert immediately after:

```json
    "infrastructures": ["liquity-v1"],
```

- [ ] **Step 2: Run schema validation**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard && npm test -- --run shared/lib
```

Expected: pass.

- [ ] **Step 3: Commit**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard
git add shared/data/stablecoins/non-usd.json
git commit -m "data: add infrastructures field to cjpy-yamato (Liquity v1)"
```

---

### Task 7: Add `infrastructures: ["m0"]` to 9 M0 entries in `usd-minor.json`

**Files:**
- Modify: `shared/data/stablecoins/usd-minor.json`

The 9 M0 entries currently in `usd-minor.json`:

| Coin id | Origin | Already has `m-m0` dependency? |
|---|---|---|
| `musd-metamask` | original | no |
| `usdn-noble` | original | no |
| `usdsc-startale` | original | yes |
| `ctusd-citrea` | original | yes |
| `usdat-saturn` | original | yes |
| `wm-m0` | added in commit `16ba080d` | yes |
| `usdnr-nerona` | added in commit `16ba080d` | yes |
| `usdk-kast` | added in commit `16ba080d` | yes |
| `xo-exodus` | added in commit `16ba080d` | yes |

- [ ] **Step 1: For each coin, locate the entry by `id` and add `"infrastructures": ["m0"],` as a new field**

Insert the field on a new line **immediately after the closing `}` of the entry's `flags: { ... }` block**, at 4-space indentation. This placement is uniform across all 9 entries and matches the convention used by other top-level metadata fields.

For entries where the `flags` block ends on the same line (compact JSON), insert after the `flags` line. Use Edit with enough surrounding context to make each match unique to that coin (typically `"id": "<coin-id>",` plus the next two-or-three lines).

After every third coin, run the schema validation as a checkpoint:

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard && npm test -- --run shared/lib/__tests__/stablecoins.test.ts
```

- [ ] **Step 2: Final schema validation**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard && npm test -- --run shared/lib
```

Expected: pass.

- [ ] **Step 3: Verify count**

```bash
git -C /Users/ahirice/Documents/git/stablecoin-dashboard grep -c '"infrastructures": \["m0"\]' shared/data/stablecoins/usd-minor.json
```

Expected: 9.

- [ ] **Step 4: Commit**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard
git add shared/data/stablecoins/usd-minor.json
git commit -m "data: tag 9 M0 stablecoins in usd-minor.json"
```

---

### Task 8: Add `infrastructures: ["m0"]` to 2 M0 entries in `usd-major.json`

**Files:**
- Modify: `shared/data/stablecoins/usd-major.json`

The 2 entries:

| Coin id |
|---|
| `usdai-usd-ai` |
| `usd0-usual` |

`m-m0` (the underlying $M token) does **NOT** receive the field — it *is* the infrastructure, not an extension. `susdai-usd-ai` (Staked USDai) is a derivative wrapper of `usdai-usd-ai`, not directly built on M0, and also does not receive the field.

- [ ] **Step 1: Add the field to `usdai-usd-ai`**

Find `"id": "usdai-usd-ai"` and insert `"infrastructures": ["m0"],` immediately after the closing `}` of its `flags: { ... }` block, at 4-space indentation.

- [ ] **Step 2: Add the field to `usd0-usual`**

Same operation for `"id": "usd0-usual"`.

- [ ] **Step 3: Validate**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard && npm test -- --run shared/lib
```

Expected: pass.

- [ ] **Step 4: Verify count**

```bash
git -C /Users/ahirice/Documents/git/stablecoin-dashboard grep -c '"infrastructures": \["m0"\]' shared/data/stablecoins/usd-major.json
```

Expected: 2.

- [ ] **Step 5: Commit**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard
git add shared/data/stablecoins/usd-major.json
git commit -m "data: tag usdai and usd0 with M0 infrastructure"
```

---

### Task 9: Phase A end-to-end verification

- [ ] **Step 1: Defensive grep for any test that asserts an exact tag-set equality**

The 14 migrated Liquity coins now emit BOTH the old `liquity-family` / `liquity-v1` / `liquity-v2` tags AND the new `infrastructure-liquity-v1` / `infrastructure-liquity-v2` tags. If any test asserts the exact return shape of `getFilterTags()` with `toEqual([...])` or `expect(tags).toHaveLength(N)`, that assertion will fail because the array now contains extra members.

```bash
git -C /Users/ahirice/Documents/git/stablecoin-dashboard grep -n "getFilterTags" --include="*.test.ts" --include="*.test.tsx"
```

Read each match and confirm none uses `toEqual` or a length assertion against a Liquity coin's tag set. If such an assertion exists, update it now (in this same task) to either accept supersets or to expect the new larger array. As of the plan's writing, no such assertion exists — but verify before continuing.

- [ ] **Step 2: Full test suite**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard && npm test -- --run
```

Expected: pass.

- [ ] **Step 3: Build**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard && npm run build
```

Expected: pass.

- [ ] **Step 4: No commit — this is a verification gate. If anything fails, stop and fix before continuing to Phase B.**

---

## Phase B — Switch consumers and rename

### Task 10: Switch `getFilterTags()` to emit ONLY `infrastructure-*` tags (remove old liquity branch)

**Files:**
- Modify: `shared/types/core.ts`

- [ ] **Step 1: Delete the old Liquity branch from `getFilterTags()`**

Find and delete this entire block:

```ts
  if (meta.protocolFamily === "liquity") {
    tags.push("liquity-family");
    switch (meta.protocolVariant) {
      case "v1":
        tags.push("liquity-v1");
        break;
      case "v2":
        tags.push("liquity-v2");
        break;
      case "style":
        tags.push("liquity-style");
        break;
      default:
        break;
    }
  }
```

The `for (const infra of meta.infrastructures ?? [])` loop added in Task 3 stays — it now emits the only Liquity-related tags (the new `infrastructure-*` ones).

- [ ] **Step 2: Run tests — expect FAILURE**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard && npm test -- --run src/components/__tests__/stablecoin-table-logic.test.ts
```

Expected: the `liquity-family` test fails because no coin emits `liquity-family` anymore. **This failure is intentional** — Task 11 fixes the test in the same commit.

- [ ] **Step 3: Don't commit yet — Task 11 fixes the test in the same commit**

---

### Task 11: Update the table-logic test to use the new infrastructure tags

**Files:**
- Modify: `src/components/__tests__/stablecoin-table-logic.test.ts`

- [ ] **Step 1: Replace the `liquity-family` test**

Find the existing test "returns the normalized Liquity-family cohort when filtering by protocol lineage" and replace it with three new tests:

```ts
  it("returns Liquity v1 infrastructure cohort when filtering by infrastructure-liquity-v1", () => {
    const trackedIds = buildTrackedIdSet(["infrastructure-liquity-v1"]);
    expect(trackedIds.has("lusd-liquity")).toBe(true);
    expect(trackedIds.has("satusd-river")).toBe(true);
    expect(trackedIds.has("meusd-mezo")).toBe(true);
    expect(trackedIds.has("btcusd-btcfi")).toBe(true);
    expect(trackedIds.has("usbd-bima")).toBe(true);
    expect(trackedIds.has("cjpy-yamato")).toBe(true);
    expect(trackedIds.has("bold-liquity")).toBe(false);
    expect(trackedIds.has("usdt-tether")).toBe(false);
  });

  it("returns Liquity v2 infrastructure cohort when filtering by infrastructure-liquity-v2", () => {
    const trackedIds = buildTrackedIdSet(["infrastructure-liquity-v2"]);
    expect(trackedIds.has("bold-liquity")).toBe(true);
    expect(trackedIds.has("usdaf-asymmetry")).toBe(true);
    expect(trackedIds.has("feusd-felix")).toBe(true);
    expect(trackedIds.has("lusd-liquity")).toBe(false);
  });

  it("returns the M0 cohort when filtering by infrastructure-m0", () => {
    const trackedIds = buildTrackedIdSet(["infrastructure-m0"]);
    expect(trackedIds.has("usdsc-startale")).toBe(true);
    expect(trackedIds.has("ctusd-citrea")).toBe(true);
    expect(trackedIds.has("usdat-saturn")).toBe(true);
    expect(trackedIds.has("usdn-noble")).toBe(true);
    expect(trackedIds.has("musd-metamask")).toBe(true);
    expect(trackedIds.has("usd0-usual")).toBe(true);
    expect(trackedIds.has("usdai-usd-ai")).toBe(true);
    expect(trackedIds.has("wm-m0")).toBe(true);
    expect(trackedIds.has("usdnr-nerona")).toBe(true);
    expect(trackedIds.has("usdk-kast")).toBe(true);
    expect(trackedIds.has("xo-exodus")).toBe(true);
    expect(trackedIds.has("m-m0")).toBe(false);
    expect(trackedIds.has("susdai-usd-ai")).toBe(false);
  });
```

- [ ] **Step 2: Run the test — expect PASS**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard && npm test -- --run src/components/__tests__/stablecoin-table-logic.test.ts
```

Expected: pass.

- [ ] **Step 3: Run the full suite**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard && npm test -- --run
```

Expected: pass.

- [ ] **Step 4: Commit (combining Task 10 + Task 11)**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard
git add shared/types/core.ts src/components/__tests__/stablecoin-table-logic.test.ts
git commit -m "refactor(filter-tags): emit only infrastructure-* tags for Liquity/M0"
```

---

### Task 12: Add unit tests for `getFilterTags()` covering empty, single, and multi-element cases

**Files:**
- Create: `shared/types/__tests__/core.test.ts`

- [ ] **Step 1: Create the test file**

Write `shared/types/__tests__/core.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { getFilterTags } from "../core";
import type { StablecoinMeta } from "../core";

function makeCoin(overrides: Partial<StablecoinMeta> = {}): StablecoinMeta {
  return {
    id: "test-coin",
    name: "Test Coin",
    symbol: "TEST",
    flags: {
      backing: "rwa-backed",
      pegCurrency: "USD",
      governance: "centralized",
      yieldBearing: false,
      rwa: true,
      navToken: false,
    },
    ...overrides,
  } as StablecoinMeta;
}

describe("getFilterTags — infrastructures", () => {
  it("emits no infrastructure tag when infrastructures is unset", () => {
    const tags = getFilterTags(makeCoin());
    expect(tags.some((t) => t.startsWith("infrastructure-"))).toBe(false);
  });

  it("emits no infrastructure tag for an empty infrastructures array", () => {
    const tags = getFilterTags(makeCoin({ infrastructures: [] }));
    expect(tags.some((t) => t.startsWith("infrastructure-"))).toBe(false);
  });

  it("emits infrastructure-liquity-v1 for a single-element liquity-v1 array", () => {
    const tags = getFilterTags(makeCoin({ infrastructures: ["liquity-v1"] }));
    expect(tags).toContain("infrastructure-liquity-v1");
    expect(tags).not.toContain("infrastructure-liquity-v2");
    expect(tags).not.toContain("infrastructure-m0");
  });

  it("emits infrastructure-m0 for a single-element m0 array", () => {
    const tags = getFilterTags(makeCoin({ infrastructures: ["m0"] }));
    expect(tags).toContain("infrastructure-m0");
  });

  it("emits one tag per element for a multi-element array", () => {
    const tags = getFilterTags(makeCoin({ infrastructures: ["liquity-v2", "m0"] }));
    expect(tags).toContain("infrastructure-liquity-v2");
    expect(tags).toContain("infrastructure-m0");
  });
});
```

- [ ] **Step 2: Run the new test**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard && npm test -- --run shared/types/__tests__/core.test.ts
```

Expected: all 5 tests pass.

- [ ] **Step 3: Commit**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard
git add shared/types/__tests__/core.test.ts
git commit -m "test(types): unit-test getFilterTags infrastructures emission"
```

---

### Task 13: Remove the old `liquity-*` members from `FilterTag` union and `FILTER_TAG_LABELS`

**Files:**
- Modify: `shared/types/core.ts`

- [ ] **Step 1: Remove the four lines from the `FilterTag` union**

Find and delete:

```ts
  | "liquity-family"
  | "liquity-v1"
  | "liquity-v2"
  | "liquity-style"
```

- [ ] **Step 2: Remove the four label entries from `FILTER_TAG_LABELS`**

Find and delete:

```ts
  "liquity-family": "Liquity",
  "liquity-v1": "Liquity v1",
  "liquity-v2": "Liquity v2",
  "liquity-style": "Liquity-Style",
```

- [ ] **Step 3: Run type-check — expect failures pointing to remaining consumers**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard && npx tsc --noEmit
```

Expected: errors in `src/hooks/use-homepage-filters.ts` (still references `liquity-v1` / `liquity-v2`) and `src/components/filter-bar.tsx` (label overrides for the same). These will be fixed in Tasks 14 and 15. **Do not commit yet.**

If `tsc` shows errors in any *other* files, those are unexpected — investigate before continuing.

---

### Task 14: Rewrite `use-homepage-filters.ts` filter group to "Infrastructure"

**Files:**
- Modify: `src/hooks/use-homepage-filters.ts`

- [ ] **Step 1: Replace the "Liquity Forks" group**

Replace this block in `FILTER_GROUPS`:

```ts
  {
    label: "Liquity Forks",
    options: ["liquity-v1", "liquity-v2"],
  },
```

with:

```ts
  {
    label: "Infrastructure",
    options: ["infrastructure-liquity-v1", "infrastructure-liquity-v2", "infrastructure-m0"],
  },
```

- [ ] **Step 2: Run type-check**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard && npx tsc --noEmit
```

Expected: errors only in `src/components/filter-bar.tsx` (still references the dead overrides).

- [ ] **Step 3: Don't commit yet — Task 15 finishes the filter UI cleanup**

---

### Task 15: Remove dead label overrides in `filter-bar.tsx` and update the filter test

**Files:**
- Modify: `src/components/filter-bar.tsx`
- Modify: `src/hooks/__tests__/use-homepage-filters.test.ts`

- [ ] **Step 1: Remove the two dead override entries from `filter-bar.tsx`**

Replace the `FILTER_BAR_LABEL_OVERRIDES` block with:

```ts
const FILTER_BAR_LABEL_OVERRIDES: Partial<Record<FilterTag, string>> = {
  "fiat-non-usd-peg": "Non USD",
  "rwa-backed": "RWA",
  "crypto-backed": "Crypto",
  "centralized-dependent": "CeFi-Dep",
};
```

(The two `"liquity-v1": "v1"` and `"liquity-v2": "v2"` lines are removed.)

- [ ] **Step 2: Update the filter group label assertion in the test**

In `src/hooks/__tests__/use-homepage-filters.test.ts`, find:

```ts
    expect(labels).toContain("Liquity Forks");
```

and replace with:

```ts
    expect(labels).toContain("Infrastructure");
```

- [ ] **Step 3: Replace the URL parsing test**

Find the existing test "parses Liquity Forks filter using lowercase key":

```ts
  it("parses Liquity Forks filter using lowercase key", () => {
    const params = new URLSearchParams("liquity+forks=liquity-v2");
    const result = parseHomepageParams(params);
    expect(result.groupSelections["Liquity Forks"]).toBe("liquity-v2");
  });
```

and replace with:

```ts
  it("parses Infrastructure filter using lowercase key", () => {
    const params = new URLSearchParams("infrastructure=infrastructure-liquity-v2");
    const result = parseHomepageParams(params);
    expect(result.groupSelections["Infrastructure"]).toBe("infrastructure-liquity-v2");
  });

  it("parses Infrastructure filter for M0", () => {
    const params = new URLSearchParams("infrastructure=infrastructure-m0");
    const result = parseHomepageParams(params);
    expect(result.groupSelections["Infrastructure"]).toBe("infrastructure-m0");
  });
```

- [ ] **Step 4: Run the test**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard && npm test -- --run src/hooks/__tests__/use-homepage-filters.test.ts
```

Expected: pass.

- [ ] **Step 5: Run the full suite**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard && npm test -- --run
```

Expected: pass.

- [ ] **Step 6: Commit Tasks 13 + 14 + 15 together**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard
git add shared/types/core.ts \
  src/hooks/use-homepage-filters.ts \
  src/hooks/__tests__/use-homepage-filters.test.ts \
  src/components/filter-bar.tsx
git commit -m "refactor(filters): rename Liquity Forks group to Infrastructure"
```

---

### Task 16: Create `shared/lib/infrastructure.ts` (replacement for `protocol-family.ts`)

**Files:**
- Create: `shared/lib/infrastructure.ts`
- (Do not delete `shared/lib/protocol-family.ts` yet — Task 22 deletes it after consumers are migrated.)

- [ ] **Step 1: Create the new file**

Write `shared/lib/infrastructure.ts`:

```ts
import type { Infrastructure } from "../types";
import { INFRASTRUCTURE_LABELS } from "../types/core";

export function getInfrastructureLabel(value: Infrastructure): string {
  return INFRASTRUCTURE_LABELS[value];
}

export function getInfrastructureSummary(value: Infrastructure): string {
  switch (value) {
    case "liquity-v1":
      return "Built on the original Liquity design: 110% liquidation threshold, Stability Pool liquidations, no ongoing borrower interest. Forked codebase with independent reserves.";
    case "liquity-v2":
      return "Built on the Liquity v2 / BOLD design: user-set borrower rates, branch-style collateral markets, Stability Pools. Forked codebase with independent reserves.";
    case "m0":
      return "Built on the M0 issuance platform: minter governance, SwapFacility, and the MExtension.sol contract pattern. Reserve composition is set by the issuer and may or may not include the underlying $M token.";
  }
}
```

- [ ] **Step 2: Type-check**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard && npx tsc --noEmit
```

Expected: pass.

- [ ] **Step 3: Don't commit yet — Tasks 16 through 22 land in one commit**

---

### Task 17: Switch `key-info-card.tsx` to the new helpers, render one chip + one summary per infrastructure

**Files:**
- Modify: `src/components/key-info-card.tsx`

- [ ] **Step 1: Replace the import**

Find:

```ts
import { getProtocolFamilyLabel, getProtocolFamilySummary } from "@shared/lib/protocol-family";
```

and replace with:

```ts
import { getInfrastructureLabel, getInfrastructureSummary } from "@shared/lib/infrastructure";
```

- [ ] **Step 2: Replace the helper calls**

Find:

```ts
  const protocolLabel = getProtocolFamilyLabel(meta);
  const protocolSummary = getProtocolFamilySummary(meta);
```

and replace with:

```ts
  const infrastructures = meta.infrastructures ?? [];
  const infrastructureSummaries = infrastructures.map((value) => ({
    value,
    label: getInfrastructureLabel(value),
    summary: getInfrastructureSummary(value),
  }));
```

- [ ] **Step 3: Replace the chip rendering**

Find:

```tsx
            {protocolLabel && (
              <span className="inline-flex items-center rounded-full border border-frost-blue/30 bg-frost-blue/10 px-3 py-1 text-xs font-semibold text-frost-blue">
                {protocolLabel}
              </span>
            )}
```

and replace with:

```tsx
            {infrastructureSummaries.map(({ value, label }) => (
              <span
                key={value}
                className={
                  value === "m0"
                    ? "inline-flex items-center rounded-full border border-violet-500/30 bg-violet-500/10 px-3 py-1 text-xs font-semibold text-violet-700 dark:text-violet-300"
                    : "inline-flex items-center rounded-full border border-frost-blue/30 bg-frost-blue/10 px-3 py-1 text-xs font-semibold text-frost-blue"
                }
              >
                {label}
              </span>
            ))}
```

- [ ] **Step 4: Replace the "Protocol Lineage" section**

Find this block (currently around lines 145-149):

```tsx
        {protocolSummary && (
          <div className="border-t border-border/40 pt-3 sm:pt-4">
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Protocol Lineage</p>
            <p className="text-sm leading-relaxed text-muted-foreground">{protocolSummary}</p>
          </div>
        )}
```

and replace with one section that renders one summary per infrastructure (so a coin with both Liquity and M0 would show both summaries stacked):

```tsx
        {infrastructureSummaries.length > 0 && (
          <div className="border-t border-border/40 pt-3 sm:pt-4 space-y-3">
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Infrastructure</p>
            {infrastructureSummaries.map(({ value, label, summary }) => (
              <div key={value}>
                <p className="text-xs font-semibold text-foreground">{label}</p>
                <p className="text-sm leading-relaxed text-muted-foreground">{summary}</p>
              </div>
            ))}
          </div>
        )}
```

The kicker label changes from "Protocol Lineage" to "Infrastructure" to match the rest of the renamed surface.

- [ ] **Step 5: Confirm there are no other stale references**

```bash
git -C /Users/ahirice/Documents/git/stablecoin-dashboard grep -n "protocolSummary\|protocolLabel\|getProtocolFamily" src/components/key-info-card.tsx
```

Expected: zero matches.

- [ ] **Step 6: Type-check**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard && npx tsc --noEmit
```

Expected: pass.

---

### Task 18: Switch `explore-next-section.tsx` to new helpers and link target

**Files:**
- Modify: `src/components/stablecoin-detail/explore-next-section.tsx`

- [ ] **Step 1: Replace the helper import**

Find:

```ts
import { getProtocolFamilyLabel } from "@shared/lib/protocol-family";
```

and replace with:

```ts
import { getInfrastructureLabel } from "@shared/lib/infrastructure";
```

- [ ] **Step 2: Update the taxonomy import**

Find:

```ts
import { buildBackingTaxonomyUrl, buildGovernanceTaxonomyUrl, buildProtocolTaxonomyUrl } from "@/lib/stablecoin-taxonomy";
```

and replace with:

```ts
import { buildBackingTaxonomyUrl, buildGovernanceTaxonomyUrl, buildInfrastructureTaxonomyUrl } from "@/lib/stablecoin-taxonomy";
```

(`buildInfrastructureTaxonomyUrl` is created in Task 20; this import temporarily refers to a missing symbol but Task 20 is in the same commit batch.)

- [ ] **Step 3: Replace the `protocolLabel` derivation and the taxonomy link**

Find:

```ts
  const protocolLabel = getProtocolFamilyLabel(coin);
```

and replace with:

```ts
  const firstInfrastructure = coin.infrastructures?.[0];
  const infrastructureLabel = firstInfrastructure ? getInfrastructureLabel(firstInfrastructure) : null;
```

Then find:

```ts
    coin.protocolFamily
      ? {
          href: buildProtocolTaxonomyUrl(
            coin.protocolVariant === "v1"
              ? "liquity-v1"
              : coin.protocolVariant === "v2"
                ? "liquity-v2"
                : "liquity-family",
          ),
          label: protocolLabel ? `Browse ${protocolLabel} stablecoins` : "Browse Liquity-family stablecoins",
        }
      : null,
```

and replace with:

```ts
    firstInfrastructure
      ? {
          href: buildInfrastructureTaxonomyUrl(firstInfrastructure),
          label: infrastructureLabel ? `Browse ${infrastructureLabel} stablecoins` : "Browse infrastructure stablecoins",
        }
      : null,
```

- [ ] **Step 4: Type-check (will still fail — Task 20 supplies `buildInfrastructureTaxonomyUrl`)**

This is expected. Don't commit yet.

---

### Task 19: Update `hero-card.tsx` — `InfrastructureBadge`, multi-chip, drop the originals exclusion

**Files:**
- Modify: `src/components/stablecoin-detail/hero-card.tsx`

- [ ] **Step 1: Replace the helper import**

Find:

```ts
import { getProtocolFamilyLabel } from "@shared/lib/protocol-family";
```

and replace with:

```ts
import { getInfrastructureLabel } from "@shared/lib/infrastructure";
import type { Infrastructure } from "@shared/types";
```

- [ ] **Step 2: Delete the `ProtocolFamilyTag` and `LiquityForkBadge` components and replace with `InfrastructureBadge` + `InfrastructureChip`**

Find these two functions:

```tsx
function ProtocolFamilyTag({ label }: { label: string | null }) {
  if (!label) return null;

  return (
    <span className="inline-flex items-center rounded-full border border-frost-blue/30 bg-frost-blue/10 px-2.5 py-0.5 text-[11px] font-semibold text-frost-blue">
      {label}
    </span>
  );
}

function LiquityForkBadge({ variant }: { variant?: "v1" | "v2" }) {
  if (!variant) return null;

  return (
    <div className="flex items-center gap-2 rounded-lg border border-border/40 bg-background/40 px-2.5 py-1.5">
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Liquity Fork</span>
      <span className="text-base font-bold font-mono text-frost-blue">{variant}</span>
    </div>
  );
}
```

and replace with:

```tsx
function InfrastructureBadge({ value }: { value: Infrastructure }) {
  const label = getInfrastructureLabel(value);
  const isM0 = value === "m0";
  const colorClass = isM0
    ? "text-violet-500 dark:text-violet-300"
    : "text-frost-blue";
  const borderClass = isM0
    ? "border-violet-500/30 bg-violet-500/10"
    : "border-border/40 bg-background/40";

  return (
    <div className={`flex items-center gap-2 rounded-lg border ${borderClass} px-2.5 py-1.5`}>
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Infrastructure</span>
      <span className={`text-base font-bold font-mono ${colorClass}`}>{label}</span>
    </div>
  );
}

function InfrastructureChip({ value }: { value: Infrastructure }) {
  const label = getInfrastructureLabel(value);
  const isM0 = value === "m0";
  const className = isM0
    ? "inline-flex items-center rounded-full border border-violet-500/30 bg-violet-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-violet-700 dark:text-violet-300"
    : "inline-flex items-center rounded-full border border-frost-blue/30 bg-frost-blue/10 px-2.5 py-0.5 text-[11px] font-semibold text-frost-blue";
  return <span className={className}>{label}</span>;
}
```

- [ ] **Step 3: Update `HeroTertiaryMetrics` props**

Find the `HeroTertiaryMetrics` function declaration and update its props from `liquityForkVariant?: "v1" | "v2"` to `infrastructures: Infrastructure[]`. Inside the function body, replace `<LiquityForkBadge variant={liquityForkVariant} />` with:

```tsx
        {infrastructures.map((value) => (
          <InfrastructureBadge key={value} value={value} />
        ))}
```

- [ ] **Step 4: Replace `protocolLabel` and `liquityForkVariant` derivations in the `HeroCard` component body**

Find:

```ts
  const protocolLabel = getProtocolFamilyLabel(coin);
```

and replace with:

```ts
  const infrastructures: Infrastructure[] = coin.infrastructures ?? [];
```

Then find and **delete** the entire `LIQUITY_ORIGINALS` set and the `liquityForkVariant` calculation:

```ts
  const LIQUITY_ORIGINALS = new Set(["bold-liquity", "lusd-liquity"]);
  const liquityForkVariant =
    coin.protocolFamily === "liquity" && (coin.protocolVariant === "v1" || coin.protocolVariant === "v2") && !LIQUITY_ORIGINALS.has(coin.id)
      ? coin.protocolVariant
      : undefined;
```

This is intentional — `bold-liquity` and `lusd-liquity` are reference implementations and will now display the Infrastructure badge alongside the forks. The "Infrastructure: Liquity v1" label is accurate for them.

- [ ] **Step 5: Update both `<ProtocolFamilyTag label={protocolLabel} />` call sites**

There are two call sites — one in the mobile layout block (around line 554) and one in the desktop layout block (around line 654). **Both are inside the `HeroCard` component's JSX return value**, so the top-level `const infrastructures = coin.infrastructures ?? [];` defined in Step 4 is in scope at both locations. No prop-drilling needed.

Replace each `<ProtocolFamilyTag label={protocolLabel} />` line with:

```tsx
                  {infrastructures.map((value) => (
                    <InfrastructureChip key={value} value={value} />
                  ))}
```

- [ ] **Step 6: Update both `<HeroTertiaryMetrics ... liquityForkVariant={liquityForkVariant} />` call sites**

There are two of them (one in the mobile layout, one in the desktop layout). Replace `liquityForkVariant={liquityForkVariant}` with `infrastructures={infrastructures}` in both.

- [ ] **Step 7: Type-check**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard && npx tsc --noEmit
```

Expected: pass except for `buildInfrastructureTaxonomyUrl` (still missing — Task 20 supplies it).

- [ ] **Step 8: Don't commit yet**

---

### Task 20: Rewrite `src/lib/stablecoin-taxonomy.ts` for the Infrastructure axis

**Files:**
- Modify: `src/lib/stablecoin-taxonomy.ts`

This task does **three surgical edits**, NOT one large block delete, because the Protocol-named symbols are interleaved with governance/backing symbols that must be preserved.

- [ ] **Step 1: Replace the type alias and add the Infrastructure import**

Find:

```ts
export type ProtocolTaxonomyValue = "liquity-family" | "liquity-v1" | "liquity-v2";
```

and replace with:

```ts
import type { Infrastructure } from "@shared/types";

export type InfrastructureTaxonomyValue = Infrastructure;
```

(The new `import` line is added at the top of the file alongside the existing imports.)

- [ ] **Step 2: Update `TaxonomyKind` and `StablecoinTaxonomyPage` generic**

Find:

```ts
type TaxonomyKind = "governance" | "backing" | "protocol";
```

and replace with:

```ts
type TaxonomyKind = "governance" | "backing" | "infrastructure";
```

Then find:

```ts
export interface StablecoinTaxonomyPage<TValue extends GovernanceType | BackingType | ProtocolTaxonomyValue> {
```

and replace with:

```ts
export interface StablecoinTaxonomyPage<TValue extends GovernanceType | BackingType | InfrastructureTaxonomyValue> {
```

- [ ] **Step 3: Replace `PROTOCOL_CONTENT` and `PROTOCOL_TAXONOMY_PAGES` together**

Find the existing block starting at `const PROTOCOL_CONTENT: Record<` and ending at the `.sort((left, right) => right.coins.length - left.coins.length);` after `PROTOCOL_TAXONOMY_PAGES`. Replace it with:

```ts
const INFRASTRUCTURE_CONTENT: Record<
  InfrastructureTaxonomyValue,
  { slug: string; title: string; shortLabel: string; intro: string; description: (count: number) => string }
> = {
  "liquity-v1": {
    slug: "liquity-v1",
    title: "Liquity v1 Infrastructure Stablecoins",
    shortLabel: "Liquity v1",
    intro:
      "Liquity v1 stablecoins fork the original Liquity CDP design: a 110% liquidation threshold, Stability Pool liquidations, and no ongoing borrower interest. This page isolates the classic LUSD-style branch.",
    description: (count) =>
      `${count} Liquity v1 stablecoin${count !== 1 ? "s" : ""} tracked by Pharos. Compare classic zero-interest Liquity-style CDP designs in one place.`,
  },
  "liquity-v2": {
    slug: "liquity-v2",
    title: "Liquity v2 Infrastructure Stablecoins",
    shortLabel: "Liquity v2",
    intro:
      "Liquity v2 stablecoins use the BOLD-style design: user-set borrower rates, branch-style collateral markets, and Stability Pools. This hub groups the newer Liquity codebase forks.",
    description: (count) =>
      `${count} Liquity v2 stablecoin${count !== 1 ? "s" : ""} tracked by Pharos. Compare BOLD-style CDP designs with user-set rates and Stability Pools.`,
  },
  "m0": {
    slug: "m0",
    title: "M0 Infrastructure Stablecoins",
    shortLabel: "M0",
    intro:
      "M0 stablecoins are built on the M0 issuance platform: minter governance, the SwapFacility, and the MExtension.sol contract pattern. Each issuer sets its own reserve composition, which may or may not include the underlying $M token. The shared infrastructure correlates governance and smart-contract risk across the cohort.",
    description: (count) =>
      `${count} M0-built stablecoin${count !== 1 ? "s" : ""} tracked by Pharos. Compare branded extensions of the M0 issuance platform.`,
  },
};

export const INFRASTRUCTURE_TAXONOMY_PAGES = (Object.entries(INFRASTRUCTURE_CONTENT) as Array<
  [InfrastructureTaxonomyValue, (typeof INFRASTRUCTURE_CONTENT)[InfrastructureTaxonomyValue]]
>)
  .map(([value, content]) => {
    const coins = ACTIVE_STABLECOINS.filter((coin) => (coin.infrastructures ?? []).includes(value));
    return {
      kind: "infrastructure" as const,
      slug: content.slug,
      value,
      href: `/stablecoins/infrastructure/${content.slug}/`,
      title: content.title,
      shortLabel: content.shortLabel,
      description: content.description(coins.length),
      intro: content.intro,
      filterTag: `infrastructure-${value}` as FilterTag,
      coins,
    };
  })
  .sort((left, right) => right.coins.length - left.coins.length);
```

- [ ] **Step 4: Update `ALL_STABLECOIN_TAXONOMY_PAGES`**

Find:

```ts
export const ALL_STABLECOIN_TAXONOMY_PAGES = [...STABLECOIN_TAXONOMY_PAGES, ...PROTOCOL_TAXONOMY_PAGES];
```

and replace with:

```ts
export const ALL_STABLECOIN_TAXONOMY_PAGES = [...STABLECOIN_TAXONOMY_PAGES, ...INFRASTRUCTURE_TAXONOMY_PAGES];
```

- [ ] **Step 5: Replace `PROTOCOL_TAXONOMY_PAGE_BY_SLUG`**

Find:

```ts
export const PROTOCOL_TAXONOMY_PAGE_BY_SLUG = new Map(
  PROTOCOL_TAXONOMY_PAGES.map((page) => [page.slug, page]),
);
```

and replace with:

```ts
export const INFRASTRUCTURE_TAXONOMY_PAGE_BY_SLUG = new Map(
  INFRASTRUCTURE_TAXONOMY_PAGES.map((page) => [page.slug, page]),
);
```

- [ ] **Step 6: Replace `buildProtocolTaxonomyUrl`**

Find:

```ts
export function buildProtocolTaxonomyUrl(value: ProtocolTaxonomyValue): string {
  const page = PROTOCOL_TAXONOMY_PAGES.find((candidate) => candidate.value === value);
  return page?.href ?? "/stablecoins/protocol/liquity/";
}
```

and replace with:

```ts
export function buildInfrastructureTaxonomyUrl(value: InfrastructureTaxonomyValue): string {
  const page = INFRASTRUCTURE_TAXONOMY_PAGES.find((candidate) => candidate.value === value);
  return page?.href ?? `/stablecoins/infrastructure/${value}/`;
}
```

The `GOVERNANCE_TAXONOMY_PAGE_BY_SLUG`, `BACKING_TAXONOMY_PAGE_BY_SLUG`, `buildGovernanceTaxonomyUrl`, and `buildBackingTaxonomyUrl` declarations are **not** touched — they survive untouched.

- [ ] **Step 7: Verify the file is consistent**

```bash
git -C /Users/ahirice/Documents/git/stablecoin-dashboard grep -n "PROTOCOL\|INFRASTRUCTURE" src/lib/stablecoin-taxonomy.ts
```

Expected output: only `INFRASTRUCTURE_*` references. Zero `PROTOCOL_*` references.

- [ ] **Step 8: Type-check**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard && npx tsc --noEmit
```

Expected: errors only in `src/components/stablecoin-taxonomy-page.tsx` (still imports `ProtocolTaxonomyValue`) and `src/app/stablecoins/protocol/[protocol]/page.tsx` (still imports `PROTOCOL_TAXONOMY_*`). Both fixed in the next tasks.

---

### Task 21: Update `stablecoin-taxonomy-page.tsx` to import the renamed type

**Files:**
- Modify: `src/components/stablecoin-taxonomy-page.tsx`

- [ ] **Step 1: Replace the import**

Find:

```ts
import type { ProtocolTaxonomyValue, StablecoinTaxonomyPage as StablecoinTaxonomyPageConfig } from "@/lib/stablecoin-taxonomy";
```

and replace with:

```ts
import type { InfrastructureTaxonomyValue, StablecoinTaxonomyPage as StablecoinTaxonomyPageConfig } from "@/lib/stablecoin-taxonomy";
```

Then find:

```ts
  page: StablecoinTaxonomyPageConfig<BackingType | GovernanceType | ProtocolTaxonomyValue>;
```

and replace with:

```ts
  page: StablecoinTaxonomyPageConfig<BackingType | GovernanceType | InfrastructureTaxonomyValue>;
```

- [ ] **Step 2: Type-check**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard && npx tsc --noEmit
```

Expected: errors only in `src/app/stablecoins/protocol/[protocol]/page.tsx`.

---

### Task 22: Move the dynamic route directory and update its `page.tsx`

**Files:**
- Create: `src/app/stablecoins/infrastructure/[infrastructure]/page.tsx`
- Delete: `src/app/stablecoins/protocol/[protocol]/page.tsx`

`src/lib/static-slug-page.ts` does NOT need any source changes — it uses generic `TParamKey extends string` parameters that accept `"infrastructure"` as-is.

- [ ] **Step 1: Create the new directory**

```bash
mkdir -p "/Users/ahirice/Documents/git/stablecoin-dashboard/src/app/stablecoins/infrastructure/[infrastructure]"
```

- [ ] **Step 2: Write the new `page.tsx`**

Create `src/app/stablecoins/infrastructure/[infrastructure]/page.tsx` with:

```tsx
import { notFound } from "next/navigation";
import { StablecoinTaxonomyPage } from "@/components/stablecoin-taxonomy-page";
import {
  INFRASTRUCTURE_TAXONOMY_PAGE_BY_SLUG,
  INFRASTRUCTURE_TAXONOMY_PAGES,
} from "@/lib/stablecoin-taxonomy";
import { buildSlugPageMetadata, buildSlugStaticParams, resolveSlugPage } from "@/lib/static-slug-page";

export function generateStaticParams() {
  return buildSlugStaticParams("infrastructure", INFRASTRUCTURE_TAXONOMY_PAGES);
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ infrastructure: string }>;
}) {
  return buildSlugPageMetadata(params, "infrastructure", INFRASTRUCTURE_TAXONOMY_PAGE_BY_SLUG, "Infrastructure Cohort Not Found | Pharos");
}

export default async function InfrastructureTaxonomyRoute({
  params,
}: {
  params: Promise<{ infrastructure: string }>;
}) {
  const page = await resolveSlugPage(params, "infrastructure", INFRASTRUCTURE_TAXONOMY_PAGE_BY_SLUG);
  if (!page) notFound();

  return <StablecoinTaxonomyPage page={page} />;
}
```

- [ ] **Step 3: Delete the old `page.tsx` and the old directory**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard
rm "src/app/stablecoins/protocol/[protocol]/page.tsx"
rmdir "src/app/stablecoins/protocol/[protocol]"
rmdir "src/app/stablecoins/protocol"
```

- [ ] **Step 4: Type-check**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard && npx tsc --noEmit
```

Expected: pass.

---

### Task 23: Add 301 redirects to `public/_redirects`

**Files:**
- Modify: `public/_redirects`

- [ ] **Step 1: Append the redirect block**

Append the following six lines after the existing redirect entries. **Use single-space separators** to match the existing convention in `public/_redirects`:

```
/stablecoins/protocol/liquity-v1/* /stablecoins/infrastructure/liquity-v1/:splat 301
/stablecoins/protocol/liquity-v1 /stablecoins/infrastructure/liquity-v1/ 301
/stablecoins/protocol/liquity-v2/* /stablecoins/infrastructure/liquity-v2/:splat 301
/stablecoins/protocol/liquity-v2 /stablecoins/infrastructure/liquity-v2/ 301
/stablecoins/protocol/liquity/* /stablecoins/infrastructure/liquity-v1/:splat 301
/stablecoins/protocol/liquity /stablecoins/infrastructure/liquity-v1/ 301
```

The `/stablecoins/protocol/liquity/` family page redirects to the v1 page (the older and more SEO-established of the two children) since the rollup page no longer exists.

- [ ] **Step 2: Don't commit yet — Tasks 16-24 commit together**

---

### Task 24: Update the hero-card test fixture for the new field shape and add an M0 case

**Files:**
- Modify: `src/components/stablecoin-detail/__tests__/hero-card.test.tsx`

- [ ] **Step 1: Replace the fixture fields**

Find:

```ts
  protocolFamily: "liquity",
  protocolVariant: "v2",
```

and replace with:

```ts
  infrastructures: ["liquity-v2"],
```

- [ ] **Step 2: Update the existing assertion**

Find the line `expect(html).toContain("Liquity v2");` (around line 237) and replace it with:

```ts
    expect(html).toContain("Infrastructure");
    expect(html).toContain("Liquity v2");
```

- [ ] **Step 3: Add a new test case asserting the M0 chip renders**

Add this test at the end of the `describe("HeroCard", () => { ... })` block (immediately before the closing brace at line 378):

```tsx
  it("renders an M0 infrastructure badge for M0-built stablecoins", () => {
    const m0Coin: StablecoinMeta = {
      ...coin,
      id: "usdsc-startale",
      name: "Startale USD",
      symbol: "USDSC",
      infrastructures: ["m0"],
    };

    const html = renderToStaticMarkup(
      <HeroCard
        coin={m0Coin}
        coinData={{ ...coinData, id: "usdsc-startale", name: "Startale USD", symbol: "USDSC" }}
        logoSrc="/logos/usdsc.svg"
        isNavToken={false}
        mcap={4_100_232}
        supply={4_100_232}
        prevDay={4_000_000}
        prevWeek={3_900_000}
        prevMonth={3_500_000}
        performanceVsUsd1y={null}
        pegRef={1}
        deviationBps={-2}
        gaugeDeviationBps={2}
        pegScoreResult={pegScoreResult}
        recordedDepegEventCount={0}
        liquidityData={liquidityData}
        yieldRanking={null}
        stressSignal={null}
        reportCard={null}
        onOpenFeedback={() => {}}
      />,
    );

    expect(html).toContain("Infrastructure");
    expect(html).toContain("M0");
  });
```

- [ ] **Step 4: Run the test**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard && npm test -- --run src/components/stablecoin-detail/__tests__/hero-card.test.tsx
```

Expected: pass.

- [ ] **Step 5: Run the full suite**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard && npm test -- --run
```

Expected: pass.

- [ ] **Step 6: Type-check both projects**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard && npx tsc --noEmit
cd /Users/ahirice/Documents/git/stablecoin-dashboard/worker && npx tsc --noEmit
```

Expected: both pass.

- [ ] **Step 7: Commit Tasks 16 through 24 together**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard
git add shared/lib/infrastructure.ts \
  src/components/key-info-card.tsx \
  src/components/stablecoin-detail/explore-next-section.tsx \
  src/components/stablecoin-detail/hero-card.tsx \
  src/components/stablecoin-detail/__tests__/hero-card.test.tsx \
  src/lib/stablecoin-taxonomy.ts \
  src/components/stablecoin-taxonomy-page.tsx \
  "src/app/stablecoins/infrastructure/[infrastructure]/page.tsx" \
  public/_redirects
git add -u "src/app/stablecoins/protocol/[protocol]/page.tsx"
git commit -m "refactor(infrastructure): rename helpers, badge, taxonomy, and route to Infrastructure axis"
```

---

### Task 25: Phase B verification

- [ ] **Step 1: Full test suite**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard && npm test -- --run
```

Expected: pass.

- [ ] **Step 2: Frontend build**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard && npm run build
```

Expected: pass. The build should produce the new `/stablecoins/infrastructure/liquity-v1/`, `/liquity-v2/`, `/m0/` static routes and no `/stablecoins/protocol/...` routes.

- [ ] **Step 3: Lint**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard && npm run lint
```

Expected: pass.

- [ ] **Step 4: Worker type-check**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard/worker && npx tsc --noEmit
```

Expected: pass.

- [ ] **Step 5: No commit — verification gate. Stop and fix if anything fails.**

---

## Phase C — Remove old fields

### Task 26: Cleanup grep — find any leftover consumers BEFORE deleting

This step runs the cleanup grep **before** any deletion so that if a stale reference exists, the fix can land in the same commit as the deletion (rather than producing a broken commit and a fix-up commit).

- [ ] **Step 1: Grep across the entire codebase for any reference to the old symbols**

```bash
git -C /Users/ahirice/Documents/git/stablecoin-dashboard grep -n "protocolFamily\|protocolVariant\|ProtocolFamily\|ProtocolVariant\|getProtocolFamily\|protocol-family" -- 'src/*' 'shared/*' 'worker/*'
```

Expected: only references in JSON files (`shared/data/stablecoins/usd-minor.json` and `non-usd.json` — these get removed in Task 27). Any other reference is a bug — fix it before proceeding to Task 27.

---

### Task 27: Remove `protocolFamily` / `protocolVariant` from all 14 Liquity entries

**Files:**
- Modify: `shared/data/stablecoins/usd-minor.json` (13 entries)
- Modify: `shared/data/stablecoins/non-usd.json` (1 entry: `cjpy-yamato`)

- [ ] **Step 1: Confirm pre-state**

```bash
git -C /Users/ahirice/Documents/git/stablecoin-dashboard grep -c '"protocolFamily"' shared/data/stablecoins/usd-minor.json shared/data/stablecoins/non-usd.json
```

Expected: 13 in `usd-minor.json` and 1 in `non-usd.json` (total 14).

- [ ] **Step 2: For each occurrence, delete the two-line block**

Each entry has both fields adjacent:

```json
    "protocolFamily": "liquity",
    "protocolVariant": "v1",
```

(or `"v2"`). Delete both lines together. The fields are followed in every existing entry by `"reserves"` or `"liveReservesConfig"`, so the trailing comma after `"protocolVariant"` is correct and the surrounding JSON stays valid after the deletion.

Use Edit with enough surrounding context to make each match unique to its coin (typically `"id": "<coin-id>",` plus the variant line).

After every fourth deletion, run the schema validation as a checkpoint:

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard && npm test -- --run shared/lib/__tests__/stablecoins.test.ts
```

- [ ] **Step 3: Verify the keys are gone**

```bash
git -C /Users/ahirice/Documents/git/stablecoin-dashboard grep -c '"protocolFamily"\|"protocolVariant"' shared/data/stablecoins/usd-minor.json shared/data/stablecoins/non-usd.json shared/data/stablecoins/usd-major.json
```

Expected: all zero.

- [ ] **Step 4: Verify the new fields are still in place**

```bash
git -C /Users/ahirice/Documents/git/stablecoin-dashboard grep -c '"infrastructures": \["liquity' shared/data/stablecoins/usd-minor.json shared/data/stablecoins/non-usd.json
```

Expected: 13 in `usd-minor.json` and 1 in `non-usd.json` = 14 total.

- [ ] **Step 5: Don't commit yet — Tasks 27 + 28 + 29 commit together**

---

### Task 28: Remove `protocolFamily` / `protocolVariant` from the Zod schema

**Files:**
- Modify: `shared/lib/stablecoins/schema.ts`

- [ ] **Step 1: Delete the constants**

Find and delete:

```ts
const PROTOCOL_FAMILY_VALUES = ["liquity"] as const;
const PROTOCOL_VARIANT_VALUES = ["v1", "v2", "style"] as const;
```

- [ ] **Step 2: Delete the schema fields**

Find and delete:

```ts
  protocolFamily: z.enum(PROTOCOL_FAMILY_VALUES).optional(),
  protocolVariant: z.enum(PROTOCOL_VARIANT_VALUES).optional(),
```

- [ ] **Step 3: Type-check**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard && npx tsc --noEmit
```

Expected: pass.

- [ ] **Step 4: Schema validation**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard && npm test -- --run shared/lib
```

Expected: pass. The `.strict()` schema rejects unknown keys; this verifies that no JSON entry still carries the old fields.

---

### Task 29: Remove `protocolFamily` / `protocolVariant` and the type aliases from `core.ts`; delete `protocol-family.ts`

**Files:**
- Modify: `shared/types/core.ts`
- Delete: `shared/lib/protocol-family.ts`

- [ ] **Step 1: Delete the type aliases**

Find and delete:

```ts
export type ProtocolFamily = "liquity";
export type ProtocolVariant = "v1" | "v2" | "style";
```

- [ ] **Step 2: Delete the `StablecoinMeta` fields**

Find and delete:

```ts
  protocolFamily?: ProtocolFamily;
  protocolVariant?: ProtocolVariant;
```

- [ ] **Step 3: Delete the now-stale `shared/lib/protocol-family.ts` file**

```bash
rm /Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/protocol-family.ts
```

- [ ] **Step 4: Type-check across frontend and worker**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard && npx tsc --noEmit
cd /Users/ahirice/Documents/git/stablecoin-dashboard/worker && npx tsc --noEmit
```

Expected: both pass. (The cleanup grep at Task 26 already verified no other consumer remains.)

- [ ] **Step 5: Run full tests + lint + build**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard && npm test -- --run && npm run lint && npm run build
```

Expected: all pass.

- [ ] **Step 6: Commit Tasks 27 + 28 + 29 together**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard
git add shared/data/stablecoins/usd-minor.json \
  shared/data/stablecoins/non-usd.json \
  shared/lib/stablecoins/schema.ts \
  shared/types/core.ts
git add -u shared/lib/protocol-family.ts
git commit -m "refactor(types): remove deprecated protocolFamily/protocolVariant"
```

---

## Phase D — Methodology, docs, verification

### Task 30: Add a new methodology section for the Infrastructure axis

**Files:**
- Create: `src/app/methodology/sections/core/infrastructure-section.tsx`
- Modify: `src/app/methodology/sections/core-sections.tsx`

The methodology page does **not** currently document the Liquity-fork tagging system as a user-facing concept (only the Liquity v1 reserves *adapter* gets a mention in the v6.92 changelog, which the spec says to leave alone). So this task **creates a new section** rather than replacing existing copy.

- [ ] **Step 1: Create the new section component**

Write `src/app/methodology/sections/core/infrastructure-section.tsx`:

```tsx
import {
  MethodologyFacts,
  MethodologySectionShell,
} from "../../methodology-shared";

export function InfrastructureMethodologySection() {
  return (
    <MethodologySectionShell
      id="infrastructure-methodology"
      title="Infrastructure Tagging"
      versionLabel="v1.0"
      changelogPath="/methodology/scoring-changelog/"
      versionNote="Version increments when the Infrastructure axis or its allowed values change."
      accentClassName="border-l-violet-500"
      badgeClassName="border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-400"
      changelogClassName="hover:text-violet-700 dark:text-violet-400"
    >
      <p>
        Infrastructure identifies the shared technical foundation a stablecoin was built on.
        Pharos currently recognises three values: <span className="text-foreground">Liquity v1</span>,{" "}
        <span className="text-foreground">Liquity v2</span>, and{" "}
        <span className="text-foreground">M0</span>. The tag answers the question:{" "}
        <em>what shared technology does this coin inherit risk from?</em>
      </p>
      <p>
        <span className="text-foreground">Liquity v1</span> and{" "}
        <span className="text-foreground">Liquity v2</span> are <em>code lineages</em> &mdash; coins that fork
        the original Liquity CDP implementation (v1) or its newer BOLD-style design (v2). Forks share source
        code but operate independently with their own reserves, governance, and Stability Pools. A vulnerability
        in the upstream Liquity codebase potentially affects every fork in that branch, even though the forks
        have no operational relationship.
      </p>
      <p>
        <span className="text-foreground">M0</span> is an <em>issuance-platform lineage</em> &mdash; coins built on
        M0&apos;s smart-contract rails (minter governance, the SwapFacility, and the{" "}
        <code className="text-xs bg-muted px-1 py-0.5 rounded">MExtension.sol</code> contract pattern). M0 provides the
        issuance machinery; the reserve composition is set by the issuer and{" "}
        <span className="text-foreground">may or may not include the underlying $M token</span>. Some M0-built coins
        are simple $M wrappers; others manage diversified collateral via M0&apos;s infrastructure. A governance
        issue at the M0 protocol level potentially affects every M0-built coin, even though their day-to-day
        operations and reserves are independent.
      </p>
      <MethodologyFacts
        facts={[
          { label: "Storage", value: "Array field on each StablecoinMeta entry" },
          { label: "Cardinality", value: "Zero, one, or many infrastructures per coin" },
          { label: "Surfaces", value: "Detail badge, homepage filter, taxonomy pages, methodology" },
        ]}
      />
    </MethodologySectionShell>
  );
}
```

- [ ] **Step 2: Register the section in `core-sections.tsx`**

In `src/app/methodology/sections/core-sections.tsx`, add the new import and render:

```tsx
import { InfrastructureMethodologySection } from "./core/infrastructure-section";
```

And add `<InfrastructureMethodologySection />` to the JSX between `<SafetyScoresMethodologySection />` and `<LiquidityMethodologySection />`. Final order:

```tsx
      <PricingPipelineMethodologySection />
      <StabilityIndexMethodologySection />
      <SafetyScoresMethodologySection />
      <InfrastructureMethodologySection />
      <LiquidityMethodologySection />
      <MintBurnFlowMethodologySection />
```

- [ ] **Step 3: Type-check**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard && npx tsc --noEmit
```

Expected: pass.

- [ ] **Step 4: Don't commit yet — Tasks 30 + 31 + 32 commit together**

---

### Task 31: Add an M0 mention to the about page

**Files:**
- Modify: `src/app/about/page.tsx`

The current about page already mentions M0 once in the `Reserve Transparency` data source group. The spec asks to add M0's GraphQL subgraph as a future-facing reference for Infrastructure ingestion (the actual ingestion is out of scope for this PR).

- [ ] **Step 1: Append M0 GraphQL to the `On-chain Reads & Events` group**

Find the `On-chain Reads & Events` entry in `DATA_SOURCE_GROUPS`. Append `, and M0 GraphQL subgraph for Infrastructure tagging` to the end of the existing `sources:` string. The full new value is the existing string verbatim, with that suffix appended right before the closing quote.

This is a one-line text change. No new section, no structural edits.

- [ ] **Step 2: Don't commit yet**

---

### Task 32: Update path references in docs and CLAUDE.md / README.md

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `docs/architecture.md`
- Modify: `docs/README.md`
- Modify: `docs/stablecoin-detail-page.md`
- Modify: `docs/classification.md`

- [ ] **Step 1: Find every reference**

```bash
git -C /Users/ahirice/Documents/git/stablecoin-dashboard grep -n "stablecoins/protocol\|protocolFamily\|protocolVariant" README.md CLAUDE.md docs/
```

- [ ] **Step 2: For each match, replace the path**

Replace `stablecoins/protocol/[protocol]` with `stablecoins/infrastructure/[infrastructure]`, and replace `protocolFamily` / `protocolVariant` references with `infrastructures` (and adjust the surrounding sentence to read naturally — these are docs, not code, so verbatim substitution may produce awkward phrasing).

For the `CLAUDE.md` route inventory at line 32, just swap the path literal in place.

- [ ] **Step 3: Verify no stale references remain in docs**

```bash
git -C /Users/ahirice/Documents/git/stablecoin-dashboard grep -n "stablecoins/protocol\|protocolFamily\|protocolVariant" README.md CLAUDE.md docs/
```

Expected: zero. (Historical agent files under `agents/audits/`, `agents/research/`, `agents/plans/historical/` are intentionally left untouched — they describe past state.)

- [ ] **Step 4: Commit Tasks 30 + 31 + 32 together**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard
git add src/app/methodology/sections/core/infrastructure-section.tsx \
  src/app/methodology/sections/core-sections.tsx \
  src/app/about/page.tsx \
  README.md \
  CLAUDE.md \
  docs/architecture.md \
  docs/README.md \
  docs/stablecoin-detail-page.md \
  docs/classification.md
git commit -m "docs: document Infrastructure axis and update route references"
```

---

### Task 33: Final cleanup grep and pre-push verification

- [ ] **Step 1: Comprehensive grep for any leftover references**

```bash
git -C /Users/ahirice/Documents/git/stablecoin-dashboard grep -n "protocolFamily\|protocolVariant\|ProtocolFamily\|ProtocolVariant\|LiquityForkBadge\|getProtocolFamily\|PROTOCOL_TAXONOMY\|ProtocolTaxonomyValue\|buildProtocolTaxonomyUrl\|liquity-family\|liquity-style\|stablecoins/protocol" -- 'src/*' 'shared/*' 'worker/*' 'public/*' 'README.md' 'CLAUDE.md' 'docs/*'
```

Expected: zero hits (the working archive under `agents/` is intentionally excluded).

The literal `liquity-v1` / `liquity-v2` (without the `infrastructure-` prefix) may still legitimately appear inside the new `infrastructures: ["liquity-v1"]` JSON entries — that's correct. The grep above does not match those because the literal includes the `["` prefix that the grep doesn't ask for.

- [ ] **Step 2: Run the merge gate (the canonical pre-push verification)**

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard && npm run test:merge-gate
```

Expected: pass. This change is Pages-impacting (touches `src/app/`, `public/`, `shared/`), so the merge gate runs the Pages build + SEO gate.

- [ ] **Step 3: Manual smoke test (optional, dev-server based)**

If a human is reviewing the implementation interactively, run the dev server and visit the new routes:

```bash
cd /Users/ahirice/Documents/git/stablecoin-dashboard && npm run dev
```

- `http://localhost:3000/stablecoins/infrastructure/liquity-v1/` &mdash; should list the 6 v1 coins (5 from `usd-minor.json` + `cjpy-yamato`).
- `http://localhost:3000/stablecoins/infrastructure/liquity-v2/` &mdash; should list 8 coins.
- `http://localhost:3000/stablecoins/infrastructure/m0/` &mdash; should list 11 coins.
- `http://localhost:3000/stablecoin/usdsc-startale/` &mdash; should show the M0 badge in violet on the detail page.
- `http://localhost:3000/stablecoin/lusd-liquity/` &mdash; should show the Liquity v1 badge in frost-blue (the originals exclusion was dropped).
- The homepage filter bar's "Infrastructure" group should have three options.

The dev server does NOT honour `_redirects` (that's a Cloudflare Pages deployment feature). Verify those after deployment by hitting `/stablecoins/protocol/liquity-v1/` and confirming the 301 lands on the new path.

For autonomous workers without a human in the loop, this step is optional &mdash; the merge gate at Step 2 already validates the build and the static export.

- [ ] **Step 4: No commit needed — verification only.**

---

## Notes for the executor

- **Work directly on `main`** per the user's explicit direction. No feature branch.
- **Order matters in Phase A**: schema must accept `infrastructures` (Task 4) before any data file adds it (Tasks 5-8). If you reorder, validation fails.
- **Order matters in Phase C**: cleanup grep first (Task 26), then data (Task 27), then schema (Task 28), then types (Task 29). If you delete the schema before deleting the data, the schema is fine; if you delete the types before the schema, the schema's `z.enum(PROTOCOL_FAMILY_VALUES)` lines reference a deleted constant. Stick to the order.
- **The `as FilterTag` cast** in `getFilterTags()` (Task 3) is intentional — TypeScript can't narrow template-literal expansions against a discriminated union, but the three concrete members are added to the union in Task 2 so the cast is sound at runtime.
- **The `LIQUITY_ORIGINALS` exclusion is intentionally dropped** in Task 19. This is a visible behaviour change on `bold-liquity` and `lusd-liquity` detail pages — they now show the Infrastructure badge. Mention this in the eventual changelog entry.
- **`npm run test:merge-gate`** is the gate. If it fails, fix it locally — do not push hoping CI will pass (per the project's CLAUDE.md).
- **Ticker collisions to be aware of when grepping**: USDK appears as both `usdk-orki` (Liquity v2) and `usdk-kast` (M0 — added in commit `16ba080d`). Don't tag the wrong one.
- **Two M0 coins to skip**: `m-m0` (the underlying $M token, IS the infrastructure not an extension) and `susdai-usd-ai` (a derivative wrapper of `usdai-usd-ai`, not directly built on M0). Neither receives the `infrastructures` field.
