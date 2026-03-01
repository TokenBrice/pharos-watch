# Test Suite Upgrade Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent polymorphic API response crashes with discriminated types, Zod runtime validation, and API contract tests.

**Architecture:** Top-down — fix the type lie first (Task 1-2), add Zod schemas and validated fetching (Task 3-5), then write contract tests that cross-validate against those schemas (Task 6-8). Each task is independently shippable.

**Tech Stack:** Vitest, Zod, TypeScript strict

**Design doc:** `docs/plans/2026-03-01-test-suite-upgrade-design.md`

---

### Task 0: Regression Test — Reproduce the Production Crash

**Files:**
- Create: `worker/src/api/__tests__/mint-burn-flows.test.ts`

This test anchors the entire effort. It reproduces the exact production crash: calling the per-coin endpoint and treating the response as `MintBurnFlowsResponse`.

**Step 1: Write the regression test**

```ts
import { describe, it, expect } from "vitest";

describe("mint-burn-flows regression: per-coin vs aggregate shape", () => {
  it("per-coin response does NOT have a coins array", async () => {
    // Simulate what the frontend did: treat per-coin response as aggregate
    const perCoinResponse = {
      stablecoinId: "1",
      symbol: "USDT",
      mintVolumeUsd: 1000,
      burnVolumeUsd: 500,
      netFlowUsd: 500,
      mintCount: 10,
      burnCount: 5,
      chains: [],
      hourly: [],
      updatedAt: 1000,
    };

    // This is the exact line that crashed in production:
    // data.coins.find((c) => c.stablecoinId === "1")
    // The per-coin response has no `coins` property.
    expect(perCoinResponse).not.toHaveProperty("coins");
    expect(perCoinResponse).toHaveProperty("stablecoinId");
  });

  it("aggregate response DOES have a coins array", async () => {
    const aggregateResponse = {
      gauge: { score: 50, band: "NEUTRAL", flightToQuality: false, flightIntensity: 0, trackedCoins: 4, trackedMcapUsd: 1e11 },
      coins: [{ stablecoinId: "1", symbol: "USDT", flowIntensity: 50, netFlow24hUsd: 100, mintVolume24hUsd: 200, burnVolume24hUsd: 100, mintCount24h: 5, burnCount24h: 3, netFlow7dUsd: 500, largestEvent24h: null }],
      hourly: [],
      updatedAt: 1000,
    };

    expect(aggregateResponse).toHaveProperty("coins");
    expect(Array.isArray(aggregateResponse.coins)).toBe(true);
    expect(aggregateResponse).toHaveProperty("gauge");
    expect(aggregateResponse).not.toHaveProperty("stablecoinId");
  });
});
```

**Step 2: Run test to verify it passes**

Run: `npm test -- worker/src/api/__tests__/mint-burn-flows.test.ts`
Expected: PASS (these are shape assertions on literal objects — they document the problem)

**Step 3: Commit**

```bash
git add worker/src/api/__tests__/mint-burn-flows.test.ts
git commit -m "test: add regression test for mint-burn-flows polymorphic response shapes"
```

---

### Task 1: Add `MintBurnPerCoinResponse` Type

**Files:**
- Modify: `src/lib/types.ts:714-719`

**Step 1: Add the per-coin response type after `MintBurnFlowsResponse`**

Insert after line 719 (`}`  closing `MintBurnFlowsResponse`):

```ts
export interface MintBurnPerCoinChain {
  chainId: string;
  mintVolumeUsd: number;
  burnVolumeUsd: number;
  mintCount: number;
  burnCount: number;
  netFlowUsd: number;
}

export interface MintBurnPerCoinResponse {
  stablecoinId: string;
  symbol: string;
  mintVolumeUsd: number;
  burnVolumeUsd: number;
  netFlowUsd: number;
  mintCount: number;
  burnCount: number;
  chains: MintBurnPerCoinChain[];
  hourly: MintBurnHourlyBucket[];
  updatedAt: number;
}
```

**Step 2: Run type-check to verify no breakage**

Run: `npm run build`
Expected: PASS (additive change — nothing imports the new type yet)

**Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat(types): add MintBurnPerCoinResponse for per-coin flow endpoint"
```

---

### Task 2: Split `useMintBurnFlows` Into Two Hooks

**Files:**
- Modify: `src/hooks/use-mint-burn-flows.ts`

**Step 1: Rewrite the hook file**

Replace the current `useMintBurnFlows` function (lines 9-20) with two separate hooks:

```ts
"use client";

import { useApiQuery, CRON_20MIN } from "./use-api-query";
import type {
  MintBurnFlowsResponse,
  MintBurnPerCoinResponse,
  MintBurnEventsResponse,
} from "@/lib/types";

/** Aggregate flows — returns gauge, coins[], hourly[]. No stablecoin filter. */
export function useMintBurnFlows(hours = 24) {
  const qs = hours !== 24 ? `?hours=${hours}` : "";
  return useApiQuery<MintBurnFlowsResponse>(
    ["mint-burn-flows", "all", hours],
    `/api/mint-burn-flows${qs}`,
    CRON_20MIN,
  );
}

/** Per-coin flows — returns flat object with chains[], hourly[]. Requires stablecoinId. */
export function useMintBurnFlowsCoin(stablecoinId: string, hours = 24) {
  const params = new URLSearchParams({ stablecoin: stablecoinId });
  if (hours !== 24) params.set("hours", hours.toString());
  return useApiQuery<MintBurnPerCoinResponse>(
    ["mint-burn-flows", stablecoinId, hours],
    `/api/mint-burn-flows?${params}`,
    CRON_20MIN,
    { enabled: !!stablecoinId },
  );
}

export function useMintBurnEvents(
  stablecoinId: string,
  opts?: { direction?: string; limit?: number; offset?: number }
) {
  const params = new URLSearchParams({ stablecoin: stablecoinId });
  if (opts?.direction) params.set("direction", opts.direction);
  if (opts?.limit) params.set("limit", opts.limit.toString());
  if (opts?.offset) params.set("offset", opts.offset.toString());

  return useApiQuery<MintBurnEventsResponse>(
    ["mint-burn-events", stablecoinId, opts?.direction ?? "all", opts?.offset ?? 0],
    `/api/mint-burn-events?${params}`,
    CRON_20MIN,
  );
}
```

**Step 2: Verify no consumers pass a stablecoinId to `useMintBurnFlows`**

Run: `grep -rn "useMintBurnFlows(" src/ --include="*.ts" --include="*.tsx"`

Check that all call sites use `useMintBurnFlows()` with no arguments (or only `hours`). The `FlowSummaryCard` already calls it without a stablecoin param. If any call site passes a stablecoinId, migrate it to `useMintBurnFlowsCoin(id)`.

**Step 3: Run type-check and build**

Run: `npm run build`
Expected: PASS (the old signature `useMintBurnFlows(stablecoinId?, hours?)` is replaced — any caller passing a stablecoinId as first arg now gets a type error since the first param is `hours: number`, catching exactly the misuse that caused the crash)

**Step 4: Commit**

```bash
git add src/hooks/use-mint-burn-flows.ts
git commit -m "refactor: split useMintBurnFlows into aggregate and per-coin hooks

