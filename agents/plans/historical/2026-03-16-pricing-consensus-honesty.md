# Pricing Consensus Honesty Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make pricing confidence honest by removing the illusory CG+DL coins API consensus, adding the DL stablecoins list price as a genuinely independent voice, and adding GeckoTerminal pool-level cross-checks for remaining single-source assets.

**Architecture:** Three layered changes: (1) Remove DL coins API from primary consensus in `fetchPrimaryPrices()`, (2) Inject DL stablecoins list prices as `defillama-list` source, (3) Add GeckoTerminal probe for CG-only single-source assets. Plus downstream consumer updates for the new source labels.

**Tech Stack:** TypeScript, Cloudflare Workers, D1, GeckoTerminal API v2

**Spec:** `agents/specs/2026-03-16-pricing-consensus-honesty-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `worker/src/cron/enrich-prices.ts` | Modify | Remove DL coins fetch from primary consensus; accept `dlListPrices` param; add GT second-pass |
| `worker/src/cron/sync-stablecoins.ts` | Modify | Extract DL list prices; pass to `fetchPrimaryPrices()`; update source distribution counting |
| `worker/src/lib/geckoterminal-price-probe.ts` | Create | GT pool fetch, response parsing, TVL gate, base/quote matching (spec names this `geckoterminal.ts`; renamed for clarity) |
| `worker/src/lib/constants.ts` | Modify | Add `CIRCUIT_SOURCE.GECKO_TERMINAL`, GT constants |
| `worker/src/cron/sync-stablecoins/shared.ts` | Verify | Re-exports `PriceSourceHealth` from `shared/types/status.ts`; bucket logic lives in `sync-stablecoins.ts` |
| `shared/types/status.ts` | Modify | Update `PriceSourceHealth.sourceDistribution` keys |
| `worker/src/lib/dews.ts` | Modify | Suppress degradation bonus for high→single-source reclassification |
| `worker/src/cron/confirm-pending-depegs.ts` | Modify | Update `"coingecko+defillama"` pattern matches |
| `src/components/status/price-source-health.tsx` | Modify | Update rendering for new source keys |
| `src/components/stablecoin-detail/price-transparency-card.tsx` | Modify | Add new sources to `KNOWN_SOURCES` |
| `docs/pricing-pipeline.md` | Modify | Update source table and methodology |
| `docs/api-reference.md` | Modify | Update known `priceSource` values |
| `docs/depeg-detection.md` | Modify | Update secondary confirmation source docs |
| `src/app/methodology/methodology-sections.tsx` | Modify | Update pricing methodology copy |
| `worker/src/cron/__tests__/enrich-prices.test.ts` | Modify | Remove DL coins mock; update consensus expectations |
| `worker/src/cron/__tests__/sync-stablecoins.test.ts` | Modify | Update `"coingecko+defillama"` fixtures |
| `worker/src/api/__tests__/status.test.ts` | Modify | Update `PriceSourceHealth` fixture keys |
| `worker/src/api/__tests__/stablecoin-summary.test.ts` | Modify | Update `priceSource` fixture |
| `worker/src/lib/__tests__/geckoterminal-price-probe.test.ts` | Create | Unit tests for GT probe |
| `src/app/about/` | Modify | Add GeckoTerminal as a data source |

---

## Chunk 1: Drop DL Coins API from Primary Consensus + Add DL List Price

### Task 1: Remove DL coins API fetch from `fetchPrimaryPrices()`

**Files:**
- Modify: `worker/src/cron/enrich-prices.ts`

- [ ] **Step 1: Remove `dlAllowed` circuit breaker check and DL coins fetch block**

In `worker/src/cron/enrich-prices.ts`, remove the following:

Line 136 — remove `const dlAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.DL_COINS);`

Line 144 — update the all-circuits-open guard to remove `!dlAllowed`:
```typescript
// Before:
if (!dlAllowed && !cgAllowed && !pythAllowed && !binanceAllowed && !coinbaseAllowed && !redstoneAllowed && !curveAllowed) {
// After:
if (!cgAllowed && !pythAllowed && !binanceAllowed && !coinbaseAllowed && !redstoneAllowed && !curveAllowed) {
```

Line 153 — remove `const dlPrices = new Map<string, number>();`

Lines 183–214 — remove the entire `if (dlAllowed) { ... }` block (the DL coins API fetch).

- [ ] **Step 2: Remove DL source injection from per-asset consensus loop**

Line 372 — remove `const dl = dlPrices.get(gId) ?? null;`

Line 378 — remove `if (dl != null) sources.push({ source: "defillama", price: dl, weight: 1 });`

Line 425 — change `dlPrice: dl ?? null,` to `dlPrice: null,` (keep the field for interface compatibility, always null now).

Lines 437 — remove `if (consensus.source === "defillama") stats.dlOnly++;`

Lines 442–446 — remove the divergence tracking block:
```typescript
// Remove this entire block:
if (consensus.confidence === "low" && dl != null && cg != null) {
  const mid = (dl + cg) / 2;
  const bps = mid > 0 ? Math.round(Math.abs(dl - cg) / mid * 10_000) : 0;
  stats.divergences.push({ id: asset.id, symbol: asset.symbol, dlPrice: dl, cgPrice: cg, bps });
}
```

Lines 449–455 — remove the divergence warning log (it will always be empty now).

- [ ] **Step 3: Clean up interfaces and imports**

`PrimaryPriceResult` (line 94): keep `dlPrice` field but update the JSDoc to note it's always null now (will be repurposed by DL list in Task 3).

`PriceValidationStats` (line 104): remove `dlOnly` field and `divergences` field. Update the stats initialization (line 128) to remove them.

Remove `DEFILLAMA_COINS` from the import on line 1 (only if no longer used — check that enrichment passes in `enrich-prices-passes.ts` still import it themselves).

Remove `CIRCUIT_SOURCE` usage for `DL_COINS` (only the `shouldAttemptFetch` call; `DL_COINS` itself stays in `constants.ts` for fallback enrichment).

Remove `DLPriceResponseSchema` import (line 28) if no longer used.

Update the function JSDoc (lines 114–116) to remove "both DL coins API and" from the description.

- [ ] **Step 4: Run type-check and tests**

Run: `cd worker && npx tsc --noEmit && cd .. && npm test`
Expected: Compilation errors in `sync-stablecoins.ts` (references to removed stats fields) and test failures in `enrich-prices.test.ts`. These are expected and will be fixed in subsequent tasks.

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/enrich-prices.ts
git commit -m "refactor(pricing): remove DL coins API from primary consensus

The DL coins API with coingecko: prefix returns CG-sourced data,
creating illusory two-source consensus. Remove it so CG alone is
honestly single-source when no independent sources exist."
```

### Task 2: Update sync-stablecoins.ts for removed stats fields

**Files:**
- Modify: `worker/src/cron/sync-stablecoins.ts`

- [ ] **Step 1: Remove references to `dlOnly` and `divergences` from stats**

Lines 771–777 (the `priceSourceHealth.divergences` field in `syncStablecoins()`): remove the `divergences` mapping from `priceSourceHealth`:
```typescript
// Remove this entire field from the priceSourceHealth object:
divergences: priceValidationStats.divergences.slice(0, 10).map((d) => ({
  id: d.id,
  symbol: d.symbol,
  cgPrice: d.cgPrice,
  dlPrice: d.dlPrice,
  bps: d.bps,
})),
```

Line 792: remove `priceValidation: priceValidationStats,` from metadata (or keep it but note the interface changed).

- [ ] **Step 2: Update PriceSourceHealth divergences**

In `shared/types/status.ts` lines 228–234, remove the `divergences` field from `PriceSourceHealth`:
```typescript
// Remove:
divergences: {
  id: string;
  symbol: string;
  cgPrice: number;
  dlPrice: number;
  bps: number;
}[];
```

Update any consumers that read `divergences` from the status endpoint.

- [ ] **Step 3: Run type-check**

Run: `cd worker && npx tsc --noEmit && cd .. && npm run build`
Expected: Should compile. If not, chase remaining references to `dlOnly` or `divergences`.

- [ ] **Step 4: Commit**

```bash
git add worker/src/cron/sync-stablecoins.ts shared/types/status.ts
git commit -m "refactor(pricing): clean up removed DL divergence tracking from sync pipeline"
```

### Task 3: Add `dlListPrices` parameter to `fetchPrimaryPrices()`

**Files:**
- Modify: `worker/src/cron/enrich-prices.ts`
- Modify: `worker/src/cron/sync-stablecoins.ts`

- [ ] **Step 1: Add `dlListPrices` parameter to `fetchPrimaryPrices()` signature**

In `enrich-prices.ts`, update the function signature (line 118):
```typescript
export async function fetchPrimaryPrices(
  assets: PeggedAsset[],
  db: D1Database,
  signal?: AbortSignal,
  references?: PriceValidationReferences,
  coingeckoApiKey?: string | null,
  chainRpcs?: Map<string, ChainRpcConfig>,
  dlListPrices?: Map<string, number>,  // NEW
): Promise<{ results: Map<string, PrimaryPriceResult>; stats: PriceValidationStats; cgPrices: Map<string, number> }> {
```

- [ ] **Step 2: Inject DL list price as `defillama-list` source in per-asset loop**

In the per-asset consensus loop (around line 376), after the CG source push and before the Pyth source push, add:
```typescript
const dlListPrice = dlListPrices?.get(asset.id);
if (dlListPrice != null && dlListPrice > 0) {
  sources.push({ source: "defillama-list", price: dlListPrice, weight: 1 });
}
```

- [ ] **Step 3: Repurpose `dlPrice` field in `PrimaryPriceResult`**

In the results.set() call (around line 421), change:
```typescript
dlPrice: null,
```
to:
```typescript
dlPrice: dlListPrices?.get(asset.id) ?? null,
```

This preserves the field for observability.

- [ ] **Step 4: Extract DL list prices in `syncStablecoins()` and pass to `fetchPrimaryPrices()`**

In `sync-stablecoins.ts`, after the DL payload is parsed (line 366) and before `fetchPrimaryPrices()` is called (line 487), extract the DL list prices:

```typescript
// Extract DL list prices before primary consensus overwrites them
const dlListPrices = new Map<string, number>();
for (const asset of llamaData.peggedAssets) {
  if (
    asset.price != null &&
    typeof asset.price === "number" &&
    Number.isFinite(asset.price) &&
    asset.price > 0
  ) {
    dlListPrices.set(asset.id, asset.price);
  }
}
```

**Important:** Use `asset.id` directly (not `String(asset.id)`). The key type must match how `fetchPrimaryPrices()` looks up values (`dlListPrices?.get(asset.id)`). By this point in the flow, `asset.id` has been through canonical remapping (lines 433–438) and is a string.

Note: this must go AFTER `hydrateGeckoIdAliases()` (line 398) and the canonical ID remapping (lines 433–438), but BEFORE `fetchPrimaryPrices()` (line 487). Insert it around line 485.

Update the `fetchPrimaryPrices()` call (line 487) to pass the new parameter:
```typescript
const { results: primaryPriceResults, stats: priceValidationStats } = await fetchPrimaryPrices(
  llamaData.peggedAssets, db, signal, validationReferences, coingeckoApiKey, chainRpcs, dlListPrices,
);
```

- [ ] **Step 5: Run type-check and tests**

Run: `cd worker && npx tsc --noEmit && cd .. && npm test`
Expected: Should compile. Tests may still fail due to fixture updates (Task 7).

- [ ] **Step 6: Commit**

```bash
git add worker/src/cron/enrich-prices.ts worker/src/cron/sync-stablecoins.ts
git commit -m "feat(pricing): inject DL stablecoins list price as independent defillama-list source

For assets with a llamaId, the DL stablecoins list provides an
independently-sourced price. Inject it into primary consensus as
defillama-list (weight 1), giving ~130 assets genuine two-source
high confidence."
```

### Task 4: Update source distribution tracking

**Files:**
- Modify: `shared/types/status.ts`
- Modify: `worker/src/cron/sync-stablecoins.ts`

- [ ] **Step 1: Update `PriceSourceHealth` type**

In `shared/types/status.ts` (line 205), update `sourceDistribution`:
```typescript
sourceDistribution: {
  coingecko: number;
  "coingecko+defillama-list": number;  // was "coingecko+defillama"
  defillama: number;
  "defillama-list": number;            // NEW
  "protocol-redeem": number;
  "defillama-contract": number;
  coinmarketcap: number;
  dexscreener: number;
  pyth: number;
  binance: number;
  coinbase: number;
  redstone: number;
  "curve-onchain": number;
  "dex-promoted": number;
  geckoterminal: number;               // NEW (for Chunk 2)
  cached: number;
  missing: number;
};
```

- [ ] **Step 2: Update source distribution initialization and counting in sync-stablecoins.ts**

Update `INDIVIDUAL_SOURCE_KEYS` (line 691):
```typescript
const INDIVIDUAL_SOURCE_KEYS = new Set<string>([
  "coingecko", "defillama", "defillama-list", "protocol-redeem", "defillama-contract",
  "coinmarketcap", "dexscreener", "pyth", "binance", "coinbase",
  "redstone", "curve-onchain", "dex-promoted", "geckoterminal", "cached",
]);
```

Update `finalSourceDistribution` initialization (line 708):
```typescript
const finalSourceDistribution: PriceSourceHealth["sourceDistribution"] = {
  "coingecko+defillama-list": 0,  // was "coingecko+defillama"
  coingecko: 0,
  defillama: 0,
  "defillama-list": 0,
  "protocol-redeem": 0,
  "defillama-contract": 0,
  coinmarketcap: 0,
  dexscreener: 0,
  pyth: 0,
  binance: 0,
  coinbase: 0,
  redstone: 0,
  "curve-onchain": 0,
  "dex-promoted": 0,
  geckoterminal: 0,
  cached: 0,
  missing: 0,
};
```

Update the special-case CG+DL composite check (line 743):
```typescript
// Before:
if (agreeSet.has("coingecko") && agreeSet.has("defillama")) {
  finalSourceDistribution["coingecko+defillama"]++;
}
// After:
if (agreeSet.has("coingecko") && agreeSet.has("defillama-list")) {
  finalSourceDistribution["coingecko+defillama-list"]++;
}
```

- [ ] **Step 3: Run type-check**

Run: `cd worker && npx tsc --noEmit && cd .. && npm run build`
Expected: May have errors in `status/price-source-health.tsx` and test files — those are next.

- [ ] **Step 4: Commit**

```bash
git add shared/types/status.ts worker/src/cron/sync-stablecoins.ts
git commit -m "refactor(pricing): update PriceSourceHealth type and source distribution for new source labels"
```

### Task 5: Update downstream consumers (confirm-pending-depegs, status UI, price card)

**Files:**
- Modify: `worker/src/cron/confirm-pending-depegs.ts`
- Modify: `src/components/status/price-source-health.tsx`
- Modify: `src/components/stablecoin-detail/price-transparency-card.tsx`

- [ ] **Step 1: Update confirm-pending-depegs.ts pattern matches**

Line 143–145 — update the pattern match:
```typescript
// Before:
const useDefiLlamaSecondary =
  primarySource === "coingecko" ||
  primarySource === "coingecko+defillama";
// After:
const useDefiLlamaSecondary =
  primarySource != null && primarySource.startsWith("coingecko");
```

Line 259 — update the confirmedBy label:
```typescript
// Before:
asset?.priceSource === "coingecko" || asset?.priceSource === "coingecko+defillama" ? "DefiLlama" : "CoinGecko"
// After:
asset?.priceSource?.startsWith("coingecko") ? "DefiLlama" : "CoinGecko"
```

- [ ] **Step 2: Update status dashboard rendering**

In `src/components/status/price-source-health.tsx`:

Line 99 — update the source display string:
```typescript
// Before:
CG∩DL {sd["coingecko+defillama"]} · CG {sd.coingecko} · DL {sd.defillama} ...
// After:
CG+DL-list {sd["coingecko+defillama-list"]} · CG {sd.coingecko} · DL {sd.defillama} · DL-list {sd["defillama-list"]} · GT {sd.geckoterminal} ...
```

Line 42 — remove `const [showDivergences, setShowDivergences] = useState(false);`

Line 57 — remove `divergences` from the destructuring:
```typescript
// Before:
const { confidenceDistribution: cd, sourceDistribution: sd, divergences, totalAssets } = health;
// After:
const { confidenceDistribution: cd, sourceDistribution: sd, totalAssets } = health;
```

Lines 102–120 — remove the entire divergences toggle/display block:
```tsx
// Remove this entire block:
{divergences.length > 0 && (
  <div>
    <button onClick={() => setShowDivergences(!showDivergences)} ...>
    ...
  </div>
)}
```

Remove the `useState` import if it's no longer used elsewhere in the component.

- [ ] **Step 3: Update price transparency card KNOWN_SOURCES**

In `src/components/stablecoin-detail/price-transparency-card.tsx` (line 9), add to the array:
```typescript
const KNOWN_SOURCES = [
  { key: "coingecko", label: "CoinGecko" },
  { key: "defillama", label: "DefiLlama" },
  { key: "defillama-list", label: "DefiLlama (list)" },  // NEW
  { key: "geckoterminal", label: "GeckoTerminal" },       // NEW
  { key: "pyth", label: "Pyth Network" },
  { key: "binance", label: "Binance" },
  { key: "coinbase", label: "Coinbase" },
  { key: "redstone", label: "RedStone" },
  { key: "curve-onchain", label: "Curve on-chain" },
  { key: "curve-oracle", label: "Curve oracle" },
  { key: "dex-promoted", label: "DEX prices" },
] as const;
```

- [ ] **Step 4: Run type-check and build**

Run: `npm run build && cd worker && npx tsc --noEmit`
Expected: Should compile cleanly.

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/confirm-pending-depegs.ts src/components/status/price-source-health.tsx src/components/stablecoin-detail/price-transparency-card.tsx
git commit -m "fix(pricing): update downstream consumers for new priceSource labels

Update depeg confirmer to use startsWith('coingecko') instead of
exact match on removed 'coingecko+defillama' label. Add defillama-list
and geckoterminal to status dashboard and price transparency card."
```

### Task 6: DEWS first-deploy spike mitigation

**Files:**
- Modify: `worker/src/lib/dews.ts`

**Context:** On first deploy, ~137 assets shift from `high` (0 pts) to `single-source` (25 pts). The `prevPriceConfidence` degradation bonus at lines 366–372 adds another +15 pts when `currScore > prevScore`, potentially adding ~6 DEWS points per affected asset. This is a one-time artifact of the pipeline change, not a real data quality degradation.

- [ ] **Step 1: Suppress degradation bonus for pipeline-reclassification shifts**

In `worker/src/lib/dews.ts`, update `computePriceSignal()` (lines 365–372) to suppress the degradation bonus when the shift is from `high` to `single-source` (which is the only transition this pipeline change causes):

```typescript
// Degradation transition bonus — suppress for pipeline reclassification
// (high→single-source with no real data quality change)
if (prevPriceConfidence) {
  const prevScore = CONFIDENCE_SCORES[prevPriceConfidence] ?? 0;
  const currScore = CONFIDENCE_SCORES[priceConfidence ?? ""] ?? 0;
  if (currScore > prevScore && !(prevPriceConfidence === "high" && (priceConfidence ?? "") === "single-source")) {
    value = Math.min(100, value + 15);
  }
}
```

**Note:** This suppression is permanent but narrow — it only affects the high→single-source transition. If a future real degradation shifts an asset from high to single-source (e.g., an oracle goes offline), the +15 degradation bonus won't fire. The base 25-pt single-source score still applies, which is the primary signal. The degradation bonus was designed for sudden drops (like high→low or single-source→fallback), so suppressing high→single-source is acceptable.

- [ ] **Step 2: Run type-check and tests**

Run: `cd worker && npx tsc --noEmit && cd .. && npm test`
Expected: Pass.

- [ ] **Step 3: Commit**

```bash
git add worker/src/lib/dews.ts
git commit -m "fix(dews): suppress degradation bonus for high→single-source reclassification

Pipeline change reclassifies ~137 assets from illusory 'high' to honest
'single-source'. Suppress the +15 degradation bonus for this specific
transition to avoid a one-time DEWS spike on first deploy."
```

### Task 7: Update test fixtures

**Files:**
- Modify: `worker/src/cron/__tests__/enrich-prices.test.ts`
- Modify: `worker/src/cron/__tests__/sync-stablecoins.test.ts`
- Modify: `worker/src/api/__tests__/status.test.ts`
- Modify: `worker/src/api/__tests__/stablecoin-summary.test.ts`

- [ ] **Step 1: Update enrich-prices.test.ts**

Line 544 — the test `"returns high confidence when DL and CG prices agree within 50bps"`:
This test will need to be rewritten. Since DL coins API is removed, CG alone should now produce `single-source`. If a `dlListPrices` map is passed, it should produce `high` with `coingecko+defillama-list`. Update test:
```typescript
// Test: CG alone is single-source
expect(result.confidence).toBe("single-source");
expect(result.source).toBe("coingecko");
```

Add a new test:
```typescript
// Test: CG + DL list price produces high confidence
// Pass dlListPrices map to fetchPrimaryPrices
```

Remove or update any mock that matches `coins.llama.fi/prices` for the primary consensus path (~10 test cases mock this endpoint). Keep mocks for fallback enrichment tests (Pass 1/1b) that use the DL coins API with `{chain}:{address}`.

The test at line 706 (`"tracks cgOnly and dlOnly in stats"`) must be rewritten: remove `dlOnly` assertion, update test name, remove DL coins mock. The `dlOnly` field was removed from `PriceValidationStats` in Task 1 Step 3, so this test will fail to compile.

- [ ] **Step 2: Update sync-stablecoins.test.ts**

Lines 1070, 1072, 1091 — update `stampPriceMetadata` test fixtures:
```typescript
// Line 1070: Change "coingecko+defillama" to "coingecko+defillama-list"
stampPriceMetadata(asset, "coingecko+defillama-list", "high", 1234, ["coingecko", "defillama-list"]);
expect(asset.priceSource).toBe("coingecko+defillama-list");
```

Line 270 — remove or update the DL coins API mock (`{ match: "coins.llama.fi/prices", body: { coins: {} } }`) from the main sync test. The primary consensus no longer fetches this endpoint.

- [ ] **Step 3: Update status.test.ts**

Line 68 — update the fixture:
```typescript
// Before:
"coingecko+defillama": 118,
// After:
"coingecko+defillama-list": 118,
```

Add the new keys to the fixture:
```typescript
"defillama-list": 0,
geckoterminal: 0,
```

Remove the `divergences` field from the fixture (it was removed from the type in Task 2).

**Note:** The existing fixture is already incomplete vs the type (missing `pyth`, `binance`, `coinbase`, `redstone`, `curve-onchain`, `dex-promoted`). Bring the fixture into full alignment with the `PriceSourceHealth.sourceDistribution` type — add all missing keys with value `0`.

- [ ] **Step 4: Update stablecoin-summary.test.ts**

Line 16 — update the fixture:
```typescript
// Before:
priceSource: "coingecko+defillama",
// After:
priceSource: "coingecko+defillama-list",
```

- [ ] **Step 5: Run all tests**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add worker/src/cron/__tests__/enrich-prices.test.ts worker/src/cron/__tests__/sync-stablecoins.test.ts worker/src/api/__tests__/status.test.ts worker/src/api/__tests__/stablecoin-summary.test.ts
git commit -m "test(pricing): update test fixtures for new source labels and removed DL coins consensus"
```

### Task 8: Full build + type-check gate for Chunk 1

- [ ] **Step 1: Run full validation**

Run: `npm run build && cd worker && npx tsc --noEmit && cd .. && npm test && npm run lint`
Expected: All pass. Fix any remaining issues.

- [ ] **Step 2: Commit any fixes**

---

## Chunk 2: GeckoTerminal Pool-Level Cross-Check

### Task 9: Add CIRCUIT_SOURCE.GECKO_TERMINAL and constants

**Files:**
- Modify: `worker/src/lib/constants.ts`

- [ ] **Step 1: Add GT circuit breaker source and constants**

In `worker/src/lib/constants.ts`, add to `CIRCUIT_SOURCE` (after line 147):
```typescript
GECKO_TERMINAL_PROBE: "geckoterminal-probe",
```

Add new constants (after the DEX constants section):
```typescript
/** Minimum TVL for a GeckoTerminal pool to be used as a price cross-check */
export const GT_PROBE_MIN_TVL_USD = 10_000;

/** Maximum time (ms) for the entire GT probe batch */
export const GT_PROBE_TIMEOUT_MS = 5_000;
```

- [ ] **Step 2: Commit**

```bash
git add worker/src/lib/constants.ts
git commit -m "feat(pricing): add GeckoTerminal probe constants and circuit breaker source"
```

### Task 10: Create GeckoTerminal price probe module

**Files:**
- Create: `worker/src/lib/geckoterminal-price-probe.ts`
- Create: `worker/src/lib/__tests__/geckoterminal-price-probe.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `worker/src/lib/__tests__/geckoterminal-price-probe.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { extractPoolPrice, type GtProbeResult } from "../geckoterminal-price-probe";

describe("extractPoolPrice", () => {
  const baseAddress = "0xabcdef1234567890abcdef1234567890abcdef12";

  it("returns price from highest-TVL pool where token is base", () => {
    const pools = [
      makePool({
        reserveUsd: "500000",
        basePriceUsd: "0.80",
        quotePriceUsd: "1.19",
        baseTokenId: `eth_${baseAddress}`,
        quoteTokenId: "eth_0xquote",
      }),
    ];
    const result = extractPoolPrice(pools, baseAddress);
    expect(result).not.toBeNull();
    expect(result!.price).toBe(0.80);
    expect(result!.tvlUsd).toBe(500000);
    expect(result!.side).toBe("base");
  });

  it("returns price from highest-TVL pool where token is quote", () => {
    const pools = [
      makePool({
        reserveUsd: "200000",
        basePriceUsd: "1.19",
        quotePriceUsd: "0.95",
        baseTokenId: "eth_0xother",
        quoteTokenId: `eth_${baseAddress}`,
      }),
    ];
    const result = extractPoolPrice(pools, baseAddress);
    expect(result).not.toBeNull();
    expect(result!.price).toBe(0.95);
    expect(result!.side).toBe("quote");
  });

  it("returns null when token address matches neither base nor quote", () => {
    const pools = [
      makePool({
        reserveUsd: "100000",
        basePriceUsd: "1.00",
        quotePriceUsd: "1.00",
        baseTokenId: "eth_0xother1",
        quoteTokenId: "eth_0xother2",
      }),
    ];
    const result = extractPoolPrice(pools, baseAddress);
    expect(result).toBeNull();
  });

  it("returns null when TVL is below threshold", () => {
    const pools = [
      makePool({
        reserveUsd: "5000",
        basePriceUsd: "0.80",
        quotePriceUsd: "1.19",
        baseTokenId: `eth_${baseAddress}`,
        quoteTokenId: "eth_0xquote",
      }),
    ];
    const result = extractPoolPrice(pools, baseAddress, 10_000);
    expect(result).toBeNull();
  });

  it("picks highest-TVL pool among multiple", () => {
    const pools = [
      makePool({
        reserveUsd: "50000",
        basePriceUsd: "0.99",
        quotePriceUsd: "1.00",
        baseTokenId: `eth_${baseAddress}`,
        quoteTokenId: "eth_0xquote",
      }),
      makePool({
        reserveUsd: "800000",
        basePriceUsd: "0.80",
        quotePriceUsd: "1.19",
        baseTokenId: `eth_${baseAddress}`,
        quoteTokenId: "eth_0xquote2",
      }),
    ];
    const result = extractPoolPrice(pools, baseAddress);
    expect(result).not.toBeNull();
    expect(result!.price).toBe(0.80);
    expect(result!.tvlUsd).toBe(800000);
  });

  it("returns null for empty pool list", () => {
    expect(extractPoolPrice([], baseAddress)).toBeNull();
  });

  it("returns null when price is zero or NaN", () => {
    const pools = [
      makePool({
        reserveUsd: "100000",
        basePriceUsd: "0",
        quotePriceUsd: "1.00",
        baseTokenId: `eth_${baseAddress}`,
        quoteTokenId: "eth_0xquote",
      }),
    ];
    expect(extractPoolPrice(pools, baseAddress)).toBeNull();
  });
});

function makePool(opts: {
  reserveUsd: string;
  basePriceUsd: string;
  quotePriceUsd: string;
  baseTokenId: string;
  quoteTokenId: string;
}) {
  return {
    id: "pool_1",
    type: "pool",
    attributes: {
      address: "0xpool",
      name: "TEST/USDC",
      pool_created_at: null,
      base_token_price_usd: opts.basePriceUsd,
      quote_token_price_usd: opts.quotePriceUsd,
      reserve_in_usd: opts.reserveUsd,
      volume_usd: { h24: "0" },
    },
    relationships: {
      base_token: { data: { id: opts.baseTokenId, type: "token" } },
      quote_token: { data: { id: opts.quoteTokenId, type: "token" } },
      dex: { data: { id: "curve", type: "dex" } },
    },
  };
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- worker/src/lib/__tests__/geckoterminal-price-probe.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the module**

Create `worker/src/lib/geckoterminal-price-probe.ts`:

```typescript
import { GT_API_BASE } from "./dex-constants";
import { RATE_LIMITS } from "./rate-limit";
import { fetchWithRetry } from "./fetch-retry";
import { USER_AGENT, GT_PROBE_MIN_TVL_USD, GT_PROBE_TIMEOUT_MS, CIRCUIT_SOURCE } from "./constants";
import { shouldAttemptFetch, recordOutcome } from "./circuit-breaker";
import { sleepWithSignal, throwIfAborted } from "./abort";
import { GT_CHAIN_MAP } from "./chain-registry";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import type { GtPool } from "../cron/dex-liquidity/types";
import type { SourcePrice } from "./price-consensus";

export interface GtProbeResult {
  price: number;
  tvlUsd: number;
  side: "base" | "quote";
  chain: string;
  poolAddress: string;
}

/**
 * Extract the best price from a GeckoTerminal pools response for a given token address.
 * Picks the highest-TVL pool where the token matches base or quote, with a TVL gate.
 */
export function extractPoolPrice(
  pools: GtPool[],
  tokenAddress: string,
  minTvlUsd = GT_PROBE_MIN_TVL_USD,
): GtProbeResult | null {
  const normalized = tokenAddress.toLowerCase();
  let best: GtProbeResult | null = null;

  for (const pool of pools) {
    const a = pool.attributes;
    const tvl = parseFloat(a.reserve_in_usd ?? "");
    if (!Number.isFinite(tvl) || tvl < minTvlUsd) continue;

    const baseId = pool.relationships.base_token.data.id.split("_").pop()?.toLowerCase() ?? "";
    const quoteId = pool.relationships.quote_token.data.id.split("_").pop()?.toLowerCase() ?? "";

    let price: number | null = null;
    let side: "base" | "quote" | null = null;

    if (baseId === normalized) {
      price = parseFloat(a.base_token_price_usd ?? "");
      side = "base";
    } else if (quoteId === normalized) {
      price = parseFloat(a.quote_token_price_usd ?? "");
      side = "quote";
    }

    if (side == null || price == null || !Number.isFinite(price) || price <= 0) continue;
    if (best == null || tvl > best.tvlUsd) {
      best = { price, tvlUsd: tvl, side, chain: "", poolAddress: a.address };
    }
  }

  return best;
}

export interface GtProbeStats {
  probed: number;
  pricesObtained: number;
  divergences500bps: number;
  skippedLowTvl: number;
}

/**
 * Probe GeckoTerminal for independent pool-level prices for assets that are
 * single-source CG-only after primary consensus. Returns a map of asset ID
 * to SourcePrice for injection into a second-pass consensus.
 */
export async function probeGeckoTerminalPrices(
  singleSourceCgAssets: { id: string; price: number }[],
  db: D1Database,
  signal?: AbortSignal,
): Promise<{ prices: Map<string, SourcePrice>; stats: GtProbeStats }> {
  const prices = new Map<string, SourcePrice>();
  const stats: GtProbeStats = { probed: 0, pricesObtained: 0, divergences500bps: 0, skippedLowTvl: 0 };

  if (singleSourceCgAssets.length === 0) return { prices, stats };

  const allowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.GECKO_TERMINAL_PROBE);
  if (!allowed) {
    console.warn("[gt-probe] Circuit open, skipping");
    return { prices, stats };
  }

  throwIfAborted(signal);

  const metaById = new Map(TRACKED_STABLECOINS.map((m) => [m.id, m]));
  let failures = 0;

  for (const asset of singleSourceCgAssets) {
    throwIfAborted(signal);

    const meta = metaById.get(asset.id);
    if (!meta?.contracts?.length) continue;

    // Find first EVM contract with a GT chain mapping
    const contract = meta.contracts.find(
      (c) => c.chain !== "solana" && c.chain !== "stellar" && c.chain !== "tron" && GT_CHAIN_MAP[c.chain],
    );
    if (!contract) continue;

    const gtChain = GT_CHAIN_MAP[contract.chain];
    const url = `${GT_API_BASE}/networks/${gtChain}/tokens/${contract.address}/pools?page=1`;

    if (stats.probed > 0) {
      await sleepWithSignal(RATE_LIMITS.GECKO_TERMINAL_MS, signal);
    }

    stats.probed++;

    try {
      const res = await fetchWithRetry(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(GT_PROBE_TIMEOUT_MS)]) : AbortSignal.timeout(GT_PROBE_TIMEOUT_MS),
      }, 0);

      if (!res?.ok) {
        failures++;
        continue;
      }

      const json = (await res.json()) as { data?: GtPool[] };
      const pools = json.data ?? [];

      const result = extractPoolPrice(pools, contract.address);
      if (!result) {
        stats.skippedLowTvl++;
        continue;
      }

      result.chain = contract.chain;
      stats.pricesObtained++;

      // Track divergences for logging
      const mid = (result.price + asset.price) / 2;
      if (mid > 0) {
        const bps = Math.round((Math.abs(result.price - asset.price) / mid) * 10_000);
        if (bps >= 500) stats.divergences500bps++;
      }

      prices.set(asset.id, {
        source: "geckoterminal",
        price: result.price,
        weight: 1,
        metadata: { tvlUsd: result.tvlUsd, chain: result.chain, poolAddress: result.poolAddress, side: result.side },
      });
    } catch (err) {
      if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
      failures++;
      console.warn(`[gt-probe] Failed for ${asset.id}:`, String(err).slice(0, 200));
    }
  }

  await recordOutcome(db, CIRCUIT_SOURCE.GECKO_TERMINAL_PROBE, failures < stats.probed);

  console.log(
    `[gt-probe] Probed ${stats.probed} assets: ${stats.pricesObtained} prices obtained, ` +
    `${stats.divergences500bps} divergences >500bps, ${stats.skippedLowTvl} skipped (low TVL)`,
  );

  return { prices, stats };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- worker/src/lib/__tests__/geckoterminal-price-probe.test.ts`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/geckoterminal-price-probe.ts worker/src/lib/__tests__/geckoterminal-price-probe.test.ts
git commit -m "feat(pricing): add GeckoTerminal pool-level price probe module

Fetches top pools by TVL from GeckoTerminal for single-source CG-only
assets. Validates base/quote token matching and applies a $10K TVL gate.
Circuit breaker and rate limiting integrated."
```

### Task 11: Integrate GT probe into the sync pipeline

**Files:**
- Modify: `worker/src/cron/enrich-prices.ts`
- Modify: `worker/src/cron/sync-stablecoins.ts`

- [ ] **Step 1: Add GT second-pass function to enrich-prices.ts**

Add a new exported function after `fetchPrimaryPrices()`:

```typescript
/**
 * For assets that are single-source CG-only after primary consensus,
 * probe GeckoTerminal for an independent pool-level price and re-run
 * consensus with the additional source.
 */
export async function runGtProbePass(
  assets: PeggedAsset[],
  primaryResults: Map<string, PrimaryPriceResult>,
  db: D1Database,
  signal?: AbortSignal,
  references?: PriceValidationReferences,
): Promise<{ updatedCount: number; stats: import("../lib/geckoterminal-price-probe").GtProbeStats }> {
  const { probeGeckoTerminalPrices } = await import("../lib/geckoterminal-price-probe");

  // Identify single-source CG-only assets
  const cgOnlyAssets: { id: string; price: number }[] = [];
  for (const asset of assets) {
    const primary = primaryResults.get(asset.id);
    if (
      primary &&
      primary.confidence === "single-source" &&
      primary.candidateSources.length === 1 &&
      primary.candidateSources[0] === "coingecko"
    ) {
      cgOnlyAssets.push({ id: asset.id, price: primary.price });
    }
  }

  if (cgOnlyAssets.length === 0) {
    return { updatedCount: 0, stats: { probed: 0, pricesObtained: 0, divergences500bps: 0, skippedLowTvl: 0 } };
  }

  const { prices: gtPrices, stats } = await probeGeckoTerminalPrices(cgOnlyAssets, db, signal);

  // Re-run consensus for assets that got a GT price
  let updatedCount = 0;
  for (const asset of assets) {
    const gtSource = gtPrices.get(asset.id);
    if (!gtSource) continue;

    const primary = primaryResults.get(asset.id);
    if (!primary) continue;

    // Build source list: original CG + GT
    const sources: import("../lib/price-consensus").SourcePrice[] = [
      { source: "coingecko", price: primary.cgPrice ?? primary.price, weight: 2 },
      gtSource,
    ];

    const context = buildPriceValidationContext({
      stablecoinId: String(asset.id),
      pegType: asset.pegType,
      navToken: asset.navToken,
      commodityOunces: asset.commodityOunces,
    });
    const pegRef = context.navToken ? null : getReferencePriceForContext(context, references);
    const consensus = computePriceConsensus(sources, pegRef, 50);

    if (!consensus) continue;

    // Update the primary result
    primary.price = consensus.price;
    primary.source = consensus.source;
    primary.confidence = consensus.confidence;
    primary.candidateSources = sources.map((s) => s.source);
    primary.agreeSources = consensus.agreeSources;
    updatedCount++;
  }

  return { updatedCount, stats };
}
```

- [ ] **Step 2: Call GT probe in sync-stablecoins.ts**

In `syncStablecoins()`, **after** the protocol-backed overrides block (after line 534, the `protocolOverrideCount` log) and **before** the `supplySource` tagging loop (line 536). Per the spec's ordering: primary consensus → authoritative overrides → GT probe → fallback enrichment. Add:

```typescript
// GT probe for single-source CG-only assets
const gtProbeAbort = returnIfAborted(signal, "gt-probe");
if (gtProbeAbort) return gtProbeAbort;
try {
  const { updatedCount: gtUpdated, stats: gtStats } = await runGtProbePass(
    llamaData.peggedAssets, primaryPriceResults, db, signal, validationReferences,
  );
  // Re-apply updated primary results to assets
  if (gtUpdated > 0) {
    for (const asset of llamaData.peggedAssets) {
      const primary = primaryPriceResults.get(asset.id);
      if (primary && primary.candidateSources.includes("geckoterminal")) {
        const decision = validatePriceCandidate(
          primary.price,
          validationContexts.get(asset),
          "primary_authoritative",
          validationReferences,
        );
        if (decision.accepted) {
          asset.price = primary.price;
          stampPriceMetadata(asset, primary.source, primary.confidence, syncStartSec, primary.candidateSources, primary.agreeSources);
        }
      }
    }
    console.log(`[sync-stablecoins] GT probe updated ${gtUpdated} asset prices`);
  }
} catch (err) {
  if (signal?.aborted) return abortResult(signal, "gt-probe");
  console.warn("[sync-stablecoins] GT probe failed (non-fatal):", err);
}
```

Add the import at the top of `sync-stablecoins.ts`:
```typescript
import { runGtProbePass } from "./enrich-prices";
```

- [ ] **Step 3: Run type-check and tests**

Run: `cd worker && npx tsc --noEmit && cd .. && npm test`
Expected: Should pass.

- [ ] **Step 4: Commit**

```bash
git add worker/src/cron/enrich-prices.ts worker/src/cron/sync-stablecoins.ts
git commit -m "feat(pricing): integrate GeckoTerminal probe into sync pipeline

After primary consensus, probe GT for single-source CG-only assets.
Re-runs consensus with GT pool price. Catches depegs invisible to
CoinGecko's aggregation (e.g., dUSD-trinity at $0.80 on Ethereum)."
```

### Task 12: Full build + type-check + test gate for Chunk 2

- [ ] **Step 1: Run full validation**

Run: `npm run build && cd worker && npx tsc --noEmit && cd .. && npm test && npm run lint`
Expected: All pass.

- [ ] **Step 2: Commit any fixes**

---

## Chunk 3: Documentation Updates

### Task 13: Update pricing documentation

**Files:**
- Modify: `docs/pricing-pipeline.md`
- Modify: `docs/api-reference.md`
- Modify: `docs/depeg-detection.md`
- Modify: `src/app/methodology/methodology-sections.tsx`

- [ ] **Step 1: Update docs/pricing-pipeline.md**

Update the Source Weights table (around line 36):
- Remove the `DefiLlama coins.llama.fi` row (weight 1, secondary aggregator voice)
- Add a new row: `DefiLlama stablecoins list | 1 | DL stablecoins list endpoint | Independent DL aggregation for assets with llamaId`
- Add a new row: `GeckoTerminal pool probe | 1 | worker/src/lib/geckoterminal-price-probe.ts | Pool-level cross-check for single-source CG-only assets`

Update the Consensus Rules section to note that CG+DL coins was removed because it was not independent.

Update the "Confidence Model" section to note: "The former 'coingecko+defillama' source label (which was illusory consensus) has been replaced by genuine multi-source labels like 'coingecko+defillama-list'."

- [ ] **Step 2: Update docs/api-reference.md**

Line 190 and 272 — replace `"coingecko+defillama"` with `"coingecko+defillama-list"`. Add `"geckoterminal"` to known source values.

- [ ] **Step 3: Update docs/depeg-detection.md**

Line 172 — update the secondary confirmation source logic description to reference `startsWith("coingecko")` instead of the exact string match.

- [ ] **Step 4: Update methodology page copy**

In `src/app/methodology/methodology-sections.tsx`, update the pricing pipeline section to reflect the removal of DL coins API from primary consensus and the addition of DL list + GT probe sources.

- [ ] **Step 5: Update the about page for the new GeckoTerminal data source**

Per CLAUDE.md: "When adding a data source, update the about page." Check `src/app/about/` for the data sources section and add GeckoTerminal as a new source (pool-level price cross-check for stablecoins without independent oracle/CEX coverage).

- [ ] **Step 6: Commit**

```bash
git add docs/pricing-pipeline.md docs/api-reference.md docs/depeg-detection.md src/app/methodology/methodology-sections.tsx src/app/about/
git commit -m "docs(pricing): update documentation for consensus honesty changes

Remove DL coins API from primary consensus docs. Document defillama-list
and geckoterminal sources. Update known priceSource values."
```

### Task 14: Final validation and build gate

- [ ] **Step 1: Full build, type-check, tests, lint**

Run: `npm run build && cd worker && npx tsc --noEmit && cd .. && npm test && npm run lint`
Expected: All pass.

- [ ] **Step 2: Manual smoke check**

Run the worker locally:
```bash
cd worker && npx wrangler dev
```

Trigger a sync and check the logs for:
- `[primary-prices]` log showing correct source counts
- `[gt-probe]` log showing probe results
- No `"coingecko+defillama"` appearing anywhere in output

- [ ] **Step 3: Final commit if needed, then push**
