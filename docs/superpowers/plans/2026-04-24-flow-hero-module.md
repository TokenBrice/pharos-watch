# Unified Mint/Burn Flow Hero Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge `FlowPressureReceipt` into `FlowBrrrOverview` as an internal "receipt band" so the `/flows/` page renders each mint/burn datum once inside one cohesive card.

**Architecture:** Single `<article>` card with two visual registers. Register 1 is the existing hero (badges + headline + description + Bank Run Gauge lever on the left, `FlowMachineScene` + `MintingPressureGauge` on the right). Register 2 is a receipt-styled band folded into the same card below a dashed tear-line — 6 mint/burn/net tiles driven by `buildFlowPressureReceiptModel`, followed by an aside-as-row (scope, top minter, top burner, coverage summary, coverage pills, sync warning). Receipt band only renders when `variant !== "compact"` so the homepage snapshot is unaffected.

**Tech Stack:** Next.js 16, React 19, Tailwind, Vitest + Testing Library, lucide-react icons.

**Spec:** `docs/superpowers/specs/2026-04-24-flow-hero-module-design.md`

---

## File Structure

**Create:**
- `src/components/flow-receipt-band.tsx` — new presentational sub-component for the receipt register (tiles + aside-as-row).
- `src/components/__tests__/flow-receipt-band.test.tsx` — mirrors the old `flow-pressure-receipt.test.tsx` against the new component.

**Modify:**
- `src/components/flow-brrr-overview.tsx` — add optional `scopeLabel`/`syncWarning` props, remove duplicate tile grids + top-minter/burner sub-grid, move Bank Run Gauge up, render `FlowReceiptBand` below a dashed tear line when `variant !== "compact"`.
- `src/app/flows/client.tsx` — drop the standalone `<FlowPressureReceipt>`, drop the coverage caption, pass `scopeLabel`/`syncWarning` into `<FlowBrrrOverview>`, remove the `FlowPressureReceipt` import.
- `docs/mint-burn-flows.md:656` — update the component inventory description for `FlowBrrrOverview` to mention the folded-in receipt band.

**Delete:**
- `src/components/flow-pressure-receipt.tsx`
- `src/components/__tests__/flow-pressure-receipt.test.tsx`

**Unchanged (verified):**
- `src/lib/flow-pressure-receipt-model.ts` + its test — the model is reused by `FlowReceiptBand`.
- `src/components/flow-machine-scene*.tsx`, `src/components/minting-pressure-gauge.tsx`, `src/components/homepage-flow-overview.tsx`.

---

## Task 1: Create `FlowReceiptBand` with a failing test

**Files:**
- Create: `src/components/__tests__/flow-receipt-band.test.tsx`
- Create: `src/components/flow-receipt-band.tsx`

- [ ] **Step 1: Write the failing test**

Write `src/components/__tests__/flow-receipt-band.test.tsx` with this exact content:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { FlowReceiptBand } from "@/components/flow-receipt-band";
import type { MintBurnCoinFlow, MintBurnGauge, MintBurnHourlyBucket } from "@shared/types";

afterEach(() => cleanup());

const gauge: MintBurnGauge = {
  score: 12,
  band: "normal",
  flightToQuality: false,
  flightIntensity: 0,
  trackedCoins: 2,
  trackedMcapUsd: 80_000_000_000,
};

function coin(symbol: string, netFlow24hUsd: number): MintBurnCoinFlow {
  return {
    stablecoinId: symbol.toLowerCase(),
    symbol,
    flowIntensity: 0,
    netFlow24hUsd,
    mintVolume24hUsd: netFlow24hUsd > 0 ? netFlow24hUsd : 0,
    burnVolume24hUsd: netFlow24hUsd < 0 ? Math.abs(netFlow24hUsd) : 0,
    mintCount24h: netFlow24hUsd > 0 ? 1 : 0,
    burnCount24h: netFlow24hUsd < 0 ? 1 : 0,
    netFlow7dUsd: netFlow24hUsd * 2,
    netFlow30dUsd: netFlow24hUsd * 3,
    netFlow90dUsd: netFlow24hUsd * 4,
    largestEvent24h: null,
    coverage: {
      startBlock: 1,
      lastSyncedBlock: 2,
      lagBlocks: null,
      historyStartAt: 1_700_000_000,
      has24hWindow: true,
      has30dWindow: true,
      has90dWindow: true,
      isPartial: false,
      status: "full",
    },
  };
}