The old hook accepted an optional stablecoinId but always typed the
response as MintBurnFlowsResponse (aggregate shape). The per-coin
endpoint returns a different shape without coins[]. Splitting into
two hooks with correct types makes this a compile error."
```

---

### Task 3: Install Zod and Add Schemas to `types.ts`

**Files:**
- Modify: `package.json` (add zod)
- Modify: `src/lib/types.ts:561-719` (replace 5 interfaces with Zod schemas)

**Step 1: Install zod**

Run: `npm install zod`

**Step 2: Add Zod schemas for the 5 prioritized response types**

At the top of `src/lib/types.ts`, add the import:

```ts
import { z } from "zod";
```

Then replace each of the 5 target interfaces with a Zod schema + `z.infer`. The key principle: leaf types that are only used as building blocks keep their `interface` form. Only response types consumed by hooks get schemas.

Replace `PegSummaryCoin` interface (lines 571-589) with:

```ts
export const PegSummaryCoinSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  name: z.string(),
  pegType: z.string(),
  pegCurrency: z.string(),
  governance: z.string(),
  currentDeviationBps: z.number().nullable(),
  pegScore: z.number().nullable(),
  pegPct: z.number(),
  severityScore: z.number(),
  spreadPenalty: z.number(),
  eventCount: z.number(),
  worstDeviationBps: z.number().nullable(),
  activeDepeg: z.boolean(),
  lastEventAt: z.number().nullable(),
  trackingSpanDays: z.number(),
  dexPriceCheck: z.object({
    dexPrice: z.number(),
    dexDeviationBps: z.number(),
    agrees: z.boolean(),
    sourcePools: z.number(),
    sourceTvl: z.number(),
  }).nullable().optional(),
});
export type PegSummaryCoin = z.infer<typeof PegSummaryCoinSchema>;
```

Replace `PegSummaryStats` interface (lines 591-599) with:

```ts
export const PegSummaryStatsSchema = z.object({
  activeDepegCount: z.number(),
  medianDeviationBps: z.number(),
  worstCurrent: z.object({ id: z.string(), symbol: z.string(), bps: z.number() }).nullable(),
  coinsAtPeg: z.number(),
  totalTracked: z.number(),
  depegEventsToday: z.number(),
  depegEventsYesterday: z.number(),
});
export type PegSummaryStats = z.infer<typeof PegSummaryStatsSchema>;
```

Replace `PegSummaryResponse` interface (lines 601-604) with:

```ts
export const PegSummaryResponseSchema = z.object({
  coins: z.array(PegSummaryCoinSchema),
  summary: PegSummaryStatsSchema.nullable(),
});
export type PegSummaryResponse = z.infer<typeof PegSummaryResponseSchema>;
```

Remove the `DexPriceCheck` interface (lines 563-569) — it's inlined in `PegSummaryCoinSchema` above.

Replace `StablecoinData` interface (lines 254-274) with:

```ts
const PegBucketsSchema = z.record(z.string(), z.number());
const ChainCirculatingSchema = z.record(z.string(), z.object({
  current: z.number(),
  circulatingPrevDay: z.number(),
  circulatingPrevWeek: z.number(),
  circulatingPrevMonth: z.number(),
}));

export const StablecoinDataSchema = z.object({
  id: z.string(),
  name: z.string(),
  symbol: z.string(),
  geckoId: z.string().nullable(),
  pegType: z.string(),
  pegMechanism: z.string(),
  price: z.number().nullable(),
  priceSource: z.string(),
  priceConfidence: z.string().nullable(),
  supplySource: z.string().optional(),
  circulating: PegBucketsSchema,
  circulatingPrevDay: PegBucketsSchema,
  circulatingPrevWeek: PegBucketsSchema,
  circulatingPrevMonth: PegBucketsSchema,
  chainCirculating: ChainCirculatingSchema,
  chains: z.array(z.string()),
});
export type StablecoinData = z.infer<typeof StablecoinDataSchema>;
```

Replace `StablecoinListResponse` interface (lines 276-280) with:

```ts
export const StablecoinListResponseSchema = z.object({
  peggedAssets: z.array(StablecoinDataSchema),
  fxFallbackRates: z.record(z.string(), z.number()).optional(),
});
export type StablecoinListResponse = z.infer<typeof StablecoinListResponseSchema>;
```

Replace `ReportCardsResponse` interface (lines 459-471) with:

```ts
export const ReportCardsResponseSchema = z.object({
  cards: z.array(z.object({
    id: z.string(),
    name: z.string(),
    symbol: z.string(),
    overallGrade: z.string(),
    overallScore: z.number().nullable(),
    dimensions: z.record(z.string(), z.object({
      grade: z.string(),
      score: z.number().nullable(),
      detail: z.string(),
    })),
    ratedDimensions: z.number(),
    rawInputs: z.object({}).passthrough(),
    dependencies: z.array(z.any()).optional(),
    isDefunct: z.boolean(),
  })),
  methodology: z.object({
    version: z.string(),
    weights: z.record(z.string(), z.number()),
    pegMultiplierExponent: z.number(),
    thresholds: z.array(z.object({ grade: z.string(), min: z.number() })),
  }),
  dependencyGraph: z.object({
    edges: z.array(z.object({ from: z.string(), to: z.string() })),
  }),
  updatedAt: z.number(),
});
export type ReportCardsResponse = z.infer<typeof ReportCardsResponseSchema>;
```

Replace `MintBurnFlowsResponse` and its sub-types (lines 680-719). Keep `MintBurnGauge`, `MintBurnCoinFlow`, `MintBurnHourlyBucket` as schemas:

```ts
export const MintBurnGaugeSchema = z.object({
  score: z.number().nullable(),
  band: z.string().nullable(),
  flightToQuality: z.boolean(),
  flightIntensity: z.number(),
  trackedCoins: z.number(),
  trackedMcapUsd: z.number(),
});
export type MintBurnGauge = z.infer<typeof MintBurnGaugeSchema>;

