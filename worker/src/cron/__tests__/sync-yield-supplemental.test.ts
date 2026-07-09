import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CronProgressUpdate } from "../../lib/cron-logger";

const OPTIONAL_RPC_MISSING_TARGET_EXAMPLE_LIMIT = 20;

const emptyTelemetry = {
  targetCount: 0,
  attemptedCount: 0,
  resolvedTargetCount: 0,
  emittedCount: 0,
  missingTargetCount: 0,
  missingByChain: {},
  missingReasonCounts: {},
  missingTargets: [],
  missingTargetsTruncated: false,
  budgetExhausted: false,
  endpointStrategy: "alternating-fallback-primary" as const,
};

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

  return {
    ACTIVE_STABLECOINS: stablecoins,
    TRACKED_META_BY_ID: new Map(stablecoins.map((coin) => [coin.id, coin])),
  };
});

vi.mock("../yield-sync/sources", () => ({
  COMPOUND_V3_COMETS: [],
  fetchMorphoVaultSources: vi.fn(async () => []),
  fetchPendleMarketSources: vi.fn(async () => []),
  fetchRoycoDawnSources: vi.fn(async () => []),
  fetchVaultsFyiSources: vi.fn(async () => ({
    candidates: [],
    telemetry: {
      enabled: false,
      hasKey: false,
      status: "skipped",
      skipReason: "disabled",
      requestCount: 0,
      pageCount: 0,
      pageCapReached: false,
      creditsEstimated: 0,
      creditsCap: 25,
      creditCapReached: false,
      monthlyCreditsEstimated: null,
      monthlyCreditsCap: 2500,
      rawVaultCount: 0,
      rankableCandidateCount: 0,
      auditOnlyCount: 0,
      malformedDropCount: 0,
      unsupportedChainCount: 0,
      identityMissCount: 0,
      sizeGateDropCount: 0,
      warningDropCount: 0,
      durationMs: 0,
      budgetMs: 20_000,
      budgetExhausted: false,
      dropExamples: [],
    },
  })),
  fetchYearnKongSources: vi.fn(async () => []),
  fetchBeefySources: vi.fn(async () => []),
  fetchCompoundV3SupplyRates: vi.fn(async () => ({
    results: [],
    telemetry: {
      targetCount: 0,
      attemptedCount: 0,
      resolvedTargetCount: 0,
      emittedCount: 0,
      missingTargetCount: 0,
      missingByChain: {},
      missingReasonCounts: {},
      missingTargets: [],
      missingTargetsTruncated: false,
      budgetExhausted: false,
      endpointStrategy: "alternating-fallback-primary",
    },
  })),
  fetchAaveV3SupplyRates: vi.fn(async () => ({
    results: [],
    telemetry: {
      targetCount: 0,
      attemptedCount: 0,
      resolvedTargetCount: 0,
      emittedCount: 0,
      missingTargetCount: 0,
      missingByChain: {},
      missingReasonCounts: {},
      missingTargets: [],
      missingTargetsTruncated: false,
      budgetExhausted: false,
      endpointStrategy: "alternating-fallback-primary",
    },
  })),
}));

vi.mock("../yield-sync/sources-rpc", () => ({
  OPTIONAL_RPC_MISSING_TARGET_EXAMPLE_LIMIT: 20,
}));

vi.mock("../../lib/db-cache", () => ({
  setCacheIfNewer: vi.fn(async () => ({ written: true, skippedBecauseNewer: false })),
}));

import { setCacheIfNewer } from "../../lib/db-cache";
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
  SUPPLEMENTAL_SOURCE_FAMILY_CONCURRENCY,
} from "../yield-sync/supplemental-source-families";
import type { VaultsFyiSourceResult } from "../yield-sync/sources";

function emptyVaultsFyiResult(
  overrides: Partial<VaultsFyiSourceResult["telemetry"]> = {},
): VaultsFyiSourceResult {
  return {
    candidates: [],
    telemetry: {
      enabled: false,
      hasKey: false,
      status: "skipped",
      skipReason: "disabled",
      requestCount: 0,
      pageCount: 0,
      pageCapReached: false,
      creditsEstimated: 0,
      creditsCap: 25,
      creditCapReached: false,
      monthlyCreditsEstimated: null,
      monthlyCreditsCap: 2500,
      rawVaultCount: 0,
      rankableCandidateCount: 0,
      auditOnlyCount: 0,
      malformedDropCount: 0,
      unsupportedChainCount: 0,
      identityMissCount: 0,
      sizeGateDropCount: 0,
      warningDropCount: 0,
      durationMs: 0,
      budgetMs: 20_000,
      budgetExhausted: false,
      dropExamples: [],
      ...overrides,
    },
  };
}

