import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logCronEvent, type CronProgressUpdate } from "../../lib/cron-logger";
import { mockRegistry } from "../../test-helpers/cron";
import { isProvenSatisfiedNeutralSkipReason } from "@shared/lib/cron-jobs";
import { beefyCandidate, degradedFamilyFetch, emptyRpcTelemetry, healthyFamilyFetch } from "./sync-yield-supplemental.test-support";

const OPTIONAL_RPC_MISSING_TARGET_EXAMPLE_LIMIT = 20;

vi.mock("@shared/lib/stablecoins/registry", () => mockRegistry({
  stablecoins: [
    { id: "usdc-circle", symbol: "USDC", flags: { yieldBearing: false }, contracts: [{ chain: "ethereum", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 }] },
    { id: "usdt-tether", symbol: "USDT", flags: { yieldBearing: false }, contracts: [{ chain: "ethereum", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 }] },
    { id: "eurc-circle", symbol: "EURC", flags: { yieldBearing: false }, contracts: [{ chain: "base", address: "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42", decimals: 6 }] },
  ],
}));

vi.mock("../yield-sync/family-registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../yield-sync/family-registry")>()),
  COMPOUND_V3_COMETS: [],
}));

vi.mock("../yield-sync/sources-rpc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../yield-sync/sources-rpc")>();
  const { emptyRpcTelemetry } = await import("./sync-yield-supplemental.test-support");
  return {
    ...actual,
    createOptionalRpcFamilyTelemetry: (targetCount: number) => ({ ...emptyRpcTelemetry(), targetCount }),
    fetchCompoundV3SupplyRates: vi.fn(async () => ({ results: [], telemetry: emptyRpcTelemetry() })),
    fetchAaveV3SupplyRates: vi.fn(async () => ({ results: [], telemetry: emptyRpcTelemetry() })),
    OPTIONAL_RPC_MISSING_TARGET_EXAMPLE_LIMIT: 20,
  };
});

vi.mock("../yield-sync/sources-optional-vaults", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../yield-sync/sources-optional-vaults")>();
  const { healthyFamilyFetch } = await import("./sync-yield-supplemental.test-support");
  return {
    ...actual,
    fetchMorphoVaultSources: vi.fn(async () => healthyFamilyFetch()),
    fetchPendleMarketSources: vi.fn(async () => healthyFamilyFetch()),
    fetchYearnKongSources: vi.fn(async () => healthyFamilyFetch()),
    fetchBeefySources: vi.fn(async () => healthyFamilyFetch()),
  };
});

vi.mock("../yield-sync/sources-optional-royco", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../yield-sync/sources-optional-royco")>()),
  fetchRoycoDawnSources: vi.fn(async () => ({ candidates: [], degraded: false })),
}));

vi.mock("../../lib/cron-logger", () => ({ logCronEvent: vi.fn() }));
vi.mock("../../lib/db-cache", () => ({
  getCaches: vi.fn(async () => new Map()),
  setCache: vi.fn(async () => undefined),
  setCacheIfNewer: vi.fn(async () => ({ written: true, skippedBecauseNewer: false })),
}));

import { getCaches, setCache, setCacheIfNewer } from "../../lib/db-cache";
import { fetchAaveV3SupplyRates, fetchCompoundV3SupplyRates } from "../yield-sync/sources-rpc";
import { fetchBeefySources, fetchMorphoVaultSources, fetchPendleMarketSources, fetchYearnKongSources } from "../yield-sync/sources-optional-vaults";
import { fetchRoycoDawnSources } from "../yield-sync/sources-optional-royco";
import { syncYieldSupplemental } from "../sync-yield-supplemental";
import { loadSupplementalSourceFamilies, SUPPLEMENTAL_SOURCE_FAMILY_CONCURRENCY } from "../yield-sync/sources-supplemental";
import { type SupplementalSourceFamilyKey, SUPPLEMENTAL_SOURCE_FAMILY_KEYS } from "../yield-sync/family-registry";
import {
  parseYieldSupplementalSourcesCache, PENDLE_RATE_LIMIT_BACKOFF_REASON, buildYieldSupplementalCountDropState,
  buildYieldSupplementalFamilyCache, buildYieldSupplementalPendleBackoff, buildYieldSupplementalRunOutcome,
  getYieldSupplementalCountDropStateCacheKey, getYieldSupplementalFamilyCacheKey,
  getYieldSupplementalPendleBackoffCacheKey, getYieldSupplementalRunOutcomeCacheKey, supplementalFamilySnapshotHash,
} from "../yield-sync/cache";

const USDC_ADDR = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDT_ADDR = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const EURC_ADDR = "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42";
const BASE_USDC_ADDR = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const aaveRate = (stablecoinId: string, symbol: string, chain: string, assetAddress: string, apy: number, sourceTvlUsd: number) =>
  ({ stablecoinId, symbol, chain, assetAddress, apy, sourceTvlUsd });
const usdcRate = () => aaveRate("usdc-circle", "USDC", "ethereum", USDC_ADDR, 4.25, 100_000_000);
const usdtRate = () => aaveRate("usdt-tether", "USDT", "ethereum", USDT_ADDR, 3.75, 80_000_000);

async function runSync(
  options?: Parameters<typeof syncYieldSupplemental>[4],
  reportProgress?: (update: CronProgressUpdate) => Promise<void>,
) {
  const result = await syncYieldSupplemental({} as D1Database, undefined, new Map(), reportProgress, options);
  return { result, meta: JSON.parse(result.metadata ?? "{}") };
}

const findNewerWrite = (key: string) => vi.mocked(setCacheIfNewer).mock.calls.find((c) => c[1] === key);
const hasNewerWrite = (key: string) => Boolean(findNewerWrite(key));
const findSetCache = (key: string) => vi.mocked(setCache).mock.calls.find((c) => c[1] === key);
const familyRow = (at: number, candidates: Parameters<typeof buildYieldSupplementalFamilyCache>[0] = []) => ({
  value: buildYieldSupplementalFamilyCache(candidates, at), updatedAt: at,
});

async function flushMicrotasks() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

