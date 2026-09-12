import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CronProgressUpdate } from "../../lib/cron-logger";
import { mockRegistry } from "../../test-helpers/cron";
import {
  beefyCandidate,
  degradedFamilyFetch,
  emptyRpcTelemetry,
  emptyVaultsFyiResult,
  healthyFamilyFetch,
} from "./sync-yield-supplemental.test-support";

const OPTIONAL_RPC_MISSING_TARGET_EXAMPLE_LIMIT = 20;


vi.mock("@shared/lib/stablecoins/registry", () => {
  const stablecoins = [
    {
      id: "usdc-circle",
      symbol: "USDC",
      contracts: [{ chain: "ethereum", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 }],
    },
    {
      id: "usdt-tether",
      symbol: "USDT",
      contracts: [{ chain: "ethereum", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 }],
    },
    {
      id: "eurc-circle",
      symbol: "EURC",
      contracts: [{ chain: "base", address: "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42", decimals: 6 }],
    },
  ];

  return mockRegistry({ stablecoins });
});

vi.mock("../yield-sync/sources", async () => {
  // The hoisted mock factory runs before static fixture imports initialize, so
  // the fixture module must be loaded dynamically here (vitest hoisting).
  const { emptyRpcTelemetry, emptyVaultsFyiResult, healthyFamilyFetch } = await import(
    "./sync-yield-supplemental.test-support"
  );
  return {
  COMPOUND_V3_COMETS: [],
  fetchMorphoVaultSources: vi.fn(async () => healthyFamilyFetch()),
  fetchPendleMarketSources: vi.fn(async () => healthyFamilyFetch()),
  fetchRoycoDawnSources: vi.fn(async () => ({ candidates: [], degraded: false })),
  fetchVaultsFyiSources: vi.fn(async () => emptyVaultsFyiResult()),
  fetchYearnKongSources: vi.fn(async () => healthyFamilyFetch()),
  fetchBeefySources: vi.fn(async () => healthyFamilyFetch()),
  fetchCompoundV3SupplyRates: vi.fn(async () => ({
    results: [],
    telemetry: emptyRpcTelemetry(),
  })),
  fetchAaveV3SupplyRates: vi.fn(async () => ({
    results: [],
    telemetry: emptyRpcTelemetry(),
  })),
  };
});

vi.mock("../yield-sync/sources-rpc", () => ({
  OPTIONAL_RPC_MISSING_TARGET_EXAMPLE_LIMIT: 20,
}));

vi.mock("../../lib/db-cache", () => ({
  getCaches: vi.fn(async () => new Map()),
  setCache: vi.fn(async () => undefined),
  setCacheIfNewer: vi.fn(async () => ({ written: true, skippedBecauseNewer: false })),
}));

import { getCaches, setCache, setCacheIfNewer } from "../../lib/db-cache";
import {
  fetchAaveV3SupplyRates,
  fetchBeefySources,
  fetchCompoundV3SupplyRates,
  fetchMorphoVaultSources,
  fetchPendleMarketSources,
  fetchRoycoDawnSources,
  fetchVaultsFyiSources,
  fetchYearnKongSources,
} from "../yield-sync/sources";
import { syncYieldSupplemental } from "../sync-yield-supplemental";
import {
  loadSupplementalSourceFamilies,
  SUPPLEMENTAL_SOURCE_FAMILY_KEYS,
  SUPPLEMENTAL_SOURCE_FAMILY_CONCURRENCY,
} from "../yield-sync/supplemental-source-families";