export const MintBurnCoinFlowSchema = z.object({
  stablecoinId: z.string(),
  symbol: z.string(),
  flowIntensity: z.number().nullable(),
  netFlow24hUsd: z.number(),
  mintVolume24hUsd: z.number(),
  burnVolume24hUsd: z.number(),
  mintCount24h: z.number(),
  burnCount24h: z.number(),
  netFlow7dUsd: z.number(),
  largestEvent24h: z.object({
    direction: z.enum(["mint", "burn"]),
    amountUsd: z.number(),
    txHash: z.string(),
    timestamp: z.number(),
  }).nullable(),
});
export type MintBurnCoinFlow = z.infer<typeof MintBurnCoinFlowSchema>;

export const MintBurnHourlyBucketSchema = z.object({
  hourTs: z.number(),
  netFlowUsd: z.number(),
  mintVolumeUsd: z.number(),
  burnVolumeUsd: z.number(),
});
export type MintBurnHourlyBucket = z.infer<typeof MintBurnHourlyBucketSchema>;

export const MintBurnFlowsResponseSchema = z.object({
  gauge: MintBurnGaugeSchema,
  coins: z.array(MintBurnCoinFlowSchema),
  hourly: z.array(MintBurnHourlyBucketSchema),
  updatedAt: z.number(),
});
export type MintBurnFlowsResponse = z.infer<typeof MintBurnFlowsResponseSchema>;
```

And add a schema for the new per-coin type (added in Task 1):

```ts
export const MintBurnPerCoinChainSchema = z.object({
  chainId: z.string(),
  mintVolumeUsd: z.number(),
  burnVolumeUsd: z.number(),
  mintCount: z.number(),
  burnCount: z.number(),
  netFlowUsd: z.number(),
});
export type MintBurnPerCoinChain = z.infer<typeof MintBurnPerCoinChainSchema>;

export const MintBurnPerCoinResponseSchema = z.object({
  stablecoinId: z.string(),
  symbol: z.string(),
  mintVolumeUsd: z.number(),
  burnVolumeUsd: z.number(),
  netFlowUsd: z.number(),
  mintCount: z.number(),
  burnCount: z.number(),
  chains: z.array(MintBurnPerCoinChainSchema),
  hourly: z.array(MintBurnHourlyBucketSchema),
  updatedAt: z.number(),
});
export type MintBurnPerCoinResponse = z.infer<typeof MintBurnPerCoinResponseSchema>;
```

**Step 3: Run type-check**

Run: `npm run build`
Expected: PASS — exported type names are identical, so all downstream imports resolve. If any type inference differs slightly (e.g., a union becomes a string), fix the schema to match.

**Step 4: Run existing tests**

Run: `npm test`
Expected: PASS — no test files import the replaced interfaces directly; they import helper functions that use the types.

**Step 5: Commit**

```bash
git add package.json package-lock.json src/lib/types.ts
git commit -m "feat: add Zod schemas for 5 high-priority API response types