describe("FlowReceiptBand", () => {
  it("renders all six tile labels, the scope caveat, and the top leaders", () => {
    const weeklyHourly: MintBurnHourlyBucket[] = [
      { hourTs: 1, mintVolumeUsd: 10_000_000, burnVolumeUsd: 3_000_000, netFlowUsd: 7_000_000 },
    ];

    render(createElement(FlowReceiptBand, {
      gauge,
      coins: [coin("USDC", 25_000_000), coin("DAI", -9_000_000)],
      weeklyHourly,
      scopeLabel: "Configured issuance chains",
      syncWarning: null,
    }));

    expect(screen.getByRole("heading", { name: "Printer and shredder accounting" })).toBeTruthy();
    expect(screen.getByText("Printed 24h")).toBeTruthy();
    expect(screen.getByText("Shredded 24h")).toBeTruthy();
    expect(screen.getByText("Net 24h")).toBeTruthy();
    expect(screen.getByText("Printed 7d")).toBeTruthy();
    expect(screen.getByText("Shredded 7d")).toBeTruthy();
    expect(screen.getByText("Net 7d")).toBeTruthy();
    expect(screen.getByText("Configured issuance chains")).toBeTruthy();
    expect(screen.getByText(/not market-wide supply creation or redemption/i)).toBeTruthy();
    expect(screen.getByText(/USDC/)).toBeTruthy();
    expect(screen.getByText(/DAI/)).toBeTruthy();
  });

  it("renders a sync warning panel when one is provided", () => {
    render(createElement(FlowReceiptBand, {
      gauge,
      coins: [coin("USDC", 25_000_000)],
      weeklyHourly: [],
      scopeLabel: "Configured issuance chains",
      syncWarning: "Ingest lag detected — 8 minutes behind",
    }));

    expect(screen.getByText(/Ingest lag detected/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/__tests__/flow-receipt-band.test.tsx`
Expected: FAIL — cannot resolve import `@/components/flow-receipt-band`.

- [ ] **Step 3: Implement `FlowReceiptBand`**

Write `src/components/flow-receipt-band.tsx` with this exact content:

```tsx
"use client";

import { ReceiptText } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  buildFlowPressureReceiptModel,
  type FlowPressureReceiptRow,
} from "@/lib/flow-pressure-receipt-model";
import { formatCurrency, formatSignedCurrency } from "@shared/lib/format";
import type {
  MintBurnCoinFlow,
  MintBurnGauge,
  MintBurnHourlyBucket,
} from "@shared/types";

interface FlowReceiptBandProps {
  gauge: MintBurnGauge | null;
  coins: MintBurnCoinFlow[];
  weeklyHourly?: MintBurnHourlyBucket[];
  scopeLabel: string;
  syncWarning: string | null;
  className?: string;
}

function formatReceiptCurrency(row: FlowPressureReceiptRow): string {
  if (row.valueUsd === null) return "NR";
  return row.tone === "net" ? formatSignedCurrency(row.valueUsd) : formatCurrency(row.valueUsd);
}

function toneClass(tone: FlowPressureReceiptRow["tone"]): string {
  if (tone === "mint") return "text-emerald-700 dark:text-emerald-300";
  if (tone === "burn") return "text-red-700 dark:text-red-300";
  return "text-foreground";
}

function statusLabel(status: string): string {
  return status.replace("-", " ");
}

export function FlowReceiptBand({
  gauge,
  coins,
  weeklyHourly,
  scopeLabel,
  syncWarning,
  className,
}: FlowReceiptBandProps) {
  const model = buildFlowPressureReceiptModel({
    gauge,
    coins,
    weeklyHourly,
    scopeLabel,
    syncWarning,
  });

  return (
    <section
      className={cn(
        "relative overflow-hidden rounded-lg border border-dashed border-border/80 bg-card/85",
        className,
      )}
      aria-labelledby="flow-receipt-band-heading"
    >
      <div
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-1"
        style={{
          background:
            "linear-gradient(90deg, oklch(0.66 0.15 155), oklch(0.68 0.17 32), oklch(0.58 0.11 240))",
        }}
      />

      <div className="space-y-3 p-4">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="pharos-kicker">Flow receipt</p>
            <h3
              id="flow-receipt-band-heading"
              className="flex items-center gap-2 text-base font-semibold"
            >
              <ReceiptText className="h-4 w-4 text-sky-700 dark:text-sky-300" aria-hidden />
              Printer and shredder accounting
            </h3>
          </div>
          <div className="rounded-full border border-border/70 bg-muted/30 px-3 py-1 text-xs text-muted-foreground">
            {model.trackedCoins} tracked {model.trackedCoins === 1 ? "coin" : "coins"}
          </div>
        </header>

        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {model.rows.map((row) => (
            <div
              key={row.id}
              className="rounded-lg border border-border/60 bg-background/50 p-3"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {row.label}
                </span>
                <span
                  className={cn(
                    "font-mono text-sm font-semibold tabular-nums",
                    toneClass(row.tone),
                  )}
                >
                  {formatReceiptCurrency(row)}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{row.detail}</p>
            </div>
          ))}
        </div>

        <div className="rounded-lg border border-border/60 bg-background/55 p-3">
          <div className="flex flex-wrap items-start gap-x-6 gap-y-2 text-sm">
            <div className="min-w-[12rem]">
              <p className="pharos-kicker">Scope</p>
              <p className="mt-0.5 text-sm font-medium">{model.scopeLabel}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Observed configured-chain events, not market-wide supply creation or redemption.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="text-muted-foreground text-xs">Top minter</span>
              <span className="font-mono text-sm font-semibold text-emerald-700 dark:text-emerald-300">
                {model.topMint
                  ? `${model.topMint.symbol} ${formatSignedCurrency(model.topMint.valueUsd)}`
                  : "None"}
              </span>
              <span className="text-muted-foreground text-xs">Top burner</span>
              <span className="font-mono text-sm font-semibold text-red-700 dark:text-red-300">
                {model.topBurn
                  ? `${model.topBurn.symbol} ${formatSignedCurrency(model.topBurn.valueUsd)}`
                  : "None"}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-muted-foreground text-xs">Coverage</span>
              <span className="text-xs font-medium">{model.coverageSummary}</span>
              {model.coverageRows.map((row) => (
                <span
                  key={row.status}
                  className="rounded-full border border-border/70 bg-muted/25 px-2 py-0.5 text-[11px] capitalize text-muted-foreground"
                >
                  {statusLabel(row.status)} {row.count}
                </span>
              ))}
            </div>
          </div>

          {model.syncWarning ? (
            <p className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
              {model.syncWarning}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/__tests__/flow-receipt-band.test.tsx`
Expected: PASS — both tests green.

- [ ] **Step 5: Commit**

```bash
git add src/components/flow-receipt-band.tsx src/components/__tests__/flow-receipt-band.test.tsx
git commit -m "feat: add FlowReceiptBand sub-component"
```

---

## Task 2: Fold `FlowReceiptBand` into `FlowBrrrOverview`

**Files:**
- Modify: `src/components/flow-brrr-overview.tsx` (whole file rewrite of the `IterationOne` layout + props surface)

- [ ] **Step 1: Extend the props surface**

In `src/components/flow-brrr-overview.tsx`, replace the existing `FlowBrrrOverviewProps` interface (lines ~37–44) with:

```tsx
interface FlowBrrrOverviewProps {
  gauge: MintBurnGauge | null;
  coins: MintBurnCoinFlow[];
  weeklyHourly?: MintBurnHourlyBucket[];
  isLoading?: boolean;
  className?: string;
  variant?: "default" | "compact";
  scopeLabel?: string;
  syncWarning?: string | null;
}
```

- [ ] **Step 2: Add the import for `FlowReceiptBand`**

At the top of `src/components/flow-brrr-overview.tsx`, alongside the other `@/components/*` imports, add:

```tsx
import { FlowReceiptBand } from "@/components/flow-receipt-band";
```

- [ ] **Step 3: Rewrite the `IterationOne` layout**

Replace the entire `IterationOne` function body (currently lines ~153–385 — from `function IterationOne({` through the closing `);\n}` that ends the component). Replace with this exact implementation:

```tsx
function IterationOne({
  snapshot,
  gauge,
  variant = "default",
  scopeLabel = "Configured issuance chains",
  syncWarning = null,
  coins,
  weeklyHourly,
}: {
  snapshot: FlowSnapshot;
  gauge: MintBurnGauge | null;
  variant?: "default" | "compact";
  scopeLabel?: string;
  syncWarning?: string | null;
  coins: MintBurnCoinFlow[];
  weeklyHourly?: MintBurnHourlyBucket[];
}) {
  const isCompact = variant === "compact";
  const totalFlow24h = snapshot.mint24h + snapshot.burn24h;
  const netDominance = snapshot.has24hActivity
    ? Math.abs(snapshot.net24h) / Math.max(totalFlow24h, 1)
    : 0.08;
  const pressurePower = snapshot.score === null
    ? 0.18
    : Math.abs(snapshot.score) / 100;
  const sceneIntensity = snapshot.netDirection === "flat"
    ? 0.12
    : clamp(Math.max(netDominance, pressurePower * 0.6), 0.12, 1);
  const sceneStress = snapshot.score === null || snapshot.score >= -10
    ? 0
    : clamp((-10 - snapshot.score) / 90, 0, 1);
  const gaugeDisplay = snapshot.score == null
    ? null
    : getPressureShiftDisplay(snapshot.score);

  return (
    <article
      className={cn(
        "relative overflow-hidden rounded-2xl border bg-card",
        isCompact ? "p-4 sm:p-5" : "p-4 sm:p-6",
      )}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-55"
        style={{
          background:
            "radial-gradient(1200px 260px at 5% 0%, rgba(34,211,238,0.13), transparent 60%), radial-gradient(780px 240px at 100% 100%, rgba(16,185,129,0.18), transparent 65%)",
        }}
      />

      <div className="relative space-y-5">
        <header className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold",
              snapshot.directionUi.badgeClass,
            )}
          >
            {snapshot.directionUi.label}
          </span>
          <span
            className={cn(
              "inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold",
              snapshot.pressureUi.badgeClass,
            )}
          >
            {snapshot.pressureUi.label}
          </span>
          {gauge?.flightToQuality && (
            <span className="inline-flex rounded-full border border-amber-600/35 bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:border-amber-500/40 dark:text-amber-300">
              FTQ {Math.round(gauge.flightIntensity)}%
            </span>
          )}
        </header>

        <div
          className={cn(
            "grid",
            isCompact
              ? "gap-4 2xl:grid-cols-[minmax(0,1.12fr)_minmax(15rem,0.88fr)]"
              : "gap-5 lg:grid-cols-[1.2fr_1fr]",
          )}
        >
          <div className="flex h-full flex-col gap-4">
            <h3
              className={cn(
                isCompact
                  ? "text-3xl font-black leading-[0.94] tracking-tight md:text-4xl 2xl:text-5xl"
                  : "text-3xl font-black tracking-tight sm:text-5xl",
                snapshot.pressureUi.headlineClass,
              )}
            >
              {snapshot.headline}
            </h3>
            <p
              className={cn(
                "text-sm text-muted-foreground",
                isCompact ? "max-w-[34rem]" : undefined,
              )}
            >
              {snapshot.description}
            </p>

            <div
              className={cn(
                "mt-auto space-y-2 rounded-xl border p-3",
                snapshot.pressureUi.panelClass,
              )}
            >
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <MethodologyLabel topic="bankRunGauge">
                  Bank Run Gauge (pressure vs 30D)
                </MethodologyLabel>
                <span className="font-mono">
                  {gaugeDisplay == null
                    ? "NR"
                    : `${getNetPrefix(gaugeDisplay)}${gaugeDisplay} / 100`}
                </span>
              </div>
              <div className="relative h-3 rounded-full border border-border/60 bg-muted/25">
                <div
                  className="h-full rounded-full"
                  style={{
                    background:
                      "linear-gradient(90deg, #ef4444 0%, #f59e0b 35%, #84cc16 65%, #10b981 100%)",
                  }}
                />
                {snapshot.leverPct !== null && (
                  <div
                    className="absolute top-1/2 h-5 w-5 -translate-y-1/2 rounded-full border-2 border-background bg-foreground shadow-[0_0_0_3px_rgba(15,23,42,0.45)] transition-all"
                    style={{ left: `calc(${snapshot.leverPct}% - 10px)` }}
                    role="img"
                    aria-label={`Bank Run Gauge at ${Math.round(snapshot.leverPct)}%`}
                  />
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                The gauge is a market-cap-weighted pressure-shift signal, not a literal mint-vs-burn direction meter.
              </p>
            </div>
          </div>

          <div className="flex h-full flex-col gap-3">
            <FlowMachineScene
              size={isCompact ? "mini" : "full"}
              mode={snapshot.directionUi.sceneMode}
              intensity={sceneIntensity}
              statusText={snapshot.directionUi.label}
              title={isCompact ? undefined : snapshot.directionUi.sceneTitle}
              subText={isCompact ? undefined : `Tracking ${snapshot.trackedCoins} stablecoins`}
              accentHex={snapshot.directionUi.accentHex}
              stress={sceneStress}
            />
            <MintingPressureGauge
              mintVolume24hUsd={snapshot.mint24h}
              burnVolume24hUsd={snapshot.burn24h}
              className={isCompact ? undefined : "mt-auto"}
            />
          </div>
        </div>

        {!isCompact && (
          <div className="border-t border-dashed border-border/70 pt-5">
            <FlowReceiptBand
              gauge={gauge}
              coins={coins}
              weeklyHourly={weeklyHourly}
              scopeLabel={scopeLabel}
              syncWarning={syncWarning}
            />
          </div>
        )}
      </div>
    </article>
  );
}
```

- [ ] **Step 4: Update the exported `FlowBrrrOverview` to thread new props**

Replace the exported `FlowBrrrOverview` function (currently lines ~387–409) with:

```tsx
export function FlowBrrrOverview({
  gauge,
  coins,
  weeklyHourly,
  isLoading,
  className,
  variant = "default",
  scopeLabel = "Configured issuance chains",
  syncWarning = null,
}: FlowBrrrOverviewProps) {
  const snapshot = useMemo(
    () => buildSnapshot(gauge, coins, weeklyHourly),
    [gauge, coins, weeklyHourly],
  );

  if (isLoading) {
    return <LoadingState />;
  }

  return (
    <div className={cn("h-full space-y-4", className)}>
      <IterationOne
        snapshot={snapshot}
        gauge={gauge}
        variant={variant}
        scopeLabel={scopeLabel}
        syncWarning={syncWarning}
        coins={coins}
        weeklyHourly={weeklyHourly}
      />
    </div>
  );
}
```

- [ ] **Step 5: Remove now-unused imports**

After the layout rewrite, `Flame`, `TrendingDown`, `TrendingUp`, `formatCurrency`, `formatSignedCurrency`, and `getNetColor` are no longer referenced in `flow-brrr-overview.tsx` (they powered the removed tile grids). Remove them from the imports at the top of the file.

Replace:
```tsx
import { Flame, TrendingDown, TrendingUp } from "lucide-react";
```
With: *(delete the line entirely)*

Replace:
```tsx
import {
  formatCurrency,
  formatSignedCurrency,
  getNetColor,
  getNetPrefix,
} from "@shared/lib/format";
```
With:
```tsx
import { getNetPrefix } from "@shared/lib/format";
```

Also delete the now-unused `formatMaybeCurrency` helper function (lines ~67–70):
```tsx
function formatMaybeCurrency(value: number | null): string {
  if (value === null) return "—";
  return formatCurrency(value);
}
```

- [ ] **Step 6: Type-check the file**

Run: `npx tsc --noEmit`
Expected: PASS — no errors in `flow-brrr-overview.tsx`.

- [ ] **Step 7: Run the component test suite**

Run: `npx vitest run src/components/__tests__/flow-receipt-band.test.tsx src/app/flows/page.test.tsx`
Expected: PASS — both files green. The page test mocks `FlowBrrrOverview`, so it should be unaffected.

- [ ] **Step 8: Commit**

```bash
git add src/components/flow-brrr-overview.tsx
git commit -m "refactor: fold FlowReceiptBand into FlowBrrrOverview"
```

---

## Task 3: Update `/flows/client.tsx` call site

**Files:**
- Modify: `src/app/flows/client.tsx:10` (remove import), `src/app/flows/client.tsx:140-161` (remove standalone receipt + caption, pass new props)

- [ ] **Step 1: Remove the `FlowPressureReceipt` import**

In `src/app/flows/client.tsx`, delete this line (currently line 10):

```tsx
import { FlowPressureReceipt } from "@/components/flow-pressure-receipt";
```

- [ ] **Step 2: Update the overview section**

Replace the existing `<section aria-label="Mint/burn overview">` block (currently lines ~140–161):

```tsx
      <section aria-label="Mint/burn overview">
        <FlowBrrrOverview
          gauge={gauge ?? null}
          coins={coins}
          weeklyHourly={weeklyHourly}
          isLoading={isSummaryLoading || (hours !== 168 && isWeeklyLoading)}
        />
        {!isSummaryLoading ? (
          <FlowPressureReceipt
            gauge={gauge ?? null}
            coins={coins}
            weeklyHourly={weeklyHourly}
            scopeLabel={scopeLabel}
            syncWarning={syncWarning}
          />
        ) : null}
        <p className="mt-3 text-xs text-muted-foreground">
          Coverage badges flag coins that are still bootstrapping, lagging, or
          missing enough history for full long-window comparisons. Values marked
          partial reflect only the covered history window.
        </p>
      </section>
```

With:

```tsx
      <section aria-label="Mint/burn overview">
        <FlowBrrrOverview
          gauge={gauge ?? null}
          coins={coins}
          weeklyHourly={weeklyHourly}
          isLoading={isSummaryLoading || (hours !== 168 && isWeeklyLoading)}
          scopeLabel={scopeLabel}
          syncWarning={syncWarning}
        />
      </section>
```

- [ ] **Step 3: Type-check and run tests**

Run: `npx tsc --noEmit && npx vitest run src/app/flows/page.test.tsx`
Expected: PASS — no type errors, page test green.

- [ ] **Step 4: Commit**

```bash
git add src/app/flows/client.tsx
git commit -m "refactor: drop standalone receipt on /flows/ page"
```

---

## Task 4: Delete `FlowPressureReceipt` and its test

**Files:**
- Delete: `src/components/flow-pressure-receipt.tsx`
- Delete: `src/components/__tests__/flow-pressure-receipt.test.tsx`

- [ ] **Step 1: Verify no remaining references**

Run:
```bash
grep -rn "FlowPressureReceipt\|flow-pressure-receipt" src/ 2>/dev/null
```
Expected: no matches. If anything surfaces (besides files marked for deletion), stop and fix before deleting.

- [ ] **Step 2: Delete the files**

Run:
```bash
git rm src/components/flow-pressure-receipt.tsx src/components/__tests__/flow-pressure-receipt.test.tsx
```

- [ ] **Step 3: Type-check and run tests**

Run: `npx tsc --noEmit && npm test -- --run`
Expected: PASS — full suite green, no orphaned imports.

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor: remove FlowPressureReceipt (folded into FlowBrrrOverview)"
```

---

## Task 5: Update component inventory docs

**Files:**
- Modify: `docs/mint-burn-flows.md:656`

- [ ] **Step 1: Update the FlowBrrrOverview description**

In `docs/mint-burn-flows.md`, replace the existing row for `FlowBrrrOverview` (line ~656):

```
| `FlowBrrrOverview` | `src/components/flow-brrr-overview.tsx` | Shared overview shell used by `/flows` and the homepage snapshot; renders the Bank Run Gauge band returned by the API plus the literal 24h minting-pressure gauge, with inline methodology help on the Bank Run Gauge label |
```

With:

```
| `FlowBrrrOverview` | `src/components/flow-brrr-overview.tsx` | Shared overview shell used by `/flows` and the homepage snapshot; renders the printer/shredder scene, Bank Run Gauge band, and literal 24h minting-pressure gauge. On `/flows` it folds in a `FlowReceiptBand` below a dashed tear-line carrying the 24h/7d mint/burn/net receipt tiles plus scope, top minter/burner, and coverage summary. Receipt band is suppressed in the `compact` variant used on the homepage. |
| `FlowReceiptBand` | `src/components/flow-receipt-band.tsx` | Receipt-styled sub-component rendered inside `FlowBrrrOverview` on `/flows`. Shows 24h/7d printed/shredded/net tiles, scope caveat, top minter/burner, coverage pills, and any sync warning. |
```

(This adds a new row for `FlowReceiptBand` directly below the updated `FlowBrrrOverview` row.)

- [ ] **Step 2: Commit**

```bash
git add docs/mint-burn-flows.md
git commit -m "docs: describe folded-in FlowReceiptBand in component inventory"
```

---

## Task 6: Full validation

**Files:** none

- [ ] **Step 1: Lint**

Run: `npm run lint`
Expected: PASS — no new warnings or errors.

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Full test suite**

Run: `npm test -- --run`
Expected: PASS — all suites green.

- [ ] **Step 4: Visually verify `/flows/` and homepage**

Run: `npm run dev` in one terminal, then open http://localhost:3000/flows/ in the browser (via the `playwright` MCP).

Verify:
- One overview card, not two.
- Printer/shredder scene, Bank Run Gauge lever, and Minting Pressure Gauge still render.
- Below a dashed tear line inside the same card: 6 tiles (Printed 24h, Shredded 24h, Net 24h, Printed 7d, Shredded 7d, Net 7d) with receipt styling (gradient stripe, ReceiptText icon, dashed outer border).
- Aside-as-row shows scope caption, top minter, top burner, coverage summary + pills.
- Open http://localhost:3000/ — homepage snapshot still shows the overview card **without** the receipt band (compact variant).

If any visual regression appears, stop and fix before declaring done.

- [ ] **Step 5: Merge-gate check**

Run: `npm run test:merge-gate`
Expected: PASS.

- [ ] **Step 6: Final commit (if any touch-ups)**

Only commit if Step 4 required fixes. Otherwise this step is a no-op.

---

## Self-Review Checklist

- [x] **Spec coverage:** Every section of `2026-04-24-flow-hero-module-design.md` is covered:
  - "Register 1 — Hero" → Task 2 Step 3 (left column reorg + Bank Run Gauge position).
  - "Register 2 — Receipt band" → Task 1 (component), Task 2 Step 3 (tear line + mount).
  - "Component and data changes" → Tasks 1–4.
  - "Styling" → Task 1 (receipt styles) and Task 2 (tear line).
  - "Responsive behaviour" → preserved grid classes in Task 1.
  - "Tests" → Task 1 (new test), Task 4 (delete old test).
  - "Migration notes" → Task 5 (docs update).
  - Homepage variant-gating → Task 2 Step 3 (`!isCompact` guard on FlowReceiptBand render).

- [x] **Placeholder scan:** No TBDs, TODOs, or vague "handle errors" directives — every step shows exact code or exact command with expected output.

- [x] **Type consistency:**
  - `FlowReceiptBandProps` (Task 1) matches the call site in Task 2 Step 3: `gauge`, `coins`, `weeklyHourly`, `scopeLabel`, `syncWarning`.
  - `FlowBrrrOverviewProps` (Task 2 Step 1) adds `scopeLabel?: string` + `syncWarning?: string | null`; used in Task 3 Step 2.
  - `IterationOne` signature (Task 2 Step 3) matches its call in Task 2 Step 4.
  - `buildFlowPressureReceiptModel` inputs unchanged; verified in Task 1 Step 3 against `src/lib/flow-pressure-receipt-model.ts`.

- [x] **Bite-sized steps:** Each step is a single 2–5 minute action with exact code/command/expected output.
