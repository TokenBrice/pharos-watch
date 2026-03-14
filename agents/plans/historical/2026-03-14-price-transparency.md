# Price Transparency Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface per-coin price source provenance on the coverage page and stablecoin detail page using data the pipeline already produces.

**Architecture:** Add a `consensusSources: string[]` field that flows from the price consensus engine through the sync pipeline into API responses. The coverage page enriches the "Price & Depeg" badge with source count. A new `PriceTransparencyCard` on the detail page shows all known sources and their status.

**Tech Stack:** TypeScript, Zod schemas, React, Tailwind CSS, shadcn/ui Card

**Spec:** `agents/specs/2026-03-14-price-transparency-design.md`

---

## File Structure

### Modified files

| File | Responsibility |
|------|---------------|
| `worker/src/cron/enrich-prices.ts` | Add `consensusSources` to `PeggedAsset` (line 34) and `PrimaryPriceResult` (line 114); collect candidate source names in consensus loop (line 412); set single-element `consensusSources` in `applyResolvedPrice()` (line 64) |
| `worker/src/cron/sync-stablecoins/shared.ts` | Extend `stampPriceMetadata()` (line 145) to accept and stamp `consensusSources` |
| `worker/src/cron/sync-stablecoins.ts` | Pass `candidateSources` through all `stampPriceMetadata()` call sites; protocol-redeem override sets `["protocol-redeem"]` |
| `shared/types/market.ts` | Add `consensusSources` to `StablecoinDataRawSchema` (line 21), `StablecoinDataSchema` transform (line 42), and `PegSummaryCoinSchema` (line 296) |
| `worker/src/api/peg-summary.ts` | Include `consensusSources` in response (line 202) |
| `src/lib/coverage.ts` | Add `sourceCount` to `CoverageStatus` (line 34); extend `BuildCoverageRowInput` (line 82) and `resolvePriceCoverage()` (line 199) |
| `src/hooks/use-coverage-matrix-model.ts` | Look up peg-summary `consensusSources` per coin, pass to `buildCoverageRow()` |
| `src/app/coverage/client.tsx` | Show source count in `CoverageBadge`; add source-depth sub-breakdown |
| `src/app/stablecoin/[id]/client.tsx` | Add `PriceTransparencyCard` to layout + `DETAIL_SECTIONS` |
| `src/lib/stablecoin-detail-view-model.ts` | Add `consensusSources` and `dexPriceCheck` to view model |

### New files

| File | Responsibility |
|------|---------------|
| `src/components/stablecoin-detail/price-transparency-card.tsx` | Standalone card showing price source provenance |

### Test files

| File | What's tested |
|------|--------------|
| `worker/src/cron/__tests__/enrich-prices.test.ts` | `PrimaryPriceResult` includes `candidateSources`; `applyResolvedPrice` sets `consensusSources` |
| `worker/src/cron/__tests__/sync-stablecoins.test.ts` | `stampPriceMetadata` passes `consensusSources` through |
| `src/lib/__tests__/coverage.test.ts` | `resolvePriceCoverage()` sets `sourceCount`; `buildCoverageRow()` plumbs it |

---

## Chunk 1: Pipeline — Persist `consensusSources`

### Task 1: Add `consensusSources` to `PeggedAsset` and `PrimaryPriceResult`

**Files:**
- Modify: `worker/src/cron/enrich-prices.ts:34-58` (PeggedAsset), `:114-120` (PrimaryPriceResult)

- [ ] **Step 1: Add `consensusSources` to `PeggedAsset` interface**

In `worker/src/cron/enrich-prices.ts`, add to the `PeggedAsset` interface (after line 57, before the closing `}`):

```typescript
  consensusSources?: string[];
```

- [ ] **Step 2: Add `candidateSources` to `PrimaryPriceResult` interface**

In the same file, add to `PrimaryPriceResult` (after line 119, before the closing `}`):

```typescript
  candidateSources: string[];
```

- [ ] **Step 3: Populate `candidateSources` in the consensus loop**

In the same file, in the consensus loop where `results.set(asset.id, ...)` is called (lines 412-418), add `candidateSources`:

```typescript
    results.set(asset.id, {
      price: consensus.price,
      source: consensus.source,
      confidence: consensus.confidence,
      dlPrice: dl ?? null,
      cgPrice: cg ?? null,
      candidateSources: sources.map((s) => s.source),
    });
```

The `sources` array (built at lines 370-397) already contains only sources that returned a valid price for this asset. `sources.map(s => s.source)` gives us exactly the candidate source names.