Replace interfaces with Zod schemas + z.infer<> for:
- StablecoinListResponse (peggedAssets[])
- PegSummaryResponse (coins[])
- ReportCardsResponse (cards[], dependencyGraph)
- MintBurnFlowsResponse (gauge, coins[], hourly[])
- MintBurnPerCoinResponse (chains[], hourly[])

Exported type names are unchanged — no downstream import changes."
```

---

### Task 4: Add Schema-Aware `apiFetch`

**Files:**
- Modify: `src/lib/api.ts`

**Step 1: Extend `apiFetch` with optional schema validation**

```ts
import type { ZodType } from "zod";

export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";

/** Fetch JSON from the API. Throws on non-OK responses.
 *  When a Zod schema is provided, validates the response and warns on mismatch
 *  (graceful degradation — returns data as-is on failure). */
export async function apiFetch<T>(path: string, schema?: ZodType<T>): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`Failed to fetch ${path}: ${res.status}`);

  const data: unknown = await res.json();

  if (schema) {
    const result = schema.safeParse(data);
    if (!result.success) {
      console.warn(
        `[API] Schema validation failed for ${path}:`,
        result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", "),
      );
      return data as T;
    }
    return result.data;
  }

  return data as T;
}
```

**Step 2: Run type-check**

Run: `npm run build`
Expected: PASS — the schema parameter is optional, so all existing callers are unchanged.

**Step 3: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat: extend apiFetch with optional Zod schema validation

When a schema is provided, validates the response and console.warn on
mismatch. Returns data as-is on failure (graceful degradation).
Callers without a schema behave exactly as before."
```

---

### Task 5: Wire Schemas Into Hooks

**Files:**
- Modify: `src/hooks/use-api-query.ts`
- Modify: `src/hooks/use-stablecoins.ts`
- Modify: `src/hooks/use-peg-summary.ts`
- Modify: `src/hooks/use-report-cards.ts`
- Modify: `src/hooks/use-mint-burn-flows.ts`

**Step 1: Extend `useApiQuery` to accept an optional schema**

In `src/hooks/use-api-query.ts`, add the schema parameter:

```ts
"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { ZodType } from "zod";

/** Cron interval constants — staleTime = cron interval, refetchInterval = 2x. */
export const CRON_15MIN = 15 * 60_000;
export const CRON_20MIN = 20 * 60_000;
export const CRON_1H = 60 * 60_000;
export const CRON_24H = 24 * 60 * 60_000;

/**
 * Generic TanStack Query hook for API endpoints.
 * Encodes the staleTime = cronInterval, refetchInterval = 2 × cronInterval rule.
 * When a Zod schema is provided, validates the response at runtime.
 */
export function useApiQuery<T>(
  key: readonly unknown[],
  path: string,
  cronInterval: number,
  opts?: { enabled?: boolean; schema?: ZodType<T> }
): UseQueryResult<T, Error> {
  return useQuery<T, Error>({
    queryKey: key,
    queryFn: () => apiFetch<T>(path, opts?.schema),
    staleTime: cronInterval,
    refetchInterval: 2 * cronInterval,
    retry: 2,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10000),
    enabled: opts?.enabled,
  });
}
```

**Step 2: Wire schemas into the 5 hooks**

`src/hooks/use-stablecoins.ts` — change line 14:
```ts
import { StablecoinListResponseSchema } from "@/lib/types";
// ...
export function useStablecoins() {
  return useApiQuery<StablecoinListResponse>(
    ["stablecoins"], "/api/stablecoins", CRON_15MIN,
    { schema: StablecoinListResponseSchema },
  );
}
```

`src/hooks/use-peg-summary.ts`:
```ts
import { PegSummaryResponseSchema, type PegSummaryResponse } from "@/lib/types";
import { useApiQuery, CRON_15MIN } from "./use-api-query";

export function usePegSummary() {
  return useApiQuery<PegSummaryResponse>(
    ["peg-summary"], "/api/peg-summary", CRON_15MIN,
    { schema: PegSummaryResponseSchema },
  );
}
```

