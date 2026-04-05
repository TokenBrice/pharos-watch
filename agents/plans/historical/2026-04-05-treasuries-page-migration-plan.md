# Treasuries Page Migration & Treasury Table Cleanup

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the treasury stable-exposure leaderboard from `/portfolio` into a dedicated `/treasuries` page with its own route, nav entry, metadata, and status badge — while deduplicating shared helpers and cleaning up the table component.

**Architecture:** The treasury table component (`TreasuryStableExposureTable`) is already self-contained and accepts `{data, logos}` props, so extraction is mechanical. The main work is: (1) create the new page shell + client, (2) extract formatting/comparison helpers from the table component into a shared utils file and deduplicate `hasComparableTreasuryDenominator`, (3) remove treasury state from the portfolio client, (4) add the nav entry. No API/worker changes required.

**Tech Stack:** Next.js 16 (static export), React 19, TypeScript strict, Tailwind CSS v4, `createClientFeaturePage` pattern, Vitest + Testing Library.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/app/treasuries/page.tsx` | **Create** | Page metadata + `createClientFeaturePage` shell |
| `src/app/treasuries/client.tsx` | **Create** | Client component: treasury hook, loading skeleton, error/stale handling, table render |
| `src/app/treasuries/error.tsx` | **Create** | Page-scoped error boundary (matches every other route in the app) |
| `src/lib/treasury-table-utils.ts` | **Create** | Extracted formatters, sorting, status helpers from table component |
| `src/components/treasury-stable-exposure-table.tsx` | **Modify** | Import helpers from utils file instead of defining inline |
| `src/app/portfolio/client.tsx` | **Modify** | Remove treasury imports, hook call, card block, stale-data entry |
| `src/lib/nav-config.ts` | **Modify** | Add `/treasuries` nav item to Data group |
| `src/lib/__tests__/treasury-table-utils.test.ts` | **Create** | Unit tests for extracted helper functions |
| `src/components/__tests__/treasury-stable-exposure-table.test.tsx` | **Modify** | Verify tests still pass after refactor |

---

### Task 1: Extract Treasury Table Utils

Extract formatting, comparison, and status helpers from the table component into a dedicated utils module. This deduplicates `hasComparableTreasuryDenominator` (was defined in both the table component and `shared/lib` as `isTreasuryComparableEntity`) and moves pure logic out of the React file.

**Files:**
- Create: `src/lib/treasury-table-utils.ts`
- Create: `src/lib/__tests__/treasury-table-utils.test.ts`
- Modify: `src/components/treasury-stable-exposure-table.tsx`

- [ ] **Step 1: Write the failing tests for the extracted utils**

Create `src/lib/__tests__/treasury-table-utils.test.ts`:

```ts
// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  formatTreasuryUsd,
  formatTreasuryUsdNullable,
  formatTreasuryPct,
  denominatorStatusLabel,
  denominatorStatusClassName,
  coverageSummary,
  sortTreasuryExposureEntities,
} from "@/lib/treasury-table-utils";
import type { TreasuryStableExposureEntity } from "@shared/types";

function makeEntity(
  overrides: Partial<TreasuryStableExposureEntity> & { slug: string; name: string },
): TreasuryStableExposureEntity {
  return {
    protocolId: overrides.slug,
    slug: overrides.slug,
    name: overrides.name,
    category: overrides.category ?? "Protocol treasury",
    source: "defillama-github",
    adapterFile: null,
    chains: ["ethereum"],
    directWalletUsd: overrides.directWalletUsd ?? 1_000_000,
    treasuryUsd: overrides.treasuryUsd ?? 1_000_000,
    stablecoinSleeveUsd: overrides.stablecoinSleeveUsd ?? 500_000,
    trackedStableUsd: overrides.trackedStableUsd ?? 400_000,
    decentralizedStableUsd: overrides.decentralizedStableUsd ?? 200_000,
    decentralizedStablePctOfTreasury: overrides.decentralizedStablePctOfTreasury ?? 20,
    decentralizedStablePctOfStableSleeve: overrides.decentralizedStablePctOfStableSleeve ?? 40,
    weightedSafetyScore: overrides.weightedSafetyScore ?? 75,
    weightedSafetyGrade: overrides.weightedSafetyGrade ?? "B",
    governanceBuckets: overrides.governanceBuckets ?? {
      centralizedUsd: 200_000,
      centralizedDependentUsd: 0,
      decentralizedUsd: 200_000,
    },
    holdings: overrides.holdings ?? [],
    coverage: overrides.coverage ?? {
      extractionMode: "static-seeded",
      ownerCount: 1,
      ownerChainCount: 1,
      denominatorStatus: "direct-only",
      directWalletUsd: 1_000_000,
      defiPositionUsd: 0,
      consumedDirectBalanceUsd: 0,
      trackedStableUsd: 400_000,
      stablecoinSleeveUsd: 500_000,
      untrackedStableUsd: 100_000,
      derivedUntrackedStableUsd: 0,
      ratedTrackedStableUsd: 400_000,
      trackedStablePctOfTreasury: 40,
      trackedStablePctOfStableSleeve: 80,
      ratedTrackedStablePct: 100,
      untrackedStableCount: 1,
      derivedUntrackedStableCount: 0,
      skippedDerivedPositionCount: 0,
      notes: [],
    },
  };
}

