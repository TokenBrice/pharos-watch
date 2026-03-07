---
title: "Migrate all 6 version files to use createMethodologyVersion factory"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "xhigh"
done: false
---

## Goal

Rewrite all 6 methodology version files to use the `createMethodologyVersion()` factory from `shared/lib/methodology-version.ts` (created in TICKET-001). Each file shrinks from ~150-250 lines of boilerplate + data to just data + a factory call. All existing exports must continue to work identically.

## Context

### The factory (from TICKET-001)

```typescript
// shared/lib/methodology-version.ts
export interface MethodologyChangelogEntry {
  version: string; title: string; date: string; effectiveAt: number;
  summary: string; impact: readonly string[]; commits: readonly string[]; reconstructed: boolean;
}
export interface MethodologyVersionConfig {
  currentVersion: string; changelogPath: string; changelog: readonly MethodologyChangelogEntry[];
}
export function createMethodologyVersion(config: MethodologyVersionConfig): MethodologyVersion;
export function toMethodologyVersionLabel(version: string): string;
```

### Key constraint: backward-compatible exports

Every version file currently exports specific named constants, a `getXVersionAt()` function, and a `toXVersionLabel()` function. All consumers import these by name. The migrated files must **re-export the same names** so no consumer needs to change in this ticket.

### Impact field name mapping

The 6 files use different field names for the impact array:
- `depeg-dews-version.ts`: `methodologyImpact`
- `stability-index-version.ts`: `scoreImpact`
- `liquidity-score-version.ts`: `scoreImpact`
- `blacklist-tracker-version.ts`: `trackingImpact`
- `yield-methodology-version.ts`: `methodologyImpact`
- `mint-burn-flow-version.ts`: `methodologyImpact`

The factory uses `impact` as the unified field name. Each version file must map its domain-specific field name to `impact` in the changelog data.

## Task

### Step 1: Migrate each version file

Apply the same transformation pattern to all 6 files. Here is the pattern using `depeg-dews-version.ts` as the example:

**Before** (`shared/lib/depeg-dews-version.ts`, ~249 lines):
```typescript
export const DEPEG_DEWS_METHODOLOGY_VERSION = "4.4";
export const DEPEG_DEWS_METHODOLOGY_VERSION_LABEL = `v${DEPEG_DEWS_METHODOLOGY_VERSION}`;
export const DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH = "/methodology/depeg-changelog/";

export interface DepegDewsMethodologyChangelogEntry {
  version: string; title: string; date: string; effectiveAt: number;
  summary: string; methodologyImpact: readonly string[];
  commits: readonly string[]; reconstructed: boolean;
}

export const DEPEG_DEWS_METHODOLOGY_CHANGELOG: readonly DepegDewsMethodologyChangelogEntry[] = [
  { version: "4.4", ..., methodologyImpact: [...], ... },
  // ... ~200 lines of data ...
] as const;

const DEPEG_DEWS_VERSION_WINDOWS_ASC = [...DEPEG_DEWS_METHODOLOGY_CHANGELOG]
  .map((entry) => ({ version: entry.version, effectiveAt: entry.effectiveAt }))
  .sort((a, b) => a.effectiveAt - b.effectiveAt);

export function getDepegDewsMethodologyVersionAt(unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds)) return DEPEG_DEWS_METHODOLOGY_VERSION;
  let resolved = DEPEG_DEWS_VERSION_WINDOWS_ASC[0]?.version ?? DEPEG_DEWS_METHODOLOGY_VERSION;
  for (const window of DEPEG_DEWS_VERSION_WINDOWS_ASC) {
    if (unixSeconds >= window.effectiveAt) { resolved = window.version; } else { break; }
  }
  return resolved;
}

export function toDepegDewsMethodologyVersionLabel(version: string): string {
  return `v${version}`;
}
```

