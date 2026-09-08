import { describe, expect, it } from "vitest";
import { DATA_HEALTH_PRESETS } from "@/lib/data-health-config";
import { FRONTEND_API_QUERY_DESCRIPTORS } from "@/lib/api-query-descriptors";
import {
  API_FRESHNESS_MAX_AGE_SEC,
  CACHE_FRESHNESS_LANES,
  FRESHNESS_SENTINEL_CACHE_KEYS,
  getCacheFreshnessLane,
  type CacheFreshnessLaneConfig,
} from "@shared/lib/api-freshness";
import {
  DATA_SURFACE_DESCRIPTOR_LIST,
  DATA_SURFACE_DESCRIPTORS,
} from "@shared/lib/data-surface-descriptors";
import { PHAROSVILLE_API_CONTRACT, PHAROSVILLE_API_ENDPOINTS } from "@shared/lib/pharosville-api-contract";

const API_FRESHNESS_BY_KEY = API_FRESHNESS_MAX_AGE_SEC as Record<string, number>;
const CACHE_FRESHNESS_LANES_BY_KEY = CACHE_FRESHNESS_LANES as Record<string, CacheFreshnessLaneConfig>;
const DATA_HEALTH_PRESETS_BY_KEY = DATA_HEALTH_PRESETS as Record<string, { label: string; staleTime: number }>;
const DESCRIPTORS_BY_KEY = DATA_SURFACE_DESCRIPTORS as unknown as Record<string, Record<string, unknown>>;

/**
 * Independent expectations for the externally visible route, cache and budget
 * policy each surface publishes. Only the fields listed per surface are
 * compared, so an added descriptor field never silently changes this oracle.
 */
const EXPECTED_SURFACE_POLICY: Record<string, Record<string, unknown>> = {
  stablecoins: {
    apiPath: "/api/stablecoins",
    queryKey: ["stablecoins"],
    producerIntervalSec: 900,
    endpointMaxAgeSec: 600,
    producerJob: "sync-stablecoins",
    cacheKey: "stablecoins",
    dependencyCriticality: "critical",
  },
  dexLiquidity: {
    apiPath: "/api/dex-liquidity",
    queryKey: ["dex-liquidity"],
    producerIntervalSec: 3600,
    endpointMaxAgeSec: 14_400,
    availabilityMaxAgeSec: 43_200,
    producerJob: "sync-dex-liquidity",
    cacheKey: "dex-liquidity",
    freshnessSentinelKey: "freshness:dex-liquidity",
    dependencyCriticality: "critical",
  },
  yieldRankings: {
    apiPath: "/api/yield-rankings",
    queryKey: ["yield-rankings"],
    summaryApiPath: "/api/yield-rankings?projection=summary",
    summaryQueryKey: ["yield-rankings", "summary"],
    producerIntervalSec: 3600,
    endpointMaxAgeSec: 3600,
    producerJob: "sync-yield-data",
    cacheKey: "yield-data",
    dependencyCriticality: "critical",
  },
  yieldHistory: {
    producerIntervalSec: 3600,
    endpointMaxAgeSec: 3600,
    producerJob: "sync-yield-data",
    cacheKey: "yield-data",
    dependencyCriticality: "critical",
  },
  stressSignals: {
    apiPath: "/api/stress-signals",
    queryKey: ["stress-signals"],
    producerIntervalSec: 1800,
    endpointMaxAgeSec: 1800,
    producerJob: "compute-dews",
    cacheKey: "dews",
    freshnessSentinelKey: "freshness:dews",
    dependencyCriticality: "critical",
  },
  reportCards: {
    apiPath: "/api/report-cards/v9",
    queryKey: ["report-cards", "v9"],
    producerIntervalSec: 1800,
    endpointMaxAgeSec: 3_600,
    producerJob: "compute-safety-score-v9",
    dependencyCriticality: "critical",
  },
  publicHealth: {
    apiPath: "/api/health",
    queryKey: ["health"],
    // Public health is produced by the 15-minute status self-check snapshot.
    producerIntervalSec: 900,
  },
};

