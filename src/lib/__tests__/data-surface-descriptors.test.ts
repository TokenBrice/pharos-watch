import { describe, expect, it } from "vitest";
import { DATA_HEALTH_PRESETS } from "@/lib/data-health-config";
import { FRONTEND_API_QUERY_BASE_REGISTRY } from "@/lib/api-query-base-registry";
import {
  API_FRESHNESS_MAX_AGE_SEC,
  CACHE_AVAILABILITY_MAX_AGE_SEC,
  CACHE_FRESHNESS_LANES,
  FRESHNESS_SENTINEL_CACHE_KEYS,
  getCacheFreshnessLane,
  type CacheFreshnessLaneConfig,
} from "@shared/lib/api-freshness";
import { DATA_DEPENDENCY_BY_ID } from "@shared/lib/data-dependency-registry";
import {
  DATA_SURFACE_DESCRIPTOR_LIST,
  DATA_SURFACE_DESCRIPTORS,
  type DataSurfaceDescriptor,
} from "@shared/lib/data-surface-descriptors";
import { PHAROSVILLE_API_CONTRACT } from "@shared/lib/pharosville-api-contract";

interface FrontendStaticQueryDescriptor {
  queryKey: readonly unknown[];
  path: string;
  producerIntervalMs: number;
  metaMaxAgeSec?: number;
}

type FrontendQueryRegistry = Record<
  string,
  FrontendStaticQueryDescriptor | ((...args: never[]) => FrontendStaticQueryDescriptor)
>;

const FRONTEND_QUERY_REGISTRY = FRONTEND_API_QUERY_BASE_REGISTRY as unknown as FrontendQueryRegistry;
const API_FRESHNESS_BY_KEY = API_FRESHNESS_MAX_AGE_SEC as Record<string, number>;
const CACHE_FRESHNESS_LANES_BY_KEY = CACHE_FRESHNESS_LANES as Record<string, CacheFreshnessLaneConfig>;
const DATA_HEALTH_PRESETS_BY_KEY = DATA_HEALTH_PRESETS as Record<string, { label: string; staleTime: number }>;
const PHAROSVILLE_CONTRACT_BY_KEY = PHAROSVILLE_API_CONTRACT as Record<
  string,
  { key: string; path: string; metaMaxAgeSec: number; producerIntervalSec: number }
>;

const STATIC_FRONTEND_DERIVED_SURFACES: readonly DataSurfaceDescriptor[] = [
  DATA_SURFACE_DESCRIPTORS.stablecoins,
  DATA_SURFACE_DESCRIPTORS.dexLiquidity,
  DATA_SURFACE_DESCRIPTORS.yieldRankings,
  DATA_SURFACE_DESCRIPTORS.stressSignals,
  DATA_SURFACE_DESCRIPTORS.reportCards,
  DATA_SURFACE_DESCRIPTORS.publicHealth,
];

function frontendStaticDescriptor(surface: DataSurfaceDescriptor): FrontendStaticQueryDescriptor {
  expect(surface.frontendQueryBaseKey).toBeTruthy();
  const entry = FRONTEND_QUERY_REGISTRY[surface.frontendQueryBaseKey ?? ""];
  expect(entry).toBeDefined();
  expect(typeof entry).toBe("object");
  if (typeof entry === "function") {
    throw new Error(`${surface.key} unexpectedly points at a dynamic frontend query descriptor`);
  }
  return entry;
}

function requireDescriptorField<T>(
  surface: DataSurfaceDescriptor,
  field: keyof DataSurfaceDescriptor,
  value: T | undefined,
): T {
  if (value === undefined) {
    throw new Error(`descriptor ${surface.key} is missing ${String(field)}`);
  }
  return value;
}