**After** (`shared/lib/depeg-dews-version.ts`):
```typescript
import {
  createMethodologyVersion,
  toMethodologyVersionLabel,
  type MethodologyChangelogEntry,
} from "./methodology-version";

const depegDews = createMethodologyVersion({
  currentVersion: "4.4",
  changelogPath: "/methodology/depeg-changelog/",
  changelog: [
    {
      version: "4.4",
      title: "No-history coins now return null peg score",
      date: "2026-03-02",
      effectiveAt: 1772449220,
      summary: "Peg score stopped treating coins with neither first-seen supply history nor depeg events as implicitly healthy.",
      impact: [
        "coinTrackingStart now returns null when both firstSeen and events are absent",
        "computePegScoreWithWindow now yields null pegScore for insufficient-history coins",
        "Prevents false perfect-score outcomes on sparse or incomplete datasets",
      ],
      commits: ["71cc096"],
      reconstructed: true,
    },
    // ... remaining entries with methodologyImpact renamed to impact ...
  ],
});

/** Canonical Depeg Tracker + DEWS methodology version (no "v" prefix). */
export const DEPEG_DEWS_METHODOLOGY_VERSION = depegDews.currentVersion;

/** Display-ready Depeg Tracker + DEWS methodology version (with "v" prefix). */
export const DEPEG_DEWS_METHODOLOGY_VERSION_LABEL = depegDews.versionLabel;

/** Public changelog route for Depeg Tracker + DEWS methodology history. */
export const DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH = depegDews.changelogPath;

/** Re-export MethodologyChangelogEntry as the domain-specific type for backward compat. */
export type DepegDewsMethodologyChangelogEntry = MethodologyChangelogEntry;

/** Reconstructed changelog data. */
export const DEPEG_DEWS_METHODOLOGY_CHANGELOG = depegDews.changelog;

/** Resolve Depeg Tracker + DEWS methodology version active at a given Unix timestamp (seconds). */
export const getDepegDewsMethodologyVersionAt = depegDews.getVersionAt;

export const toDepegDewsMethodologyVersionLabel = toMethodologyVersionLabel;
```

### Step 2: Apply the same pattern to all 6 files

Apply the transformation above to each file. The only differences per file are:

**`shared/lib/depeg-dews-version.ts`**:
- Impact field rename: `methodologyImpact` -> `impact`
- Factory variable name: `depegDews`
- All existing export names preserved

**`shared/lib/stability-index-version.ts`**:
- Impact field rename: `scoreImpact` -> `impact`
- Factory variable name: `psi`
- Exports: `PSI_METHODOLOGY_VERSION`, `PSI_METHODOLOGY_VERSION_LABEL`, `PSI_METHODOLOGY_CHANGELOG_PATH`, `PSI_METHODOLOGY_CHANGELOG`, `PsiMethodologyChangelogEntry` (type alias), `getPsiMethodologyVersionAt`, `toPsiMethodologyVersionLabel`

**`shared/lib/liquidity-score-version.ts`**:
- Impact field rename: `scoreImpact` -> `impact`
- Factory variable name: `liquidity`
- Exports: `LIQUIDITY_METHODOLOGY_VERSION`, `LIQUIDITY_METHODOLOGY_VERSION_LABEL`, `LIQUIDITY_METHODOLOGY_CHANGELOG_PATH`, `LIQUIDITY_METHODOLOGY_CHANGELOG`, `LiquidityMethodologyChangelogEntry` (type alias), `getLiquidityMethodologyVersionAt`, `toLiquidityMethodologyVersionLabel`

**`shared/lib/blacklist-tracker-version.ts`**:
- Impact field rename: `trackingImpact` -> `impact`
- Factory variable name: `blacklistTracker`
- Exports: `BLACKLIST_TRACKER_METHODOLOGY_VERSION`, `BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL`, `BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH`, `BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG`, `BlacklistTrackerMethodologyChangelogEntry` (type alias), `getBlacklistTrackerMethodologyVersionAt`, `toBlacklistTrackerMethodologyVersionLabel`