describe("syncYieldSupplemental", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-26T12:00:00.000Z"));
    vi.mocked(fetchMorphoVaultSources).mockResolvedValue(healthyFamilyFetch());
    vi.mocked(fetchPendleMarketSources).mockResolvedValue(healthyFamilyFetch());
    vi.mocked(fetchRoycoDawnSources).mockResolvedValue({ candidates: [], degraded: false });
    vi.mocked(fetchYearnKongSources).mockResolvedValue(healthyFamilyFetch());
    vi.mocked(fetchCompoundV3SupplyRates).mockResolvedValue({ results: [], telemetry: emptyRpcTelemetry() });
    vi.mocked(fetchAaveV3SupplyRates).mockResolvedValue({ results: [], telemetry: emptyRpcTelemetry() });
    vi.mocked(fetchBeefySources).mockResolvedValue(healthyFamilyFetch());
    vi.mocked(getCaches).mockResolvedValue(new Map());
    vi.mocked(setCacheIfNewer).mockResolvedValue({ written: true, skippedBecauseNewer: false });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe("producer-adjacent family selection", () => {
    const now = Date.parse("2026-03-26T12:00:00.000Z") / 1000;
    const aaveKey = getYieldSupplementalFamilyCacheKey("aaveV3");
    const siblingKey = getYieldSupplementalFamilyCacheKey("beefy");
    const selected = { families: ["aaveV3"] as const, catchUpMinMarkerAgeSec: 14_400 };

    it("fetches overdue Aave despite a fresh sibling and preserves sibling diagnostics", async () => {
      const siblingHash = "a".repeat(64);
      vi.mocked(getCaches).mockResolvedValue(new Map([
        [aaveKey, familyRow(now - 14_400)],
        [siblingKey, familyRow(now - 10)],
        [getYieldSupplementalRunOutcomeCacheKey(), {
          value: buildYieldSupplementalRunOutcome(
            Object.fromEntries(SUPPLEMENTAL_SOURCE_FAMILY_KEYS.map((f) => [f, "retained-previous"])) as
              Record<SupplementalSourceFamilyKey, "retained-previous">,
            ["aaveV3", "beefy"], now - 10, { beefy: "sibling-failure" }, { beefy: siblingHash },
          ), updatedAt: now - 10,
        }],
      ]));
      const { meta } = await runSync(selected);
      expect(fetchAaveV3SupplyRates).toHaveBeenCalledOnce();
      expect(fetchBeefySources).not.toHaveBeenCalled();
      expect(fetchMorphoVaultSources).not.toHaveBeenCalled();
      expect(fetchCompoundV3SupplyRates).not.toHaveBeenCalled();
      expect(vi.mocked(setCacheIfNewer).mock.calls.map((c) => c[1])).toEqual([aaveKey]);
      expect(JSON.parse(vi.mocked(setCache).mock.calls[0]![2])).toMatchObject({
        degradedFamilies: ["beefy"], degradedFamilyReasons: { beefy: "sibling-failure" },
        familyCacheResults: { beefy: "retained-previous" }, familySnapshotHashes: { beefy: siblingHash },
      });
      expect(meta.degradedFamilies).toEqual([]);
    });

    it("does not report un-run sibling families as failed with zero candidates", async () => {
      const prev = Object.fromEntries(SUPPLEMENTAL_SOURCE_FAMILY_KEYS.map((f) => [f, "published"])) as
        Record<SupplementalSourceFamilyKey, "published">;
      vi.mocked(getCaches).mockResolvedValue(new Map([[getYieldSupplementalRunOutcomeCacheKey(), {
        value: buildYieldSupplementalRunOutcome(prev, ["aaveV3"], now - 600, { aaveV3: "usd-price-unavailable" }),
        updatedAt: now - 600,
      }]]));
      const { meta } = await runSync(selected);
      expect(JSON.parse(vi.mocked(setCache).mock.calls[0]![2]).familyCacheResults.beefy).toBe("published");
      expect(meta.sourceCoverage.supplementalSourceAccounting.familyExecution.familyCount).toBe(1);
      expect(meta.sourceCoverage.sourceFamilySummaries.aaveV3).toMatchObject({ status: "ok" });
      for (const family of SUPPLEMENTAL_SOURCE_FAMILY_KEYS.filter((k) => k !== "aaveV3")) {
        expect(meta.sourceCoverage.sourceFamilySummaries).not.toHaveProperty(family);
        expect(meta.sourceCoverage.sourceFamilyCounts).not.toHaveProperty(family);
        expect(meta.sourceCoverage.sourceFamilyInventoryCounts).not.toHaveProperty(family);
      }
    });

    it("does not renew Aave or sibling clocks before the family cadence is due", async () => {
      vi.mocked(getCaches).mockResolvedValue(new Map([[aaveKey, familyRow(now - 14_399)]]));
      const { result } = await runSync(selected);
      expect(result.status).toBe("skipped_neutral");
      expect(fetchAaveV3SupplyRates).not.toHaveBeenCalled();
      expect(setCacheIfNewer).not.toHaveBeenCalled();
      expect(setCache).not.toHaveBeenCalled();
    });

    it("retries a failed Aave outcome even with a recent retained family marker", async () => {
      vi.mocked(getCaches).mockResolvedValue(new Map([
        [aaveKey, familyRow(now - 30)],
        [getYieldSupplementalRunOutcomeCacheKey(), { value: JSON.stringify({ version: 1, degradedFamilies: ["aaveV3"] }), updatedAt: now - 10 }],
      ]));
      await runSync(selected);
      expect(fetchAaveV3SupplyRates).toHaveBeenCalledOnce();
    });

    it("keeps Aave failure evidence when an independent family publishes", async () => {
      const aaveHash = "b".repeat(64);
      vi.mocked(getCaches).mockResolvedValue(new Map([[getYieldSupplementalRunOutcomeCacheKey(), {
        value: JSON.stringify({
          version: 1, degradedFamilies: ["aaveV3"],
          familyCacheResults: { aaveV3: "retained-previous" }, familySnapshotHashes: { aaveV3: aaveHash },
        }),
        updatedAt: now - 10,
      }]]));
      await runSync({ families: ["beefy"] });
      expect(JSON.parse(vi.mocked(setCache).mock.calls[0]![2])).toMatchObject({
        degradedFamilies: ["aaveV3"], familyCacheResults: { aaveV3: "retained-previous" }, familySnapshotHashes: { aaveV3: aaveHash },
      });
      expect(fetchAaveV3SupplyRates).not.toHaveBeenCalled();
    });

    it("fails closed rather than overwriting unreadable sibling outcomes", async () => {
      vi.mocked(getCaches).mockRejectedValueOnce(new Error("outcome read failed"));
      await expect(runSync(selected)).rejects.toThrow("outcome read failed");
      expect(fetchAaveV3SupplyRates).not.toHaveBeenCalled();
      expect(setCache).not.toHaveBeenCalled();
    });
  });

  it("reports supplemental source-family and empty-snapshot progress metadata", async () => {
    const progressUpdates: CronProgressUpdate[] = [];
    const { result, meta } = await runSync(undefined, vi.fn(async (u: CronProgressUpdate) => { progressUpdates.push(u); }));

    expect(result.status).toBe("degraded");
    expect(progressUpdates.find((u) => u.stage === "source-family-fetch")).toMatchObject({
      metadata: {
        providerFamily: "yield-supplemental", phase: "source-family-fetch",
        providerFamilies: expect.arrayContaining(["aaveV3", "compoundV3"]),
        countTotals: { sourceFamilies: expect.any(Number) },
      },
    });
    expect(progressUpdates.find((u) => u.stage === "empty-snapshot")).toMatchObject({
      metadata: {
        providerFamily: "yield-supplemental", phase: "empty-snapshot", fallbackMode: "empty-snapshot",
        countTotals: { rawSupplementalCandidates: 0, rowsDropped: 0 },
      },
    });
    expect(vi.mocked(setCacheIfNewer)).toHaveBeenCalledTimes(SUPPLEMENTAL_SOURCE_FAMILY_KEYS.length);
    expect(vi.mocked(setCacheIfNewer).mock.calls.map((c) => c[1])).toEqual(
      expect.arrayContaining(SUPPLEMENTAL_SOURCE_FAMILY_KEYS.map((f) => `yield:supplemental-sources:v1:${f}`)),
    );
    expect(progressUpdates.some((u) => u.stage === "aggregate-cache-write")).toBe(false);
    for (const key of ["cacheWriteSkipped", "cacheWriteMode", "casSkipped", "cacheKey"]) {
      expect(meta).not.toHaveProperty(key);
    }
  });

  describe("pendle free-quota lane", () => {
    const START_SEC = Math.floor(Date.parse("2026-03-26T12:00:00.000Z") / 1000);
    const pendleKey = getYieldSupplementalFamilyCacheKey("pendle");
    const backoffKey = getYieldSupplementalPendleBackoffCacheKey();
    const activeBackoffUntilSec = START_SEC + 7200;
    const backoffRow = (backoffUntilSec: number, source: "retry-after" | "x-ratelimit-weekly-reset", recordedAtSec: number) => ({
      value: buildYieldSupplementalPendleBackoff({ backoffUntilSec, source, recordedAtSec }),
      updatedAt: recordedAtSec,
    });

    it("skips the fetch while the retained row is inside the daily cadence", async () => {
      vi.mocked(getCaches).mockResolvedValue(new Map([[pendleKey, familyRow(START_SEC - 5 * 3600)]]));
      vi.mocked(fetchMorphoVaultSources).mockResolvedValue(healthyFamilyFetch([beefyCandidate()]));
      const { result, meta } = await runSync();

      expect(fetchPendleMarketSources).not.toHaveBeenCalled();
      expect(meta.familyCacheResults?.pendle).toBe("skipped-not-due");
      expect(meta.degradedFamilies).toEqual([]);
      expect(result.status).toBeUndefined();
      expect(hasNewerWrite(pendleKey)).toBe(false);
    });

    it("fetches on the first run after the cadence elapses instead of waiting for a daily boundary", async () => {
      vi.mocked(getCaches).mockResolvedValue(new Map([
        [pendleKey, familyRow(START_SEC - 25 * 3600)],
        [backoffKey, backoffRow(START_SEC - 60, "x-ratelimit-weekly-reset", START_SEC - 3 * 86400)],
      ]));
      const { meta } = await runSync();

      expect(fetchPendleMarketSources).toHaveBeenCalledTimes(1);
      expect(meta.familyCacheResults?.pendle).toBe("empty-published");
    });

    it("records the 429 window and keeps the retained row inside the budget", async () => {
      vi.mocked(getCaches).mockResolvedValue(new Map([[pendleKey, familyRow(START_SEC - 30 * 3600)]]));
      vi.mocked(fetchMorphoVaultSources).mockResolvedValue(healthyFamilyFetch([beefyCandidate()]));
      vi.mocked(fetchPendleMarketSources).mockResolvedValue({
        candidates: [], degraded: true, rateLimited: { backoffSec: 7200, source: "retry-after" },
      });
      const { result, meta } = await runSync();

      const backoffWrite = findSetCache(backoffKey);
      expect(backoffWrite).toBeDefined();
      expect(JSON.parse(backoffWrite?.[2] ?? "{}")).toMatchObject({
        backoffUntilSec: activeBackoffUntilSec, reason: PENDLE_RATE_LIMIT_BACKOFF_REASON, source: "retry-after",
      });
      expect(logCronEvent).toHaveBeenCalledTimes(1);
      expect(logCronEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        eventType: PENDLE_RATE_LIMIT_BACKOFF_REASON,
        metadata: expect.objectContaining({ backoffUntilSec: activeBackoffUntilSec, recordedAtSec: START_SEC }),
      }));
      expect(meta.familyCacheResults?.pendle).toBe("skipped-backoff");
      expect(meta.degradedFamilies).toEqual([]);
      expect(result.status).toBeUndefined();
    });

    it("does not call pendle again while the recorded backoff is active", async () => {
      vi.mocked(getCaches).mockResolvedValue(new Map([
        [pendleKey, familyRow(START_SEC - 30 * 3600)],
        [backoffKey, backoffRow(activeBackoffUntilSec, "retry-after", START_SEC)],
      ]));
      vi.mocked(fetchMorphoVaultSources).mockResolvedValue(healthyFamilyFetch([beefyCandidate()]));
      const { result, meta } = await runSync();

      expect(fetchPendleMarketSources).not.toHaveBeenCalled();
      expect(meta.familyCacheResults?.pendle).toBe("skipped-backoff");
      expect(meta.degradedFamilies).toEqual([]);
      expect(result.status).toBeUndefined();
    });

    it("fails closed when the retained family baseline cannot be read", async () => {
      vi.mocked(getCaches).mockRejectedValueOnce(new Error("d1 unavailable"));
      vi.mocked(fetchMorphoVaultSources).mockResolvedValue(healthyFamilyFetch([beefyCandidate()]));
      const { result, meta } = await runSync();

      expect(fetchPendleMarketSources).not.toHaveBeenCalled();
      expect(setCacheIfNewer).not.toHaveBeenCalled();
      expect(result.status).toBe("degraded");
      expect(meta).toMatchObject({ reason: "retained-family-state-unavailable" });
    });

    it("degrades with the machine-readable reason while the stale retained row waits out an active backoff", async () => {
      vi.mocked(getCaches).mockResolvedValue(new Map([
        [pendleKey, familyRow(START_SEC - 49 * 3600)],
        [backoffKey, backoffRow(activeBackoffUntilSec, "x-ratelimit-weekly-reset", START_SEC)],
      ]));
      vi.mocked(fetchMorphoVaultSources).mockResolvedValue(healthyFamilyFetch([beefyCandidate()]));
      const { result, meta } = await runSync();

      expect(fetchPendleMarketSources).not.toHaveBeenCalled();
      expect(result.status).toBe("degraded");
      expect(meta).toMatchObject({
        pendleBackoff: { source: "x-ratelimit-weekly-reset", recordedAtSec: START_SEC, backoffUntilSec: activeBackoffUntilSec },
        familyCacheResults: { pendle: "retained-previous" },
        degradedFamilies: ["pendle"],
        degradedFamilyReasons: { pendle: PENDLE_RATE_LIMIT_BACKOFF_REASON },
      });
      expect(logCronEvent).not.toHaveBeenCalled();
      expect(JSON.parse(findSetCache(getYieldSupplementalRunOutcomeCacheKey())?.[2] ?? "{}")).toMatchObject({
        degradedFamilies: ["pendle"], degradedFamilyReasons: { pendle: PENDLE_RATE_LIMIT_BACKOFF_REASON },
      });
    });

    it("degrades with the machine-readable reason when a fresh 429 arrives past the retained-row budget", async () => {
      vi.mocked(getCaches).mockResolvedValue(new Map([[pendleKey, familyRow(START_SEC - 49 * 3600)]]));
      vi.mocked(fetchMorphoVaultSources).mockResolvedValue(healthyFamilyFetch([beefyCandidate()]));
      vi.mocked(fetchPendleMarketSources).mockResolvedValue({
        candidates: [], degraded: true, rateLimited: { backoffSec: 7200, source: "retry-after" },
      });
      const { result, meta } = await runSync();

      expect(meta).toMatchObject({
        familyCacheResults: { pendle: "retained-previous" },
        degradedFamilies: ["pendle"], degradedFamilyReasons: { pendle: PENDLE_RATE_LIMIT_BACKOFF_REASON },
      });
      expect(findSetCache(backoffKey)).toBeDefined();
      expect(result.status).toBe("degraded");
    });
  });

  it("does not request or publish retired vaults.fyi work", async () => {
    const { result } = await runSync();
    expect(result.metadata).not.toContain("vaultsFyi");
    expect(vi.mocked(setCacheIfNewer).mock.calls.some((c) => String(c[1]).includes("vaultsFyi"))).toBe(false);
  });

  it("keeps distinct same-chain Aave candidates by using asset-scoped source keys", async () => {
    vi.mocked(fetchAaveV3SupplyRates).mockResolvedValue({
      results: [usdcRate(), usdtRate(), aaveRate("eurc-circle", "EURC", "base", EURC_ADDR, 2.1, 10_000_000)],
      telemetry: { ...emptyRpcTelemetry(), targetCount: 3, attemptedCount: 3, resolvedTargetCount: 3, emittedCount: 3 },
    });
    const { result, meta } = await runSync();

    expect(result.status).toBeUndefined();
    expect(result.itemCount).toBe(3);
    const cacheCall = findNewerWrite("yield:supplemental-sources:v1:aaveV3");
    expect(cacheCall?.[1]).toBe("yield:supplemental-sources:v1:aaveV3");
    expect(hasNewerWrite("yield:supplemental-sources:v1")).toBe(false);

    const payload = JSON.parse(String(cacheCall?.[2])) as { sourceCount: number; data: Array<{ yield: { sourceKey: string; dataSource: string } }> };
    expect(payload.sourceCount).toBe(3);
    expect(payload.data.map((e) => e.yield.sourceKey)).toEqual([
      `aave-v3-onchain:ethereum:${USDC_ADDR.toLowerCase()}`,
      `aave-v3-onchain:ethereum:${USDT_ADDR.toLowerCase()}`,
      `aave-v3-onchain:base:${EURC_ADDR}`,
    ]);
    expect(payload.data.map((e) => e.yield.dataSource)).toEqual(["protocol-api", "protocol-api", "protocol-api"]);
    expect(meta).toMatchObject({
      rowsRead: 3, rowsWritten: 3, rowsDropped: 0,
      sourceCoverage: {
        rawSupplementalCandidates: 3, dedupedSupplementalCandidates: 3, sourceFamilyCounts: { aaveV3: 3 },
        optionalRpcTelemetry: { aaveV3: { resolvedTargetCount: 3, emittedCount: 3, missingTargetCount: 0 } },
        sourceFamilySummaries: {
          aaveV3: {
            status: "ok", rawCandidateCount: 3, candidateCount: 3,
            optionalRpc: { targetCount: 3, attemptedCount: 3, resolvedTargetCount: 3, emittedCount: 3, missingTargetExamplesTruncated: false },
          },
        },
      },
    });
  });

  it("retains the previous family snapshot when the fetch ends degraded", async () => {
    vi.mocked(fetchBeefySources).mockResolvedValue(healthyFamilyFetch([beefyCandidate()]));
    vi.mocked(fetchMorphoVaultSources).mockResolvedValue(degradedFamilyFetch());
    const { result, meta } = await runSync();

    expect(result.productivity?.productive).toBe(true);
    expect(hasNewerWrite("yield:supplemental-sources:v1:beefy")).toBe(true);
    expect(hasNewerWrite("yield:supplemental-sources:v1:morpho")).toBe(false);
    expect(meta).toMatchObject({
      familyCacheResults: { beefy: "published", morpho: "retained-previous" }, degradedFamilies: ["morpho"],
    });
    const runOutcomeCall = findSetCache("yield:supplemental-source-run:v1");
    expect(runOutcomeCall).toBeDefined();
    expect(JSON.parse(String(runOutcomeCall?.[2]))).toMatchObject({
      version: 1, degradedFamilies: ["morpho"], familyCacheResults: { morpho: "retained-previous", beefy: "published" },
    });
  });

  it.each([0, 1])("retains Compound when %s RPC attempts leave fixed targets unconfigured", async (attemptedCount) => {
    const key = getYieldSupplementalFamilyCacheKey("compoundV3");
    vi.mocked(getCaches).mockResolvedValue(new Map([[key, familyRow(1_700_000_000, [beefyCandidate()])]]));
    vi.mocked(fetchCompoundV3SupplyRates).mockResolvedValue({
      results: [],
      telemetry: { ...emptyRpcTelemetry(), targetCount: 2, attemptedCount, missingTargetCount: 2, missingReasonCounts: { "no-rpc-config": 2 } },
    });
    const { meta } = await runSync();
    expect(hasNewerWrite(key)).toBe(false);
    expect(meta.familyCacheResults.compoundV3).toBe("retained-previous");
    expect(meta.degradedFamilies).toContain("compoundV3");
    expect(meta.degradedFamilyReasons.compoundV3).toBe("no-rpc-config");
    expect(meta.sourceCoverage.optionalRpcTelemetry.compoundV3.missingReasonCounts).toEqual({ "no-rpc-config": 2 });
  });

  it("publishes a genuinely empty Compound inventory rather than retaining it as a failure", async () => {
    const { meta } = await runSync();
    expect(meta.familyCacheResults.compoundV3).toBe("empty-published");
  });

  it("leaves an older bound outcome after its upsert fails following a committed newer family", async () => {
    const oldRow = familyRow(1_700_000_000);
    const key = getYieldSupplementalFamilyCacheKey("morpho");
    const rows = new Map([[key, oldRow]]);
    vi.mocked(getCaches).mockImplementation(async () => new Map(rows));
    vi.mocked(fetchMorphoVaultSources).mockResolvedValue(healthyFamilyFetch([beefyCandidate()]));
    vi.mocked(setCacheIfNewer).mockImplementation(async (_db, cacheKey, value, updatedAt) => {
      rows.set(cacheKey, { value, updatedAt });
      return { written: true, skippedBecauseNewer: false };
    });
    vi.mocked(setCache).mockRejectedValueOnce(new Error("outcome-upsert-failed"));
    await expect(runSync()).rejects.toThrow("outcome-upsert-failed");
    expect(rows.get(key)?.value).not.toBe(oldRow.value);
    expect(supplementalFamilySnapshotHash(rows.get(key)!)).not.toBe(supplementalFamilySnapshotHash(oldRow));
  });

  it("does not claim output when candidate-bearing family writes lose the newer-cache fence", async () => {
    vi.mocked(fetchBeefySources).mockResolvedValue(healthyFamilyFetch([beefyCandidate()]));
    vi.mocked(setCacheIfNewer).mockResolvedValue({ written: false, skippedBecauseNewer: true });
    const { result, meta } = await runSync();
    expect(result.productivity?.productive).toBe(false);
    expect(meta.outputPublishedAt).toBeUndefined();
  });

  it("counts an accepted empty family snapshot as output that clears previous candidates", async () => {
    const { result, meta } = await runSync();
    expect(result.itemCount).toBe(0);
    expect(result.productivity?.productive).toBe(true);
    expect(meta.outputPublishedAt).toBe(meta.syncStartSec);
    expect(meta.familyCacheResults.beefy).toBe("empty-published");
  });

  it("retains the previous Aave snapshot when the miss ratio reaches the family threshold", async () => {
    vi.mocked(fetchAaveV3SupplyRates).mockResolvedValue({
      results: [usdcRate()],
      telemetry: {
        ...emptyRpcTelemetry(), targetCount: 3, attemptedCount: 3, resolvedTargetCount: 1, emittedCount: 1,
        missingTargetCount: 2, missingByChain: { ethereum: 2 }, missingReasonCounts: { "rpc-failure": 2 },
      },
    });
    const { meta } = await runSync();
    expect(hasNewerWrite("yield:supplemental-sources:v1:aaveV3")).toBe(false);
    expect(meta.familyCacheResults?.aaveV3).toBe("retained-previous");
    expect(meta.degradedFamilies).toContain("aaveV3");
  });

  it("publishes Aave successes when one ordinary target misses below the family threshold", async () => {
    vi.mocked(fetchAaveV3SupplyRates).mockResolvedValue({
      results: [usdcRate(), usdtRate()],
      telemetry: {
        ...emptyRpcTelemetry(), targetCount: 3, attemptedCount: 3, resolvedTargetCount: 2, emittedCount: 2,
        missingTargetCount: 1, missingByChain: { ethereum: 1 }, missingReasonCounts: { "reserve-data-unavailable": 1 },
      },
    });
    const { result, meta } = await runSync();
    expect(result.status).toBeUndefined();
    expect(hasNewerWrite("yield:supplemental-sources:v1:aaveV3")).toBe(true);
    expect(meta.familyCacheResults?.aaveV3).toBe("published");
    expect(meta.degradedFamilies).not.toContain("aaveV3");
  });

  it("retains the previous Royco snapshot when pagination ends early", async () => {
    vi.mocked(fetchRoycoDawnSources).mockResolvedValue({
      candidates: [beefyCandidate({}, { sourceKey: "royco-dawn:1:survivor:senior" })], degraded: true,
    });
    const { meta } = await runSync();
    expect(hasNewerWrite("yield:supplemental-sources:v1:roycoDawn")).toBe(false);
    expect(meta.familyCacheResults?.roycoDawn).toBe("retained-previous");
    expect(meta.degradedFamilies).toContain("roycoDawn");
  });

  it("retains the previous snapshot when a family callback fails outright", async () => {
    vi.mocked(fetchMorphoVaultSources).mockRejectedValue(new Error("morpho exploded"));
    vi.mocked(fetchBeefySources).mockResolvedValue(healthyFamilyFetch([beefyCandidate()]));
    const { meta } = await runSync();
    expect(meta.familyCacheResults?.morpho).toBe("retained-previous");
    expect(meta.degradedFamilies).toEqual(["morpho"]);
  });

  it("publishes an empty family row when a successful fetch genuinely has no candidates", async () => {
    vi.mocked(fetchBeefySources).mockResolvedValue(healthyFamilyFetch([beefyCandidate()]));
    const { meta } = await runSync();
    expect(JSON.parse(String(findNewerWrite("yield:supplemental-sources:v1:morpho")?.[2]))).toMatchObject({ sourceCount: 0, data: [] });
    expect(meta.familyCacheResults?.morpho).toBe("empty-published");
    expect(meta.degradedFamilies).toEqual([]);
  });

  it("keeps a recent marker-only admission skip distinct from proven artifact availability", async () => {
    const startSec = 1_774_526_400;
    vi.mocked(getCaches).mockResolvedValue(new Map([["yield:supplemental-sources:v1:morpho", { value: "{}", updatedAt: startSec - 3 * 3600 }]]));
    const { result, meta } = await runSync({ catchUpMinMarkerAgeSec: 4 * 3600 });

    expect(result.status).toBe("skipped_neutral");
    expect(result.itemCount).toBe(0);
    expect(meta).toMatchObject({
      reason: "supplemental-catch-up-marker-not-due", artifactProven: false,
      newestFamilyMarkerAgeSec: 3 * 3600, minMarkerAgeSec: 4 * 3600,
    });
    expect(fetchMorphoVaultSources).not.toHaveBeenCalled();
    expect(setCacheIfNewer).not.toHaveBeenCalled();
    expect(isProvenSatisfiedNeutralSkipReason(meta.reason)).toBe(false);
  });

  it("proves catch-up satisfied only after validating every current family artifact", async () => {
    const updatedAt = Math.floor(Date.now() / 1000) - 3 * 3600;
    vi.mocked(getCaches).mockResolvedValue(new Map(SUPPLEMENTAL_SOURCE_FAMILY_KEYS.map((f) => [getYieldSupplementalFamilyCacheKey(f), familyRow(updatedAt)])));
    const { result, meta } = await runSync({ catchUpMinMarkerAgeSec: 4 * 3600 });

    expect(result.status).toBe("skipped_neutral");
    expect(meta).toMatchObject({ reason: "supplemental-catch-up-not-due", artifactProven: true });
    expect(meta.provenFamilies).toHaveLength(SUPPLEMENTAL_SOURCE_FAMILY_KEYS.length);
    expect(isProvenSatisfiedNeutralSkipReason(meta.reason)).toBe(true);
    expect(result.productivity).toMatchObject({ productive: false });
    expect(fetchMorphoVaultSources).not.toHaveBeenCalled();
  });

  it.each(["missing", "malformed", "stale", "future", "invalid-row"])(
    "does not claim artifact satisfaction for a %s family", async (kind) => {
      const now = Math.floor(Date.now() / 1000);
      const updatedAt = now - 3600;
      const rows = new Map(SUPPLEMENTAL_SOURCE_FAMILY_KEYS.map((f) => [getYieldSupplementalFamilyCacheKey(f), familyRow(updatedAt)]));
      const key = getYieldSupplementalFamilyCacheKey(SUPPLEMENTAL_SOURCE_FAMILY_KEYS[0]);
      if (kind === "missing") rows.delete(key);
      else if (kind === "malformed") rows.set(key, { value: "{}", updatedAt });
      else if (kind === "invalid-row") rows.set(key, {
        value: JSON.stringify({ version: 1, updatedAt, source: "sync-yield-supplemental", sourceCount: 0, data: [{}] }), updatedAt,
      });
      else rows.set(key, familyRow(kind === "future" ? now + 60 : now - 4 * 3600));
      vi.mocked(getCaches).mockResolvedValue(rows);
      const { meta } = await runSync({ catchUpMinMarkerAgeSec: 4 * 3600 });
      expect(meta).toMatchObject({ reason: "supplemental-catch-up-marker-not-due", artifactProven: false });
      expect(isProvenSatisfiedNeutralSkipReason(meta.reason)).toBe(false);
    },
  );

  it("propagates failed catch-up readback instead of proving output exists", async () => {
    vi.mocked(getCaches).mockRejectedValueOnce(new Error("D1 unavailable"));
    await expect(runSync({ catchUpMinMarkerAgeSec: 4 * 3600 })).rejects.toThrow("D1 unavailable");
  });

  it("runs the catch-up once the newest family marker is older than the cadence", async () => {
    vi.mocked(getCaches).mockResolvedValue(new Map([["yield:supplemental-sources:v1:morpho", { value: "{}", updatedAt: 1_774_526_400 - 5 * 3600 }]]));
    const { result } = await runSync({ catchUpMinMarkerAgeSec: 4 * 3600 });
    expect(result.status).not.toBe("skipped_neutral");
    expect(fetchMorphoVaultSources).toHaveBeenCalled();
  });

  it("runs the catch-up when no family marker has ever been written", async () => {
    vi.mocked(getCaches).mockResolvedValue(new Map());
    const { result } = await runSync({ catchUpMinMarkerAgeSec: 4 * 3600 });
    expect(result.status).not.toBe("skipped_neutral");
    expect(fetchMorphoVaultSources).toHaveBeenCalled();
  });

  it("bounds optional RPC missing-target examples in source family summaries", async () => {
    const missingTargets = Array.from({ length: 30 }, (_, i) => `ethereum:T${i}`);
    vi.mocked(fetchAaveV3SupplyRates).mockResolvedValue({
      results: [usdcRate()],
      telemetry: {
        ...emptyRpcTelemetry(), targetCount: 30, attemptedCount: 4, resolvedTargetCount: 1, emittedCount: 1,
        missingTargetCount: 29, missingByChain: { ethereum: 29 }, missingReasonCounts: { "budget-exhausted": 29 },
        missingTargets, missingTargetsTruncated: true, budgetExhausted: true,
      },
    });
    const { meta } = await runSync();
    expect(hasNewerWrite("yield:supplemental-sources:v1:aaveV3")).toBe(false);
    expect(meta.familyCacheResults?.aaveV3).toBe("retained-previous");
    expect(meta.sourceCoverage?.sourceFamilySummaries?.aaveV3?.optionalRpc).toMatchObject({
      missingTargetCount: 29, budgetExhausted: true, missingTargetExamplesTruncated: true,
    });
    expect(meta.sourceCoverage?.sourceFamilySummaries?.aaveV3?.optionalRpc?.missingTargetExamples).toHaveLength(
      OPTIONAL_RPC_MISSING_TARGET_EXAMPLE_LIMIT,
    );
  });

  it("keeps same-asset Aave markets on different chains when per-target results are available", async () => {
    vi.mocked(fetchAaveV3SupplyRates).mockResolvedValue({
      results: [usdcRate(), aaveRate("usdc-circle", "USDC", "base", BASE_USDC_ADDR, 3.5, 40_000_000)],
      telemetry: { ...emptyRpcTelemetry(), targetCount: 2, attemptedCount: 2, resolvedTargetCount: 2, emittedCount: 2 },
    });
    const { result } = await runSync();
    expect(result.itemCount).toBe(2);
    const payload = JSON.parse(String(findNewerWrite("yield:supplemental-sources:v1:aaveV3")?.[2]));
    expect(payload.sourceCount).toBe(2);
    expect(payload.data).toEqual([
      expect.objectContaining({
        stablecoinId: "usdc-circle",
        yield: expect.objectContaining({ sourceKey: `aave-v3-onchain:ethereum:${USDC_ADDR.toLowerCase()}`, currentApy: 4.25, sourceTvlUsd: 100_000_000 }),
      }),
      expect.objectContaining({
        stablecoinId: "usdc-circle",
        yield: expect.objectContaining({ sourceKey: `aave-v3-onchain:base:${BASE_USDC_ADDR.toLowerCase()}`, currentApy: 3.5, sourceTvlUsd: 40_000_000 }),
      }),
    ]);
  });

  it("dedupes on the newest observation and reports the drop count", async () => {
    vi.mocked(fetchBeefySources).mockResolvedValue(healthyFamilyFetch([
      beefyCandidate({}, { currentApy: 9.9, apyBase: 9.9, sourceTvlUsd: 1_000_000, yieldType: "lending-vault", sourceObservedAt: 1_774_500_000 }),
      beefyCandidate({}, { currentApy: 5.5, apyBase: 5.5, sourceTvlUsd: 1_000_000, yieldType: "lending-vault" }),
      beefyCandidate({ symbol: "USDT", address: USDT_ADDR }, {
        currentApy: 4, apyBase: 4, sourcePool: "vault-b", sourceTvlUsd: 2_000_000,
        sourceKey: "protocol-api:beefy:ethereum:vault-b", yieldSource: "Beefy: vault-b", yieldType: "lending-vault",
      }),
    ]));
    const { result, meta } = await runSync();
    expect(result.itemCount).toBe(2);

    const payload = JSON.parse(String(findNewerWrite("yield:supplemental-sources:v1:beefy")?.[2]));
    expect(payload.sourceCount).toBe(2);
    expect(payload.data).toEqual([
      expect.objectContaining({ yield: expect.objectContaining({ sourceKey: "protocol-api:beefy:ethereum:vault-a", currentApy: 5.5 }) }),
      expect.objectContaining({ yield: expect.objectContaining({ sourceKey: "protocol-api:beefy:ethereum:vault-b", currentApy: 4 }) }),
    ]);
    expect(meta).toMatchObject({
      rowsRead: 3, rowsWritten: 2, rowsDropped: 1,
      sourceCoverage: {
        rawSupplementalCandidates: 3, dedupedSupplementalCandidates: 2,
        optionalRpcTelemetry: { compoundV3: { emittedCount: 0 }, aaveV3: { emittedCount: 0 } },
        sourceFamilySummaries: {
          beefy: {
            dedupeDiscardedValues: [{
              sourceKey: "protocol-api:beefy:ethereum:vault-a", discardedApy: 9.9,
              discardedObservedAt: 1_774_500_000, keptApy: 5.5, keptObservedAt: 1_774_526_400,
            }],
          },
        },
      },
    });
  });

  it.each(["observation", "retrieval"] as const)("breaks a dedupe tie using %s clocks before TVL", async (clock) => {
    const observedAt = 1_774_526_400;
    const clocks = clock === "observation"
      ? [{ sourceObservedAt: observedAt }, { sourceObservedAt: observedAt }]
      : [{ sourceObservedAt: null, sourceFetchedAt: observedAt }, { sourceObservedAt: null, sourceFetchedAt: observedAt - 1 }];
    vi.mocked(fetchBeefySources).mockResolvedValue(healthyFamilyFetch([
      beefyCandidate({}, { currentApy: 4.2, apyBase: 4.2, sourceTvlUsd: 1_000_000, ...clocks[0] }),
      beefyCandidate({}, { currentApy: 3.8, apyBase: 3.8, sourceTvlUsd: 9_000_000, ...clocks[1] }),
    ]));
    const { meta } = await runSync();

    const beefyCacheCall = findNewerWrite("yield:supplemental-sources:v1:beefy");
    const payload = parseYieldSupplementalSourcesCache(String(beefyCacheCall?.[2]), beefyCacheCall![3]);
    expect(payload?.sourceCount).toBe(1);
    const hasObservation = clock === "observation";
    expect(payload?.candidates[0]?.yield).toMatchObject(hasObservation
      ? { currentApy: 3.8, sourceTvlUsd: 9_000_000, sourceObservedAt: observedAt }
      : { currentApy: 4.2, sourceTvlUsd: 1_000_000, sourceObservedAt: null, sourceFetchedAt: observedAt });
    expect(meta.degradedFamilies).toEqual([]);
    expect(meta.sourceCoverage?.sourceFamilySummaries?.beefy?.dedupeDiscardedValues).toEqual([
      expect.objectContaining(hasObservation ? { discardedApy: 4.2, keptApy: 3.8 }
        : { discardedApy: 3.8, keptApy: 4.2, discardedObservedAt: null, keptObservedAt: null }),
    ]);
  });

  it("drops malformed supplemental source rows with source-family examples", async () => {
    const row = (symbol: string, address: string, y: Record<string, unknown>) => ({
      symbol, chain: "ethereum", address,
      yield: {
        currentApy: 5, apyBase: 5, apyReward: null, sourcePool: "vault-a", sourceTvlUsd: 1_000_000,
        dataSource: "protocol-api" as const, exchangeRate: null, sourceKey: "", yieldSource: "Beefy: vault-a",
        yieldType: "lending-vault" as const, sourceObservedAt: 1_774_526_400, comparisonAnchorObservedAt: null, ...y,
      },
    });
    vi.mocked(fetchBeefySources).mockResolvedValue(healthyFamilyFetch([
      row("USDC", USDC_ADDR, {}),
      row("USDT", USDT_ADDR, { currentApy: 4, apyBase: 4, sourcePool: "vault-b", sourceTvlUsd: 2_000_000, sourceKey: "protocol-api:beefy:ethereum:vault-b", yieldSource: "Beefy: vault-b" }),
      row("USDC", USDC_ADDR, { currentApy: 5000, apyBase: 5000, sourcePool: "vault-over-envelope", sourceKey: "protocol-api:beefy:ethereum:vault-over-envelope", yieldSource: "Beefy: vault-over-envelope" }),
    ]));
    const { result, meta } = await runSync();
    expect(result.itemCount).toBe(1);

    const payload = JSON.parse(String(findNewerWrite("yield:supplemental-sources:v1:beefy")?.[2]));
    expect(payload.sourceCount).toBe(1);
    expect(payload.data[0]?.yield.sourceKey).toBe("protocol-api:beefy:ethereum:vault-b");
    expect(meta.sourceCoverage?.sourceFamilyCounts?.beefy).toBe(3);
    expect(meta.sourceCoverage?.supplementalSourceAccounting).toMatchObject({
      malformedSourceDrops: { total: 1, bySourceFamily: { beefy: 1 }, exampleSourceKeysBySourceFamily: { beefy: ["(missing-source-key)"] } },
      apyEnvelopeDrops: { total: 1, bySourceFamily: { beefy: 1 }, exampleSourceKeysBySourceFamily: { beefy: ["protocol-api:beefy:ethereum:vault-over-envelope"] } },
    });
  });

  it("bounds supplemental source family execution concurrency", async () => {
    const started: SupplementalSourceFamilyKey[] = [];
    const pending = new Map<SupplementalSourceFamilyKey, () => void>();
    let active = 0;
    let maxActive = 0;
    const trackFamily = <T,>(key: SupplementalSourceFamilyKey, result: T) => () => {
      started.push(key);
      maxActive = Math.max(maxActive, ++active);
      return new Promise<T>((resolve) => {
        pending.set(key, () => { active -= 1; pending.delete(key); resolve(result); });
      });
    };

    vi.mocked(fetchMorphoVaultSources).mockImplementation(trackFamily("morpho", healthyFamilyFetch()));
    vi.mocked(fetchPendleMarketSources).mockImplementation(trackFamily("pendle", healthyFamilyFetch()));
    vi.mocked(fetchYearnKongSources).mockImplementation(trackFamily("yearnKong", healthyFamilyFetch()));
    vi.mocked(fetchBeefySources).mockImplementation(trackFamily("beefy", healthyFamilyFetch()));
    vi.mocked(fetchRoycoDawnSources).mockImplementation(trackFamily("roycoDawn", { candidates: [], degraded: false }));
    vi.mocked(fetchCompoundV3SupplyRates).mockImplementation(trackFamily("compoundV3", { results: [], telemetry: emptyRpcTelemetry() }));
    vi.mocked(fetchAaveV3SupplyRates).mockImplementation(trackFamily("aaveV3", { results: [], telemetry: emptyRpcTelemetry() }));

    const loadPromise = loadSupplementalSourceFamilies({ startSec: 1 });
    await flushMicrotasks();
    expect(started).toEqual(["morpho"]);

    pending.get("morpho")?.();
    await flushMicrotasks();
    expect(started).toEqual(["morpho", "pendle"]);

    pending.get("pendle")?.();
    await flushMicrotasks();
    expect(started).toEqual(["morpho", "pendle", "yearnKong"]);

    while (pending.size > 0) {
      pending.values().next().value?.();
      await flushMicrotasks();
    }

    const result = await loadPromise;
    expect(maxActive).toBeLessThanOrEqual(SUPPLEMENTAL_SOURCE_FAMILY_CONCURRENCY);
    expect(result.supplementalSourceAccounting.familyExecution).toEqual({
      familyCount: SUPPLEMENTAL_SOURCE_FAMILY_KEYS.length, concurrencyLimit: SUPPLEMENTAL_SOURCE_FAMILY_CONCURRENCY,
    });
  });

  it("keeps successful family results when another supplemental family throws", async () => {
    vi.mocked(fetchMorphoVaultSources).mockRejectedValue(new Error("morpho exploded"));
    vi.mocked(fetchBeefySources).mockResolvedValue(healthyFamilyFetch([beefyCandidate()]));
    const { result } = await runSync();

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(1);
    const payload = JSON.parse(String(findNewerWrite("yield:supplemental-sources:v1:beefy")?.[2]));
    expect(payload.sourceCount).toBe(1);
    expect(payload.data[0]?.yield.sourceKey).toBe("protocol-api:beefy:ethereum:vault-a");
    expect(hasNewerWrite("yield:supplemental-sources:v1:morpho")).toBe(false);
    expect(hasNewerWrite("yield:supplemental-sources:v1:beefy")).toBe(true);
  });

  describe("family count-drop detection", () => {
    const morphoKey = getYieldSupplementalFamilyCacheKey("morpho");
    const stateKey = getYieldSupplementalCountDropStateCacheKey();
    const morphoCandidates = (count: number) => Array.from({ length: count }, (_, i) =>
      beefyCandidate({ address: `0x${(i + 1).toString(16).padStart(40, "0")}` }, { sourceKey: `protocol-api:morpho-vault:ethereum:vault-${i}` }),
    );
    const dropStateRow = (morpho: { baseline: number; strikes: number; consistentRuns: number }, at: number) => ({
      value: buildYieldSupplementalCountDropState({ morpho }, at), updatedAt: at,
    });

    it("retains a collapsed family read without degrading on the first strike", async () => {
      const now = Math.floor(Date.now() / 1000);
      vi.mocked(getCaches).mockResolvedValue(new Map([[morphoKey, familyRow(now - 14_400, morphoCandidates(4))]]));
      vi.mocked(fetchMorphoVaultSources).mockResolvedValue(healthyFamilyFetch(morphoCandidates(1)));
      const { result, meta } = await runSync();

      expect(result.status).toBeUndefined();
      expect(meta.familyCacheResults.morpho).toBe("retained-previous");
      expect(meta.degradedFamilies).toEqual([]);
      expect(meta.familyCountDrops.morpho).toEqual({
        baseline: 4, previousCount: 4, candidateCount: 1, strikes: 1, consistentRuns: 0, retained: true, accepted: false,
      });
      expect(hasNewerWrite(morphoKey)).toBe(false);
      expect(JSON.parse(String(findSetCache(stateKey)?.[2])).families).toEqual({
        morpho: { baseline: 4, strikes: 1, consistentRuns: 0 },
      });
    });

    it("degrades a family after two consecutive collapsed reads", async () => {
      const now = Math.floor(Date.now() / 1000);
      vi.mocked(getCaches).mockResolvedValue(new Map([
        [morphoKey, familyRow(now - 14_400, morphoCandidates(4))],
        [stateKey, dropStateRow({ baseline: 4, strikes: 1, consistentRuns: 0 }, now - 3_600)],
      ]));
      vi.mocked(fetchMorphoVaultSources).mockResolvedValue(healthyFamilyFetch(morphoCandidates(1)));
      const { result, meta } = await runSync();

      expect(result.status).toBe("degraded");
      expect(meta).toMatchObject({
        degradedFamilies: ["morpho"], degradedFamilyReasons: { morpho: "family-count-drop" }, reason: "family-count-drop:morpho",
      });
      expect(meta.familyCountDrops.morpho.strikes).toBe(2);
      expect(hasNewerWrite(morphoKey)).toBe(false);
    });

    it("publishes the recovered family and clears its strike", async () => {
      const now = Math.floor(Date.now() / 1000);
      vi.mocked(getCaches).mockResolvedValue(new Map([
        [morphoKey, familyRow(now - 14_400, morphoCandidates(4))],
        [stateKey, dropStateRow({ baseline: 4, strikes: 1, consistentRuns: 0 }, now - 3_600)],
      ]));
      vi.mocked(fetchMorphoVaultSources).mockResolvedValue(healthyFamilyFetch(morphoCandidates(4)));
      const { result, meta } = await runSync();

      expect(result.status).toBeUndefined();
      expect(meta.familyCacheResults.morpho).toBe("published");
      expect(meta.familyCountDrops).toBeUndefined();
      expect(JSON.parse(String(findSetCache(stateKey)?.[2])).families).toEqual({});
    });

    it("publishes the smaller snapshot with its real clock once the confirmation window closes", async () => {
      const now = Math.floor(Date.now() / 1000);
      vi.mocked(getCaches).mockResolvedValue(new Map([
        [morphoKey, familyRow(now - 7_200, morphoCandidates(4))],
        [stateKey, dropStateRow({ baseline: 4, strikes: 2, consistentRuns: 0 }, now - 3_600)],
      ]));
      vi.mocked(fetchMorphoVaultSources).mockResolvedValue(healthyFamilyFetch(morphoCandidates(1)));
      const { result, meta } = await runSync();
      const publishCall = findNewerWrite(morphoKey);

      expect(result.status).toBe("degraded");
      expect(meta).toMatchObject({ reason: "family-count-drop:morpho", familyCacheResults: { morpho: "published" } });
      expect(meta.familyCountDrops.morpho).toMatchObject({ strikes: 3, retained: false });
      expect(publishCall?.[3]).toBe(now);
      expect(JSON.parse(String(publishCall?.[2])).sourceCount).toBe(1);
    });

    it("never retains past the family's own freshness budget", async () => {
      const now = Math.floor(Date.now() / 1000);
      vi.mocked(getCaches).mockResolvedValue(new Map([[morphoKey, familyRow(now - 7 * 3_600, morphoCandidates(4))]]));
      vi.mocked(fetchMorphoVaultSources).mockResolvedValue(healthyFamilyFetch(morphoCandidates(1)));
      const { result, meta } = await runSync();

      expect(result.status).toBe("degraded");
      expect(meta.reason).toBe("family-count-drop:morpho");
      expect(meta.familyCountDrops.morpho).toMatchObject({ strikes: 1, retained: false });
      expect(hasNewerWrite(morphoKey)).toBe(true);
    });

    it("accepts the new level after six consistent runs", async () => {
      const now = Math.floor(Date.now() / 1000);
      vi.mocked(getCaches).mockResolvedValue(new Map([
        [morphoKey, familyRow(now - 3_600, morphoCandidates(1))],
        [stateKey, dropStateRow({ baseline: 4, strikes: 5, consistentRuns: 5 }, now - 3_600)],
      ]));
      vi.mocked(fetchMorphoVaultSources).mockResolvedValue(healthyFamilyFetch(morphoCandidates(1)));
      const { result, meta } = await runSync();

      expect(result.status).toBeUndefined();
      expect(meta.familyCountDrops.morpho).toMatchObject({ consistentRuns: 6, accepted: true });
      expect(meta.degradedFamilies).toEqual([]);
      expect(JSON.parse(String(findSetCache(stateKey)?.[2])).families).toEqual({});
    });
  });
});
