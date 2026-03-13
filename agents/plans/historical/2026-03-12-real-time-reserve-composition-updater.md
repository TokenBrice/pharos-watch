# Live Reserve Composition Sync — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a generic, adapter-driven pipeline that syncs stablecoin reserve composition from live data sources into D1 daily, serves it via a new API endpoint, and replaces the hardcoded static reserves on the frontend detail page — with the infiniFi protocol data API as the first adapter.

**Architecture:** A `liveReservesConfig` field on `StablecoinMeta` declares the adapter + URL for each coin. A daily cron job (`sync-live-reserves`) iterates configured coins, checks the circuit breaker, fetches via registered adapters using `fetchWithRetry`, converts raw responses to `ReserveSlice[]`, and upserts into the `reserve_composition` D1 table. A new `GET /api/stablecoin-reserves/:id` endpoint serves live data from D1; the frontend hook only fires for configured coins and the view model falls back to static `getReserves(coin)` when no live record is available.

**Tech stack:** TypeScript strict, Cloudflare Workers + D1, Vitest, TanStack Query (React), `shared/lib/reserve-templates.ts` for `ReserveResult` type, `logCronRun`/`runCronWithLease` wrapper pattern, `matchDynamicRoute` router pattern, `fetchWithRetry` + circuit breaker pattern.

**Design decisions:**
- **No history table (v1):** The `reserve_composition` table stores one row per coin (latest snapshot only). Historical tracking can be added later if needed — the daily cron cadence means at most one row per coin per day, and the static `reserves` field in metadata preserves the last-known-good baseline.
- **URL duplication with `proofOfReserves`:** `liveReservesConfig.url` intentionally duplicates `proofOfReserves.url`. They serve different purposes — `proofOfReserves` is a display/audit concept, `liveReservesConfig` is an operational/cron concept. They may diverge if a protocol has separate display and API endpoints.
- **Connection budget:** The daily-0800 trigger currently uses ≤2 concurrent external connections. Each adapter fetch is sequential (one coin at a time), adding at most 1 connection. If more adapters are added, the cron must stay sequential to respect the 6-connection pool budget.

---

## Reference: Key Files

| Purpose | File |
|---|---|
| Stablecoin metadata | `shared/lib/stablecoins.ts` |
| Shared types | `shared/types/index.ts` |
| Reserve types + helpers | `shared/lib/reserve-templates.ts` |
| Cron job registry | `shared/lib/cron-jobs.ts` |
| API path registry | `shared/lib/api-endpoints.ts` |
| Worker router | `worker/src/router.ts` |
| Daily-0800 cron slot | `worker/src/handlers/scheduled/daily-0800.ts` |
| D1 migrations | `worker/migrations/` (latest: `0063_telegram_global_alerts.sql`) |
| View model | `src/lib/stablecoin-detail-view-model.ts` |
| View model hook | `src/hooks/use-stablecoin-detail-view-model.ts` |
| Reserve treemap | `src/components/reserve-treemap.tsx` |
| Overview section | `src/components/stablecoin-detail/overview-section.tsx` |
| Existing cron pattern | `worker/src/cron/sync-usds-status.ts` |
| Existing API test pattern | `worker/src/api/__tests__/mint-burn-flows.test.ts` |
| Circuit breaker | `worker/src/lib/circuit-breaker.ts` |
| Circuit source keys | `worker/src/lib/constants.ts` (`CIRCUIT_SOURCE`) |
| Fetch with retry | `worker/src/lib/fetch-retry.ts` (`fetchWithRetry`) |
| Mock D1 helper | `worker/src/api/__tests__/helpers/mock-d1.ts` |
| API response helpers | `worker/src/lib/api-utils.ts` (`jsonFreshResponse`, `errorResponse`) |
| On-chain read pattern | `worker/src/cron/sync-usds-status.ts` (Etherscan V2 `eth_call` / `eth_getStorageAt`) |
| Chain RPC configs | `worker/src/lib/chain-registry.ts` (`getChainRpc`, `initChainRpcs`) |

---

## Chunk 1: Data Layer

### Task 1: D1 migration — `reserve_composition` table

**Files:**
- Create: `worker/migrations/0064_reserve_composition.sql`

- [ ] **Step 1: Create migration file**

```sql
-- worker/migrations/0064_reserve_composition.sql
CREATE TABLE IF NOT EXISTS reserve_composition (
  stablecoin_id TEXT NOT NULL PRIMARY KEY,
  slices        TEXT NOT NULL,     -- JSON: ReserveSlice[]
  fetched_at    INTEGER NOT NULL,  -- Unix seconds
  source        TEXT NOT NULL      -- adapter key (e.g., "infinifi")
);
```

- [ ] **Step 2: Apply to remote D1**

```bash
cd worker
npx wrangler d1 execute stablecoin-db --remote --file migrations/0064_reserve_composition.sql
```

Expected: `Successfully executed SQL`

- [ ] **Step 3: Verify table exists**

```bash
npx wrangler d1 execute stablecoin-db --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table' AND name='reserve_composition';"
```

Expected: one row with `name = reserve_composition`

- [ ] **Step 4: Commit**

```bash
git add worker/migrations/0064_reserve_composition.sql
git commit -m "feat(db): add reserve_composition table for live reserve sync"
```

---

### Task 2: Shared types + metadata config

**Files:**
- Modify: `shared/types/index.ts` — add `LiveReservesConfig` type + `StablecoinMeta.liveReservesConfig`
- Modify: `shared/lib/reserve-templates.ts` — extend `ReserveResult` with optional `liveAt`
- Modify: `shared/lib/stablecoins.ts` — add `liveReservesConfig` to `iusd-infinifi`
- Modify: `worker/src/lib/constants.ts` — add `LIVE_RESERVES` to `CIRCUIT_SOURCE`

- [ ] **Step 1: Add `LiveReservesConfig` type to `shared/types/index.ts`**

Find the `StablecoinMeta` interface and add before it:

```ts
/** Configuration for live reserve composition sync. */
export interface LiveReservesConfig {
  /** Registered adapter key (e.g., "infinifi", "circle", "bold-onchain"). */
  adapter: string;
  /** Machine-readable URL the cron adapter fetches. Empty string for on-chain adapters. */
  url: string;
  /** Human-readable URL for the "source" link shown in the UI (e.g. stats page). */
  displayUrl?: string;
}
```

Then add to `StablecoinMeta`:

```ts
liveReservesConfig?: LiveReservesConfig;
```

(Place after `reserves?: ReserveSlice[];` — line ~168)