`src/hooks/use-report-cards.ts`:
```ts
import { ReportCardsResponseSchema, type ReportCardsResponse } from "@/lib/types";
import { useApiQuery, CRON_15MIN } from "./use-api-query";

export function useReportCards() {
  return useApiQuery<ReportCardsResponse>(
    ["report-cards"], "/api/report-cards", CRON_15MIN,
    { schema: ReportCardsResponseSchema },
  );
}
```

`src/hooks/use-mint-burn-flows.ts` — add schemas to both hooks:
```ts
import {
  MintBurnFlowsResponseSchema,
  MintBurnPerCoinResponseSchema,
  type MintBurnFlowsResponse,
  type MintBurnPerCoinResponse,
  type MintBurnEventsResponse,
} from "@/lib/types";

export function useMintBurnFlows(hours = 24) {
  const qs = hours !== 24 ? `?hours=${hours}` : "";
  return useApiQuery<MintBurnFlowsResponse>(
    ["mint-burn-flows", "all", hours],
    `/api/mint-burn-flows${qs}`,
    CRON_20MIN,
    { schema: MintBurnFlowsResponseSchema },
  );
}

export function useMintBurnFlowsCoin(stablecoinId: string, hours = 24) {
  const params = new URLSearchParams({ stablecoin: stablecoinId });
  if (hours !== 24) params.set("hours", hours.toString());
  return useApiQuery<MintBurnPerCoinResponse>(
    ["mint-burn-flows", stablecoinId, hours],
    `/api/mint-burn-flows?${params}`,
    CRON_20MIN,
    { enabled: !!stablecoinId, schema: MintBurnPerCoinResponseSchema },
  );
}
```

**Step 3: Run type-check and build**

Run: `npm run build`
Expected: PASS

**Step 4: Run existing tests**

Run: `npm test`
Expected: PASS

**Step 5: Commit**

```bash
git add src/hooks/use-api-query.ts src/hooks/use-stablecoins.ts src/hooks/use-peg-summary.ts src/hooks/use-report-cards.ts src/hooks/use-mint-burn-flows.ts
git commit -m "feat: wire Zod schemas into 5 high-priority hooks

useStablecoins, usePegSummary, useReportCards, useMintBurnFlows, and
useMintBurnFlowsCoin now validate API responses at runtime. On schema
mismatch: console.warn + return data as-is (graceful degradation)."
```

---

### Task 6: Create D1 Mock Helper

**Files:**
- Create: `worker/src/api/__tests__/helpers/mock-d1.ts`

**Step 1: Write the mock**

```ts
/**
 * Lightweight D1 mock for API contract tests.
 * Returns canned row data based on table name substring matching.
 * Tests response shape, not SQL correctness.
 */

interface MockTable {
  /** Substring to match in SQL query (e.g., "mint_burn_hourly") */
  match: string;
  /** Rows to return from .all() */
  rows: unknown[];
  /** Single row to return from .first() (defaults to rows[0]) */
  first?: unknown;
}

export function mockD1(tables: MockTable[] = []): D1Database {
  function findTable(sql: string): MockTable | undefined {
    return tables.find((t) => sql.includes(t.match));
  }

  const stmt = (sql: string) => ({
    bind: (..._args: unknown[]) => ({
      all: async <T>() => ({
        results: (findTable(sql)?.rows ?? []) as T[],
        success: true,
        meta: {},
      }),
      first: async <T>() =>
        (findTable(sql)?.first ?? findTable(sql)?.rows?.[0] ?? null) as T | null,
      run: async () => ({ success: true, meta: {} }),
    }),
    all: async <T>() => ({
      results: (findTable(sql)?.rows ?? []) as T[],
      success: true,
      meta: {},
    }),
    first: async <T>() =>
      (findTable(sql)?.first ?? findTable(sql)?.rows?.[0] ?? null) as T | null,
    run: async () => ({ success: true, meta: {} }),
  });

  return {
    prepare: (sql: string) => stmt(sql),
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;
}
```

**Step 2: Commit**

```bash
git add worker/src/api/__tests__/helpers/mock-d1.ts
git commit -m "test: add lightweight D1 mock for API contract tests"
```

---