function dependency(id: string) {
  const definition = DATA_DEPENDENCY_BY_ID.get(id);
  expect(definition).toBeDefined();
  return definition;
}

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

  it("pins descriptor-owned source values for covered API paths and query keys", () => {
    expect({
      path: DATA_SURFACE_DESCRIPTORS.stablecoins.apiPath,
      queryKey: DATA_SURFACE_DESCRIPTORS.stablecoins.queryKey,
      producerIntervalSec: DATA_SURFACE_DESCRIPTORS.stablecoins.producerIntervalSec,
      endpointMaxAgeSec: DATA_SURFACE_DESCRIPTORS.stablecoins.endpointMaxAgeSec,
      producerJob: DATA_SURFACE_DESCRIPTORS.stablecoins.producerJob,
      cacheKey: DATA_SURFACE_DESCRIPTORS.stablecoins.cacheKey,
      criticality: DATA_SURFACE_DESCRIPTORS.stablecoins.dependencyCriticality,
    }).toEqual({
      path: "/api/stablecoins",
      queryKey: ["stablecoins"],
      producerIntervalSec: 900,
      endpointMaxAgeSec: 600,
      producerJob: "sync-stablecoins",
      cacheKey: "stablecoins",
      criticality: "critical",
    });

    expect({
      path: DATA_SURFACE_DESCRIPTORS.dexLiquidity.apiPath,
      queryKey: DATA_SURFACE_DESCRIPTORS.dexLiquidity.queryKey,
      producerIntervalSec: DATA_SURFACE_DESCRIPTORS.dexLiquidity.producerIntervalSec,
      endpointMaxAgeSec: DATA_SURFACE_DESCRIPTORS.dexLiquidity.endpointMaxAgeSec,
      availabilityMaxAgeSec: DATA_SURFACE_DESCRIPTORS.dexLiquidity.availabilityMaxAgeSec,
      producerJob: DATA_SURFACE_DESCRIPTORS.dexLiquidity.producerJob,
      cacheKey: DATA_SURFACE_DESCRIPTORS.dexLiquidity.cacheKey,
      sentinel: DATA_SURFACE_DESCRIPTORS.dexLiquidity.freshnessSentinelKey,
      criticality: DATA_SURFACE_DESCRIPTORS.dexLiquidity.dependencyCriticality,
    }).toEqual({
      path: "/api/dex-liquidity",
      queryKey: ["dex-liquidity"],
      producerIntervalSec: 1800,
      endpointMaxAgeSec: 3600,
      availabilityMaxAgeSec: 43_200,
      producerJob: "sync-dex-liquidity",
      cacheKey: "dex-liquidity",
      sentinel: "freshness:dex-liquidity",
      criticality: "critical",
    });

    expect({
      path: DATA_SURFACE_DESCRIPTORS.yieldRankings.apiPath,
      queryKey: DATA_SURFACE_DESCRIPTORS.yieldRankings.queryKey,
      producerIntervalSec: DATA_SURFACE_DESCRIPTORS.yieldRankings.producerIntervalSec,
      endpointMaxAgeSec: DATA_SURFACE_DESCRIPTORS.yieldRankings.endpointMaxAgeSec,
      producerJob: DATA_SURFACE_DESCRIPTORS.yieldRankings.producerJob,
      cacheKey: DATA_SURFACE_DESCRIPTORS.yieldRankings.cacheKey,
      criticality: DATA_SURFACE_DESCRIPTORS.yieldRankings.dependencyCriticality,
    }).toEqual({
      path: "/api/yield-rankings",
      queryKey: ["yield-rankings"],
      producerIntervalSec: 3600,
      endpointMaxAgeSec: 3600,
      producerJob: "sync-yield-data",
      cacheKey: "yield-data",
      criticality: "critical",
    });

    expect({
      path: DATA_SURFACE_DESCRIPTORS.stressSignals.apiPath,
      queryKey: DATA_SURFACE_DESCRIPTORS.stressSignals.queryKey,
      producerIntervalSec: DATA_SURFACE_DESCRIPTORS.stressSignals.producerIntervalSec,
      endpointMaxAgeSec: DATA_SURFACE_DESCRIPTORS.stressSignals.endpointMaxAgeSec,
      producerJob: DATA_SURFACE_DESCRIPTORS.stressSignals.producerJob,
      cacheKey: DATA_SURFACE_DESCRIPTORS.stressSignals.cacheKey,
      sentinel: DATA_SURFACE_DESCRIPTORS.stressSignals.freshnessSentinelKey,
      criticality: DATA_SURFACE_DESCRIPTORS.stressSignals.dependencyCriticality,
    }).toEqual({
      path: "/api/stress-signals",
      queryKey: ["stress-signals"],
      producerIntervalSec: 1800,
      endpointMaxAgeSec: 1800,
      producerJob: "compute-dews",
      cacheKey: "dews",
      sentinel: "freshness:dews",
      criticality: "critical",
    });

    expect({
      path: DATA_SURFACE_DESCRIPTORS.reportCards.apiPath,
      queryKey: DATA_SURFACE_DESCRIPTORS.reportCards.queryKey,
      producerIntervalSec: DATA_SURFACE_DESCRIPTORS.reportCards.producerIntervalSec,
      endpointMaxAgeSec: DATA_SURFACE_DESCRIPTORS.reportCards.endpointMaxAgeSec,
      producerJob: DATA_SURFACE_DESCRIPTORS.reportCards.producerJob,
      criticality: DATA_SURFACE_DESCRIPTORS.reportCards.dependencyCriticality,
    }).toEqual({
      path: "/api/report-cards",
      queryKey: ["report-cards"],
      producerIntervalSec: 900,
      endpointMaxAgeSec: 900,
      producerJob: "publish-report-card-cache",
      criticality: "critical",
    });

    expect({
      path: DATA_SURFACE_DESCRIPTORS.publicHealth.apiPath,
      queryKey: DATA_SURFACE_DESCRIPTORS.publicHealth.queryKey,
      producerIntervalSec: DATA_SURFACE_DESCRIPTORS.publicHealth.producerIntervalSec,
    }).toEqual({
      path: "/api/health",
      queryKey: ["health"],
      producerIntervalSec: 60,
    });
  });

  it("pins dynamic yield history descriptor builders", () => {
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
    expect(surface.buildApiPath("usdt", 90, "best", null)).toBe(
      "/api/yield-history?stablecoin=usdt&days=90&mode=best",
    );
    expect(surface.buildQueryKey("usdt", 90, "best", null)).toEqual([
      "yield-history",
      "usdt",
      90,
      "best",
      null,
    ]);
    expect({
      producerIntervalSec: surface.producerIntervalSec,
      endpointMaxAgeSec: surface.endpointMaxAgeSec,
      producerJob: surface.producerJob,
      cacheKey: surface.cacheKey,
      criticality: surface.dependencyCriticality,
    }).toEqual({
      producerIntervalSec: 3600,
      endpointMaxAgeSec: 3600,
      producerJob: "sync-yield-data",
      cacheKey: "yield-data",
      criticality: "critical",
    });
  });

  it("derives static frontend query descriptor values from descriptors", () => {
    for (const surface of STATIC_FRONTEND_DERIVED_SURFACES) {
      const frontend = frontendStaticDescriptor(surface);
      const apiPath = requireDescriptorField(surface, "apiPath", surface.apiPath);
      const queryKey = requireDescriptorField(surface, "queryKey", surface.queryKey);
      const producerIntervalSec = requireDescriptorField(
        surface,
        "producerIntervalSec",
        surface.producerIntervalSec,
      );

      expect(frontend.queryKey).toBe(queryKey);
      expect(frontend.path).toBe(apiPath);
      expect(frontend.producerIntervalMs).toBe(producerIntervalSec * 1000);
      if (surface.endpointMaxAgeSec === undefined) {
        expect(frontend).not.toHaveProperty("metaMaxAgeSec");
      } else {
        expect(frontend.metaMaxAgeSec).toBe(surface.endpointMaxAgeSec);
      }
    }
  });

  it("derives dynamic yield history frontend descriptors from the descriptor builder", () => {
    const surface = DATA_SURFACE_DESCRIPTORS.yieldHistory;
    const frontendWithSource = FRONTEND_API_QUERY_BASE_REGISTRY.yieldHistory("usdc", 365, "source", "aave-v3");
    const frontendWithoutSource = FRONTEND_API_QUERY_BASE_REGISTRY.yieldHistory("usdt", 90, "best", null);

    expect(frontendWithSource.path).toBe(surface.buildApiPath("usdc", 365, "source", "aave-v3"));
    expect(frontendWithSource.queryKey).toEqual(surface.buildQueryKey("usdc", 365, "source", "aave-v3"));
    expect(frontendWithSource.producerIntervalMs).toBe(surface.producerIntervalSec * 1000);
    expect(frontendWithSource.metaMaxAgeSec).toBe(surface.endpointMaxAgeSec);

    expect(frontendWithoutSource.path).toBe(surface.buildApiPath("usdt", 90, "best", null));
    expect(frontendWithoutSource.queryKey).toEqual(surface.buildQueryKey("usdt", 90, "best", null));
    expect(frontendWithoutSource.producerIntervalMs).toBe(surface.producerIntervalSec * 1000);
    expect(frontendWithoutSource.metaMaxAgeSec).toBe(surface.endpointMaxAgeSec);
  });

  it("derives endpoint freshness budgets from descriptors", () => {
    for (const surface of DATA_SURFACE_DESCRIPTOR_LIST) {
      if (!surface.apiFreshnessKey) continue;
      const endpointMaxAgeSec = requireDescriptorField(surface, "endpointMaxAgeSec", surface.endpointMaxAgeSec);

      expect(API_FRESHNESS_BY_KEY[surface.apiFreshnessKey]).toBe(endpointMaxAgeSec);
    }
  });

  it("pins non-derived cache freshness lanes and keeps descriptors aligned", () => {
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
      producerIntervalSec: 1800,
      endpointMaxAgeSec: 3600,
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
      if (!surface.cacheFreshnessLaneKey) continue;

      const lane = CACHE_FRESHNESS_LANES_BY_KEY[surface.cacheFreshnessLaneKey];
      expect(lane).toBeDefined();
      expect(getCacheFreshnessLane(surface.cacheKey ?? "")).toBe(lane);
      expect(surface.cacheKey).toBe(lane.cacheKey);
      expect(surface.producerJob).toBe(lane.producerJob);
      expect(surface.producerIntervalSec).toBe(lane.producerIntervalSec);
      expect(surface.endpointMaxAgeSec).toBe(lane.endpointMaxAgeSec);
      expect(surface.availabilityMaxAgeSec).toBe(lane.availabilityMaxAgeSec);
      expect(surface.availabilityMaxAgeSec).toBe(CACHE_AVAILABILITY_MAX_AGE_SEC[lane.cacheKey]);
      expect(surface.freshnessSentinelKey).toBe(lane.freshnessSentinelKey);
    }
  });

  it("derives descriptor-covered data dependency fields and pins the explicit fields", () => {
    const cases = [
      {
        surface: DATA_SURFACE_DESCRIPTORS.stablecoins,
        id: "stablecoins",
        explicit: {
          label: "Stablecoin market snapshot",
          sourceOfTruth: "cache:stablecoins",
          publicationSurface: null,
          impactLayer: "availability",
          dependsOn: [],
          consumers: ["home", "stablecoin-detail", "report-cards", "api:stablecoins"],
          runbookPath: "docs/runbooks/stablecoins-cache.md",
        },
      },
      {
        surface: DATA_SURFACE_DESCRIPTORS.dexLiquidity,
        id: "dex-liquidity",
        explicit: {
          label: "DEX liquidity scoring",
          sourceOfTruth: "dex_liquidity_publication_generations",
          publicationSurface: "dex-liquidity",
          impactLayer: "availability",
          dependsOn: ["stablecoins"],
          consumers: ["liquidity-ranking", "dews", "report-cards", "redemption-backstops", "yield-rankings"],
          runbookPath: null,
        },
      },
      {
        surface: DATA_SURFACE_DESCRIPTORS.yieldRankings,
        id: "yield-rankings",
        explicit: {
          label: "Yield rankings",
          sourceOfTruth: "yield_publication_generations",
          publicationSurface: "yield-rankings",
          impactLayer: "availability",
          dependsOn: ["dex-liquidity"],
          consumers: ["yield-intelligence", "report-cards", "api:yield"],
          runbookPath: null,
        },
      },
      {
        surface: DATA_SURFACE_DESCRIPTORS.stressSignals,
        id: "dews",
        explicit: {
          label: "DEWS risk signals",
          sourceOfTruth: "cache:dews",
          publicationSurface: "dews",
          impactLayer: "availability",
          dependsOn: ["dex-liquidity"],
          consumers: ["stress-signals", "telegram-alerts", "report-cards"],
          runbookPath: null,
        },
      },
      {
        surface: DATA_SURFACE_DESCRIPTORS.reportCards,
        id: "report-card-cache",
        explicit: {
          label: "Report-card cache",
          sourceOfTruth: "cron_runs:publish-report-card-cache",
          publicationSurface: "report-card-cache",
          impactLayer: "availability",
          dependsOn: ["stablecoins", "dex-liquidity", "yield-rankings", "dews"],
          consumers: ["report-cards", "stablecoin-detail"],
          runbookPath: null,
        },
      },
    ];

    for (const { surface, id, explicit } of cases) {
      const definition = dependency(id);
      expect(definition?.producerJob).toBe(surface.producerJob ?? null);
      expect(definition?.cacheKey).toBe(surface.cacheKey ?? null);
      expect(definition?.criticality).toBe(surface.dependencyCriticality);
      expect({
        label: definition?.label,
        sourceOfTruth: definition?.sourceOfTruth,
        publicationSurface: definition?.publicationSurface,
        impactLayer: definition?.impactLayer,
        dependsOn: definition?.dependsOn,
        consumers: definition?.consumers,
        runbookPath: definition?.runbookPath,
      }).toEqual(explicit);
    }
  });

  it("pins non-derived data health presets and keeps descriptors aligned", () => {
    expect({
      stablecoins: DATA_HEALTH_PRESETS_BY_KEY.stablecoins,
      dexLiquidity: DATA_HEALTH_PRESETS_BY_KEY.dexLiquidity,
      yieldRankings: DATA_HEALTH_PRESETS_BY_KEY.yieldRankings,
      stressSignals: DATA_HEALTH_PRESETS_BY_KEY.stressSignals,
      reportCards: DATA_HEALTH_PRESETS_BY_KEY.reportCards,
    }).toEqual({
      stablecoins: { label: "Prices", staleTime: 600_000 },
      dexLiquidity: { label: "Liquidity", staleTime: 3_600_000 },
      yieldRankings: { label: "Yield Rankings", staleTime: 3_600_000 },
      stressSignals: { label: "DEWS", staleTime: 1_800_000 },
      reportCards: { label: "Report Cards", staleTime: 900_000 },
    });

    for (const surface of DATA_SURFACE_DESCRIPTOR_LIST) {
      if (!surface.dataHealthPresetKey) continue;

      const preset = DATA_HEALTH_PRESETS_BY_KEY[surface.dataHealthPresetKey];
      expect(preset).toBeDefined();
      expect(surface.uiLabel).toBe(preset.label);
      expect(surface.endpointMaxAgeSec).toBe(preset.staleTime / 1000);
    }
  });

  it("derives descriptor-covered PharosVille contract fields while non-covered entries stay pinned", () => {
    for (const surface of [
      DATA_SURFACE_DESCRIPTORS.stablecoins,
      DATA_SURFACE_DESCRIPTORS.stressSignals,
      DATA_SURFACE_DESCRIPTORS.reportCards,
    ]) {
      const schemaKey = requireDescriptorField(surface, "pharosVilleSchemaKey", surface.pharosVilleSchemaKey);
      const contract = PHAROSVILLE_CONTRACT_BY_KEY[schemaKey];
      const apiPath = requireDescriptorField(surface, "apiPath", surface.apiPath);
      const endpointMaxAgeSec = requireDescriptorField(surface, "endpointMaxAgeSec", surface.endpointMaxAgeSec);
      const producerIntervalSec = requireDescriptorField(
        surface,
        "producerIntervalSec",
        surface.producerIntervalSec,
      );

      expect(contract).toBeDefined();
      expect(contract.key).toBe(schemaKey);
      expect(contract.path).toBe(apiPath);
      expect(contract.metaMaxAgeSec).toBe(endpointMaxAgeSec);
      expect(contract.producerIntervalSec).toBe(producerIntervalSec);
    }

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
        metaMaxAgeSec: 86_400,
        producerIntervalSec: 1800,
      },
      pegSummary: {
        path: "/api/peg-summary",
        metaMaxAgeSec: 900,
        producerIntervalSec: 900,
      },
    });
  });
});
