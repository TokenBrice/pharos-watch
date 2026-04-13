# Sky/MakerCore Reserve Adapter v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the `sky-makercore` reserve adapter to fetch module-level debt/collateral data from the Block Analitica API instead of DefiLlama, producing 7 risk-labeled slices matching the Sky dashboard.

**Architecture:** Single adapter file rewrite. Fetches `info-sky.blockanalitica.com/groups/?days_ago=1&order=-debt`, maps each module to a risk-labeled reserve slice using debt values. Config JSONs updated to point at the new URL. Existing adapter key, registration, and definition stay unchanged.

**Tech Stack:** TypeScript, Vitest, existing adapter helper functions (`slicesFromValues`, `fetchJsonWithRetry`, `verifiedFreshnessMetadata`)

**Spec:** `agents/specs/2026-04-05-sky-makercore-adapter-v2-design.md`

---

### Task 1: Write tests for the new module-mapping logic

**Files:**
- Modify: `worker/src/cron/reserve-adapters/__tests__/sky-makercore.test.ts`

This task replaces the old token-bucketing tests with module-mapping tests.

- [ ] **Step 1: Replace the test file with new tests**

```typescript
import { describe, it, expect } from "vitest";
import {
  adaptSkyModules,
  listUnknownGroups,
  resolveSkyImmediateRedeemableUsd,
  type SkyGroupResult,
} from "../sky-makercore";

const SAMPLE_GROUPS: SkyGroupResult[] = [
  { group: "stablecoins", group_name: "Stablecoins", debt: "4848053264.74", collateral: "4848920495.92", datetime: "2026-04-05T17:33:24.053849" },
  { group: "spark", group_name: "Spark", debt: "3604127984.82", collateral: "3604127984.82", datetime: "2026-04-05T17:33:24.053849" },
  { group: "grove", group_name: "Grove", debt: "2942299611.45", collateral: "2942299611.45", datetime: "2026-04-05T17:33:24.053849" },
  { group: "obex", group_name: "Obex", debt: "605813016.00", collateral: "605813016.00", datetime: "2026-04-05T17:33:24.053849" },
  { group: "core", group_name: "Core", debt: "524177048.08", collateral: "1744997221.98", datetime: "2026-04-05T17:33:24.053849" },
  { group: "staked", group_name: "Staking Engine", debt: "153348644.44", collateral: "1213000185.95", datetime: "2026-04-05T17:33:24.053849" },
  { group: "legacy-rwa", group_name: "Legacy RWA", debt: "104787191.81", collateral: "104787191.81", datetime: "2026-04-05T17:33:24.053849" },
];

describe("adaptSkyModules", () => {
  it("produces 7 slices from all known modules", () => {
    const slices = adaptSkyModules(SAMPLE_GROUPS);
    expect(slices).toHaveLength(7);
    const total = slices.reduce((sum, s) => sum + s.pct, 0);
    expect(total).toBe(100);
  });

  it("assigns correct risk levels per module", () => {
    const slices = adaptSkyModules(SAMPLE_GROUPS);
    const byName = Object.fromEntries(slices.map((s) => [s.name, s]));

    expect(byName["Stablecoins (PSM)"].risk).toBe("very-low");
    expect(byName["Stablecoins (PSM)"].coinId).toBe("usdc-circle");
    expect(byName["Stablecoins (PSM)"].depType).toBe("mechanism");

    expect(byName["Spark (lending)"].risk).toBe("low");
    expect(byName["Grove (RWA)"].risk).toBe("low");
    expect(byName["Obex"].risk).toBe("medium");
    expect(byName["Core (crypto vaults)"].risk).toBe("medium");
    expect(byName["Staking Engine"].risk).toBe("high");
    expect(byName["Legacy RWA"].risk).toBe("low");
  });

  it("stablecoins slice is the largest by percentage", () => {
    const slices = adaptSkyModules(SAMPLE_GROUPS);
    const stableSlice = slices.find((s) => s.name === "Stablecoins (PSM)")!;
    const maxPct = Math.max(...slices.map((s) => s.pct));
    expect(stableSlice.pct).toBe(maxPct);
  });

  it("omits modules with zero debt", () => {
    const withZero: SkyGroupResult[] = [
      { group: "stablecoins", group_name: "Stablecoins", debt: "5000000000", collateral: "5000000000", datetime: "2026-04-05T17:33:24" },
      { group: "legacy-rwa", group_name: "Legacy RWA", debt: "0", collateral: "0", datetime: "2026-04-05T17:33:24" },
    ];
    const slices = adaptSkyModules(withZero);
    expect(slices).toHaveLength(1);
    expect(slices[0].pct).toBe(100);
  });

  it("returns empty when all debts are zero", () => {
    const allZero: SkyGroupResult[] = [
      { group: "stablecoins", group_name: "Stablecoins", debt: "0", collateral: "0", datetime: "2026-04-05T17:33:24" },
    ];
    expect(adaptSkyModules(allZero)).toEqual([]);
  });

  it("buckets unknown groups into Other modules with high risk", () => {
    const withUnknown: SkyGroupResult[] = [
      { group: "stablecoins", group_name: "Stablecoins", debt: "9000000000", collateral: "9000000000", datetime: "2026-04-05T17:33:24" },
      { group: "new-module", group_name: "New Module", debt: "1000000000", collateral: "1000000000", datetime: "2026-04-05T17:33:24" },
    ];
    const slices = adaptSkyModules(withUnknown);
    const otherSlice = slices.find((s) => s.name === "Other modules");
    expect(otherSlice).toBeDefined();
    expect(otherSlice!.risk).toBe("high");
    expect(otherSlice!.pct).toBe(10);
  });
});

describe("resolveSkyImmediateRedeemableUsd", () => {
  it("returns stablecoins module collateral as redeemable", () => {
    expect(resolveSkyImmediateRedeemableUsd(SAMPLE_GROUPS)).toBe(4848920495.92);
  });

  it("returns 0 when no stablecoins module exists", () => {
    const noStable: SkyGroupResult[] = [
      { group: "core", group_name: "Core", debt: "500000000", collateral: "1500000000", datetime: "2026-04-05T17:33:24" },
    ];
    expect(resolveSkyImmediateRedeemableUsd(noStable)).toBe(0);
  });
});

describe("listUnknownGroups", () => {
  it("identifies groups not in the known set", () => {
    const groups: SkyGroupResult[] = [
      { group: "stablecoins", group_name: "Stablecoins", debt: "100", collateral: "100", datetime: "2026-04-05T17:33:24" },
      { group: "mystery", group_name: "Mystery", debt: "50", collateral: "50", datetime: "2026-04-05T17:33:24" },
    ];
    const unknown = listUnknownGroups(groups);
    expect(unknown).toContain("mystery");
    expect(unknown).not.toContain("stablecoins");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd worker && npx vitest run src/cron/reserve-adapters/__tests__/sky-makercore.test.ts`