### Task 7: Contract Tests for `handleMintBurnFlows`

**Files:**
- Modify: `worker/src/api/__tests__/mint-burn-flows.test.ts` (extend from Task 0)

**Step 1: Add contract tests using the D1 mock and Zod schemas**

Extend the file created in Task 0 with handler-level tests:

```ts
import { describe, it, expect } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { handleMintBurnFlows } from "../mint-burn-flows";
import {
  MintBurnFlowsResponseSchema,
  MintBurnPerCoinResponseSchema,
} from "../../../src/lib/types";

// ... keep existing regression tests from Task 0 ...

describe("handleMintBurnFlows contract tests", () => {
  const nowSec = Math.floor(Date.now() / 1000);

  // Minimal canned data for the mock
  const hourlyRow = {
    stablecoin_id: "1",
    chain_id: "ethereum",
    hour_ts: nowSec - 3600,
    mint_count: 5,
    burn_count: 3,
    mint_volume_usd: 10000,
    burn_volume_usd: 5000,
    net_flow_usd: 5000,
  };

  const stablecoinsCache = JSON.stringify({
    peggedAssets: [{ id: "1", circulating: { peggedUSD: 100000000000 } }],
  });

  const db = mockD1([
    { match: "mint_burn_hourly", rows: [hourlyRow] },
    { match: "mint_burn_events", rows: [] },
    {
      match: "cache",
      rows: [{ key: "stablecoins", value: stablecoinsCache, updated_at: nowSec }],
      first: { key: "stablecoins", value: stablecoinsCache, updated_at: nowSec },
    },
  ]);

  it("aggregate mode returns shape matching MintBurnFlowsResponseSchema", async () => {
    const url = new URL("https://x/api/mint-burn-flows");
    const res = await handleMintBurnFlows(db, url);

    expect(res.status).toBe(200);
    const body = await res.json();

    // Cross-validate against the same Zod schema the frontend uses
    const parsed = MintBurnFlowsResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);

    // Structural assertions
    expect(body).toHaveProperty("gauge");
    expect(body).toHaveProperty("coins");
    expect(body).toHaveProperty("hourly");
    expect(Array.isArray(body.coins)).toBe(true);
    expect(body).not.toHaveProperty("stablecoinId");
  });

  it("per-coin mode returns shape matching MintBurnPerCoinResponseSchema", async () => {
    const url = new URL("https://x/api/mint-burn-flows?stablecoin=1");
    const res = await handleMintBurnFlows(db, url);

    expect(res.status).toBe(200);
    const body = await res.json();

    // Cross-validate against per-coin schema
    const parsed = MintBurnPerCoinResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);

    // Structural assertions — NOT aggregate shape
    expect(body).toHaveProperty("stablecoinId");
    expect(body).toHaveProperty("chains");
    expect(body).not.toHaveProperty("coins");
    expect(body).not.toHaveProperty("gauge");
  });

  it("unknown stablecoin returns 404", async () => {
    const url = new URL("https://x/api/mint-burn-flows?stablecoin=99999");
    const res = await handleMintBurnFlows(db, url);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });
});
```

**Step 2: Run the tests**

Run: `npm test -- worker/src/api/__tests__/mint-burn-flows.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add worker/src/api/__tests__/mint-burn-flows.test.ts
git commit -m "test: add contract tests for mint-burn-flows handler

Tests both aggregate and per-coin modes, validates response shape
against the same Zod schemas the frontend uses. Includes 404 test."
```

---

### Task 8: Contract Tests for `handleStabilityIndex`

**Files:**
- Create: `worker/src/api/__tests__/stability-index.test.ts`

**Step 1: Write the contract tests**