- [ ] **Step 2: Extend `ReserveResult` in `shared/lib/reserve-templates.ts`**

```ts
export interface ReserveResult {
  reserves: ReserveSlice[];
  estimated: boolean;
  /** Unix seconds. Present when reserves came from a live sync (not static). */
  liveAt?: number;
  /** Adapter key. Present when reserves came from a live sync. */
  source?: string;
  /** Human-readable URL to link to. Present when reserves came from a live sync. */
  displayUrl?: string;
}
```

- [ ] **Step 3: Add `liveReservesConfig` to `iusd-infinifi` in `shared/lib/stablecoins.ts`**

In the `iusd-infinifi` entry (after `proofOfReserves`):

```ts
liveReservesConfig: {
  adapter: "infinifi",
  url: "https://eth-api.infinifi.xyz/api/protocol/data",
  displayUrl: "https://stats.infinifi.xyz/",
},
```

- [ ] **Step 4: Add `LIVE_RESERVES` to `CIRCUIT_SOURCE` in `worker/src/lib/constants.ts`**

```ts
LIVE_RESERVES: "live-reserves",
```

(Add after the last entry in `CIRCUIT_SOURCE`)

- [ ] **Step 5: Type-check**

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | grep -v "\.test\."
cd worker && npx tsc --noEmit 2>&1 | grep "error TS"
```

Expected: no output (no errors)

- [ ] **Step 6: Commit**

```bash
git add shared/types/index.ts shared/lib/reserve-templates.ts shared/lib/stablecoins.ts worker/src/lib/constants.ts
git commit -m "feat(types): add LiveReservesConfig type, liveReservesConfig metadata field, and circuit source"
```

---

## Chunk 2: Worker — Adapter + Cron

### Task 3: Adapter registry + InfiniFi adapter

**Files:**
- Create: `worker/src/cron/reserve-adapters/index.ts`
- Create: `worker/src/cron/reserve-adapters/infinifi.ts`
- Create: `worker/src/cron/reserve-adapters/__tests__/infinifi.test.ts`

#### Adapter contract

An adapter has two parts — a pure transform function and a fetch+transform wrapper. The fetch wrapper receives an optional `AdapterContext` for adapters that need worker infrastructure (e.g., RPC access for on-chain reads):

```ts
/** Context passed from the cron to adapters that need worker infrastructure. */
export interface AdapterContext {
  /** Etherscan API key for on-chain reads via Etherscan V2 proxy. */
  etherscanApiKey?: string;
  /** Alchemy API key for direct JSON-RPC calls. */
  alchemyApiKey?: string;
}

export interface AdapterResult {
  slices: ReserveSlice[];
  /** Position/farm names not in the adapter's risk map (for operator awareness). */
  unknownFarms?: string[];
}

/** Adapter function: fetch data from `url` (or on-chain), transform to slices. */
type AdapterFn = (url: string, signal: AbortSignal, ctx?: AdapterContext) => Promise<AdapterResult>;
```

- **JSON API adapters** (InfiniFi): fetch the URL, parse JSON, transform. Ignore `ctx`.
- **HTML scraping adapters** (Circle): fetch the URL, parse embedded JS variables, transform. Ignore `ctx`.
- **On-chain adapters** (BOLD): use `ctx.etherscanApiKey` to make `eth_call` via Etherscan V2 proxy (existing pattern in `sync-blacklist.ts` and `sync-usds-status.ts`). The `url` field in `liveReservesConfig` is unused — set to `""`.

The cron applies circuit breaker logic at the registry level before calling the adapter.

#### InfiniFi API response shape (relevant fields)

```ts
// Minimal types — only what we need from https://eth-api.infinifi.xyz/api/protocol/data
interface InfiniFiFarm {
  name: string;
  label: string;
  assets: string;           // raw wei
  assetsNormalized: number; // USD
  type: "LIQUID" | "ILLIQUID" | "PROTOCOL";
  underlyingAssetSymbol: string;
}
interface InfiniFiProtocolData {
  code: "OK";
  data: {
    stats: {
      asset: { totalTVLAssetNormalized: number };
    };
    farms: InfiniFiFarm[];
  };
}
```

#### Risk + coinId mapping

Assign risk and coinId by farm name. Maintained as a lookup table in `infinifi.ts`:

| Farm `name` | risk | coinId | depType |
|---|---|---|---|
| `fasanara-rwa-farm`, `fasanara-gdaf` | `"high"` | — | — |
| `falconx-farm` | `"high"` | — | — |
| `morpho-v2-sentora-pyusd` | `"high"` | — | — |
| `maple-farm-institutional`, `maple-farm-syrup` | `"high"` | — | — |
| `spark-sUSDC-refcode` | `"low"` | `"usdc-circle"` | `"wrapper"` |
| `fluid-fUSDC` | `"low"` | `"usdc-circle"` | `"wrapper"` |
| `aavev3`, `aavev3-horizon-usdc`, `aavev3-rlusd-farm` | `"low"` | `"usdc-circle"` | `"wrapper"` |
| `euler-sentora-usdc` | `"low"` | `"usdc-circle"` | `"wrapper"` |
| `morpho-steakUSDCinfinifi`, `capfarm`, `tokemak-autoUSD`, `gauntlet-alpha-farm`, `reservoir-wsrUSD` | `"medium"` | — | — |
| `sGHO` | `"medium"` | — | — |
| unknown farms with `type: "LIQUID"` | `"low"` | — | — |
| unknown farms with `type: "ILLIQUID"` | `"medium"` | — | — |

Farms with `type: "PROTOCOL"` or `assetsNormalized === 0` are skipped.

#### Percentage computation

```
pct = round((farm.assetsNormalized / totalTVLAssetNormalized) * 100)
```

Percentages that round to 0 are dropped. After rounding, if the sum differs from 100 due to rounding, adjust the largest slice — but only if the adjustment wouldn't make it ≤ 0 (in that edge case, accept the imperfect sum).

- [ ] **Step 1: Write failing test for InfiniFi adapter**

```ts
// worker/src/cron/reserve-adapters/__tests__/infinifi.test.ts
import { describe, expect, it } from "vitest";
import { adaptInfiniFi } from "../infinifi";