Expected: FAIL — `adaptSkyModules` is not exported from `../sky-makercore`

---

### Task 2: Rewrite the adapter implementation

**Files:**
- Modify: `worker/src/cron/reserve-adapters/sky-makercore.ts`

- [ ] **Step 1: Replace the adapter with the new Block Analitica module-level implementation**

```typescript
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig, LiveReserveWarning } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchJsonWithRetry,
  getAdapterTimeout,
  requireJsonInputFromConfig,
  reserveDegradedWarning,
  slicesFromValues,
  verifiedFreshnessMetadata,
  unverifiedFreshnessMetadata,
} from "./helpers";

// ---------------------------------------------------------------------------
// Block Analitica groups API response
// ---------------------------------------------------------------------------

export interface SkyGroupResult {
  group: string;
  group_name: string;
  debt: string;
  collateral: string;
  datetime: string;
}

interface BlockAnaliticaGroupsResponse {
  count: number;
  results: SkyGroupResult[];
}

// ---------------------------------------------------------------------------
// Module → slice mapping
// ---------------------------------------------------------------------------

interface ModuleSpec {
  name: string;
  risk: "very-low" | "low" | "medium" | "high" | "very-high";
  coinId?: string;
  depType?: "mechanism";
}

const MODULE_MAP: Record<string, ModuleSpec> = {
  stablecoins: { name: "Stablecoins (PSM)", risk: "very-low", coinId: "usdc-circle", depType: "mechanism" },
  spark:       { name: "Spark (lending)", risk: "low" },
  grove:       { name: "Grove (RWA)", risk: "low" },
  obex:        { name: "Obex", risk: "medium" },
  core:        { name: "Core (crypto vaults)", risk: "medium" },
  staked:      { name: "Staking Engine", risk: "high" },
  "legacy-rwa":{ name: "Legacy RWA", risk: "low" },
};

const KNOWN_GROUPS = new Set(Object.keys(MODULE_MAP));

function parseDebt(raw: string): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function parseCollateral(raw: string): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export function adaptSkyModules(groups: SkyGroupResult[]): AdapterResult["slices"] {
  const knownValues: Array<{
    value: number;
    name: string;
    risk: "very-low" | "low" | "medium" | "high" | "very-high";
    coinId?: string;
    depType?: "mechanism";
  }> = [];

  let unknownDebtTotal = 0;

  for (const g of groups) {
    const debt = parseDebt(g.debt);
    if (debt <= 0) continue;

    const spec = MODULE_MAP[g.group];
    if (spec) {
      knownValues.push({ value: debt, ...spec });
    } else {
      unknownDebtTotal += debt;
    }
  }

  if (unknownDebtTotal > 0) {
    knownValues.push({ value: unknownDebtTotal, name: "Other modules", risk: "high" });
  }

  return slicesFromValues(knownValues);
}

export function resolveSkyImmediateRedeemableUsd(groups: SkyGroupResult[]): number {
  const stableGroup = groups.find((g) => g.group === "stablecoins");
  if (!stableGroup) return 0;
  return parseCollateral(stableGroup.collateral);
}

export function listUnknownGroups(groups: SkyGroupResult[]): string[] {
  return groups.filter((g) => !KNOWN_GROUPS.has(g.group)).map((g) => g.group);
}

// ---------------------------------------------------------------------------
// Adapter entry point
// ---------------------------------------------------------------------------

export async function fetchSkyMakercoreReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primaryInput = requireJsonInputFromConfig(config, "sky-makercore");
  const payload = await fetchJsonWithRetry<BlockAnaliticaGroupsResponse>(
    primaryInput.url,
    signal,
    getAdapterTimeout(config, 15_000),
    ctx,
  );

  const groups = payload.results;
  if (!Array.isArray(groups) || groups.length === 0) {
    throw new Error("sky-makercore: groups results array is empty or missing");
  }

  const slices = adaptSkyModules(groups);
  if (slices.length === 0) {
    throw new Error("sky-makercore: all module debt values are zero or invalid");
  }

  const totalCollateralUsd = groups.reduce((sum, g) => sum + parseCollateral(g.collateral), 0);
  const immediateRedeemableUsd = resolveSkyImmediateRedeemableUsd(groups);

  // Snapshot timestamp from the first result's datetime field
  const datetimeStr = groups[0].datetime;
  const snapshotEpoch = datetimeStr ? Math.floor(new Date(datetimeStr + "Z").getTime() / 1000) : 0;

  const unknown = listUnknownGroups(groups);
  const warnings: LiveReserveWarning[] = unknown.map((group) =>
    reserveDegradedWarning("unknown-asset", `Sky module bucketed into other: ${group}`),
  );

  const totalDebt = groups.reduce((sum, g) => sum + parseDebt(g.debt), 0);
  const unknownDebt = groups.filter((g) => !KNOWN_GROUPS.has(g.group)).reduce((sum, g) => sum + parseDebt(g.debt), 0);

  return {
    slices,
    metadata: {
      tokenCount: groups.length,
      totalCollateralUsd: Math.round(totalCollateralUsd),
      immediateRedeemableUsd,
      snapshotDate: snapshotEpoch,
      ...(snapshotEpoch > 0
        ? verifiedFreshnessMetadata(snapshotEpoch)
        : unverifiedFreshnessMetadata(
            "module-groups-api",
            "Sky groups payload did not expose a trustworthy snapshot timestamp",
          )),
      unknownExposurePct: totalDebt > 0 ? (unknownDebt / totalDebt) * 100 : 0,
    },
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd worker && npx vitest run src/cron/reserve-adapters/__tests__/sky-makercore.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Run worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add worker/src/cron/reserve-adapters/sky-makercore.ts worker/src/cron/reserve-adapters/__tests__/sky-makercore.test.ts
git commit -m "feat(reserves): rewrite sky-makercore adapter to use Block Analitica module-level API

Replaces the stale DefiLlama token-level source with info-sky.blockanalitica.com
groups endpoint. Produces 7 risk-labeled slices matching the official Sky dashboard
modules: Stablecoins (PSM), Spark, Grove, Obex, Core, Staking Engine, Legacy RWA."
```

