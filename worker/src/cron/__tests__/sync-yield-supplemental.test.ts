import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const emptyTelemetry = {
  targetCount: 0,
  attemptedCount: 0,
  resolvedTargetCount: 0,
  emittedCount: 0,
  missingTargetCount: 0,
  missingByChain: {},
  missingReasonCounts: {},
  missingTargets: [],
  budgetExhausted: false,
  endpointStrategy: "alternating-fallback-primary" as const,
};

vi.mock("@shared/lib/stablecoins", () => {
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
      budgetExhausted: false,
      endpointStrategy: "alternating-fallback-primary",
    },
  })),
  fetchAaveV3SupplyRates: vi.fn(async () => ({
    rates: new Map(),
    telemetry: {
      targetCount: 0,
      attemptedCount: 0,
      resolvedTargetCount: 0,
      emittedCount: 0,
      missingTargetCount: 0,
      missingByChain: {},
      missingReasonCounts: {},
      missingTargets: [],
      budgetExhausted: false,
      endpointStrategy: "alternating-fallback-primary",
    },
  })),
}));

vi.mock("../../lib/db-cache", () => ({
  setCacheIfNewer: vi.fn(async () => {}),
}));

import { setCacheIfNewer } from "../../lib/db-cache";
import {
  fetchAaveV3SupplyRates,
  fetchBeefySources,
} from "../yield-sync/sources";
import { syncYieldSupplemental } from "../sync-yield-supplemental";

describe("syncYieldSupplemental", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-26T12:00:00.000Z"));
    vi.mocked(fetchAaveV3SupplyRates).mockResolvedValue({ rates: new Map(), telemetry: emptyTelemetry });
    vi.mocked(fetchBeefySources).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("keeps distinct same-chain Aave candidates by using asset-scoped source keys", async () => {
    vi.mocked(fetchAaveV3SupplyRates).mockResolvedValue({
      rates: new Map([
        ["usdc-circle", { apy: 4.25, chain: "ethereum" }],
        ["usdt-tether", { apy: 3.75, chain: "ethereum" }],
        ["eurc-circle", { apy: 2.1, chain: "base" }],
      ]),
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
});