const SAMPLE_RESPONSE = {
  code: "OK",
  data: {
    stats: {
      asset: { totalTVLAssetNormalized: 100 },
    },
    farms: [
      {
        name: "fasanara-gdaf",
        label: "Fasanara mGLOBAL",
        assetsNormalized: 40,
        type: "ILLIQUID",
        underlyingAssetSymbol: "USDC",
      },
      {
        name: "spark-sUSDC-refcode",
        label: "Spark sUSDC",
        assetsNormalized: 30,
        type: "LIQUID",
        underlyingAssetSymbol: "sUSDC",
      },
      {
        name: "fluid-fUSDC",
        label: "Fluid USDC",
        assetsNormalized: 30,
        type: "LIQUID",
        underlyingAssetSymbol: "USDC",
      },
      {
        name: "MintController",
        label: "Mint Controller",
        assetsNormalized: 0,
        type: "PROTOCOL",
        underlyingAssetSymbol: "USDC",
      },
    ],
  },
};

describe("adaptInfiniFi", () => {
  it("converts farm data to ReserveSlice[], skips PROTOCOL and zero-asset farms", () => {
    const slices = adaptInfiniFi(SAMPLE_RESPONSE as any);
    expect(slices).toHaveLength(3);
    expect(slices.find((s) => s.name.includes("Fasanara"))).toMatchObject({
      pct: 40,
      risk: "high",
    });
    expect(slices.find((s) => s.name.includes("Spark"))).toMatchObject({
      pct: 30,
      risk: "low",
      coinId: "usdc-circle",
      depType: "wrapper",
    });
  });

  it("sums to 100 after rounding", () => {
    const total = adaptInfiniFi(SAMPLE_RESPONSE as any).reduce((acc, s) => acc + s.pct, 0);
    expect(total).toBe(100);
  });

  it("drops farms where assetsNormalized is 0", () => {
    const slices = adaptInfiniFi(SAMPLE_RESPONSE as any);
    expect(slices.every((s) => s.pct > 0)).toBe(true);
  });

  it("returns unknown farm names in a separate list", () => {
    const response = {
      ...SAMPLE_RESPONSE,
      data: {
        ...SAMPLE_RESPONSE.data,
        farms: [
          ...SAMPLE_RESPONSE.data.farms,
          { name: "brand-new-farm", label: "Brand New", assetsNormalized: 10, type: "LIQUID", underlyingAssetSymbol: "USDC" },
        ],
        stats: { asset: { totalTVLAssetNormalized: 110 } },
      },
    };
    const result = adaptInfiniFi(response as any);
    expect(result.unknownFarms).toContain("brand-new-farm");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd worker && npx vitest run src/cron/reserve-adapters/__tests__/infinifi.test.ts
```

Expected: FAIL — `adaptInfiniFi` not found

- [ ] **Step 3: Implement `worker/src/cron/reserve-adapters/infinifi.ts`**

```ts
// worker/src/cron/reserve-adapters/infinifi.ts
import type { ReserveSlice } from "@shared/types";
import { fetchWithRetry } from "../../lib/fetch-retry";

interface InfiniFiFarm {
  name: string;
  label: string;
  assetsNormalized: number;
  type: "LIQUID" | "ILLIQUID" | "PROTOCOL";
  underlyingAssetSymbol: string;
}

interface InfiniFiProtocolData {
  code: string;
  data: {
    stats: { asset: { totalTVLAssetNormalized: number } };
    farms: InfiniFiFarm[];
  };
}

interface FarmRiskConfig {
  risk: ReserveSlice["risk"];
  coinId?: string;
  depType?: ReserveSlice["depType"];
}

const FARM_RISK_MAP: Record<string, FarmRiskConfig> = {
  "fasanara-rwa-farm":      { risk: "high" },
  "fasanara-gdaf":          { risk: "high" },
  "falconx-farm":           { risk: "high" },
  "morpho-v2-sentora-pyusd":{ risk: "high" },
  "maple-farm-institutional":{ risk: "high" },
  "maple-farm-syrup":       { risk: "high" },
  "spark-sUSDC-refcode":    { risk: "low", coinId: "usdc-circle", depType: "wrapper" },
  "fluid-fUSDC":            { risk: "low", coinId: "usdc-circle", depType: "wrapper" },
  "aavev3":                 { risk: "low", coinId: "usdc-circle", depType: "wrapper" },
  "aavev3-horizon-usdc":    { risk: "low", coinId: "usdc-circle", depType: "wrapper" },
  "aavev3-rlusd-farm":      { risk: "low", coinId: "usdc-circle", depType: "wrapper" },
  "euler-sentora-usdc":     { risk: "low", coinId: "usdc-circle", depType: "wrapper" },
  "morpho-steakUSDCinfinifi":{ risk: "medium" },
  "capfarm":                { risk: "medium" },
  "tokemak-autoUSD":        { risk: "medium" },
  "gauntlet-alpha-farm":    { risk: "medium" },
  "reservoir-wsrUSD":       { risk: "medium" },
  "sGHO":                   { risk: "medium" },
};

export interface AdaptInfiniFiResult {
  slices: ReserveSlice[];
  /** Farm names not found in FARM_RISK_MAP (for operator awareness). */
  unknownFarms: string[];
}

/** Convert raw InfiniFi protocol data to ReserveSlice[]. Pure function — no I/O. */
export function adaptInfiniFi(payload: InfiniFiProtocolData): AdaptInfiniFiResult {
  const tvl = payload.data.stats.asset.totalTVLAssetNormalized;
  if (!tvl || tvl <= 0) return { slices: [], unknownFarms: [] };

  const activeFarms = payload.data.farms.filter(
    (f) => f.type !== "PROTOCOL" && f.assetsNormalized > 0,
  );

  const unknownFarms: string[] = [];

  // Raw pct per farm
  const rawSlices = activeFarms.map((f) => {
    const config = FARM_RISK_MAP[f.name];
    if (!config) unknownFarms.push(f.name);
    const risk: ReserveSlice["risk"] = config?.risk
      ?? (f.type === "LIQUID" ? "low" : "medium");
    return {
      name: f.label,
      pct: Math.round((f.assetsNormalized / tvl) * 100),
      risk,
      ...(config?.coinId ? { coinId: config.coinId } : {}),
      ...(config?.depType ? { depType: config.depType } : {}),
    } satisfies ReserveSlice;
  }).filter((s) => s.pct > 0);

  // Adjust largest slice so total sums to exactly 100
  const sum = rawSlices.reduce((acc, s) => acc + s.pct, 0);
  if (sum !== 100 && rawSlices.length > 0) {
    const maxIdx = rawSlices.reduce(
      (maxI, s, i, arr) => (s.pct > arr[maxI].pct ? i : maxI),
      0,
    );
    const adjustment = 100 - sum;
    // Guard: only adjust if the result stays positive
    if (rawSlices[maxIdx].pct + adjustment > 0) {
      rawSlices[maxIdx].pct += adjustment;
    }
  }

  return { slices: rawSlices, unknownFarms };
}

/** Fetch + adapt infiniFi protocol data. Uses fetchWithRetry for resilience. */
export async function fetchInfiniFiReserves(
  url: string,
  signal: AbortSignal,
): Promise<AdaptInfiniFiResult> {
  const res = await fetchWithRetry(url, { signal }, 2, { timeoutMs: 10_000 });
  if (!res) throw new Error("infiniFi API: fetchWithRetry returned null (all retries failed)");
  if (!res.ok) throw new Error(`infiniFi API ${res.status}`);
  const payload = await res.json() as InfiniFiProtocolData;
  if (payload.code !== "OK") throw new Error("infiniFi API returned non-OK code");
  return adaptInfiniFi(payload);
}
```

- [ ] **Step 4: Create adapter registry `worker/src/cron/reserve-adapters/index.ts`**

```ts
// worker/src/cron/reserve-adapters/index.ts
import { fetchInfiniFiReserves } from "./infinifi";
import type { ReserveSlice } from "@shared/types";

/** Context passed from the cron to adapters that need worker infrastructure. */
export interface AdapterContext {
  etherscanApiKey?: string;
  alchemyApiKey?: string;
}

export interface AdapterResult {
  slices: ReserveSlice[];
  /** Position/farm names not in the adapter's risk map (for operator awareness). */
  unknownFarms?: string[];
}

type AdapterFn = (url: string, signal: AbortSignal, ctx?: AdapterContext) => Promise<AdapterResult>;

const ADAPTERS: Record<string, AdapterFn> = {
  infinifi: fetchInfiniFiReserves,
};

/** Returns the adapter function for the given key, or null if unknown. */
export function getReserveAdapter(adapterKey: string): AdapterFn | null {
  return ADAPTERS[adapterKey] ?? null;
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd worker && npx vitest run src/cron/reserve-adapters/__tests__/infinifi.test.ts
```

Expected: all tests PASS

- [ ] **Step 6: Type-check worker**

```bash
cd worker && npx tsc --noEmit 2>&1 | grep "error TS"
```

Expected: no output

- [ ] **Step 7: Commit**

```bash
git add worker/src/cron/reserve-adapters/
git commit -m "feat(cron): add reserve adapter registry with infiniFi adapter"
```

---

### Task 4: `sync-live-reserves` cron job

**Files:**
- Create: `worker/src/cron/sync-live-reserves.ts`
- Create: `worker/src/cron/__tests__/sync-live-reserves.test.ts`
- Modify: `shared/lib/cron-jobs.ts` — add `sync-live-reserves` to `CRON_JOB_DEFINITIONS_BASE`
- Modify: `worker/src/handlers/scheduled/daily-0800.ts` — wire in the cron

- [ ] **Step 1: Write failing cron test**

```ts
// worker/src/cron/__tests__/sync-live-reserves.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";

// Mock the adapter registry so tests don't make real HTTP calls
vi.mock("../reserve-adapters/index", () => ({
  getReserveAdapter: vi.fn().mockReturnValue(
    async () => ({ slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }], unknownFarms: [] })
  ),
}));

// Mock circuit breaker — always allow fetch
vi.mock("../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: vi.fn().mockResolvedValue(true),
  recordOutcomeSafe: vi.fn().mockResolvedValue(undefined),
}));

describe("syncLiveReserves", () => {
  it("upserts one row per configured coin and returns itemCount", async () => {
    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    const result = await syncLiveReserves(db, new AbortController().signal, {});
    // iusd-infinifi has liveReservesConfig — expect 1 coin processed
    expect(result?.itemCount).toBe(1);
  });

  it("skips coins without liveReservesConfig", async () => {
    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    const result = await syncLiveReserves(db, new AbortController().signal, {});
    // Only iusd-infinifi is configured so far
    expect(result?.itemCount).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd worker && npx vitest run src/cron/__tests__/sync-live-reserves.test.ts
```

Expected: FAIL — `syncLiveReserves` not found

- [ ] **Step 3: Implement `worker/src/cron/sync-live-reserves.ts`**

```ts
// worker/src/cron/sync-live-reserves.ts
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import type { CronResult } from "../lib/db";
import { batchExecute } from "../lib/db";
import { getReserveAdapter, type AdapterContext } from "./reserve-adapters/index";
import { shouldAttemptFetch, recordOutcomeSafe } from "../lib/circuit-breaker";
import { CIRCUIT_SOURCE } from "../lib/constants";

const CONFIGURED_COINS = TRACKED_STABLECOINS.filter((c) => c.liveReservesConfig);

export async function syncLiveReserves(
  db: D1Database,
  signal: AbortSignal,
  adapterCtx?: AdapterContext,
): Promise<CronResult> {
  let synced = 0;
  let failed = 0;
  const now = Math.floor(Date.now() / 1000);
  const allUnknownFarms: string[] = [];

  // Circuit breaker check — one breaker for all live-reserves sources
  const canFetch = await shouldAttemptFetch(db, CIRCUIT_SOURCE.LIVE_RESERVES);
  if (!canFetch) {
    return {
      itemCount: 0,
      metadata: JSON.stringify({ synced: 0, failed: 0, total: CONFIGURED_COINS.length, circuitOpen: true }),
    };
  }

  const upserts: D1PreparedStatement[] = [];

  for (const coin of CONFIGURED_COINS) {
    const config = coin.liveReservesConfig!;
    const adapter = getReserveAdapter(config.adapter);
    if (!adapter) {
      console.warn(`[sync-live-reserves] Unknown adapter "${config.adapter}" for ${coin.id}`);
      failed++;
      continue;
    }

    try {
      const result = await adapter(config.url, signal, adapterCtx);
      if (result.slices.length === 0) {
        console.warn(`[sync-live-reserves] Adapter returned empty slices for ${coin.id}`);
        failed++;
        continue;
      }
      if (result.unknownFarms && result.unknownFarms.length > 0) {
        console.warn(`[sync-live-reserves] Unknown farms for ${coin.id}: ${result.unknownFarms.join(", ")}`);
        allUnknownFarms.push(...result.unknownFarms);
      }
      upserts.push(
        db
          .prepare(
            `INSERT INTO reserve_composition (stablecoin_id, slices, fetched_at, source)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(stablecoin_id) DO UPDATE SET
               slices = excluded.slices,
               fetched_at = excluded.fetched_at,
               source = excluded.source`,
          )
          .bind(coin.id, JSON.stringify(result.slices), now, config.adapter),
      );
      synced++;
    } catch (e) {
      console.error(`[sync-live-reserves] Failed for ${coin.id}:`, e);
      failed++;
    }
  }

  // Record circuit breaker outcome
  await recordOutcomeSafe(db, CIRCUIT_SOURCE.LIVE_RESERVES, failed < CONFIGURED_COINS.length);

  if (upserts.length > 0) {
    await batchExecute(db, upserts);
  }

  return {
    itemCount: synced,
    metadata: JSON.stringify({
      synced,
      failed,
      total: CONFIGURED_COINS.length,
      ...(allUnknownFarms.length > 0 ? { unknownFarms: allUnknownFarms } : {}),
    }),
  };
}
```

- [ ] **Step 4: Add `sync-live-reserves` to `shared/lib/cron-jobs.ts`**

In `CRON_JOB_DEFINITIONS_BASE`, after `sync-usds-status`:

```ts
{
  job: "sync-live-reserves",
  label: "Live reserve sync",
  group: "daily",
  intervalSec: 86400,
  scheduleKey: "daily0800Utc",
  triggerMode: "shared",
},
```

- [ ] **Step 5: Wire into `worker/src/handlers/scheduled/daily-0800.ts`**

Add import and registration:

```ts
import { syncLiveReserves } from "../../cron/sync-live-reserves";

// Add inside runDaily0800Slot:
runtime.ctx.waitUntil(
  runtime.runLeasedCron("sync-live-reserves", (signal) =>
    syncLiveReserves(runtime.db, signal, {
      etherscanApiKey: runtime.env.ETHERSCAN_API_KEY,
      alchemyApiKey: runtime.env.ALCHEMY_API_KEY,
    }),
  )
);
```

- [ ] **Step 6: Run tests**

```bash
cd worker && npx vitest run src/cron/__tests__/sync-live-reserves.test.ts
```

Expected: PASS

- [ ] **Step 7: Type-check**

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | grep -v "\.test\."
cd worker && npx tsc --noEmit 2>&1 | grep "error TS"
```

Expected: no output

- [ ] **Step 8: Commit**

```bash
git add \
  worker/src/cron/sync-live-reserves.ts \
  worker/src/cron/__tests__/sync-live-reserves.test.ts \
  shared/lib/cron-jobs.ts \
  worker/src/handlers/scheduled/daily-0800.ts
git commit -m "feat(cron): add sync-live-reserves daily cron job with circuit breaker"
```

---

## Chunk 3: API Endpoint

### Task 5: `GET /api/stablecoin-reserves/:id`

**Files:**
- Create: `worker/src/api/stablecoin-reserves.ts`
- Create: `worker/src/api/__tests__/stablecoin-reserves.test.ts`
- Modify: `shared/lib/api-endpoints.ts` — add path + endpoint definition
- Modify: `worker/src/router.ts` — add dynamic route + import

#### Response shape

```ts
// 200 OK — live data found
{
  stablecoinId: string;
  slices: ReserveSlice[];
  fetchedAt: number;   // Unix seconds
  source: string;      // adapter key
  estimated: false;
}

// 404 — no live data in D1 (cron hasn't run or coin not configured)
{ error: "Not found" }
```

- [ ] **Step 1: Write failing test**

> **Note:** `mockD1()` takes `MockTableConfig[]` — an array of objects with `match` (SQL substring), `rows` (for `.all()`), and `first` (for `.first()`). See `worker/src/api/__tests__/helpers/mock-d1.ts`.

```ts
// worker/src/api/__tests__/stablecoin-reserves.test.ts
import { describe, expect, it } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { handleStablecoinReserves } from "../stablecoin-reserves";

describe("handleStablecoinReserves", () => {
  it("returns 404 when no live data exists in D1", async () => {
    const db = mockD1();
    const res = await handleStablecoinReserves(db, "iusd-infinifi");
    expect(res.status).toBe(404);
  });

  it("returns live slices when D1 has data", async () => {
    const slices = [{ name: "Test Farm", pct: 100, risk: "low" as const }];
    const db = mockD1([
      {
        match: "reserve_composition",
        rows: [],
        first: {
          stablecoin_id: "iusd-infinifi",
          slices: JSON.stringify(slices),
          fetched_at: 1000,
          source: "infinifi",
        },
      },
    ]);
    const res = await handleStablecoinReserves(db, "iusd-infinifi");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.slices).toEqual(slices);
    expect(body.estimated).toBe(false);
    expect(body.source).toBe("infinifi");
  });

  it("returns 404 for unknown stablecoin IDs", async () => {
    const db = mockD1();
    const res = await handleStablecoinReserves(db, "not-a-coin");
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd worker && npx vitest run src/api/__tests__/stablecoin-reserves.test.ts
```

Expected: FAIL

- [ ] **Step 3: Implement `worker/src/api/stablecoin-reserves.ts`**

> **Note:** Use `jsonFreshResponse` (not `jsonResponse`) for Cache-Control support. Use `TRACKED_IDS` (not `TRACKED_STABLECOIN_IDS`) — that's the actual export name.

```ts
// worker/src/api/stablecoin-reserves.ts
import { jsonFreshResponse, errorResponse } from "../lib/api-utils";
import { TRACKED_IDS } from "@shared/lib/stablecoins";
import type { ReserveSlice } from "@shared/types";

interface ReserveCompositionRow {
  stablecoin_id: string;
  slices: string;
  fetched_at: number;
  source: string;
}

export async function handleStablecoinReserves(
  db: D1Database,
  stablecoinId: string,
): Promise<Response> {
  // Reject unknown IDs early
  if (!TRACKED_IDS.has(stablecoinId)) {
    return errorResponse(404, "Not found");
  }

  const row = await db
    .prepare(
      "SELECT stablecoin_id, slices, fetched_at, source FROM reserve_composition WHERE stablecoin_id = ?",
    )
    .bind(stablecoinId)
    .first<ReserveCompositionRow>();

  if (!row) {
    return errorResponse(404, "Not found");
  }

  let slices: ReserveSlice[];
  try {
    slices = JSON.parse(row.slices) as ReserveSlice[];
  } catch {
    return errorResponse(500, "Malformed reserve data");
  }

  return jsonFreshResponse(
    {
      stablecoinId: row.stablecoin_id,
      slices,
      fetchedAt: row.fetched_at,
      source: row.source,
      estimated: false,
    },
    { cacheControl: "public, s-maxage=3600, max-age=300" },
  );
}
```

- [ ] **Step 4: Add to `shared/lib/api-endpoints.ts`**

In `API_PATHS`:
```ts
stablecoinReserves: (stablecoinId: string) => `/api/stablecoin-reserves/${encodeURIComponent(stablecoinId)}`,
```

In `ENDPOINT_DEFINITIONS`:
```ts
{
  path: "/api/stablecoin-reserves/iusd-infinifi",
  methods: ["GET"],
  adminRequired: false,
  mutatingAdmin: false,
  cacheBypass: false,
  handlerKey: "stablecoin-reserves-probe",
  probeGroup: "public",
},
```

- [ ] **Step 5: Wire into `worker/src/router.ts`**

Add import at top:
```ts
import { handleStablecoinReserves } from "./api/stablecoin-reserves";
```

Add dynamic route after the `stablecoin-summary` route:

> **Note:** The `matchDynamicRoute` handler takes 3 args: `(db, canonicalId, ctx)`. Include `_ctx` even if unused.

```ts
const reservesResult = matchDynamicRoute(
  path,
  /^\/api\/stablecoin-reserves\/(.+)$/,
  (db, id, _ctx) => handleStablecoinReserves(db, id),
  db,
  ctx,
);
if (reservesResult) return reservesResult;
```

Also add to `STATIC_ROUTE_HANDLER_BY_KEY` for the probe:
```ts
"stablecoin-reserves-probe": ({ db }) => handleStablecoinReserves(db, "iusd-infinifi"),
```

- [ ] **Step 6: Run tests**

```bash
cd worker && npx vitest run src/api/__tests__/stablecoin-reserves.test.ts
```

Expected: PASS

- [ ] **Step 7: Type-check**

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | grep -v "\.test\."
cd worker && npx tsc --noEmit 2>&1 | grep "error TS"
```

Expected: no output

- [ ] **Step 8: Smoke test against local worker**

```bash
cd worker && npx wrangler dev &
sleep 3
curl -s http://localhost:8787/api/stablecoin-reserves/iusd-infinifi | jq .
```

Expected: `{ "error": "Not found" }` (404 — cron not yet run) or live data if D1 already populated.

- [ ] **Step 9: Commit**

```bash
git add \
  worker/src/api/stablecoin-reserves.ts \
  worker/src/api/__tests__/stablecoin-reserves.test.ts \
  shared/lib/api-endpoints.ts \
  worker/src/router.ts
git commit -m "feat(api): add GET /api/stablecoin-reserves/:id endpoint"
```

---

## Chunk 4: Frontend

### Task 6: Hook + view model integration + treemap label

**Files:**
- Create: `src/hooks/use-stablecoin-reserves.ts`
- Modify: `src/lib/stablecoin-detail-view-model.ts` — prefer live reserves
- Modify: `src/hooks/use-stablecoin-detail-view-model.ts` — pass live data in
- Modify: `src/components/stablecoin-detail/overview-section.tsx` — show "Live" vs "Estimated" label
- Modify: `src/components/reserve-treemap.tsx` — accept `isLive` prop
- Modify: `src/lib/api.ts` — add `fetchStablecoinReserves` helper

- [ ] **Step 1: Add `fetchStablecoinReserves` to `src/lib/api.ts`**

> **Note:** `apiRequest` is a private function in `api.ts`. Use `buildApiUrl` + `fetch` directly, since 404 is a valid non-error case and `apiFetch` would throw.

```ts
export async function fetchStablecoinReserves(stablecoinId: string): Promise<{
  slices: ReserveSlice[];
  fetchedAt: number;
  source: string;
} | null> {
  const res = await fetch(buildApiUrl(API_PATHS.stablecoinReserves(stablecoinId)));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`stablecoin-reserves fetch failed: ${res.status}`);
  const data = await res.json() as { slices: ReserveSlice[]; fetchedAt: number; source: string };
  return data;
}
```

> Import `ReserveSlice` from `@shared/types` and `API_PATHS` from `@shared/lib/api-endpoints` (both may already be imported in the file).

- [ ] **Step 2: Create `src/hooks/use-stablecoin-reserves.ts`**

```ts
"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchStablecoinReserves } from "@/lib/api";
import type { ReserveResult } from "@shared/lib/reserve-templates";

const STALE_TIME = 60 * 60 * 1000; // 1 hour — daily cron
const REFETCH_INTERVAL = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Fetches live reserve composition for a stablecoin from the API.
 * Returns null when no live data is available (cron not yet run or not configured).
 * Only call this when `coin.liveReservesConfig` is defined.
 * `displayUrl` comes from the static coin metadata (not the API) since it never changes.
 */
export function useStablecoinReserves(
  stablecoinId: string,
  enabled: boolean,
  displayUrl?: string,
): ReserveResult | null {
  const { data } = useQuery({
    queryKey: ["stablecoin-reserves", stablecoinId],
    queryFn: () => fetchStablecoinReserves(stablecoinId),
    enabled,
    staleTime: STALE_TIME,
    refetchInterval: REFETCH_INTERVAL,
    retry: 1,
  });

  if (!data) return null;
  return {
    reserves: data.slices,
    estimated: false,
    liveAt: data.fetchedAt,
    source: data.source,
    displayUrl,
  };
}
```

- [ ] **Step 3: Update view model params + logic in `src/lib/stablecoin-detail-view-model.ts`**

Add `liveReserves: ReserveResult | null` to `BuildStablecoinDetailViewModelParams`:

```ts
liveReserves: ReserveResult | null;
```

Replace the `const reserves = getReserves(coin);` line with:

```ts
const reserves = liveReserves ?? getReserves(coin);
```

Also import `ReserveResult` from `@shared/lib/reserve-templates` if not already present.

- [ ] **Step 4: Update hook in `src/hooks/use-stablecoin-detail-view-model.ts`**

Add import:
```ts
import { useStablecoinReserves } from "@/hooks/use-stablecoin-reserves";
```

Add hook call inside `useStablecoinDetailViewModel`:
```ts
const liveReserves = useStablecoinReserves(
  id,
  !!coin.liveReservesConfig,
  coin.liveReservesConfig?.displayUrl,
);
```

Pass it to `buildStablecoinDetailViewModel`:
```ts
liveReserves,
```

- [ ] **Step 5: Update `overview-section.tsx` — visual live badge + source link**

The `ReserveTreemap` card title row gets a "Live" badge when data is live. A footer row shows the last-updated timestamp and a source link.

Replace the existing reserves block:

```tsx
{reserves && (
  <div>
    <ReserveTreemap
      reserves={reserves.reserves}
      isLive={!!reserves.liveAt}
    />
    <div className="mt-1 flex items-center justify-center gap-2 text-xs text-muted-foreground">
      {reserves.liveAt ? (
        <>
          <span>
            Updated{" "}
            {new Date(reserves.liveAt * 1000).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
              timeZoneName: "short",
            })}
          </span>
          {reserves.displayUrl && (
            <>
              <span aria-hidden>·</span>
              <a
                href={reserves.displayUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 hover:text-foreground transition-colors"
              >
                Source
              </a>
            </>
          )}
        </>
      ) : reserves.estimated ? (
        <span>
          Estimated composition based on {coin.flags.backing.replace("-", " ")} classification
        </span>
      ) : null}
    </div>
  </div>
)}
```

Also update `ReserveTreemap` to accept and render the `isLive` prop. In `src/components/reserve-treemap.tsx`, add `isLive?: boolean` to `ReserveTreemapProps` and update the `CardTitle` line:

```tsx
// ReserveTreemapProps
isLive?: boolean;

// CardTitle row — replace the existing title line with:
<CardTitle as="h2" className={`${DETAIL_SECTION_TITLE_CLASS} flex items-center gap-2`}>
  Reserve Composition
  {isLive && (
    <span className="inline-flex items-center rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400 ring-1 ring-inset ring-emerald-500/20">
      Live
    </span>
  )}
</CardTitle>
```

- [ ] **Step 6: Build check**

```bash
npm run build 2>&1 | tail -20
```

Expected: `Route (app) ... Compiled successfully` — no TypeScript errors

- [ ] **Step 7: Run all tests**

```bash
npm test 2>&1 | tail -20
```

Expected: all tests pass

- [ ] **Step 8: Commit**

```bash
git add \
  src/hooks/use-stablecoin-reserves.ts \
  src/lib/stablecoin-detail-view-model.ts \
  src/hooks/use-stablecoin-detail-view-model.ts \
  src/components/stablecoin-detail/overview-section.tsx \
  src/components/reserve-treemap.tsx \
  src/lib/api.ts
git commit -m "feat(frontend): show live reserve composition on stablecoin detail pages"
```

---

## Chunk 5: Docs

### Task 7: Documentation

**Files:**
- Modify: `docs/api-reference.md` — document the new endpoint
- Modify: `docs/worker-infrastructure.md` — document new cron job + table + circuit source

- [ ] **Step 1: Update `docs/api-reference.md`**

Add a new section for the endpoint (place near the stablecoin detail endpoints):

```markdown
### `GET /api/stablecoin-reserves/:id`

Returns live reserve composition for a stablecoin synced from its configured live data source. Only coins with a `liveReservesConfig` in their metadata have records. Returns `404` when no live data exists (cron not yet run).

**Cache:** slow (`public, s-maxage=3600, max-age=300`)

**Response (200):**
| Field | Type | Description |
|---|---|---|
| `stablecoinId` | `string` | Pharos coin ID |
| `slices` | `ReserveSlice[]` | Live reserve composition |
| `fetchedAt` | `number` | Unix seconds of last sync |
| `source` | `string` | Adapter key (e.g., `"infinifi"`) |
| `estimated` | `false` | Always false — live data only |

**Response (404):** `{ "error": "Not found" }`
```

- [ ] **Step 2: Update `docs/worker-infrastructure.md`**

In the Trigger 8 (`0 8 * * *`) table, add:

```markdown
| `sync-live-reserves` | `syncLiveReserves()` | `worker/src/cron/sync-live-reserves.ts` | This doc |
```

Update the connection budget note for Trigger 8 to mention the new job:

```markdown
**Connection budget:** 3 snapshot jobs are D1-only (0 external connections). `fetch-tbill-rate` (FRED), `sync-usds-status` (Etherscan), and `sync-live-reserves` (protocol APIs, sequential) use ≤3 concurrent external connections.
```

In the circuit breaker sources table, add:

```markdown
| `LIVE_RESERVES` | `live-reserves` | `sync-live-reserves` |
```

In the D1 schema section (or nearest appropriate place), document:

```markdown
#### `reserve_composition`

Stores live reserve composition synced daily from protocol data APIs. One row per coin (latest snapshot only).

| Column | Type | Description |
|---|---|---|
| `stablecoin_id` | TEXT PK | Pharos coin ID |
| `slices` | TEXT | JSON-serialized `ReserveSlice[]` |
| `fetched_at` | INTEGER | Unix seconds of last successful sync |
| `source` | TEXT | Adapter key used (e.g., `"infinifi"`) |

Only coins with `liveReservesConfig` set in their metadata appear in this table.
```

- [ ] **Step 3: Commit**

```bash
git add docs/api-reference.md docs/worker-infrastructure.md
git commit -m "docs: document live reserve sync endpoint, cron job, and circuit breaker"
```

---

## Adding a New Adapter

To add a new live reserve source:

1. **Create** `worker/src/cron/reserve-adapters/<protocol>.ts` with:
   - A pure `adapt<Protocol>(payload)` transform function (for unit testing)
   - A `fetch<Protocol>Reserves(url, signal, ctx?)` wrapper that uses `fetchWithRetry` and returns `AdapterResult`
2. **Register** in `worker/src/cron/reserve-adapters/index.ts` — add to `ADAPTERS`.
3. **Add** `liveReservesConfig: { adapter: "<protocol>", url: "...", displayUrl: "..." }` to the relevant coin in `shared/lib/stablecoins.ts`.
4. No other changes needed — the cron, circuit breaker, API, and frontend all pick it up automatically.
5. **Connection budget:** Adapters are called sequentially. Adding more coins is fine as long as total fetch time stays within the 5-minute cron timeout. If many adapters are added, consider moving to a dedicated trigger slot.

---

## Planned Adapters

### Adapter: `circle` — USDC and EURC (HTML scraping)

**Coins:** `usdc-circle`, `eurc-circle`
**Source URL:** `https://www.circle.com/transparency`
**Update frequency:** Quasi-static — tied to attestation reports (roughly monthly)
**Adapter type:** HTML scraping (no public JSON API)

**Data source findings:**
- Circle has **no public API** for reserve composition breakdown.
- `api.circle.com/v1/stablecoins` returns per-chain supply data only (not reserve breakdown).
- The transparency page embeds reserve amounts as **hardcoded JavaScript constants** in the page source:
  ```js
  // USDC example (values in billions USD):
  const usdcReserves = 20.77 + 11.21 + 0.65 + 44.75;
  // These correspond to the 4 reserve categories displayed on the page
  ```
- Reserve categories (as of March 2026):
  - **USDC:** Deposits at SIIs, <3-Month Treasuries, Other Bank Deposits, Overnight Reverse Treasury Repo
  - **EURC:** Deposits at SIIs, Other Bank Deposits

**Adapter strategy:**
1. Fetch the transparency page HTML via `fetchWithRetry`
2. Extract the embedded JS values using regex patterns (e.g., match `const usdcReserves = ...`)
3. Map values to category names (hardcoded in adapter — categories change rarely)
4. Validate: sum of components must be > 0, all values positive
5. Return `AdapterResult` with slices

**Risk classification:**
| Category | risk |
|---|---|
| <3-Month Treasuries | `"very-low"` |
| Overnight Reverse Treasury Repo | `"very-low"` |
| Deposits at SIIs | `"low"` |
| Other Bank Deposits | `"low"` |

**`liveReservesConfig`:**
```ts
// usdc-circle
liveReservesConfig: {
  adapter: "circle",
  url: "https://www.circle.com/transparency",
  displayUrl: "https://www.circle.com/transparency",
},
// eurc-circle — same adapter, same URL (adapter parses both coins' data)
liveReservesConfig: {
  adapter: "circle",
  url: "https://www.circle.com/transparency",
  displayUrl: "https://www.circle.com/transparency",
},
```

**Fragility note:** HTML scraping is inherently fragile — Circle can change their page structure at any time. The adapter should:
- Log warnings when expected patterns aren't found (don't silently return empty)
- Fall back gracefully to static `reserves` in metadata when scraping fails
- Include a `structureVersion` field in cron metadata so operators notice when the page changes

---

### Adapter: `tether` — USDT (needs research)

**Coin:** `usdt-tether`
**Source URL:** `https://tether.to/en/transparency/?tab=usdt`
**Update frequency:** Quasi-static — tied to quarterly attestation reports
**Adapter type:** TBD — currently blocked

**Data source findings:**
- `app.tether.to/transparency.json` returns **per-chain token supply** only (total authorized, not issued, quarantined per blockchain). **No reserve composition breakdown.**
- The transparency page is a **JS-rendered SPA** (Angular Material). Reserve composition data (the pie chart showing US Treasury Bills, Cash, Bitcoin, Gold, etc.) is loaded dynamically after page render.
- No accessible API endpoint was found for the reserve breakdown. The data appears to be fetched by the Angular app from an undiscovered backend endpoint.
- The page has **Cloudflare bot protection** (Turnstile challenge), making headless scraping unreliable from Workers.

**Next steps (before building this adapter):**
1. Use browser DevTools Network tab on the live page to capture the actual XHR/fetch request that loads the reserve breakdown
2. If an API endpoint is found → build a JSON API adapter (easy)
3. If data is only in rendered DOM → consider:
   - A lightweight proxy service that runs a headless browser periodically and caches the result
   - Manual periodic update to static `reserves` metadata (current approach)
4. **Do not build this adapter until the data source is identified.** The current static `reserves` data in metadata is sufficient.

---

### Adapter: `bold-onchain` — Liquity BOLD (on-chain reads)

**Coin:** `bold-liquity`
**Source:** Ethereum mainnet smart contracts (3 ActivePool contracts)
**Update frequency:** Real-time (on-chain state changes with every transaction)
**Adapter type:** On-chain via Etherscan V2 `eth_call` proxy

**Data source:**
BOLD is backed by three collateral types in separate Liquity V2 ActivePool contracts:

| Pool | Contract | Collateral |
|---|---|---|
| WETH | `0xeB5A8C825582965f1d84606E078620a84ab16AfE` | Wrapped Ether |
| wstETH | `0x531a8f99c70d6a56a7cee02d6b4281650d7919a0` | Lido Wrapped Staked ETH |
| rETH | `0x9074d72cc82dad1e13e454755aa8f144c479532f` | Rocket Pool ETH |

Each ActivePool exposes a `collBalance` storage variable (or the pool's token balance can be read directly).

**Adapter strategy:**
1. Use `ctx.etherscanApiKey` to make 3 `eth_call` requests via Etherscan V2 proxy (same pattern as `sync-usds-status.ts` and `sync-blacklist.ts`)
2. Read each pool's collateral balance (ERC-20 `balanceOf` or direct `collBalance()` view function)
3. Fetch collateral prices from DefiLlama coins API (`coins.llama.fi/prices/current/ethereum:0x...`) for WETH, wstETH, rETH — 1 batched request
4. Compute USD value per pool: `balance × price`
5. Compute percentage per pool: `poolUsd / totalUsd × 100`
6. Return 3 slices with risk/coinId mappings

**Risk classification:**
| Collateral | risk | coinId | depType |
|---|---|---|---|
| WETH | `"medium"` | — | — |
| wstETH | `"medium"` | — | — |
| rETH | `"medium"` | — | — |

All three are volatile crypto collateral in an overcollateralized CDP — `"medium"` risk.

**Connection budget:** 3 Etherscan calls + 1 DeFiLlama price call = 4 sequential HTTP requests. Fits comfortably within the daily-0800 slot.

**`liveReservesConfig`:**
```ts
// bold-liquity
liveReservesConfig: {
  adapter: "bold-onchain",
  url: "",  // On-chain adapter — does not fetch a URL
  displayUrl: "https://www.liquity.org/bold",
},
```

**Implementation note:** The `url` field is empty because on-chain adapters don't fetch a URL. The adapter uses `ctx.etherscanApiKey` passed from the cron. This is the same pattern used by `sync-usds-status.ts` (which reads ERC-1967 storage via Etherscan V2).

---

### Adapter priority

| Adapter | Difficulty | Value | Priority |
|---|---|---|---|
| `infinifi` (this plan) | Easy — clean JSON API | High (first live adapter, proves architecture) | **P0 — this plan** |
| `bold-onchain` | Medium — on-chain reads, needs prices | High (real-time, verifiable) | **P1** |
| `circle` | Medium — HTML scraping, fragile | High (USDC + EURC are top 2 stablecoins) | **P1** |
| `tether` | Blocked — no known data source | High (USDT is #1) | **P2 — needs research first** |

---

## Validation Checklist

Before marking complete:

- [ ] `npm run build` passes with no TypeScript errors
- [ ] `npm test` (all Vitest) passes
- [ ] `cd worker && npx tsc --noEmit` passes
- [ ] Migration applied to remote D1
- [ ] Worker deployed (`cd worker && npx wrangler deploy`)
- [ ] Manual trigger: `GET https://api.pharos.watch/api/stablecoin-reserves/iusd-infinifi` returns 404 pre-cron or live data post-cron
- [ ] `/status` page shows `sync-live-reserves` in the daily cron list
- [ ] iUSD detail page shows "Live" badge and "Updated <date>" caption under the reserve treemap after first cron run