async function flushMicrotasks() {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

describe("syncYieldSupplemental", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-26T12:00:00.000Z"));
    vi.mocked(fetchMorphoVaultSources).mockResolvedValue([]);
    vi.mocked(fetchPendleMarketSources).mockResolvedValue([]);
    vi.mocked(fetchRoycoDawnSources).mockResolvedValue([]);
    vi.mocked(fetchVaultsFyiSources).mockResolvedValue(emptyVaultsFyiResult());
    vi.mocked(fetchYearnKongSources).mockResolvedValue([]);
    vi.mocked(fetchCompoundV3SupplyRates).mockResolvedValue({ results: [], telemetry: emptyTelemetry });
    vi.mocked(fetchAaveV3SupplyRates).mockResolvedValue({ results: [], telemetry: emptyTelemetry });
    vi.mocked(fetchBeefySources).mockResolvedValue([]);
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
        ...emptyTelemetry,
        targetCount: 3,
        attemptedCount: 3,
        resolvedTargetCount: 3,
        emittedCount: 3,
      },
    });

    const result = await syncYieldSupplemental({} as D1Database, undefined, new Map());

    expect(result.status).toBeUndefined();
    expect(result.itemCount).toBe(3);

    const cacheCall = vi.mocked(setCacheIfNewer).mock.calls[0];
    expect(cacheCall?.[1]).toBe("yield:supplemental-sources:v1");
    expect(
      vi.mocked(setCacheIfNewer).mock.calls.some((call) => call[1] === "yield:supplemental-sources:v1:aaveV3"),
    ).toBe(true);

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

  it("publishes empty family cache rows to clear previous non-empty caches", async () => {
    vi.mocked(fetchBeefySources).mockResolvedValue([
      {
        symbol: "USDC",
        chain: "ethereum",
        address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        yield: {
          currentApy: 4.1,
          apyBase: 4.1,
          apyReward: null,
          sourcePool: "vault-a",
          sourceTvlUsd: 1_500_000,
          dataSource: "protocol-api",
          exchangeRate: null,
          sourceKey: "protocol-api:beefy:ethereum:vault-a",
          yieldSource: "Beefy: vault-a",
          yieldType: "lending-opportunity",
          sourceObservedAt: 1_774_526_400,
          comparisonAnchorObservedAt: null,
        },
      },
    ]);

    const result = await syncYieldSupplemental({} as D1Database, undefined, new Map());

    expect(
      vi.mocked(setCacheIfNewer).mock.calls.some((call) => call[1] === "yield:supplemental-sources:v1:beefy"),
    ).toBe(true);
    expect(
      vi.mocked(setCacheIfNewer).mock.calls.some((call) => call[1] === "yield:supplemental-sources:v1:morpho"),
    ).toBe(true);

    const beefyCall = vi
      .mocked(setCacheIfNewer)
      .mock.calls.find((call) => call[1] === "yield:supplemental-sources:v1:beefy");
    const beefyPayload = JSON.parse(String(beefyCall?.[2])) as { sourceCount: number; data: unknown[] };
    expect(beefyPayload.sourceCount).toBe(1);

    const metadata = JSON.parse(result.metadata ?? "{}") as {
      familyCacheResults?: Record<string, "published" | "skipped-newer" | "empty" | "empty-published">;
    };
    expect(metadata.familyCacheResults?.beefy).toBe("published");
    const morphoCall = vi
      .mocked(setCacheIfNewer)
      .mock.calls.find((call) => call[1] === "yield:supplemental-sources:v1:morpho");
    const morphoPayload = JSON.parse(String(morphoCall?.[2])) as { sourceCount: number; data: unknown[] };
    expect(morphoPayload.sourceCount).toBe(0);
    expect(morphoPayload.data).toEqual([]);
    expect(metadata.familyCacheResults?.morpho).toBe("empty-published");
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
    vi.mocked(fetchBeefySources).mockResolvedValue([
      {
        symbol: "USDC",
        chain: "ethereum",
        address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        yield: {
          currentApy: 4.1,
          apyBase: 4.1,
          apyReward: null,
          sourcePool: "vault-a",
          sourceTvlUsd: 1_500_000,
          dataSource: "protocol-api",
          exchangeRate: null,
          sourceKey: "protocol-api:beefy:ethereum:vault-a",
          yieldSource: "Beefy: vault-a",
          yieldType: "lending-opportunity",
          sourceObservedAt: 1_774_526_400,
          comparisonAnchorObservedAt: null,
        },
      },
    ]);
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

  it("does not publish a fresh vaults.fyi family cache when the provider run fails", async () => {
    vi.mocked(fetchBeefySources).mockResolvedValue([
      {
        symbol: "USDC",
        chain: "ethereum",
        address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        yield: {
          currentApy: 4.1,
          apyBase: 4.1,
          apyReward: null,
          sourcePool: "vault-a",
          sourceTvlUsd: 1_500_000,
          dataSource: "protocol-api",
          exchangeRate: null,
          sourceKey: "protocol-api:beefy:ethereum:vault-a",
          yieldSource: "Beefy: vault-a",
          yieldType: "lending-opportunity",
          sourceObservedAt: 1_774_526_400,
          comparisonAnchorObservedAt: null,
        },
      },
    ]);
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
      familyCacheResults?: Record<string, "published" | "skipped-newer" | "empty" | "empty-published">;
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
    expect(metadata.familyCacheResults?.vaultsFyi).toBe("empty");
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
        ...emptyTelemetry,
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
        ...emptyTelemetry,
        targetCount: 2,
        attemptedCount: 2,
        resolvedTargetCount: 2,
        emittedCount: 2,
      },
    });

    const result = await syncYieldSupplemental({} as D1Database, undefined, new Map());

    expect(result.itemCount).toBe(2);

    const payload = JSON.parse(String(vi.mocked(setCacheIfNewer).mock.calls[0]?.[2])) as {
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

  it("dedupes exact duplicate candidates and reports the drop count", async () => {
    vi.mocked(fetchBeefySources).mockResolvedValue([
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
          sourceKey: "protocol-api:beefy:ethereum:vault-a",
          yieldSource: "Beefy: vault-a",
          yieldType: "lending-vault",
          sourceObservedAt: 1_774_526_400,
          comparisonAnchorObservedAt: null,
        },
      },
      {
        symbol: "USDC",
        chain: "ethereum",
        address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        yield: {
          currentApy: 5.5,
          apyBase: 5.5,
          apyReward: null,
          sourcePool: "vault-a",
          sourceTvlUsd: 1_000_000,
          dataSource: "protocol-api",
          exchangeRate: null,
          sourceKey: "protocol-api:beefy:ethereum:vault-a",
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
    ]);

    const result = await syncYieldSupplemental({} as D1Database, undefined, new Map());

    expect(result.itemCount).toBe(2);

    const payload = JSON.parse(String(vi.mocked(setCacheIfNewer).mock.calls[0]?.[2])) as {
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
  });

  it("drops malformed supplemental source rows with source-family examples", async () => {
    vi.mocked(fetchBeefySources).mockResolvedValue([
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
    ]);

    const result = await syncYieldSupplemental({} as D1Database, undefined, new Map());

    expect(result.itemCount).toBe(1);

    const payload = JSON.parse(String(vi.mocked(setCacheIfNewer).mock.calls[0]?.[2])) as {
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

    vi.mocked(fetchMorphoVaultSources).mockImplementation(trackFamily("morpho", []));
    vi.mocked(fetchPendleMarketSources).mockImplementation(trackFamily("pendle", []));
    vi.mocked(fetchYearnKongSources).mockImplementation(trackFamily("yearnKong", []));
    vi.mocked(fetchBeefySources).mockImplementation(trackFamily("beefy", []));
    vi.mocked(fetchVaultsFyiSources).mockImplementation(trackFamily("vaultsFyi", emptyVaultsFyiResult()));
    vi.mocked(fetchRoycoDawnSources).mockImplementation(trackFamily("roycoDawn", []));
    vi.mocked(fetchCompoundV3SupplyRates).mockImplementation(
      trackFamily("compoundV3", {
        results: [],
        telemetry: emptyTelemetry,
      }),
    );
    vi.mocked(fetchAaveV3SupplyRates).mockImplementation(
      trackFamily("aaveV3", {
        results: [],
        telemetry: emptyTelemetry,
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
    vi.mocked(fetchBeefySources).mockResolvedValue([
      {
        symbol: "USDC",
        chain: "ethereum",
        address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        yield: {
          currentApy: 4.1,
          apyBase: 4.1,
          apyReward: null,
          sourcePool: "vault-a",
          sourceTvlUsd: 1_500_000,
          dataSource: "protocol-api",
          exchangeRate: null,
          sourceKey: "protocol-api:beefy:ethereum:vault-a",
          yieldSource: "Beefy: vault-a",
          yieldType: "lending-opportunity",
          sourceObservedAt: 1_774_526_400,
          comparisonAnchorObservedAt: null,
        },
      },
    ]);

    const result = await syncYieldSupplemental({} as D1Database, undefined, new Map());

    expect(result.status).toBeUndefined();
    expect(result.itemCount).toBe(1);

    const payload = JSON.parse(String(vi.mocked(setCacheIfNewer).mock.calls[0]?.[2])) as {
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