describe("treasury-table-utils", () => {
  describe("formatTreasuryUsd", () => {
    it("formats positive values as compact USD", () => {
      expect(formatTreasuryUsd(1_234_567)).toBe("$1,234,567");
    });

    it("formats zero", () => {
      expect(formatTreasuryUsd(0)).toBe("$0");
    });
  });

  describe("formatTreasuryUsdNullable", () => {
    it("returns N/A for null", () => {
      expect(formatTreasuryUsdNullable(null)).toBe("N/A");
    });

    it("formats number values", () => {
      expect(formatTreasuryUsdNullable(500)).toBe("$500");
    });
  });

  describe("formatTreasuryPct", () => {
    it("returns N/A for null", () => {
      expect(formatTreasuryPct(null)).toBe("N/A");
    });

    it("formats percentage with one decimal", () => {
      expect(formatTreasuryPct(12.34)).toBe("12.3%");
    });
  });

  describe("denominatorStatusLabel", () => {
    it("maps adjusted-with-defi to Treasury-comparable", () => {
      const entity = makeEntity({
        slug: "x",
        name: "X",
        coverage: {
          ...makeEntity({ slug: "x", name: "X" }).coverage,
          denominatorStatus: "adjusted-with-defi",
        },
      });
      expect(denominatorStatusLabel(entity)).toBe("Treasury-comparable");
    });

    it("maps partial to Partial denominator", () => {
      const entity = makeEntity({
        slug: "x",
        name: "X",
        coverage: {
          ...makeEntity({ slug: "x", name: "X" }).coverage,
          denominatorStatus: "partial",
        },
      });
      expect(denominatorStatusLabel(entity)).toBe("Partial denominator");
    });

    it("maps invalid to Invalid denominator", () => {
      const entity = makeEntity({
        slug: "x",
        name: "X",
        coverage: {
          ...makeEntity({ slug: "x", name: "X" }).coverage,
          denominatorStatus: "invalid",
        },
      });
      expect(denominatorStatusLabel(entity)).toBe("Invalid denominator");
    });

    it("maps direct-only to Direct-only denominator", () => {
      const entity = makeEntity({ slug: "x", name: "X" });
      expect(denominatorStatusLabel(entity)).toBe("Direct-only denominator");
    });
  });

  describe("coverageSummary", () => {
    it("returns invalid message for invalid status", () => {
      const entity = makeEntity({
        slug: "x",
        name: "X",
        coverage: {
          ...makeEntity({ slug: "x", name: "X" }).coverage,
          denominatorStatus: "invalid",
        },
      });
      expect(coverageSummary(entity)).toBe("Invalid treasury denominator");
    });

    it("returns tracked percentage for valid status", () => {
      const entity = makeEntity({ slug: "x", name: "X" });
      expect(coverageSummary(entity)).toBe("Tracked 80.0% of stable sleeve");
    });
  });

  describe("sortTreasuryExposureEntities", () => {
    it("sorts by decentralizedStableUsd descending by default", () => {
      const a = makeEntity({ slug: "a", name: "A", decentralizedStableUsd: 100 });
      const b = makeEntity({ slug: "b", name: "B", decentralizedStableUsd: 500 });
      const sorted = sortTreasuryExposureEntities([a, b], "decentralizedStableUsd");
      expect(sorted[0]!.slug).toBe("b");
      expect(sorted[1]!.slug).toBe("a");
    });

    it("breaks ties alphabetically by name", () => {
      const a = makeEntity({ slug: "a", name: "Alpha", decentralizedStableUsd: 100 });
      const b = makeEntity({ slug: "b", name: "Beta", decentralizedStableUsd: 100 });
      const sorted = sortTreasuryExposureEntities([a, b], "decentralizedStableUsd");
      expect(sorted[0]!.slug).toBe("a");
      expect(sorted[1]!.slug).toBe("b");
    });

    it("sorts by weightedSafetyScore descending", () => {
      const a = makeEntity({ slug: "a", name: "A", weightedSafetyScore: 60 });
      const b = makeEntity({ slug: "b", name: "B", weightedSafetyScore: 90 });
      const sorted = sortTreasuryExposureEntities([a, b], "weightedSafetyScore");
      expect(sorted[0]!.slug).toBe("b");
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/lib/__tests__/treasury-table-utils.test.ts`
Expected: FAIL — module `@/lib/treasury-table-utils` does not exist yet.

- [ ] **Step 3: Create the utils module**

Create `src/lib/treasury-table-utils.ts`:

```ts
import { isTreasuryComparableEntity } from "@shared/lib/treasury-stable-exposure";
import type { TreasuryStableExposureEntity } from "@shared/types";

// Re-export so consumers have one import source
export { isTreasuryComparableEntity };

// ---------------------------------------------------------------------------
// Sort key type + options
// ---------------------------------------------------------------------------

export type TreasuryExposureSortKey =
  | "decentralizedStableUsd"
  | "decentralizedStablePctOfTreasury"
  | "decentralizedStablePctOfStableSleeve"
  | "trackedStableUsd"
  | "weightedSafetyScore";

export const TREASURY_SORT_OPTIONS: Array<{ value: TreasuryExposureSortKey; label: string }> = [
  { value: "decentralizedStableUsd", label: "Decentralized Stable $" },
  { value: "decentralizedStablePctOfTreasury", label: "Decentralized Stable % of Treasury" },
  { value: "decentralizedStablePctOfStableSleeve", label: "Decentralized Stable % of Stable Sleeve" },
  { value: "trackedStableUsd", label: "Tracked Stable Sleeve $" },
  { value: "weightedSafetyScore", label: "Weighted Stable Grade" },
];

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

const usdCompactFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

export function formatTreasuryUsd(value: number): string {
  return usdCompactFormatter.format(value);
}

export function formatTreasuryUsdNullable(value: number | null): string {
  return value == null ? "N/A" : formatTreasuryUsd(value);
}

export function formatTreasuryPct(value: number | null): string {
  return value == null ? "N/A" : `${value.toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Denominator status helpers
// ---------------------------------------------------------------------------

export function denominatorStatusLabel(entity: TreasuryStableExposureEntity): string {
  switch (entity.coverage.denominatorStatus) {
    case "adjusted-with-defi":
      return "Treasury-comparable";
    case "partial":
      return "Partial denominator";
    case "invalid":
      return "Invalid denominator";
    case "direct-only":
    default:
      return "Direct-only denominator";
  }
}

export function denominatorStatusClassName(entity: TreasuryStableExposureEntity): string {
  switch (entity.coverage.denominatorStatus) {
    case "adjusted-with-defi":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "partial":
      return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "invalid":
      return "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300";
    case "direct-only":
    default:
      return "border-border/70 bg-background/60 text-muted-foreground";
  }
}

export function coverageSummary(entity: TreasuryStableExposureEntity): string {
  const trackedPct = entity.coverage.trackedStablePctOfStableSleeve;
  if (entity.coverage.denominatorStatus === "invalid") return "Invalid treasury denominator";
  if (entity.coverage.denominatorStatus === "partial") {
    return trackedPct == null
      ? "Stable sleeve detected, treasury share unavailable"
      : `Tracked ${trackedPct.toFixed(1)}% of sleeve, treasury share unavailable`;
  }
  if (trackedPct == null) return "No stable sleeve detected";
  return `Tracked ${trackedPct.toFixed(1)}% of stable sleeve`;
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

function compareEntities(
  a: TreasuryStableExposureEntity,
  b: TreasuryStableExposureEntity,
  sortKey: TreasuryExposureSortKey,
): number {
  switch (sortKey) {
    case "decentralizedStablePctOfTreasury":
      return (b.decentralizedStablePctOfTreasury ?? -1) - (a.decentralizedStablePctOfTreasury ?? -1);
    case "decentralizedStablePctOfStableSleeve":
      return (b.decentralizedStablePctOfStableSleeve ?? -1) - (a.decentralizedStablePctOfStableSleeve ?? -1);
    case "trackedStableUsd":
      return b.trackedStableUsd - a.trackedStableUsd;
    case "weightedSafetyScore":
      return (b.weightedSafetyScore ?? -1) - (a.weightedSafetyScore ?? -1);
    case "decentralizedStableUsd":
    default:
      return b.decentralizedStableUsd - a.decentralizedStableUsd;
  }
}

export function sortTreasuryExposureEntities(
  entities: readonly TreasuryStableExposureEntity[],
  sortKey: TreasuryExposureSortKey,
): TreasuryStableExposureEntity[] {
  return [...entities].sort((a, b) => {
    const sortDiff = compareEntities(a, b, sortKey);
    if (sortDiff !== 0) return sortDiff;
    return a.name.localeCompare(b.name);
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/lib/__tests__/treasury-table-utils.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Refactor the table component to import from utils**

Modify `src/components/treasury-stable-exposure-table.tsx` — replace the inline definitions with imports. The full replacement:

Remove these inline definitions (lines 9-112):
- `TreasuryExposureSortKey` type
- `SORT_OPTIONS` array
- `usdCompactFormatter`, `formatUsd`, `formatUsdNullable`, `formatPct`
- `hasComparableTreasuryDenominator`, `coverageSummary`, `denominatorStatusLabel`, `denominatorStatusClassName`
- `compareEntities`, `sortTreasuryExposureEntities`

Replace with imports:

```ts
import {
  type TreasuryExposureSortKey,
  TREASURY_SORT_OPTIONS,
  formatTreasuryUsd,
  formatTreasuryUsdNullable,
  formatTreasuryPct,
  isTreasuryComparableEntity,
  denominatorStatusLabel,
  denominatorStatusClassName,
  coverageSummary,
  sortTreasuryExposureEntities,
} from "@/lib/treasury-table-utils";
```

Then update the references inside the component:
- `SORT_OPTIONS` → `TREASURY_SORT_OPTIONS`
- `formatUsd(...)` → `formatTreasuryUsd(...)`
- `formatUsdNullable(...)` → `formatTreasuryUsdNullable(...)`
- `formatPct(...)` → `formatTreasuryPct(...)`
- `hasComparableTreasuryDenominator(...)` → `isTreasuryComparableEntity(...)`

- [ ] **Step 6: Run existing table tests to verify nothing broke**

Run: `npm test -- src/components/__tests__/treasury-stable-exposure-table.test.tsx`
Expected: all existing tests PASS (sorting, partial-row rendering unchanged).

- [ ] **Step 7: Commit**

```bash
git add src/lib/treasury-table-utils.ts src/lib/__tests__/treasury-table-utils.test.ts src/components/treasury-stable-exposure-table.tsx
git commit -m "refactor: extract treasury table utils and deduplicate helpers"
```

---

### Task 2: Create the `/treasuries` Page Shell

Create the new page route using the `createClientFeaturePage` pattern, matching established conventions.

**Files:**
- Create: `src/app/treasuries/page.tsx`
- Create: `src/app/treasuries/client.tsx`
- Create: `src/app/treasuries/error.tsx`

- [ ] **Step 1: Create the page shell**

Create `src/app/treasuries/page.tsx`:

```tsx
import { Skeleton } from "@/components/ui/skeleton";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import { buildPageMetadata } from "@/lib/page-metadata";

const description =
  "Compare public protocol and DAO treasuries by decentralized stablecoin exposure, treasury share, stable-sleeve mix, and weighted safety grades.";

export const metadata = buildPageMetadata({
  title: "Treasuries: Protocol Stablecoin Exposure",
  description,
  canonical: "/treasuries/",
});

export default createClientFeaturePage({
  loadClient: () => import("./client").then((m) => ({ default: m.TreasuriesClient })),
  loading: <Skeleton className="h-[400px] w-full rounded-xl" />,
  shell: {
    breadcrumbName: "Treasuries",
    path: "/treasuries/",
    title: "Protocol Treasuries",
    statusBadge: { status: "testing-in-prod" },
    leadParagraphs: [
      "Compare public protocol and DAO treasuries by decentralized stablecoin dollars, treasury share, and stable-sleeve mix.",
    ],
  },
});
```

Note: `ogImage` is intentionally omitted — `buildPageMetadata` falls back to the default `/og-card.png`. A dedicated `og-treasuries.png` can be added later once the page graduates from testing-in-prod.

- [ ] **Step 2: Create the client component**

Create `src/app/treasuries/client.tsx`:

```tsx
"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { TreasuryStableExposureTable } from "@/components/treasury-stable-exposure-table";
import { useTreasuryStableExposure } from "@/hooks/use-treasury-stable-exposure";
import { useLogos } from "@/hooks/use-logos";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { Landmark } from "lucide-react";

export function TreasuriesClient() {
  const {
    data: treasuryData,
    isLoading,
    dataUpdatedAt: treasuryUpdatedAt,
    error: treasuryError,
    refetch: refetchTreasury,
    meta: treasuryMeta,
  } = useTreasuryStableExposure();
  const { data: logos } = useLogos();

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-full rounded-xl" />
        <Skeleton className="h-[500px] w-full rounded-2xl" />
      </div>
    );
  }

  return (
    <SectionErrorBoundary name="Treasuries">
      <div className="space-y-6">
        <StaleDataBanner
          queries={[
            {
              label: "Treasury stable exposure",
              dataUpdatedAt: treasuryUpdatedAt,
              staleTime: 24 * 60 * 60 * 1000,
              error: treasuryError,
              hasData: !!treasuryData?.entities?.length,
              meta: treasuryMeta,
            },
          ]}
        />
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Landmark className="h-5 w-5 text-primary/80 shrink-0" />
              <CardTitle className="pharos-kicker">Protocol Treasury Stable Exposure</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-4 pt-0">
            <QueryErrorNotice
              error={treasuryError}
              hasData={!!treasuryData?.entities?.length}
              onRetry={() => {
                void refetchTreasury();
              }}
            />
            {treasuryData?.entities?.length ? (
              <TreasuryStableExposureTable data={treasuryData} logos={logos} />
            ) : (
              <p className="text-sm text-muted-foreground">
                Treasury rankings will appear here once the daily treasury snapshot is available.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </SectionErrorBoundary>
  );
}
```

- [ ] **Step 3: Create the error boundary**

Create `src/app/treasuries/error.tsx`:

```tsx
"use client";

import { createPageError } from "@/components/create-page-error";

export default createPageError("Failed to load treasuries", "TreasuriesError");
```

- [ ] **Step 4: Verify the page builds**

Run: `npm run build`
Expected: build succeeds, `/treasuries` page is statically exported.

- [ ] **Step 5: Commit**

```bash
git add src/app/treasuries/page.tsx src/app/treasuries/client.tsx src/app/treasuries/error.tsx
git commit -m "feat: add dedicated /treasuries page with testing-in-prod badge"
```

---

### Task 3: Add Nav Entry for Treasuries

Add the `/treasuries` route to the navigation config so it appears in the sidebar and command palette.

**Files:**
- Modify: `src/lib/nav-config.ts`

- [ ] **Step 1: Add the import and nav item**

In `src/lib/nav-config.ts`, add `Landmark` to the lucide-react import on line 1-25:

```ts
import {
  Activity,
  LayoutDashboard,
  Droplets,
  Compass,
  ShieldBan,
  Skull,
  Info,
  Landmark,
  Layers,
  KeyRound,
  BookOpen,
  FlaskConical,
  ArrowLeftRight,
  ArrowUpDown,
  Newspaper,
  Rocket,
  Send,
  Wallet,
  Network,
  TrendingUp,
  TableProperties,
  ScrollText,
  createLucideIcon,
} from "lucide-react";
```

Then add the treasuries nav item to the `Data` group, after the Blacklist Tracker entry (line 75):

```ts
      { href: "/treasuries", label: "Treasuries", icon: Landmark, description: "Protocol and DAO treasuries ranked by stablecoin exposure" },
```

- [ ] **Step 2: Verify build passes**

Run: `npm run build`
Expected: build succeeds, no type errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/nav-config.ts
git commit -m "feat: add /treasuries nav entry to Data group"
```

---

### Task 4: Remove Treasury from Portfolio Page

Remove the treasury hook call, imports, card block, and stale-data entry from the portfolio client.

**Files:**
- Modify: `src/app/portfolio/client.tsx`

- [ ] **Step 1: Remove treasury imports**

In `src/app/portfolio/client.tsx`, remove these two import lines (lines 28-29):

```ts
// DELETE these lines:
import { useTreasuryStableExposure } from "@/hooks/use-treasury-stable-exposure";
import { TreasuryStableExposureTable } from "@/components/treasury-stable-exposure-table";
```

- [ ] **Step 2: Remove the treasury hook call**

Remove the treasury hook invocation (lines 257-263):

```ts
// DELETE this block:
  const {
    data: treasuryData,
    dataUpdatedAt: treasuryUpdatedAt,
    error: treasuryError,
    refetch: refetchTreasury,
    meta: treasuryMeta,
  } = useTreasuryStableExposure();
```

- [ ] **Step 3: Remove the treasury entry from StaleDataBanner**

In the `StaleDataBanner` `queries` array (around lines 395-413), remove the second query object — the treasury entry:

```ts
// DELETE this object from the queries array:
          {
            label: "Treasury stable exposure",
            dataUpdatedAt: treasuryUpdatedAt,
            staleTime: 24 * 60 * 60 * 1000,
            error: treasuryError,
            hasData: !!treasuryData?.entities?.length,
            meta: treasuryMeta,
          },
```

The `StaleDataBanner` should now only contain the single `reportCards` query entry.

- [ ] **Step 4: Remove the treasury card block**

Remove the entire treasury `<Card>` block (lines 572-600):

```tsx
// DELETE this entire block:
      <Card>
        <CardHeader className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle className="pharos-kicker">Protocol Treasury Stable Exposure</CardTitle>
              <p className="mt-2 text-sm text-muted-foreground">
                Compare public protocol and DAO treasuries by decentralized stablecoin dollars, treasury share,
                and stable-sleeve mix.
              </p>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 pt-0">
          <QueryErrorNotice
            error={treasuryError}
            hasData={!!treasuryData?.entities?.length}
            onRetry={() => {
              void refetchTreasury();
            }}
          />
          {treasuryData?.entities?.length ? (
            <TreasuryStableExposureTable data={treasuryData} logos={logos} />
          ) : (
            <p className="text-sm text-muted-foreground">
              Treasury rankings will appear here once the daily treasury snapshot is available.
            </p>
          )}
        </CardContent>
      </Card>
```

- [ ] **Step 5: Verify build and tests pass**

Run: `npm run build && npm test`
Expected: build succeeds, all tests pass. The portfolio page no longer imports treasury-related modules.

- [ ] **Step 6: Commit**

```bash
git add src/app/portfolio/client.tsx
git commit -m "refactor: remove treasury section from portfolio page"
```

---

### Task 5: Final Verification

Run the full merge gate to confirm everything is clean.

**Files:** None (verification only)

- [ ] **Step 1: Run the merge gate**

Run: `npm run test:merge-gate`
Expected: all checks pass (lint, type-check, tests, build).

- [ ] **Step 2: Verify the treasuries page renders in dev**

Run: `npm run dev`

Then open `http://localhost:3000/treasuries` and verify:
1. Breadcrumb reads "Dashboard / Treasuries"
2. Title reads "Protocol Treasuries"
3. Status badge reads "Testing in Prod" (orange styling, matching the screenshot)
4. Lead paragraph is visible
5. Treasury table loads (or shows empty-state message if no cached data)
6. The page appears in the sidebar navigation under "Data"

Then open `http://localhost:3000/portfolio` and verify:
1. No treasury card at the bottom
2. No treasury entry in the stale-data banner
3. Portfolio functionality (holdings, radar, upstream exposure) works unchanged

- [ ] **Step 3: Commit any remaining fixes if needed**

Only if verification surfaced issues. Otherwise, done.