```ts
import { describe, it, expect } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { handleStabilityIndex } from "../stability-index";

describe("handleStabilityIndex contract tests", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const yesterdayMidnight = nowSec - 86400 - (nowSec % 86400);

  const sampleRow = {
    stored_at: nowSec - 300,
    score: 72.5,
    band: "Stable",
    components: JSON.stringify({ pricePeg: 85, supplyMomentum: 60 }),
    input_snapshot: JSON.stringify({ totalMcapUsd: 1e11, contributors: [] }),
  };

  const historyRow = {
    computed_at: yesterdayMidnight,
    score: 71.0,
    band: "Stable",
    components: JSON.stringify({ pricePeg: 83, supplyMomentum: 59 }),
    input_snapshot: null,
  };

  const db = mockD1([
    { match: "stability_index_samples", rows: [sampleRow], first: sampleRow },
    { match: "stability_index", rows: [historyRow] },
  ]);

  it("summary mode returns current + history without components in history", async () => {
    const url = new URL("https://x/api/stability-index");
    const res = await handleStabilityIndex(db, url);

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toHaveProperty("current");
    expect(body).toHaveProperty("history");
    expect(body.current).toHaveProperty("score");
    expect(body.current).toHaveProperty("band");
    expect(body.current).toHaveProperty("components");
    expect(Array.isArray(body.history)).toBe(true);
  });

  it("detail mode includes components in history items", async () => {
    const url = new URL("https://x/api/stability-index?detail=true");
    const res = await handleStabilityIndex(db, url);

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toHaveProperty("current");
    expect(body).toHaveProperty("history");
    expect(Array.isArray(body.history)).toBe(true);
    // Detail mode adds components to history items
    if (body.history.length > 0) {
      expect(body.history[0]).toHaveProperty("components");
    }
  });
});
```

**Step 2: Run the tests**

Run: `npm test -- worker/src/api/__tests__/stability-index.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add worker/src/api/__tests__/stability-index.test.ts
git commit -m "test: add contract tests for stability-index handler

Tests summary vs detail modes. Detail mode verifies components
are included in history items."
```

---

### Task 9: Update `docs/testing.md`

**Files:**
- Modify: `docs/testing.md`

**Step 1: Add sections documenting the new test categories**

After the existing "Existing Test Suites" table, add:

```markdown
### API Contract Tests

Located in `worker/src/api/__tests__/`. These test that worker handlers return the correct response shape for each endpoint mode. They use a lightweight D1 mock (`helpers/mock-d1.ts`) that returns canned row data.

| File | Handler | Modes Tested |
|------|---------|--------------|
| `mint-burn-flows.test.ts` | `handleMintBurnFlows` | Aggregate (gauge + coins[]), Per-coin (flat + chains[]), 404 |
| `stability-index.test.ts` | `handleStabilityIndex` | Summary, Detail (with components in history) |

Contract tests validate responses against the same Zod schemas the frontend uses, creating a direct link between what the worker produces and what the frontend expects.

### Zod Runtime Validation

Five high-priority API response types have Zod schemas in `src/lib/types.ts`:
- `StablecoinListResponseSchema`
- `PegSummaryResponseSchema`
- `ReportCardsResponseSchema`
- `MintBurnFlowsResponseSchema`
- `MintBurnPerCoinResponseSchema`

These are wired into their respective hooks via `useApiQuery`'s `schema` option. On validation failure: `console.warn` with details, return data as-is (graceful degradation). Schemas are the single source of truth — types are derived via `z.infer<>`.

When adding a new API endpoint:
1. Define the response schema in `src/lib/types.ts` if the response has nested arrays or objects accessed via `.find()` / `.map()`
2. Pass the schema to `useApiQuery` via `{ schema: MyResponseSchema }`
3. Add a contract test in `worker/src/api/__tests__/` if the endpoint has multiple response modes
```

Also add to the "What to test" conventions section:

```markdown
- **API contract tests** — when a worker handler has multiple response modes (different JSON shapes based on query params), add a contract test for each mode in `worker/src/api/__tests__/`. Use the D1 mock from `helpers/mock-d1.ts`.
```

**Step 2: Run lint**

Run: `npm run lint`
Expected: PASS

**Step 3: Commit**

```bash
git add docs/testing.md
git commit -m "docs: update testing.md with contract tests and Zod validation sections"
```

---

### Final: Run Full Suite

Run: `npm test && npm run build && npm run lint`
Expected: All pass. The test count should increase from 163 to ~171 (8 new tests across 3 files).