describe("data surface descriptors", () => {
  it("declares the stage 2.1a surface inventory with stable keys", () => {
    expect(DATA_SURFACE_DESCRIPTOR_LIST.map((surface) => surface.key)).toEqual([
      "stablecoins",
      "dexLiquidity",
      "yieldRankings",
      "yieldHistory",
      "stressSignals",
      "reportCards",
      "publicHealth",
    ]);
    expect(new Set(DATA_SURFACE_DESCRIPTOR_LIST.map((surface) => surface.key)).size).toBe(
      DATA_SURFACE_DESCRIPTOR_LIST.length,
    );
  });

  it("publishes the expected route, cache and budget policy per surface", () => {
    expect(Object.keys(EXPECTED_SURFACE_POLICY)).toEqual(DATA_SURFACE_DESCRIPTOR_LIST.map((surface) => surface.key));

    for (const [key, expected] of Object.entries(EXPECTED_SURFACE_POLICY)) {
      const descriptor = DESCRIPTORS_BY_KEY[key];
      const projected = Object.fromEntries(Object.keys(expected).map((field) => [field, descriptor?.[field]]));
      expect(projected, key).toEqual(expected);
    }
  });

  it("builds yield history routes and per-argument query keys", () => {
    const surface = DATA_SURFACE_DESCRIPTORS.yieldHistory;

    expect(surface.buildApiPath("usdc", 365, "source", "aave-v3")).toBe(
      "/api/yield-history?stablecoin=usdc&days=365&mode=source&sourceKey=aave-v3",
    );
    expect(surface.buildQueryKey("usdc", 365, "source", "aave-v3")).toEqual([
      "yield-history",
      "usdc",
      365,
      "source",
      "aave-v3",
    ]);
    expect(surface.buildApiPath("usdt", 90, "best", null)).toBe("/api/yield-history?stablecoin=usdt&days=90&mode=best");
    expect(surface.buildQueryKey("usdt", 90, "best", null)).toEqual(["yield-history", "usdt", 90, "best", null]);
  });

  it("gives the frontend query registry the descriptor routes and distinct cache keys", () => {
    expect(FRONTEND_API_QUERY_DESCRIPTORS.stablecoins.path).toBe("/api/stablecoins");
    expect(FRONTEND_API_QUERY_DESCRIPTORS.stablecoins.queryKey).toEqual(["stablecoins"]);
    expect(FRONTEND_API_QUERY_DESCRIPTORS.stablecoins.producerIntervalMs).toBe(900_000);
    expect(FRONTEND_API_QUERY_DESCRIPTORS.stablecoins.metaMaxAgeSec).toBe(600);

    const withSource = FRONTEND_API_QUERY_DESCRIPTORS.yieldHistory("usdc", 365, "source", "aave-v3");
    const otherSource = FRONTEND_API_QUERY_DESCRIPTORS.yieldHistory("usdc", 365, "source", "compound-v3");
    const bestMode = FRONTEND_API_QUERY_DESCRIPTORS.yieldHistory("usdc", 365, "best", null);

    expect(withSource.path).toBe("/api/yield-history?stablecoin=usdc&days=365&mode=source&sourceKey=aave-v3");
    expect(withSource.queryKey).toEqual(["yield-history", "usdc", 365, "source", "aave-v3"]);
    expect(withSource.producerIntervalMs).toBe(3_600_000);
    expect(withSource.metaMaxAgeSec).toBe(3600);

    // Distinct arguments must not collide in the React Query cache.
    expect(otherSource.queryKey).not.toEqual(withSource.queryKey);
    expect(bestMode.queryKey).not.toEqual(withSource.queryKey);
    expect(bestMode.path).not.toBe(withSource.path);
  });

  it("derives endpoint freshness budgets from descriptors", () => {
    for (const surface of DATA_SURFACE_DESCRIPTOR_LIST) {
      if (!("apiFreshnessKey" in surface) || !surface.apiFreshnessKey) continue;

      expect(API_FRESHNESS_BY_KEY[surface.apiFreshnessKey], surface.key).toBe(
        "endpointMaxAgeSec" in surface ? surface.endpointMaxAgeSec : undefined,
      );
    }
  });

  it("pins the cache freshness lanes and resolves each descriptor cache key to its lane", () => {
    expect(CACHE_FRESHNESS_LANES_BY_KEY.stablecoins).toMatchObject({
      cacheKey: "stablecoins",
      producerJob: "sync-stablecoins",
      producerIntervalSec: 900,
      endpointMaxAgeSec: 600,
      availabilityMaxAgeSec: 600,
    });
    expect(CACHE_FRESHNESS_LANES_BY_KEY.dexLiquidity).toMatchObject({
      cacheKey: "dex-liquidity",
      producerJob: "sync-dex-liquidity",
      producerIntervalSec: 3600,
      endpointMaxAgeSec: 14_400,
      availabilityMaxAgeSec: 43_200,
      freshnessSentinelKey: "freshness:dex-liquidity",
    });
    expect(CACHE_FRESHNESS_LANES_BY_KEY.yieldData).toMatchObject({
      cacheKey: "yield-data",
      producerJob: "sync-yield-data",
      producerIntervalSec: 3600,
      endpointMaxAgeSec: 3600,
      availabilityMaxAgeSec: 3600,
      freshnessSentinelKey: "freshness:yield-data",
    });
    expect(CACHE_FRESHNESS_LANES_BY_KEY.dews).toMatchObject({
      cacheKey: "dews",
      producerJob: "compute-dews",
      producerIntervalSec: 1800,
      endpointMaxAgeSec: 1800,
      availabilityMaxAgeSec: 1800,
      freshnessSentinelKey: "freshness:dews",
    });
    expect(FRESHNESS_SENTINEL_CACHE_KEYS).toEqual(["dex-liquidity", "yield-data", "dews"]);

    for (const surface of DATA_SURFACE_DESCRIPTOR_LIST) {
      if (!("cacheFreshnessLaneKey" in surface) || !surface.cacheFreshnessLaneKey) continue;

      expect(getCacheFreshnessLane(surface.cacheKey ?? ""), surface.key).toBe(
        CACHE_FRESHNESS_LANES_BY_KEY[surface.cacheFreshnessLaneKey],
      );
    }
  });

  it("pins the non-derived data health presets", () => {
    expect({
      stablecoins: DATA_HEALTH_PRESETS_BY_KEY.stablecoins,
      dexLiquidity: DATA_HEALTH_PRESETS_BY_KEY.dexLiquidity,
      yieldRankings: DATA_HEALTH_PRESETS_BY_KEY.yieldRankings,
      stressSignals: DATA_HEALTH_PRESETS_BY_KEY.stressSignals,
      reportCards: DATA_HEALTH_PRESETS_BY_KEY.reportCards,
    }).toEqual({
      stablecoins: { label: "Prices", staleTime: 600_000 },
      dexLiquidity: { label: "Liquidity", staleTime: 14_400_000 },
      yieldRankings: { label: "Yield Rankings", staleTime: 3_600_000 },
      stressSignals: { label: "DEWS", staleTime: 1_800_000 },
      reportCards: { label: "Report Cards", staleTime: 3_600_000 },
    });
  });

  it("pins the PharosVille contract entries that no descriptor owns", () => {
    expect({
      chains: {
        path: PHAROSVILLE_API_CONTRACT.chains.path,
        metaMaxAgeSec: PHAROSVILLE_API_CONTRACT.chains.metaMaxAgeSec,
        producerIntervalSec: PHAROSVILLE_API_CONTRACT.chains.producerIntervalSec,
      },
      stability: {
        path: PHAROSVILLE_API_CONTRACT.stability.path,
        metaMaxAgeSec: PHAROSVILLE_API_CONTRACT.stability.metaMaxAgeSec,
        producerIntervalSec: PHAROSVILLE_API_CONTRACT.stability.producerIntervalSec,
      },
      pegSummary: {
        path: PHAROSVILLE_API_CONTRACT.pegSummary.path,
        metaMaxAgeSec: PHAROSVILLE_API_CONTRACT.pegSummary.metaMaxAgeSec,
        producerIntervalSec: PHAROSVILLE_API_CONTRACT.pegSummary.producerIntervalSec,
      },
    }).toEqual({
      chains: {
        path: "/api/chains",
        metaMaxAgeSec: 1800,
        producerIntervalSec: 900,
      },
      stability: {
        path: "/api/stability-index?detail=true",
        // 2x the 1800s producer interval since the WS0.7 freshness fix; was a
        // 24h budget that hid PSI incidents for a day.
        metaMaxAgeSec: 3600,
        producerIntervalSec: 1800,
      },
      pegSummary: {
        path: "/api/peg-summary",
        metaMaxAgeSec: 900,
        producerIntervalSec: 900,
      },
    });
  });

  it("publishes every PharosVille endpoint on a distinct usable route with a positive budget", () => {
    const paths = PHAROSVILLE_API_ENDPOINTS.map((endpoint) => endpoint.path);

    expect(new Set(paths).size).toBe(paths.length);
    for (const endpoint of PHAROSVILLE_API_ENDPOINTS) {
      expect(endpoint.path, endpoint.key).toMatch(/^\/api\//);
      expect(endpoint.metaMaxAgeSec, endpoint.key).toBeGreaterThan(0);
      expect(endpoint.producerIntervalSec, endpoint.key).toBeGreaterThan(0);
    }
  });
});
