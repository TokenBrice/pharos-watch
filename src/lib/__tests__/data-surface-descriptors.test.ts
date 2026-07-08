import { describe, expect, it } from "vitest";
import {
  CRON_15MIN,
  CRON_1MIN,
  CRON_30MIN,
  CRON_YIELD,
} from "@/lib/cron-intervals";
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

  it("keeps static frontend query descriptors in parity", () => {
    for (const surface of [
      DATA_SURFACE_DESCRIPTORS.stablecoins,
      DATA_SURFACE_DESCRIPTORS.dexLiquidity,
      DATA_SURFACE_DESCRIPTORS.yieldRankings,
      DATA_SURFACE_DESCRIPTORS.stressSignals,
      DATA_SURFACE_DESCRIPTORS.reportCards,
      DATA_SURFACE_DESCRIPTORS.publicHealth,
    ]) {
      const frontend = frontendStaticDescriptor(surface);

      expect(surface.apiPath).toBe(frontend.path);
      expect(surface.queryKey).toEqual(frontend.queryKey);
      expect(surface.producerIntervalSec).toBe(frontend.producerIntervalMs / 1000);
      expect(surface.endpointMaxAgeSec).toBe(frontend.metaMaxAgeSec);
    }
  });

  it("keeps dynamic yield history builders in parity with the frontend registry", () => {
    const surface = DATA_SURFACE_DESCRIPTORS.yieldHistory;
    const frontendWithSource = FRONTEND_API_QUERY_BASE_REGISTRY.yieldHistory("usdc", 365, "source", "aave-v3");
    const frontendWithoutSource = FRONTEND_API_QUERY_BASE_REGISTRY.yieldHistory("usdt", 90, "best", null);

    expect(surface.buildApiPath?.("usdc", 365, "source", "aave-v3")).toBe(frontendWithSource.path);
    expect(surface.buildQueryKey?.("usdc", 365, "source", "aave-v3")).toEqual(frontendWithSource.queryKey);
    expect(surface.producerIntervalSec).toBe(frontendWithSource.producerIntervalMs / 1000);
    expect(surface.endpointMaxAgeSec).toBe(frontendWithSource.metaMaxAgeSec);

    expect(surface.buildApiPath?.("usdt", 90, "best", null)).toBe(frontendWithoutSource.path);
    expect(surface.buildQueryKey?.("usdt", 90, "best", null)).toEqual(frontendWithoutSource.queryKey);
  });

  it("keeps endpoint freshness budgets in parity", () => {
    for (const surface of DATA_SURFACE_DESCRIPTOR_LIST) {
      if (!surface.apiFreshnessKey) continue;

      expect(surface.endpointMaxAgeSec).toBe(API_FRESHNESS_BY_KEY[surface.apiFreshnessKey]);
    }
  });

  it("keeps cache freshness lanes and sentinels in parity", () => {
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

      if (surface.freshnessSentinelKey) {
        expect(FRESHNESS_SENTINEL_CACHE_KEYS as readonly string[]).toContain(lane.cacheKey);
      }
    }
  });

  it("keeps data dependency fields in parity", () => {
    for (const surface of DATA_SURFACE_DESCRIPTOR_LIST) {
      if (!surface.dataDependencyId) continue;

      const dependency = DATA_DEPENDENCY_BY_ID.get(surface.dataDependencyId);
      expect(dependency).toBeDefined();
      expect(surface.producerJob ?? null).toBe(dependency?.producerJob);
      expect(surface.cacheKey ?? null).toBe(dependency?.cacheKey);
      expect(surface.dependencyCriticality).toBe(dependency?.criticality);
    }
  });

  it("keeps data health labels and stale-time budgets in parity", () => {
    for (const surface of DATA_SURFACE_DESCRIPTOR_LIST) {
      if (!surface.dataHealthPresetKey) continue;

      const surfaceKey: string = surface.key;
      const preset = DATA_HEALTH_PRESETS_BY_KEY[surface.dataHealthPresetKey];
      expect(preset).toBeDefined();
      if (!("uiLabel" in surface) || !("endpointMaxAgeSec" in surface)) {
        throw new Error(`descriptor ${surfaceKey} has dataHealthPresetKey but lacks uiLabel/endpointMaxAgeSec`);
      }
      expect(surface.uiLabel).toBe(preset.label);
      expect(surface.endpointMaxAgeSec).toBe(preset.staleTime / 1000);
    }
  });

  it("keeps PharosVille schema reference keys in parity without importing schemas", () => {
    for (const surface of DATA_SURFACE_DESCRIPTOR_LIST) {
      if (!("pharosVilleSchemaKey" in surface) || !surface.pharosVilleSchemaKey) continue;

      const surfaceKey: string = surface.key;
      const contract = PHAROSVILLE_CONTRACT_BY_KEY[surface.pharosVilleSchemaKey];
      expect(contract).toBeDefined();
      expect(surface.pharosVilleSchemaKey).toBe(contract.key);
      if (!("apiPath" in surface) || !("endpointMaxAgeSec" in surface)) {
        throw new Error(`descriptor ${surfaceKey} has pharosVilleSchemaKey but lacks apiPath/endpointMaxAgeSec`);
      }
      expect(surface.apiPath).toBe(contract.path);
      expect(surface.endpointMaxAgeSec).toBe(contract.metaMaxAgeSec);
      expect(surface.producerIntervalSec).toBe(contract.producerIntervalSec);
    }
  });

  it("keeps frontend cron interval aliases in parity", () => {
    expect(DATA_SURFACE_DESCRIPTORS.stablecoins.producerIntervalSec).toBe(CRON_15MIN / 1000);
    expect(DATA_SURFACE_DESCRIPTORS.reportCards.producerIntervalSec).toBe(CRON_15MIN / 1000);
    expect(DATA_SURFACE_DESCRIPTORS.dexLiquidity.producerIntervalSec).toBe(CRON_30MIN / 1000);
    expect(DATA_SURFACE_DESCRIPTORS.stressSignals.producerIntervalSec).toBe(CRON_30MIN / 1000);
    expect(DATA_SURFACE_DESCRIPTORS.yieldRankings.producerIntervalSec).toBe(CRON_YIELD / 1000);
    expect(DATA_SURFACE_DESCRIPTORS.yieldHistory.producerIntervalSec).toBe(CRON_YIELD / 1000);
    expect(DATA_SURFACE_DESCRIPTORS.publicHealth.producerIntervalSec).toBe(CRON_1MIN / 1000);
  });
});