---

### Task 3: Update config for USDS and DAI

**Files:**
- Modify: `shared/data/stablecoins/usd-major.json` (USDS entry around line 856, DAI entry around line 1128)

- [ ] **Step 1: Update USDS static reserves and liveReservesConfig URL**

In the `usds-sky` entry, replace the `reserves` array (lines 856–878) with:

```json
    "reserves": [
      {
        "name": "Stablecoins (PSM)",
        "pct": 38,
        "risk": "very-low",
        "coinId": "usdc-circle",
        "depType": "mechanism"
      },
      {
        "name": "Spark (lending)",
        "pct": 28,
        "risk": "low"
      },
      {
        "name": "Grove (RWA)",
        "pct": 23,
        "risk": "low"
      },
      {
        "name": "Obex",
        "pct": 5,
        "risk": "medium"
      },
      {
        "name": "Core (crypto vaults)",
        "pct": 4,
        "risk": "medium"
      },
      {
        "name": "Staking Engine",
        "pct": 1,
        "risk": "high"
      },
      {
        "name": "Legacy RWA",
        "pct": 1,
        "risk": "low"
      }
    ],
```

In the same entry, replace the `inputs.primary.url` (line 892):
```
"url": "https://info-sky.blockanalitica.com/groups/?days_ago=1&order=-debt"
```