**`shared/lib/yield-methodology-version.ts`**:
- Impact field rename: `methodologyImpact` -> `impact`
- Factory variable name: `yieldMethodology`
- Exports: `YIELD_METHODOLOGY_VERSION`, `YIELD_METHODOLOGY_VERSION_LABEL`, `YIELD_METHODOLOGY_CHANGELOG_PATH`, `YIELD_METHODOLOGY_CHANGELOG`, `YieldMethodologyChangelogEntry` (type alias), `getYieldMethodologyVersionAt`, `toYieldMethodologyVersionLabel`

**`shared/lib/mint-burn-flow-version.ts`**:
- Impact field rename: `methodologyImpact` -> `impact`
- Factory variable name: `mintBurnFlow`
- Exports: `MINT_BURN_FLOW_METHODOLOGY_VERSION`, `MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL`, `MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH`, `MINT_BURN_FLOW_METHODOLOGY_CHANGELOG`, `MintBurnFlowMethodologyChangelogEntry` (type alias), `getMintBurnFlowMethodologyVersionAt`, `toMintBurnFlowMethodologyVersionLabel`

### Step 3: Update frontend changelog pages

The changelog pages use a `selectImpact` function in their route factory to extract the impact field. Since the field is now always `impact`, update the `selectImpact` functions.

Check these 6 changelog page files:
- `src/app/methodology/depeg-changelog/page.tsx`
- `src/app/methodology/stability-index-changelog/page.tsx`
- `src/app/methodology/liquidity-score-changelog/page.tsx`
- `src/app/methodology/blacklist-tracker-changelog/page.tsx`
- `src/app/methodology/yield-changelog/page.tsx`
- `src/app/methodology/mint-burn-flow-changelog/page.tsx`

Each uses a `createMethodologyChangelogRoute` factory that takes a `selectImpact` function. Read each file to find the `selectImpact` mapping. Since the changelog entry type is now `MethodologyChangelogEntry` with an `impact` field, the `selectImpact` function in each page should become:
```typescript
selectImpact: (entry) => entry.impact,
```

This may already be the case if the factory was already extracting `impact` — verify by reading the factory file first.

### Step 4: Update the `MethodologyVersionCard` component

`src/components/methodology-version-card.tsx` defines its own `MethodologyChangelogEntry` interface (lines 1-9) with 7 fields including `impact: readonly string[]`. The factory's interface has the same 7 fields plus `effectiveAt: number`. Since all callers pass full changelog entries (which include `effectiveAt`), the wider type is safe. Replace the local interface with an import:

- Delete lines 1-9 (the local `MethodologyChangelogEntry` interface)
- Add import: `import { type MethodologyChangelogEntry } from "@shared/lib/methodology-version";`
- Re-export the type for consumers: `export type { MethodologyChangelogEntry };`

The `methodology-changelog-page.tsx` component imports `MethodologyChangelogEntry` from this file, so the re-export is required.

**Note:** The 7th version file `shared/lib/safety-score-version.ts` is excluded from this migration — it contains only 3 constants with no changelog array or version-resolution boilerplate.

### Step 5: Update test files

The 6 test files in `src/lib/__tests__/*-version.test.ts` each test:
1. Changelog consistency (first entry version matches VERSION constant)
2. Version label formatting
3. `getVersionAt()` timestamp resolution

Since the exported names haven't changed, most tests should still pass without modification. However, update any test that references the old domain-specific `ChangelogEntry` type or the old impact field name.

Verify each test file compiles and passes after the migration.

### Important: Do NOT change any consumer files

All worker API handlers, cron jobs, and frontend pages import by the domain-specific names (e.g., `DEPEG_DEWS_METHODOLOGY_VERSION`, `getDepegDewsMethodologyVersionAt`). These names are preserved as re-exports, so **no consumer files need to change**. Do not modify any files outside of `shared/lib/*-version.ts`, the test files, and the changelog page `selectImpact` functions.

## Consumer Reference (DO NOT MODIFY — verify they still compile)

These files import from the version modules. They should work without changes since we preserve all export names:

**Worker consumers:**
- `worker/src/api/stress-signals.ts` — imports from `depeg-dews-version`
- `worker/src/api/depeg-events.ts` — imports from `depeg-dews-version`
- `worker/src/api/peg-summary.ts` — imports from `depeg-dews-version`
- `worker/src/api/blacklist.ts` — imports from `blacklist-tracker-version`
- `worker/src/api/stability-index.ts` — imports from `stability-index-version`
- `worker/src/api/backfill-stability-index.ts` — imports from `stability-index-version`
- `worker/src/api/dex-liquidity.ts` — imports from `liquidity-score-version`
- `worker/src/api/dex-liquidity-history.ts` — imports from `liquidity-score-version`
- `worker/src/cron/stability-index.ts` — imports `PSI_METHODOLOGY_VERSION`
- `worker/src/cron/snapshot-psi.ts` — imports `PSI_METHODOLOGY_VERSION`
- `worker/src/cron/sync-blacklist.ts` — imports `getBlacklistTrackerMethodologyVersionAt`
- `worker/src/cron/dex-liquidity/persistence.ts` — imports `LIQUIDITY_METHODOLOGY_VERSION`
- `worker/src/lib/safety-scores.ts` — imports `getDepegDewsMethodologyVersionAt`
- `worker/src/lib/peg-analytics.ts` — imports `getDepegDewsMethodologyVersionAt`

**Frontend consumers:**
- `src/app/methodology/page.tsx` — imports VERSION_LABEL and CHANGELOG_PATH from multiple version files
- `src/app/blacklist/page.tsx` — imports from `blacklist-tracker-version`
- `src/app/depeg/page.tsx` — imports from `depeg-dews-version`
- `src/app/flows/page.tsx` — imports from `mint-burn-flow-version`
- `src/app/liquidity/page.tsx` — imports from `liquidity-score-version`
- `src/app/yield/page.tsx` — imports from `yield-methodology-version`
- `src/app/stability-index/page.tsx` — imports from `stability-index-version`
- 6 changelog pages — imports CHANGELOG + VERSION constants

## Acceptance Criteria

- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
- All 6 version files import from `./methodology-version`
  - `grep -c "from.*methodology-version" shared/lib/depeg-dews-version.ts` returns 1
  - `grep -c "from.*methodology-version" shared/lib/stability-index-version.ts` returns 1
  - `grep -c "from.*methodology-version" shared/lib/liquidity-score-version.ts` returns 1
  - `grep -c "from.*methodology-version" shared/lib/blacklist-tracker-version.ts` returns 1
  - `grep -c "from.*methodology-version" shared/lib/yield-methodology-version.ts` returns 1
  - `grep -c "from.*methodology-version" shared/lib/mint-burn-flow-version.ts` returns 1
- No version file contains the old `VERSION_WINDOWS_ASC` boilerplate:
  - `grep -c "VERSION_WINDOWS_ASC" shared/lib/depeg-dews-version.ts` returns 0
  - `grep -c "VERSION_WINDOWS_ASC" shared/lib/stability-index-version.ts` returns 0
  - `grep -c "VERSION_WINDOWS_ASC" shared/lib/liquidity-score-version.ts` returns 0
  - `grep -c "VERSION_WINDOWS_ASC" shared/lib/blacklist-tracker-version.ts` returns 0
  - `grep -c "VERSION_WINDOWS_ASC" shared/lib/yield-methodology-version.ts` returns 0
  - `grep -c "VERSION_WINDOWS_ASC" shared/lib/mint-burn-flow-version.ts` returns 0
- No version file contains inline `getVersionAt` logic (the `for (const window of` loop):
  - `grep -c "for (const window of" shared/lib/depeg-dews-version.ts` returns 0
  - `grep -c "for (const window of" shared/lib/stability-index-version.ts` returns 0
- All existing test files pass: `npx vitest run src/lib/__tests__/*-version.test.ts`
- Worker type-check passes: `cd worker && npx tsc --noEmit`