async function flushMicrotasks() {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

describe("syncYieldSupplemental", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-26T12:00:00.000Z"));
    vi.mocked(fetchMorphoVaultSources).mockResolvedValue(healthyFamilyFetch());
    vi.mocked(fetchPendleMarketSources).mockResolvedValue(healthyFamilyFetch());
    vi.mocked(fetchRoycoDawnSources).mockResolvedValue({ candidates: [], degraded: false });
    vi.mocked(fetchVaultsFyiSources).mockResolvedValue(emptyVaultsFyiResult());
    vi.mocked(fetchYearnKongSources).mockResolvedValue(healthyFamilyFetch());
    vi.mocked(fetchCompoundV3SupplyRates).mockResolvedValue({ results: [], telemetry: emptyRpcTelemetry() });
    vi.mocked(fetchAaveV3SupplyRates).mockResolvedValue({ results: [], telemetry: emptyRpcTelemetry() });
    vi.mocked(fetchBeefySources).mockResolvedValue(healthyFamilyFetch());
    vi.mocked(getCaches).mockResolvedValue(new Map());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("reports supplemental source-family and empty-snapshot progress metadata", async () => {
    const progressUpdates: CronProgressUpdate[] = [];
    const reportProgress = vi.fn(async (update: CronProgressUpdate) => {
      progressUpdates.push(update);
    });

    const result = await syncYieldSupplemental({} as D1Database, undefined, new Map(), reportProgress);

    expect(result.status).toBe("degraded");
    expect(progressUpdates.find((update) => update.stage === "source-family-fetch")).toMatchObject({
      metadata: {
        providerFamily: "yield-supplemental",
        phase: "source-family-fetch",
        providerFamilies: expect.arrayContaining(["aaveV3", "compoundV3"]),
        countTotals: { sourceFamilies: expect.any(Number) },
      },
    });
    expect(progressUpdates.find((update) => update.stage === "empty-snapshot")).toMatchObject({
      metadata: {
        providerFamily: "yield-supplemental",
        phase: "empty-snapshot",
        fallbackMode: "empty-snapshot",
        countTotals: {
          rawSupplementalCandidates: 0,
          rowsDropped: 0,
        },
      },
    });
    expect(vi.mocked(setCacheIfNewer)).toHaveBeenCalledTimes(SUPPLEMENTAL_SOURCE_FAMILY_KEYS.length);
    const cacheKeys = vi.mocked(setCacheIfNewer).mock.calls.map((call) => call[1]);
    expect(cacheKeys).toEqual(
      expect.arrayContaining(SUPPLEMENTAL_SOURCE_FAMILY_KEYS.map((family) => `yield:supplemental-sources:v1:${family}`)),
    );
    expect(progressUpdates.some((update) => update.stage === "aggregate-cache-write")).toBe(false);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata).not.toHaveProperty("cacheWriteSkipped");
    expect(metadata).not.toHaveProperty("cacheWriteMode");
    expect(metadata).not.toHaveProperty("casSkipped");
    expect(metadata).not.toHaveProperty("cacheKey");
  });

  it("threads vaults.fyi runtime config into the supplemental source family loader without persisting the key", async () => {
    const signal = new AbortController().signal;
    const vaultsFyi = {
      enabled: true as const,
      disabledReason: null,
      apiKey: "vaults-key",
      rankableVaults: ["base:vault-a"],
      maxCreditsPerRun: 25,
      maxCreditsPerMonth: null,
      maxPagesPerRun: null,
    };

    const db = {} as D1Database;
    const result = await syncYieldSupplemental(db, signal, new Map(), undefined, vaultsFyi);

    expect(fetchVaultsFyiSources).toHaveBeenCalledWith({
      db,
      config: vaultsFyi,
      signal,
      startSec: 1_774_526_400,
    });
    expect(result.metadata).not.toContain("vaults-key");
  });

  it("keeps distinct same-chain Aave candidates by using asset-scoped source keys", async () => {
    vi.mocked(fetchAaveV3SupplyRates).mockResolvedValue({
      results: [
        {
          stablecoinId: "usdc-circle",
          symbol: "USDC",
          chain: "ethereum",
          assetAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          apy: 4.25,
          sourceTvlUsd: 100_000_000,
        },
        {
          stablecoinId: "usdt-tether",
          symbol: "USDT",
          chain: "ethereum",
          assetAddress: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
          apy: 3.75,
          sourceTvlUsd: 80_000_000,
        },
        {
          stablecoinId: "eurc-circle",
          symbol: "EURC",
          chain: "base",
          assetAddress: "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42",
          apy: 2.1,
          sourceTvlUsd: 10_000_000,
        },
      ],
      telemetry: {
        ...emptyRpcTelemetry(),
        targetCount: 3,
        attemptedCount: 3,
        resolvedTargetCount: 3,
        emittedCount: 3,
      },
    });

    const result = await syncYieldSupplemental({} as D1Database, undefined, new Map());

    expect(result.status).toBeUndefined();
    expect(result.itemCount).toBe(3);

    const cacheCall = vi
      .mocked(setCacheIfNewer)
      .mock.calls.find((call) => call[1] === "yield:supplemental-sources:v1:aaveV3");
    expect(cacheCall?.[1]).toBe("yield:supplemental-sources:v1:aaveV3");
    expect(vi.mocked(setCacheIfNewer).mock.calls.map((call) => call[1])).not.toContain(
      "yield:supplemental-sources:v1",
    );

    const payload = JSON.parse(String(cacheCall?.[2])) as {
      sourceCount: number;
      data: Array<{ yield: { sourceKey: string; dataSource: string } }>;
    };

    expect(payload.sourceCount).toBe(3);
    expect(payload.data.map((entry) => entry.yield.sourceKey)).toEqual([
      "aave-v3-onchain:ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      "aave-v3-onchain:ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7",
      "aave-v3-onchain:base:0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42",
    ]);
    expect(payload.data.map((entry) => entry.yield.dataSource)).toEqual([
      "protocol-api",
      "protocol-api",
      "protocol-api",
    ]);

    const metadata = JSON.parse(result.metadata ?? "{}") as {
      rowsRead: number;
      rowsWritten: number;
      rowsDropped: number;
      sourceCoverage?: {
        rawSupplementalCandidates?: number;
        dedupedSupplementalCandidates?: number;
        sourceFamilyCounts?: { aaveV3?: number };
        sourceFamilySummaries?: {
          aaveV3?: {
            status?: string;
            rawCandidateCount?: number;
            candidateCount?: number;
            optionalRpc?: {
              targetCount?: number;
              attemptedCount?: number;
              resolvedTargetCount?: number;
              emittedCount?: number;
              missingTargetExamplesTruncated?: boolean;
            };
          };
        };
        optionalRpcTelemetry?: {
          aaveV3?: { resolvedTargetCount?: number; emittedCount?: number; missingTargetCount?: number };
        };
      };
    };

    expect(metadata.rowsRead).toBe(3);
    expect(metadata.rowsWritten).toBe(3);
    expect(metadata.rowsDropped).toBe(0);
    expect(metadata.sourceCoverage?.rawSupplementalCandidates).toBe(3);
    expect(metadata.sourceCoverage?.dedupedSupplementalCandidates).toBe(3);
    expect(metadata.sourceCoverage?.sourceFamilyCounts?.aaveV3).toBe(3);
    expect(metadata.sourceCoverage?.optionalRpcTelemetry?.aaveV3?.resolvedTargetCount).toBe(3);
    expect(metadata.sourceCoverage?.optionalRpcTelemetry?.aaveV3?.emittedCount).toBe(3);
    expect(metadata.sourceCoverage?.optionalRpcTelemetry?.aaveV3?.missingTargetCount).toBe(0);
    expect(metadata.sourceCoverage?.sourceFamilySummaries?.aaveV3).toMatchObject({
      status: "ok",
      rawCandidateCount: 3,
      candidateCount: 3,
      optionalRpc: {
        targetCount: 3,
        attemptedCount: 3,
        resolvedTargetCount: 3,
        emittedCount: 3,
        missingTargetExamplesTruncated: false,
      },
    });
  });

  it("retains the previous family snapshot when the fetch ends degraded", async () => {
    vi.mocked(fetchBeefySources).mockResolvedValue(healthyFamilyFetch([beefyCandidate()]));
    // A 5xx from Morpho ends the fetch early: its previous snapshot must survive.
    vi.mocked(fetchMorphoVaultSources).mockResolvedValue(degradedFamilyFetch());

    const result = await syncYieldSupplemental({} as D1Database, undefined, new Map());

    expect(
      vi.mocked(setCacheIfNewer).mock.calls.some((call) => call[1] === "yield:supplemental-sources:v1:beefy"),
    ).toBe(true);
    expect(
      vi.mocked(setCacheIfNewer).mock.calls.some((call) => call[1] === "yield:supplemental-sources:v1:morpho"),
    ).toBe(false);

    const metadata = JSON.parse(result.metadata ?? "{}") as {
      familyCacheResults?: Record<string, string>;
      degradedFamilies?: string[];
    };
    expect(metadata.familyCacheResults?.beefy).toBe("published");
    expect(metadata.familyCacheResults?.morpho).toBe("retained-previous");
    expect(metadata.degradedFamilies).toEqual(["morpho"]);

    const runOutcomeCall = vi
      .mocked(setCache)
      .mock.calls.find((call) => call[1] === "yield:supplemental-source-run:v1");
    expect(runOutcomeCall).toBeDefined();
    expect(JSON.parse(String(runOutcomeCall?.[2]))).toMatchObject({
      version: 1,
      degradedFamilies: ["morpho"],
      familyCacheResults: { morpho: "retained-previous", beefy: "published" },
    });
  });

  it("retains the previous RPC-family snapshot when some targets fail", async () => {
    // A per-target RPC failure resolves with a partial list under an `ok`
    // status; publishing it would replace the previous full snapshot (SRC-SUPP-2).
    vi.mocked(fetchAaveV3SupplyRates).mockResolvedValue({
      results: [
        {
          stablecoinId: "usdc-circle",
          symbol: "USDC",
          chain: "ethereum",
          assetAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          apy: 4.25,
          sourceTvlUsd: 100_000_000,
        },
      ],
      telemetry: {
        ...emptyRpcTelemetry(),
        targetCount: 3,
        attemptedCount: 3,
        resolvedTargetCount: 1,
        emittedCount: 1,
        missingTargetCount: 2,
        missingByChain: { ethereum: 2 },
        missingReasonCounts: { "rpc-failure": 2 },
      },
    });

    const result = await syncYieldSupplemental({} as D1Database, undefined, new Map());

    expect(
      vi.mocked(setCacheIfNewer).mock.calls.some((call) => call[1] === "yield:supplemental-sources:v1:aaveV3"),
    ).toBe(false);

    const metadata = JSON.parse(result.metadata ?? "{}") as {
      familyCacheResults?: Record<string, string>;
      degradedFamilies?: string[];
    };
    expect(metadata.familyCacheResults?.aaveV3).toBe("retained-previous");
    expect(metadata.degradedFamilies).toContain("aaveV3");
  });

  it("retains the previous Royco snapshot when pagination ends early", async () => {
    // SRC-SUPP-2: the paginated Royco walk returns the pages it already fetched
    // together with `degraded: true` instead of silently replacing the snapshot.
    vi.mocked(fetchRoycoDawnSources).mockResolvedValue({
      candidates: [beefyCandidate({}, { sourceKey: "royco-dawn:1:survivor:senior" })],
      degraded: true,
    });

    const result = await syncYieldSupplemental({} as D1Database, undefined, new Map());

    expect(
      vi.mocked(setCacheIfNewer).mock.calls.some((call) => call[1] === "yield:supplemental-sources:v1:roycoDawn"),
    ).toBe(false);

    const metadata = JSON.parse(result.metadata ?? "{}") as {
      familyCacheResults?: Record<string, string>;
      degradedFamilies?: string[];
    };
    expect(metadata.familyCacheResults?.roycoDawn).toBe("retained-previous");
    expect(metadata.degradedFamilies).toContain("roycoDawn");
  });

  it("retains the previous snapshot when a family callback fails outright", async () => {
    // A thrown family callback is the other degraded shape: the runner marks the
    // family failed and the writer must not publish an empty replacement.
    vi.mocked(fetchMorphoVaultSources).mockRejectedValue(new Error("morpho exploded"));
    vi.mocked(fetchBeefySources).mockResolvedValue(healthyFamilyFetch([beefyCandidate()]));

    const result = await syncYieldSupplemental({} as D1Database, undefined, new Map());

    const metadata = JSON.parse(result.metadata ?? "{}") as {
      familyCacheResults?: Record<string, string>;
      degradedFamilies?: string[];
    };
    expect(metadata.familyCacheResults?.morpho).toBe("retained-previous");
    expect(metadata.degradedFamilies).toEqual(["morpho"]);
  });

  it("publishes an empty family row when a successful fetch genuinely has no candidates", async () => {
    vi.mocked(fetchBeefySources).mockResolvedValue(healthyFamilyFetch([beefyCandidate()]));

    const result = await syncYieldSupplemental({} as D1Database, undefined, new Map());

    const morphoCall = vi
      .mocked(setCacheIfNewer)
      .mock.calls.find((call) => call[1] === "yield:supplemental-sources:v1:morpho");
    const morphoPayload = JSON.parse(String(morphoCall?.[2])) as { sourceCount: number; data: unknown[] };
    expect(morphoPayload.sourceCount).toBe(0);
    expect(morphoPayload.data).toEqual([]);

    const metadata = JSON.parse(result.metadata ?? "{}") as {
      familyCacheResults?: Record<string, string>;
      degradedFamilies?: string[];
    };
    expect(metadata.familyCacheResults?.morpho).toBe("empty-published");
    expect(metadata.degradedFamilies).toEqual([]);
  });

  it("skips the hourly catch-up while the newest family marker is younger than the cadence", async () => {
    const startSec = 1_774_526_400;
    vi.mocked(getCaches).mockResolvedValue(new Map([
      ["yield:supplemental-sources:v1:morpho", { value: "{}", updatedAt: startSec - 3 * 3600 }],
    ]));

    const result = await syncYieldSupplemental(
      {} as D1Database,
      undefined,
      new Map(),
      undefined,
      undefined,
      { catchUpMinMarkerAgeSec: 4 * 3600 },
    );

    expect(result.status).toBe("skipped_neutral");
    expect(result.itemCount).toBe(0);
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      reason: "supplemental-catch-up-not-due",
      newestFamilyMarkerAgeSec: 3 * 3600,
      minMarkerAgeSec: 4 * 3600,
    });
    expect(fetchMorphoVaultSources).not.toHaveBeenCalled();
    expect(setCacheIfNewer).not.toHaveBeenCalled();
  });

  it("runs the catch-up once the newest family marker is older than the cadence", async () => {
    const startSec = 1_774_526_400;
    vi.mocked(getCaches).mockResolvedValue(new Map([
      ["yield:supplemental-sources:v1:morpho", { value: "{}", updatedAt: startSec - 5 * 3600 }],
    ]));

    const result = await syncYieldSupplemental(
      {} as D1Database,
      undefined,
      new Map(),
      undefined,
      undefined,
      { catchUpMinMarkerAgeSec: 4 * 3600 },
    );

    expect(result.status).not.toBe("skipped_neutral");
    expect(fetchMorphoVaultSources).toHaveBeenCalled();
  });

  it("runs the catch-up when no family marker has ever been written", async () => {
    vi.mocked(getCaches).mockResolvedValue(new Map());

    const result = await syncYieldSupplemental(
      {} as D1Database,
      undefined,
      new Map(),
      undefined,
      undefined,
      { catchUpMinMarkerAgeSec: 4 * 3600 },
    );

    expect(result.status).not.toBe("skipped_neutral");
    expect(fetchMorphoVaultSources).toHaveBeenCalled();
  });

  it("registers vaults.fyi as a supplemental family with per-family cache metadata", async () => {
    vi.mocked(fetchVaultsFyiSources).mockResolvedValue({
      candidates: [
        {
          symbol: "USDC",
          chain: "base",
          address: "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42",
          yield: {
            currentApy: 4.8,
            apyBase: 4.8,
            apyReward: null,
            sourcePool: "base-vault-1",
            sourceTvlUsd: 2_500_000,
            dataSource: "protocol-api",
            exchangeRate: null,
            sourceKey: "protocol-api:vaults-fyi:base:base-vault-1",
            yieldSource: "vaults.fyi: base-vault-1",
            yieldType: "lending-opportunity",
            sourceObservedAt: 1_774_526_400,
            comparisonAnchorObservedAt: null,
          },
        },
      ],
      telemetry: {
        ...emptyVaultsFyiResult({ enabled: true, hasKey: true, rawVaultCount: 1, rankableCandidateCount: 1 }).telemetry,
        status: "ok",
        skipReason: null,
      },
    });

    const result = await syncYieldSupplemental({} as D1Database, undefined, new Map());

    expect(result.itemCount).toBe(1);
    expect(
      vi.mocked(setCacheIfNewer).mock.calls.some((call) => call[1] === "yield:supplemental-sources:v1:vaultsFyi"),
    ).toBe(true);

    const vaultsFyiCall = vi
      .mocked(setCacheIfNewer)
      .mock.calls.find((call) => call[1] === "yield:supplemental-sources:v1:vaultsFyi");
    const vaultsFyiPayload = JSON.parse(String(vaultsFyiCall?.[2])) as {
      sourceCount: number;
      data: Array<{ yield: { sourceKey: string } }>;
    };
    expect(vaultsFyiPayload.sourceCount).toBe(1);
    expect(vaultsFyiPayload.data[0]?.yield.sourceKey).toBe("protocol-api:vaults-fyi:base:base-vault-1");

    const metadata = JSON.parse(result.metadata ?? "{}") as {
      familyCacheResults?: Record<string, "published" | "skipped-newer" | "empty" | "empty-published">;
      sourceCoverage?: {
        sourceFamilyCounts?: { vaultsFyi?: number };
        sourceFamilyInventoryCounts?: { vaultsFyi?: number };
        sourceFamilySummaries?: {
          vaultsFyi?: {
            status?: string;
            rawCandidateCount?: number;
            candidateCount?: number;
            inventoryCount?: number;
            malformedDropCount?: number;
            provider?: {
              vaultsFyi?: {
                status?: string;
                rankableCandidateCount?: number;
              };
            };
          };
        };
      };
    };
    expect(metadata.familyCacheResults?.vaultsFyi).toBe("published");
    expect(metadata.sourceCoverage?.sourceFamilyCounts?.vaultsFyi).toBe(1);
    expect(metadata.sourceCoverage?.sourceFamilyInventoryCounts?.vaultsFyi).toBe(1);
    expect(metadata.sourceCoverage?.sourceFamilySummaries?.vaultsFyi).toMatchObject({
      status: "ok",
      rawCandidateCount: 1,
      candidateCount: 1,
      inventoryCount: 1,
      malformedDropCount: 0,
      provider: {
        vaultsFyi: {
          status: "ok",
          rankableCandidateCount: 1,
        },
      },
    });
  });

  it("keeps vaults.fyi audit inventory counts separate from supplemental candidate counts", async () => {
    vi.mocked(fetchBeefySources).mockResolvedValue(healthyFamilyFetch([beefyCandidate()]));
    vi.mocked(fetchVaultsFyiSources).mockResolvedValue({
      candidates: [],
      telemetry: {
        ...emptyVaultsFyiResult({
          enabled: true,
          hasKey: true,
          rawVaultCount: 8,
          auditOnlyCount: 8,
          creditsEstimated: 25,
          pageCount: 1,
          pageCapReached: true,
        }).telemetry,
        status: "ok",
        skipReason: null,
      },
    });

    const result = await syncYieldSupplemental({} as D1Database, undefined, new Map());
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      sourceCoverage?: {
        sourceFamilyCounts?: { vaultsFyi?: number };
        sourceFamilyInventoryCounts?: { vaultsFyi?: number };
        sourceFamilySummaries?: {
          vaultsFyi?: {
            rawCandidateCount?: number;
            candidateCount?: number;
            inventoryCount?: number;
            provider?: {
              vaultsFyi?: {
                pageCapReached?: boolean;
                rawVaultCount?: number;
                auditOnlyCount?: number;
              };
            };
          };
        };
      };
    };

    expect(metadata.sourceCoverage?.sourceFamilyCounts?.vaultsFyi).toBe(0);
    expect(metadata.sourceCoverage?.sourceFamilyInventoryCounts?.vaultsFyi).toBe(8);
    expect(metadata.sourceCoverage?.sourceFamilySummaries?.vaultsFyi).toMatchObject({
      rawCandidateCount: 0,
      candidateCount: 0,
      inventoryCount: 8,
      provider: {
        vaultsFyi: {
          pageCapReached: true,
          rawVaultCount: 8,
          auditOnlyCount: 8,
        },
      },
    });
  });

  it("retains the vaults.fyi snapshot when the provider run fails", async () => {
    vi.mocked(fetchBeefySources).mockResolvedValue(healthyFamilyFetch([beefyCandidate()]));
    vi.mocked(fetchVaultsFyiSources).mockResolvedValue({
      candidates: [],
      telemetry: {
        ...emptyVaultsFyiResult({ enabled: true, hasKey: true }).telemetry,
        status: "failed",
        skipReason: "request-failed",
      },
    });

    const result = await syncYieldSupplemental({} as D1Database, undefined, new Map());

    expect(
      vi.mocked(setCacheIfNewer).mock.calls.some((call) => call[1] === "yield:supplemental-sources:v1:vaultsFyi"),
    ).toBe(false);

    const metadata = JSON.parse(result.metadata ?? "{}") as {
      familyCacheResults?: Record<
        string,
        "published" | "skipped-newer" | "empty" | "empty-published" | "retained-previous"
      >;
      degradedFamilies?: string[];
      sourceCoverage?: {
        sourceFamilySummaries?: {
          vaultsFyi?: {
            status?: string;
            provider?: {
              vaultsFyi?: {
                skipReason?: string | null;
              };
            };
          };
        };
      };
    };
    expect(metadata.familyCacheResults?.vaultsFyi).toBe("retained-previous");
    expect(metadata.degradedFamilies).toEqual(["vaultsFyi"]);
    expect(metadata.sourceCoverage?.sourceFamilySummaries?.vaultsFyi).toMatchObject({
      status: "failed",
      provider: {
        vaultsFyi: {
          skipReason: "request-failed",
        },
      },
    });
  });

  it("bounds optional RPC missing-target examples in source family summaries", async () => {
    const missingTargets = Array.from({ length: 30 }, (_, index) => `ethereum:T${index}`);
    vi.mocked(fetchAaveV3SupplyRates).mockResolvedValue({
      results: [
        {
          stablecoinId: "usdc-circle",
          symbol: "USDC",
          chain: "ethereum",
          assetAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          apy: 4.25,
          sourceTvlUsd: 100_000_000,
        },
      ],
      telemetry: {
        ...emptyRpcTelemetry(),
        targetCount: 30,
        attemptedCount: 4,
        resolvedTargetCount: 1,
        emittedCount: 1,
        missingTargetCount: 29,
        missingByChain: { ethereum: 29 },
        missingReasonCounts: { "budget-exhausted": 29 },
        missingTargets,
        missingTargetsTruncated: true,
        budgetExhausted: true,
      },
    });

    const result = await syncYieldSupplemental({} as D1Database, undefined, new Map());
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      sourceCoverage?: {
        sourceFamilySummaries?: {
          aaveV3?: {
            optionalRpc?: {
              missingTargetExamples?: string[];
              missingTargetExamplesTruncated?: boolean;
              missingTargetCount?: number;
              budgetExhausted?: boolean;
            };
          };
        };
      };
    };

    expect(metadata.sourceCoverage?.sourceFamilySummaries?.aaveV3?.optionalRpc).toMatchObject({
      missingTargetCount: 29,
      budgetExhausted: true,
      missingTargetExamplesTruncated: true,
    });
    expect(
      metadata.sourceCoverage?.sourceFamilySummaries?.aaveV3?.optionalRpc?.missingTargetExamples,
    ).toHaveLength(OPTIONAL_RPC_MISSING_TARGET_EXAMPLE_LIMIT);
  });

  it("keeps same-asset Aave markets on different chains when per-target results are available", async () => {
    vi.mocked(fetchAaveV3SupplyRates).mockResolvedValue({
      results: [
        {
          stablecoinId: "usdc-circle",
          symbol: "USDC",
          chain: "ethereum",
          assetAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          apy: 4.25,
          sourceTvlUsd: 100_000_000,
        },
        {
          stablecoinId: "usdc-circle",
          symbol: "USDC",
          chain: "base",
          assetAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          apy: 3.5,
          sourceTvlUsd: 40_000_000,
        },
      ],
      telemetry: {
        ...emptyRpcTelemetry(),
        targetCount: 2,
        attemptedCount: 2,
        resolvedTargetCount: 2,
        emittedCount: 2,
      },
    });

    const result = await syncYieldSupplemental({} as D1Database, undefined, new Map());

    expect(result.itemCount).toBe(2);

    const aaveCacheCall = vi
      .mocked(setCacheIfNewer)
      .mock.calls.find((call) => call[1] === "yield:supplemental-sources:v1:aaveV3");
    const payload = JSON.parse(String(aaveCacheCall?.[2])) as {
      sourceCount: number;
      data: Array<{
        stablecoinId?: string;
        yield: { sourceKey: string; currentApy: number; sourceTvlUsd: number | null };
      }>;
    };
    expect(payload.sourceCount).toBe(2);
    expect(payload.data).toEqual([
      expect.objectContaining({
        stablecoinId: "usdc-circle",
        yield: expect.objectContaining({
          sourceKey: "aave-v3-onchain:ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          currentApy: 4.25,
          sourceTvlUsd: 100_000_000,
        }),
      }),
      expect.objectContaining({
        stablecoinId: "usdc-circle",
        yield: expect.objectContaining({
          sourceKey: "aave-v3-onchain:base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
          currentApy: 3.5,
          sourceTvlUsd: 40_000_000,
        }),
      }),
    ]);
  });

  it("dedupes on the newest observation and reports the drop count", async () => {
    // The older row is a transient APY spike: B27 keeps the current value.
    vi.mocked(fetchBeefySources).mockResolvedValue(healthyFamilyFetch([
      beefyCandidate({}, {
        currentApy: 9.9, apyBase: 9.9, sourceTvlUsd: 1_000_000, yieldType: "lending-vault",
        sourceObservedAt: 1_774_500_000,
      }),
      beefyCandidate({}, { currentApy: 5.5, apyBase: 5.5, sourceTvlUsd: 1_000_000, yieldType: "lending-vault" }),
      beefyCandidate(
        { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7" },
        {
          currentApy: 4, apyBase: 4, sourcePool: "vault-b", sourceTvlUsd: 2_000_000,
          sourceKey: "protocol-api:beefy:ethereum:vault-b", yieldSource: "Beefy: vault-b", yieldType: "lending-vault",
        },
      ),
    ]));

    const result = await syncYieldSupplemental({} as D1Database, undefined, new Map());

    expect(result.itemCount).toBe(2);

    const beefyCacheCall = vi
      .mocked(setCacheIfNewer)
      .mock.calls.find((call) => call[1] === "yield:supplemental-sources:v1:beefy");
    const payload = JSON.parse(String(beefyCacheCall?.[2])) as {
      sourceCount: number;
      data: Array<{ yield: { sourceKey: string; currentApy: number } }>;
    };
    expect(payload.sourceCount).toBe(2);
    expect(payload.data).toEqual([
      expect.objectContaining({
        yield: expect.objectContaining({
          sourceKey: "protocol-api:beefy:ethereum:vault-a",
          currentApy: 5.5,
        }),
      }),
      expect.objectContaining({
        yield: expect.objectContaining({
          sourceKey: "protocol-api:beefy:ethereum:vault-b",
          currentApy: 4,
        }),
      }),
    ]);

    const metadata = JSON.parse(result.metadata ?? "{}") as {
      rowsRead: number;
      rowsWritten: number;
      rowsDropped: number;
      sourceCoverage?: {
        rawSupplementalCandidates?: number;
        dedupedSupplementalCandidates?: number;
        sourceFamilySummaries?: {
          beefy?: {
            dedupeDiscardedValues?: Array<{
              sourceKey: string;
              discardedApy: number;
              discardedObservedAt: number | null;
              keptApy: number;
              keptObservedAt: number | null;
            }>;
          };
        };
        optionalRpcTelemetry?: {
          compoundV3?: { emittedCount?: number };
          aaveV3?: { emittedCount?: number };
        };
      };
    };

    expect(metadata.rowsRead).toBe(3);
    expect(metadata.rowsWritten).toBe(2);
    expect(metadata.rowsDropped).toBe(1);
    expect(metadata.sourceCoverage?.rawSupplementalCandidates).toBe(3);
    expect(metadata.sourceCoverage?.dedupedSupplementalCandidates).toBe(2);
    expect(metadata.sourceCoverage?.optionalRpcTelemetry?.compoundV3?.emittedCount).toBe(0);
    expect(metadata.sourceCoverage?.optionalRpcTelemetry?.aaveV3?.emittedCount).toBe(0);
    expect(metadata.sourceCoverage?.sourceFamilySummaries?.beefy?.dedupeDiscardedValues).toEqual([
      {
        sourceKey: "protocol-api:beefy:ethereum:vault-a",
        discardedApy: 9.9,
        discardedObservedAt: 1_774_500_000,
        keptApy: 5.5,
        keptObservedAt: 1_774_526_400,
      },
    ]);
  });

  it("breaks a dedupe tie on the larger TVL and reports zero degraded families", async () => {
    const observedAt = 1_774_526_400;
    vi.mocked(fetchBeefySources).mockResolvedValue(healthyFamilyFetch([
      beefyCandidate({}, {
        currentApy: 4.2, apyBase: 4.2, sourceTvlUsd: 1_000_000, sourceObservedAt: observedAt,
      }),
      beefyCandidate({}, {
        currentApy: 3.8, apyBase: 3.8, sourceTvlUsd: 9_000_000, sourceObservedAt: observedAt,
      }),
    ]));

    const result = await syncYieldSupplemental({} as D1Database, undefined, new Map());

    const beefyCacheCall = vi
      .mocked(setCacheIfNewer)
      .mock.calls.find((call) => call[1] === "yield:supplemental-sources:v1:beefy");
    const payload = JSON.parse(String(beefyCacheCall?.[2])) as {
      sourceCount: number;
      data: Array<{ yield: { currentApy: number; sourceTvlUsd: number } }>;
    };
    expect(payload.sourceCount).toBe(1);
    expect(payload.data[0]?.yield).toMatchObject({ currentApy: 3.8, sourceTvlUsd: 9_000_000 });

    const metadata = JSON.parse(result.metadata ?? "{}") as {
      degradedFamilies?: string[];
      sourceCoverage?: {
        sourceFamilySummaries?: { beefy?: { dedupeDiscardedValues?: Array<{ discardedApy: number }> } };
      };
    };
    expect(metadata.degradedFamilies).toEqual([]);
    expect(metadata.sourceCoverage?.sourceFamilySummaries?.beefy?.dedupeDiscardedValues).toEqual([
      expect.objectContaining({ discardedApy: 4.2, keptApy: 3.8 }),
    ]);
  });

  it("drops malformed supplemental source rows with source-family examples", async () => {
    vi.mocked(fetchBeefySources).mockResolvedValue(healthyFamilyFetch([
      {
        symbol: "USDC",
        chain: "ethereum",
        address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        yield: {
          currentApy: 5,
          apyBase: 5,
          apyReward: null,
          sourcePool: "vault-a",
          sourceTvlUsd: 1_000_000,
          dataSource: "protocol-api",
          exchangeRate: null,
          sourceKey: "",
          yieldSource: "Beefy: vault-a",
          yieldType: "lending-vault",
          sourceObservedAt: 1_774_526_400,
          comparisonAnchorObservedAt: null,
        },
      },
      {
        symbol: "USDT",
        chain: "ethereum",
        address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        yield: {
          currentApy: 4,
          apyBase: 4,
          apyReward: null,
          sourcePool: "vault-b",
          sourceTvlUsd: 2_000_000,
          dataSource: "protocol-api",
          exchangeRate: null,
          sourceKey: "protocol-api:beefy:ethereum:vault-b",
          yieldSource: "Beefy: vault-b",
          yieldType: "lending-vault",
          sourceObservedAt: 1_774_526_400,
          comparisonAnchorObservedAt: null,
        },
      },
    ]));

    const result = await syncYieldSupplemental({} as D1Database, undefined, new Map());

    expect(result.itemCount).toBe(1);

    const beefyCacheCall = vi
      .mocked(setCacheIfNewer)
      .mock.calls.find((call) => call[1] === "yield:supplemental-sources:v1:beefy");
    const payload = JSON.parse(String(beefyCacheCall?.[2])) as {
      sourceCount: number;
      data: Array<{ yield: { sourceKey: string } }>;
    };
    expect(payload.sourceCount).toBe(1);
    expect(payload.data[0]?.yield.sourceKey).toBe("protocol-api:beefy:ethereum:vault-b");

    const metadata = JSON.parse(result.metadata ?? "{}") as {
      sourceCoverage?: {
        sourceFamilyCounts?: { beefy?: number };
        supplementalSourceAccounting?: {
          malformedSourceDrops?: {
            total?: number;
            bySourceFamily?: { beefy?: number };
            exampleSourceKeysBySourceFamily?: { beefy?: string[] };
          };
          sizeGatedDrops?: { total?: number };
        };
      };
    };

    expect(metadata.sourceCoverage?.sourceFamilyCounts?.beefy).toBe(2);
    expect(metadata.sourceCoverage?.supplementalSourceAccounting?.malformedSourceDrops?.total).toBe(1);
    expect(metadata.sourceCoverage?.supplementalSourceAccounting?.malformedSourceDrops?.bySourceFamily?.beefy).toBe(1);
    expect(
      metadata.sourceCoverage?.supplementalSourceAccounting?.malformedSourceDrops?.exampleSourceKeysBySourceFamily
        ?.beefy,
    ).toEqual(["(missing-source-key)"]);
    expect(metadata.sourceCoverage?.supplementalSourceAccounting?.sizeGatedDrops?.total).toBe(0);
  });

  it("bounds supplemental source family execution concurrency", async () => {
    type PendingSource =
      | "morpho"
      | "pendle"
      | "yearnKong"
      | "beefy"
      | "vaultsFyi"
      | "compoundV3"
      | "aaveV3"
      | "roycoDawn";

    const started: PendingSource[] = [];
    const pending = new Map<PendingSource, () => void>();
    let active = 0;
    let maxActive = 0;

    function trackFamily<T>(key: PendingSource, result: T) {
      return () => {
        started.push(key);
        active += 1;
        maxActive = Math.max(maxActive, active);
        return new Promise<T>((resolve) => {
          pending.set(key, () => {
            active -= 1;
            pending.delete(key);
            resolve(result);
          });
        });
      };
    }

    vi.mocked(fetchMorphoVaultSources).mockImplementation(trackFamily("morpho", healthyFamilyFetch()));
    vi.mocked(fetchPendleMarketSources).mockImplementation(trackFamily("pendle", healthyFamilyFetch()));
    vi.mocked(fetchYearnKongSources).mockImplementation(trackFamily("yearnKong", healthyFamilyFetch()));
    vi.mocked(fetchBeefySources).mockImplementation(trackFamily("beefy", healthyFamilyFetch()));
    vi.mocked(fetchVaultsFyiSources).mockImplementation(trackFamily("vaultsFyi", emptyVaultsFyiResult()));
    vi.mocked(fetchRoycoDawnSources).mockImplementation(trackFamily("roycoDawn", { candidates: [], degraded: false }));
    vi.mocked(fetchCompoundV3SupplyRates).mockImplementation(
      trackFamily("compoundV3", {
        results: [],
        telemetry: emptyRpcTelemetry(),
      }),
    );
    vi.mocked(fetchAaveV3SupplyRates).mockImplementation(
      trackFamily("aaveV3", {
        results: [],
        telemetry: emptyRpcTelemetry(),
      }),
    );

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
      const resolveNext = pending.values().next().value;
      resolveNext?.();
      await flushMicrotasks();
    }

    const result = await loadPromise;

    expect(maxActive).toBeLessThanOrEqual(SUPPLEMENTAL_SOURCE_FAMILY_CONCURRENCY);
    expect(result.supplementalSourceAccounting.familyExecution).toEqual({
      familyCount: 8,
      concurrencyLimit: SUPPLEMENTAL_SOURCE_FAMILY_CONCURRENCY,
    });
  });

  it("keeps successful family results when another supplemental family throws", async () => {
    vi.mocked(fetchMorphoVaultSources).mockRejectedValue(new Error("morpho exploded"));
    vi.mocked(fetchBeefySources).mockResolvedValue(healthyFamilyFetch([beefyCandidate()]));

    const result = await syncYieldSupplemental({} as D1Database, undefined, new Map());

    expect(result.status).toBeUndefined();
    expect(result.itemCount).toBe(1);

    const beefyCacheCall = vi
      .mocked(setCacheIfNewer)
      .mock.calls.find((call) => call[1] === "yield:supplemental-sources:v1:beefy");
    const payload = JSON.parse(String(beefyCacheCall?.[2])) as {
      sourceCount: number;
      data: Array<{ yield: { sourceKey: string } }>;
    };
    expect(payload.sourceCount).toBe(1);
    expect(payload.data[0]?.yield.sourceKey).toBe("protocol-api:beefy:ethereum:vault-a");
    expect(
      vi.mocked(setCacheIfNewer).mock.calls.some((call) => call[1] === "yield:supplemental-sources:v1:morpho"),
    ).toBe(false);
    expect(
      vi.mocked(setCacheIfNewer).mock.calls.some((call) => call[1] === "yield:supplemental-sources:v1:beefy"),
    ).toBe(true);
  });
});