- [ ] **Step 2: Update DAI static reserves and liveReservesConfig URL**

In the `dai-makerdao` entry, apply the same changes: replace `reserves` array (lines 1128–1155) with the identical array from Step 1, and replace `inputs.primary.url` (line 1169) with:
```
"url": "https://info-sky.blockanalitica.com/groups/?days_ago=1&order=-debt"
```

DAI and USDS share the same Vat, so they share the same reserve composition.

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: No errors

- [ ] **Step 4: Run full build + type-check**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git add shared/data/stablecoins/usd-major.json
git commit -m "feat(reserves): update USDS and DAI config to Block Analitica source

Updates static fallback reserves to match current module proportions.
Points primary input URL at info-sky.blockanalitica.com groups endpoint."
```

---

### Task 4: Run merge gate and verify

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 2: Run merge gate**

Run: `npm run test:merge-gate`
Expected: Gate passes

- [ ] **Step 3: Verify adapter works against live API**

Run from worker dev or via curl:
```bash
curl -s 'https://info-sky.blockanalitica.com/groups/?days_ago=1&order=-debt' | python3 -c "
import json, sys
data = json.load(sys.stdin)
for r in data['results']:
    print(f\"{r['group_name']:20s} debt={float(r['debt'])/1e9:.2f}B  collateral={float(r['collateral'])/1e9:.2f}B\")
print(f\"Total modules: {data['count']}\")
"
```
Expected: 7 modules listed with non-zero debt values matching the Sky dashboard.