- [ ] **Step 4: Type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: PASS (no errors related to `candidateSources` — it's consumed in Task 2)

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/enrich-prices.ts
git commit -m "feat(pipeline): add consensusSources to PeggedAsset and candidateSources to PrimaryPriceResult"
```

---

### Task 2: Extend `applyResolvedPrice()` to set `consensusSources`

**Files:**
- Modify: `worker/src/cron/enrich-prices.ts:64-75`
- Test: `worker/src/cron/__tests__/enrich-prices.test.ts`

- [ ] **Step 1: Export `applyResolvedPrice` and add `consensusSources` parameter**

In `worker/src/cron/enrich-prices.ts`, change `applyResolvedPrice` (lines 64-75):

```typescript
export function applyResolvedPrice(
  asset: PeggedAsset,
  price: number,
  source: string,
  confidence: PriceConfidence,
  updatedAtSec = Math.floor(Date.now() / 1000),
): void {
  asset.price = price;
  asset.priceSource = source;
  asset.priceConfidence = confidence;
  asset.priceUpdatedAt = updatedAtSec;
  asset.consensusSources = [source];
}
```

The enrichment pass is a fallback — only one source resolves the price, so `consensusSources` is always a single-element array containing the source name.

- [ ] **Step 2: Write the test**

Add to `worker/src/cron/__tests__/enrich-prices.test.ts`:

```typescript
import { applyResolvedPrice } from "../enrich-prices";

describe("applyResolvedPrice", () => {
  it("sets consensusSources to single-element array with source name", () => {
    const asset: PeggedAsset = {
      id: "test",
      name: "Test",
      symbol: "TEST",
      price: 0,
      priceSource: "",
      circulating: {},
      chains: [],
    };

    applyResolvedPrice(asset, 0.9998, "cmc", "fallback", 1000);

    expect(asset.price).toBe(0.9998);
    expect(asset.priceSource).toBe("cmc");
    expect(asset.priceConfidence).toBe("fallback");
    expect(asset.priceUpdatedAt).toBe(1000);
    expect(asset.consensusSources).toEqual(["cmc"]);
  });
});
```

- [ ] **Step 3: Run test to verify it passes**

Run: `npx vitest run worker/src/cron/__tests__/enrich-prices.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add worker/src/cron/enrich-prices.ts worker/src/cron/__tests__/enrich-prices.test.ts
git commit -m "feat(pipeline): applyResolvedPrice sets consensusSources"
```

---

### Task 3: Extend `stampPriceMetadata()` to accept and stamp `consensusSources`

**Files:**
- Modify: `worker/src/cron/sync-stablecoins/shared.ts:145-154`
- Test: `worker/src/cron/__tests__/sync-stablecoins.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `worker/src/cron/__tests__/sync-stablecoins.test.ts` (or create a new describe block):

```typescript
import { stampPriceMetadata } from "../sync-stablecoins/shared";
import type { PeggedAsset } from "../enrich-prices";

describe("stampPriceMetadata", () => {
  it("stamps consensusSources when provided", () => {
    const asset = { id: "test", name: "Test", symbol: "T", circulating: {}, chains: [] } as PeggedAsset;

    stampPriceMetadata(asset, "coingecko+defillama", "high", 1234, ["coingecko", "defillama"]);

    expect(asset.priceSource).toBe("coingecko+defillama");
    expect(asset.priceConfidence).toBe("high");
    expect(asset.priceUpdatedAt).toBe(1234);
    expect(asset.consensusSources).toEqual(["coingecko", "defillama"]);
  });

  it("leaves consensusSources unchanged when not provided", () => {
    const asset = {
      id: "test", name: "Test", symbol: "T", circulating: {}, chains: [],
      consensusSources: ["existing"],
    } as PeggedAsset;

    stampPriceMetadata(asset, "cached", "fallback", 5678);

    expect(asset.consensusSources).toEqual(["existing"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run worker/src/cron/__tests__/sync-stablecoins.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — `stampPriceMetadata` doesn't accept 5th parameter

- [ ] **Step 3: Implement — extend `stampPriceMetadata`**

In `worker/src/cron/sync-stablecoins/shared.ts` (line 145), change:

```typescript
export function stampPriceMetadata(
  asset: PeggedAsset,
  source: string,
  confidence: PeggedAsset["priceConfidence"],
  updatedAt: number | null,
  consensusSources?: string[],
): void {
  asset.priceSource = source;
  asset.priceConfidence = confidence ?? null;
  asset.priceUpdatedAt = updatedAt;
  if (consensusSources !== undefined) {
    asset.consensusSources = consensusSources;
  }
}
```

The parameter is optional — existing call sites that don't pass it won't break, and the field stays unchanged (preserving any value set earlier by the consensus loop or `applyResolvedPrice`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run worker/src/cron/__tests__/sync-stablecoins.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/sync-stablecoins/shared.ts worker/src/cron/__tests__/sync-stablecoins.test.ts
git commit -m "feat(pipeline): stampPriceMetadata accepts consensusSources"
```

---

### Task 4: Wire `candidateSources` through `sync-stablecoins.ts`

**Files:**
- Modify: `worker/src/cron/sync-stablecoins.ts:558-596`

- [ ] **Step 1: Pass `candidateSources` when applying primary price results**

In `worker/src/cron/sync-stablecoins.ts`, in the primary price application loop (around line 568-577), update all `stampPriceMetadata` calls:

At line 570 (primary accepted):
```typescript
        stampPriceMetadata(asset, primary.source, primary.confidence, syncStartSec, primary.candidateSources);
```

At line 572 (primary rejected, DL fallback):
```typescript
        stampPriceMetadata(asset, asset.priceSource || "defillama", "single-source", syncStartSec, [asset.priceSource || "defillama"]);
```

At line 576 (no primary result, DL-only):
```typescript
      stampPriceMetadata(asset, asset.priceSource || "defillama", "single-source", syncStartSec, [asset.priceSource || "defillama"]);
```

- [ ] **Step 2: Set `consensusSources: ["protocol-redeem"]` for protocol overrides**

At line 594-595, after `stampPriceMetadata`:
```typescript
    asset.price = override.price;
    stampPriceMetadata(asset, override.source, override.confidence, syncStartSec, [override.source]);
```

This replaces the primary consensus sources with the single authoritative source, as specified in the design.

- [ ] **Step 3: Handle the fallback sync path too**

The file has TWO sync paths (fallback and main). Check the fallback path (around lines 190-296) for the same pattern. Update those `stampPriceMetadata` calls similarly:

Line 208 (authoritative override in fallback):
```typescript
    stampPriceMetadata(asset, override.source, override.confidence, syncStartSec, [override.source]);
```

Line 229 (pre-rejected fallback):
```typescript
      stampPriceMetadata(asset, asset.priceSource || "unknown", null, null);
```
This one is clearing a bad price — leave `consensusSources` unchanged (don't pass it).

Line 242 (enriched fallback tag):
```typescript
      stampPriceMetadata(asset, asset.priceSource || "unknown", "fallback", syncStartSec);
```
Already set by `applyResolvedPrice` during enrichment — don't override.

Line 293 (cached fallback):
```typescript
          stampPriceMetadata(asset, "cached", "fallback", cached.updatedAt);
```
Cached prices preserve whatever `consensusSources` the cached asset had. Don't override.

Similarly in the main path:
- Line 624 (pre-rejected): don't pass `consensusSources`
- Line 640 (enriched tag): don't pass — already set by `applyResolvedPrice`
- Line 701 (cached fallback): don't pass — preserve existing

- [ ] **Step 4: Type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/sync-stablecoins.ts
git commit -m "feat(pipeline): wire candidateSources through sync pipeline"
```

---

### Task 5: Add `consensusSources` to Zod schemas

**Files:**
- Modify: `shared/types/market.ts:21-60` (StablecoinDataRawSchema, transform), `:296-328` (PegSummaryCoinSchema)

- [ ] **Step 1: Add to `StablecoinDataRawSchema`**

In `shared/types/market.ts`, add after `priceUpdatedAt` (line 32), before `supplySource`:

```typescript
  consensusSources: z.array(z.string()).optional(),
```

- [ ] **Step 2: Add to `StablecoinDataSchema` transform**

In the `.transform()` block (line 42-60), add after `priceUpdatedAt` mapping (line 52):

```typescript
  consensusSources: asset.consensusSources ?? [],
```

- [ ] **Step 3: Add to `PegSummaryCoinSchema`**

In `PegSummaryCoinSchema` (lines 296-328), add after `priceUpdatedAt` (line 307):

```typescript
  consensusSources: z.array(z.string()).optional(),
```

- [ ] **Step 4: Type-check both frontend and worker**

Run: `npm run build && cd worker && npx tsc --noEmit`
Expected: PASS — the field is `.optional()` so existing payloads without it still validate.

- [ ] **Step 5: Commit**

```bash
git add shared/types/market.ts
git commit -m "feat(types): add consensusSources to StablecoinData and PegSummaryCoin schemas"
```

---

### Task 6: Include `consensusSources` in peg-summary API response

**Files:**
- Modify: `worker/src/api/peg-summary.ts:202-225`

- [ ] **Step 1: Add `consensusSources` to coin response object**

In `worker/src/api/peg-summary.ts`, in the `coins.push({...})` block (line 202), add after `priceUpdatedAt` (line 213):

```typescript
      consensusSources: asset?.consensusSources,
```

Also add the field to the inline type annotation for the coin object (around line 130-136):

```typescript
      consensusSources?: string[];
```

- [ ] **Step 2: Type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add worker/src/api/peg-summary.ts
git commit -m "feat(api): include consensusSources in peg-summary response"
```

---

## Chunk 2: Coverage Page — Enriched "Price & Depeg" Column

### Task 7: Add `sourceCount` to `CoverageStatus` and extend `resolvePriceCoverage()`

**Files:**
- Modify: `src/lib/coverage.ts:34-42` (CoverageStatus), `:82-92` (BuildCoverageRowInput), `:179-197` (createStatus), `:199-233` (resolvePriceCoverage), `:605-650` (buildCoverageRow)
- Test: `src/lib/__tests__/coverage.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/__tests__/coverage.test.ts`:

```typescript
  it("sets sourceCount and sourceNames on tracked price coverage when consensusSources provided", () => {
    const status = resolvePriceCoverage(makeCoin(), true, ["coingecko", "defillama", "pyth"], "high");

    expect(status.kind).toBe("tracked");
    expect(status.sourceCount).toBe(3);
    expect(status.sourceNames).toEqual(["coingecko", "defillama", "pyth"]);
    expect(status.priceConfidence).toBe("high");
  });

  it("sets sourceCount on tracked price coverage with empty sources", () => {
    const status = resolvePriceCoverage(makeCoin(), true, [], "single-source");

    expect(status.kind).toBe("tracked");
    expect(status.sourceCount).toBe(0);
    expect(status.sourceNames).toEqual([]);
    expect(status.priceConfidence).toBe("single-source");
  });

  it("does not set sourceCount when consensusSources omitted (backward compat)", () => {
    const status = resolvePriceCoverage(makeCoin(), true);

    expect(status.kind).toBe("tracked");
    expect(status.sourceCount).toBeUndefined();
    expect(status.sourceNames).toBeUndefined();
    expect(status.priceConfidence).toBeUndefined();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/__tests__/coverage.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — `resolvePriceCoverage` doesn't accept 3rd parameter; `sourceCount` doesn't exist

- [ ] **Step 3: Add `sourceCount` to `CoverageStatus`**

In `src/lib/coverage.ts`, extend the interface (line 34):

```typescript
export interface CoverageStatus {
  kind: string;
  label: string;
  spokenLabel: string;
  tone: CoverageTone;
  available: boolean;
  sortRank: number;
  detail: string;
  sourceCount?: number;
  sourceNames?: string[];
  priceConfidence?: string;
}
```

- [ ] **Step 4: Add new fields to `BuildCoverageRowInput`**

In `src/lib/coverage.ts` (line 82), add after `hasPegCoverage`:

```typescript
  consensusSources?: string[];
  priceConfidence?: string;
```

- [ ] **Step 5: Extend `resolvePriceCoverage()` signature**

Change `resolvePriceCoverage` (line 199):

```typescript
export function resolvePriceCoverage(
  coin: StablecoinMeta,
  hasPegCoverage: boolean,
  consensusSources?: string[],
  priceConfidence?: string,
): CoverageStatus {
  if (coin.flags.navToken) {
    return createStatus(
      "price-only",
      "Price only",
      "sky",
      true,
      2,
      "NAV-priced token. Price tracking is available, but peg/depeg logic is not applicable.",
    );
  }

  if (hasPegCoverage) {
    const status = createStatus(
      "tracked",
      "Tracked",
      "emerald",
      true,
      3,
      "Live peg monitoring, peg score coverage, and depeg-event history are available.",
    );
    if (consensusSources !== undefined) {
      status.sourceCount = consensusSources.length;
      status.sourceNames = consensusSources;
    }
    if (priceConfidence !== undefined) {
      status.priceConfidence = priceConfidence;
    }
    return status;
  }

  return createStatus(
    "missing",
    "Missing",
    "rose",
    false,
    0,
    "No peg-summary row is currently available for this asset.",
  );
}
```

- [ ] **Step 6: Pass new fields in `buildCoverageRow()`**

In `buildCoverageRow` (line 605), destructure the new fields:

```typescript
export function buildCoverageRow({
  coin,
  marketCapUsd,
  hasPegCoverage,
  consensusSources,
  priceConfidence,
  safetyScore,
  ...rest
}: BuildCoverageRowInput): CoverageRow {
  const statuses = {
    price: resolvePriceCoverage(coin, hasPegCoverage, consensusSources, priceConfidence),
    ...
```

(Keep everything else the same — just add the two new fields to the destructuring and pass them through.)

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/coverage.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/lib/coverage.ts src/lib/__tests__/coverage.test.ts
git commit -m "feat(coverage): resolvePriceCoverage sets sourceCount from consensusSources"
```

---

### Task 8: Plumb `consensusSources` through `use-coverage-matrix-model.ts`

**Files:**
- Modify: `src/hooks/use-coverage-matrix-model.ts:30-63`

- [ ] **Step 1: Build a peg-summary lookup map**

In `useCoverageMatrixModel()`, inside the `useMemo` block (line 30), after `pegIds` (line 34), add:

```typescript
    const pegCoinById = new Map(
      (pegQuery.data?.coins ?? []).map((coin) => [coin.id, coin]),
    );
```

- [ ] **Step 2: Pass `consensusSources` to `buildCoverageRow()`**

In the `buildCoverageRow` call (line 50-62), add the new fields:

```typescript
    return TRACKED_STABLECOINS.map((coin) => {
      const pegCoin = pegCoinById.get(coin.id);
      return buildCoverageRow({
        coin,
        marketCapUsd: assetById.has(coin.id)
          ? getCirculatingRaw(assetById.get(coin.id)!)
          : 0,
        hasPegCoverage: pegIds.has(coin.id),
        consensusSources: pegCoin?.consensusSources,
        priceConfidence: pegCoin?.priceConfidence ?? undefined,
        safetyScore: reportCardById.get(coin.id)?.overallScore ?? null,
        dexCoverageClass: dexQuery.data?.[coin.id]?.coverageClass ?? null,
        hasYieldCoverage: yieldIds.has(coin.id),
        flowCoverageStatus: flowById.get(coin.id)?.coverage?.status ?? null,
        bluechipGrade: bluechipQuery.data?.[coin.id]?.grade ?? null,
        hasDependencyCoverage: dependencyIds.has(coin.id),
      });
    });
```

- [ ] **Step 3: Type-check**

Run: `npm run build 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/hooks/use-coverage-matrix-model.ts
git commit -m "feat(coverage): plumb consensusSources from peg-summary into coverage rows"
```

---

### Task 9: Update `CoverageBadge` to show source count

**Files:**
- Modify: `src/app/coverage/client.tsx:46-66` (CoverageBadge), feature snapshot area

- [ ] **Step 1: Show source count in badge label**

In `src/app/coverage/client.tsx`, modify `CoverageBadge` (line 46):

```typescript
const SOURCE_DISPLAY_NAMES: Record<string, string> = {
  coingecko: "CoinGecko",
  defillama: "DefiLlama",
  pyth: "Pyth Network",
  binance: "Binance",
  coinbase: "Coinbase",
  redstone: "RedStone",
  "curve-onchain": "Curve on-chain",
  "dex-promoted": "DEX prices",
};

function buildSourceTooltip(status: CoverageStatus): string {
  if (!status.sourceNames?.length) return status.detail;

  const confidenceLabel = status.priceConfidence
    ? `${status.priceConfidence.charAt(0).toUpperCase()}${status.priceConfidence.slice(1).replace("-", " ")} confidence`
    : "";
  const sourceList = status.sourceNames
    .map((s) => SOURCE_DISPLAY_NAMES[s] ?? s)
    .join(", ");

  return confidenceLabel
    ? `${confidenceLabel} — ${sourceList}`
    : sourceList;
}

function CoverageBadge({
  status,
  compact = false,
}: {
  status: CoverageStatus;
  compact?: boolean;
}) {
  const countSuffix =
    status.sourceCount != null && status.sourceCount > 0
      ? compact
        ? ` (${status.sourceCount})`
        : ` (${status.sourceCount} sources)`
      : "";

  return (
    <span
      title={buildSourceTooltip(status)}
      className={cn(
        "inline-flex items-center justify-center rounded-full border px-2.5 py-1 text-[11px] font-medium tracking-[0.01em]",
        compact ? "min-w-[4.25rem]" : "min-w-[4.75rem]",
        COVERAGE_BADGE_TONE_CLASS[status.tone],
      )}
    >
      <span aria-hidden="true">
        {status.label}
        {countSuffix}
      </span>
      <span className="sr-only">
        {status.spokenLabel}
        {countSuffix}
      </span>
    </span>
  );
}
```

The tooltip now shows confidence level and source names (e.g., "High confidence — CoinGecko, DefiLlama, Pyth Network, Binance, Coinbase"). For badges without source data, the existing `status.detail` text is used as a fallback.

- [ ] **Step 2: Add source-depth sub-breakdown for Price feature snapshot**

In the `CoverageFeatureSnapshotRow` component (or wherever the Price feature breakdown renders), find where `breakdownItems` are rendered. After the existing breakdown items for the "price" feature, add a secondary line.

In `src/lib/coverage.ts`, update `buildCoverageBreakdown` (line 531) to add source-depth info:

```typescript
function buildCoverageBreakdown(
  featureKey: CoverageFeatureKey,
  breakdownMap: Map<string, number>,
  availableCount: number,
  totalCount: number,
  rows?: CoverageRow[],
) {
  if (featureKey === "price") {
    const base = `tracked ${breakdownMap.get("tracked") ?? 0} · price-only ${breakdownMap.get("price-only") ?? 0}`;
    if (!rows) return base;

    // Source-depth distribution
    let deep = 0;   // 5+ sources
    let mid = 0;    // 3-4 sources
    let shallow = 0; // 1-2 sources
    for (const row of rows) {
      const count = row.statuses.price.sourceCount;
      if (count == null) continue;
      if (count >= 5) deep++;
      else if (count >= 3) mid++;
      else shallow++;
    }
    if (deep + mid + shallow > 0) {
      return `${base} · 5+ sources: ${deep} · 3-4: ${mid} · 1-2: ${shallow}`;
    }
    return base;
  }
  // ... rest unchanged
```

Update `buildCoverageFeatureSummary` to pass `rows`:

In `buildCoverageFeatureSummary` (line 585), pass `rows` as the 5th argument:

```typescript
    breakdown: buildCoverageBreakdown(
      feature.key,
      breakdownMap,
      availableRows.length,
      rows.length,
      rows,
    ),
```

- [ ] **Step 3: Update the coverage test for breakdown**

Update the existing test in `src/lib/__tests__/coverage.test.ts` that checks `summary.breakdown` (line 162). Since none of the test coins have `consensusSources`, the source-depth suffix won't appear, so the existing assertion should still pass.

Add a new test:

```typescript
  it("includes source-depth breakdown when consensusSources are present", () => {
    const rows = [
      buildCoverageRow({
        coin: makeCoin({ id: "deep", symbol: "DEEP" }),
        marketCapUsd: 500,
        hasPegCoverage: true,
        consensusSources: ["coingecko", "defillama", "pyth", "binance", "coinbase"],
        safetyScore: null,
        dexCoverageClass: null,
        hasYieldCoverage: false,
        flowCoverageStatus: null,
        bluechipGrade: null,
        hasDependencyCoverage: false,
      }),
      buildCoverageRow({
        coin: makeCoin({ id: "shallow", symbol: "SHAL" }),
        marketCapUsd: 500,
        hasPegCoverage: true,
        consensusSources: ["coingecko"],
        safetyScore: null,
        dexCoverageClass: null,
        hasYieldCoverage: false,
        flowCoverageStatus: null,
        bluechipGrade: null,
        hasDependencyCoverage: false,
      }),
    ];

    const summary = buildCoverageFeatureSummary(
      COVERAGE_FEATURES.find((f) => f.key === "price")!,
      rows,
      1_000,
    );

    expect(summary.breakdown).toContain("tracked 2");
    expect(summary.breakdown).toContain("5+ sources: 1");
    expect(summary.breakdown).toContain("1-2: 1");
  });
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/__tests__/coverage.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 5: Build check**

Run: `npm run build 2>&1 | tail -10`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/app/coverage/client.tsx src/lib/coverage.ts src/lib/__tests__/coverage.test.ts
git commit -m "feat(coverage): show source count in badge and source-depth breakdown"
```

---

## Chunk 3: Detail Page — `PriceTransparencyCard`

### Task 10: Add `consensusSources` and `dexPriceCheck` to the detail view model

**Files:**
- Modify: `src/lib/stablecoin-detail-view-model.ts:57-93` (ReadyViewModel), `:200-276` (builder)

- [ ] **Step 1: Add fields to `StablecoinDetailReadyViewModel`**

In `src/lib/stablecoin-detail-view-model.ts`, add to the `StablecoinDetailReadyViewModel` interface (after `pegScoreResult` on line 75):

```typescript
  consensusSources: string[];
  dexPriceCheck: PegSummaryCoin["dexPriceCheck"];
```

- [ ] **Step 2: Populate in the builder function**

In `buildStablecoinDetailViewModel` (line 200-201), `pegScoreResult` is already resolved. After that line, add:

```typescript
  const consensusSources = pegScoreResult?.consensusSources ?? [];
  const dexPriceCheck = pegScoreResult?.dexPriceCheck ?? null;
```

Then in the return object (line 213), add after `pegScoreResult`:

```typescript
    consensusSources,
    dexPriceCheck,
```

- [ ] **Step 3: Type-check**

Run: `npm run build 2>&1 | tail -10`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/lib/stablecoin-detail-view-model.ts
git commit -m "feat(detail): add consensusSources and dexPriceCheck to view model"
```

---

### Task 11: Create `PriceTransparencyCard` component

**Files:**
- Create: `src/components/stablecoin-detail/price-transparency-card.tsx`

- [ ] **Step 1: Create the component**

Create `src/components/stablecoin-detail/price-transparency-card.tsx`:

```typescript
"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DETAIL_SECTION_TITLE_CLASS } from "@/components/stablecoin-detail/section-title";
import type { PegSummaryCoin, StablecoinData } from "@shared/types";
import { cn } from "@/lib/utils";

/** Canonical known sources in display order */
const KNOWN_SOURCES = [
  { key: "coingecko", label: "CoinGecko" },
  { key: "defillama", label: "DefiLlama" },
  { key: "pyth", label: "Pyth Network" },
  { key: "binance", label: "Binance" },
  { key: "coinbase", label: "Coinbase" },
  { key: "redstone", label: "RedStone" },
  { key: "curve-onchain", label: "Curve on-chain" },
  { key: "dex-promoted", label: "DEX prices" },
] as const;

type SourceStatus = "used" | "available" | "no-data" | "not-applicable";

function resolveSourceStatus(
  sourceKey: string,
  priceSource: string | undefined,
  consensusSources: string[],
  isProtocolRedeem: boolean,
): SourceStatus {
  if (isProtocolRedeem) return "not-applicable";
  // The priceSource field can be a composite like "coingecko+defillama"
  const winners = (priceSource ?? "").split("+").map((s) => s.trim().toLowerCase());
  if (winners.includes(sourceKey)) return "used";
  if (consensusSources.includes(sourceKey)) return "available";
  return "no-data";
}

const STATUS_CONFIG: Record<SourceStatus, { dot: string; label: string }> = {
  used: { dot: "bg-emerald-500", label: "Used" },
  available: { dot: "bg-sky-400", label: "Available" },
  "no-data": { dot: "bg-muted-foreground/30", label: "No data" },
  "not-applicable": { dot: "bg-muted-foreground/30", label: "Not applicable" },
};

const CONFIDENCE_COLORS: Record<string, string> = {
  high: "text-emerald-600 dark:text-emerald-400",
  "single-source": "text-amber-600 dark:text-amber-400",
  low: "text-rose-600 dark:text-rose-400",
  fallback: "text-muted-foreground",
};

function formatPriceSource(source: string): string {
  // "coingecko+defillama" → "CoinGecko + DefiLlama"
  const labelMap: Record<string, string> = Object.fromEntries(
    KNOWN_SOURCES.map((s) => [s.key, s.label]),
  );
  // Handle composite source labels like "coingecko+defillama" or "coingecko+2more"
  return source
    .split("+")
    .map((s) => labelMap[s.trim()] ?? s.trim())
    .join(" + ");
}

function formatTimeAgo(updatedAtSec: number | null | undefined): string {
  if (updatedAtSec == null) return "—";
  const diffSec = Math.floor(Date.now() / 1000) - updatedAtSec;
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

interface PriceTransparencyCardProps {
  coinData: StablecoinData;
  consensusSources: string[];
  dexPriceCheck: PegSummaryCoin["dexPriceCheck"];
}

export function PriceTransparencyCard({
  coinData,
  consensusSources,
  dexPriceCheck,
}: PriceTransparencyCardProps) {
  if (coinData.price == null) return null;

  const isProtocolRedeem = coinData.priceSource === "protocol-redeem";

  return (
    <Card className="rounded-xl border-l-[3px] border-l-sky-500">
      <CardHeader className="pb-2">
        <CardTitle as="h2" className={DETAIL_SECTION_TITLE_CLASS}>
          Price Transparency
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Price summary */}
        <div className="space-y-1 text-sm">
          <div className="flex items-baseline gap-2">
            <span className="text-muted-foreground">Current price:</span>
            <span className="font-semibold tabular-nums">${coinData.price.toFixed(4)}</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-muted-foreground">Source:</span>
            <span className="font-medium">
              {isProtocolRedeem ? "Protocol Redemption" : formatPriceSource(coinData.priceSource)}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-baseline gap-2">
              <span className="text-muted-foreground">Confidence:</span>
              <span
                className={cn(
                  "text-xs font-semibold uppercase tracking-wider",
                  CONFIDENCE_COLORS[coinData.priceConfidence ?? ""] ?? "text-muted-foreground",
                )}
              >
                {coinData.priceConfidence ?? "—"}
              </span>
            </div>
            <div className="text-xs text-muted-foreground">
              Updated: {formatTimeAgo(coinData.priceUpdatedAt)}
            </div>
          </div>
        </div>

        {/* Source table */}
        <div className="rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">
                  Source
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {isProtocolRedeem ? (
                <tr className="border-b last:border-b-0">
                  <td className="px-3 py-2 font-medium">Protocol Redemption</td>
                  <td className="px-3 py-2">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
                      <span className="text-xs text-muted-foreground">Used</span>
                    </span>
                  </td>
                </tr>
              ) : null}
              {KNOWN_SOURCES.map(({ key, label }) => {
                const status = resolveSourceStatus(
                  key,
                  coinData.priceSource,
                  consensusSources,
                  isProtocolRedeem,
                );
                const config = STATUS_CONFIG[status];
                return (
                  <tr key={key} className="border-b last:border-b-0">
                    <td className="px-3 py-2 font-medium">{label}</td>
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-1.5">
                        <span
                          className={cn("inline-block h-2 w-2 rounded-full", config.dot)}
                        />
                        <span className="text-xs text-muted-foreground">{config.label}</span>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* DEX Price Check */}
        {dexPriceCheck ? (
          <div className="space-y-1">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              DEX Price Check
            </div>
            <div className="text-sm">
              <span className="tabular-nums font-medium">
                DEX price: ${dexPriceCheck.dexPrice.toFixed(4)}
              </span>
              {" · "}
              <span
                className={cn(
                  "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold",
                  dexPriceCheck.agrees
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                    : "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-400",
                )}
              >
                {dexPriceCheck.agrees ? "Agrees" : "Disagrees"}
              </span>
              {" · "}
              <span className="text-muted-foreground">
                {dexPriceCheck.sourcePools} pool{dexPriceCheck.sourcePools === 1 ? "" : "s"}
                {" · "}${(dexPriceCheck.sourceTvl / 1e6).toFixed(1)}M TVL
                {" · "}{Math.abs(dexPriceCheck.dexDeviationBps).toFixed(1)} bps deviation
              </span>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: Build check**

Run: `npm run build 2>&1 | tail -10`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/components/stablecoin-detail/price-transparency-card.tsx
git commit -m "feat(detail): create PriceTransparencyCard component"
```

---

### Task 12: Add `PriceTransparencyCard` to the detail page

**Files:**
- Modify: `src/app/stablecoin/[id]/client.tsx:64-73` (DETAIL_SECTIONS), `:42-46` (imports), `:196-199` (layout)

- [ ] **Step 1: Add dynamic import**

In `src/app/stablecoin/[id]/client.tsx`, after the `KeyInfoCard` dynamic import (line 42), add:

```typescript
const PriceTransparencyCard = dynamic(
  () => import("@/components/stablecoin-detail/price-transparency-card").then((mod) => mod.PriceTransparencyCard),
  { ssr: false },
);
```

- [ ] **Step 2: Add `DETAIL_SECTIONS` entry**

In `DETAIL_SECTIONS` (line 64), add after `{ id: "info", label: "Info" }` (line 68):

```typescript
  { id: "price-transparency", label: "Price Sources" },
```

- [ ] **Step 3: Add the card to the layout**

After the `KeyInfoCard` section (line 196-197), before `YieldDetailSection` (line 199), add:

```typescript
      {viewModel.coinData.price != null ? (
        <section id="price-transparency">
          <PriceTransparencyCard
            coinData={viewModel.coinData}
            consensusSources={viewModel.consensusSources}
            dexPriceCheck={viewModel.dexPriceCheck}
          />
        </section>
      ) : null}
```

- [ ] **Step 4: Build check**

Run: `npm run build 2>&1 | tail -10`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/stablecoin/[id]/client.tsx
git commit -m "feat(detail): add PriceTransparencyCard to stablecoin detail page"
```

---

### Task 13: Update documentation

**Files:**
- Modify: `docs/stablecoin-detail-page.md`, `docs/coverage-page.md`, `docs/data-pipeline.md`, `docs/api-reference.md`, `docs/data-flow-map.md`

- [ ] **Step 1: Update `docs/stablecoin-detail-page.md`**

Add a new section for the Price Transparency Card in the section composition list, placed after Key Information:

```markdown
### Price Transparency Card
- **Component:** `PriceTransparencyCard` (`src/components/stablecoin-detail/price-transparency-card.tsx`)
- **Data:** `coinData.price`, `coinData.priceSource`, `coinData.priceConfidence`, `coinData.priceUpdatedAt` from stablecoins API; `consensusSources` and `dexPriceCheck` from peg-summary API
- **Scrollspy ID:** `price-transparency` (label: "Price Sources")
- **Hidden when:** `coinData.price == null`
- Shows current price, source label, confidence badge, update recency, and a table of all known price sources with their status (Used/Available/No data). When protocol-redeem overrides are active, all market sources show "Not applicable". DEX Price Check section renders when `dexPriceCheck` data exists.
```

- [ ] **Step 2: Update `docs/coverage-page.md`**

Add a note about the enriched "Price & Depeg" column:

```markdown
#### Source count enrichment
When `consensusSources` data is available from the peg-summary API, the "Tracked" badge shows a source count suffix: "Tracked (5 sources)" (or "Tracked (5)" in compact mode). Tooltip expands to mention the source count. The feature snapshot breakdown adds a secondary source-depth distribution line: `5+ sources: N · 3-4: N · 1-2: N`.
```

- [ ] **Step 3: Update `docs/data-pipeline.md`**

Add a note about `consensusSources` in the price enrichment section:

```markdown
#### Consensus source provenance
After N-source consensus, each asset receives a `consensusSources: string[]` field listing all source names that returned a valid price for that coin during the sync cycle. For enrichment-pass fallbacks, this is a single-element array. Protocol-redeem overrides replace it with `["protocol-redeem"]`.
```

- [ ] **Step 4: Update `docs/api-reference.md`**

Add `consensusSources` to both the `/api/stablecoins` and `/api/peg-summary` response schemas:

```markdown
| `consensusSources` | `string[]` | Optional. Source names that returned a valid price for this coin. Empty array when absent. |
```

- [ ] **Step 5: Update `docs/data-flow-map.md`**

In the stablecoins flow section, note that `consensusSources` is now part of the data flowing from cron → cache → API → frontend.

- [ ] **Step 6: Commit**

```bash
git add docs/stablecoin-detail-page.md docs/coverage-page.md docs/data-pipeline.md docs/api-reference.md docs/data-flow-map.md
git commit -m "docs: add consensusSources and PriceTransparencyCard documentation"
```

---

### Task 14: Final integration verification

- [ ] **Step 1: Run all tests**

Run: `npm test 2>&1 | tail -30`
Expected: All tests PASS

- [ ] **Step 2: Full build + type-check**

Run: `npm run build && cd worker && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Lint**

Run: `npm run lint 2>&1 | tail -20`
Expected: PASS (or only pre-existing warnings)

- [ ] **Step 4: Final commit (if any fixups needed)**

```bash
git add -A
git commit -m "chore: integration fixups for price transparency"
```
