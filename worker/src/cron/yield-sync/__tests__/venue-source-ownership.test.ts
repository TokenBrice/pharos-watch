import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import type * as TrackedUtilsModule from "@shared/lib/tracked-stablecoin-utils";
import type * as StablecoinRegistryModule from "@shared/lib/stablecoins/registry";

vi.mock("@shared/lib/tracked-stablecoin-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof TrackedUtilsModule>();
  const registry = await vi.importActual<typeof StablecoinRegistryModule>("@shared/lib/stablecoins/registry");
  return {
    ...actual,
    // A small cohort keeps the resolver from walking the full catalog. Each coin
    // exercises one identity path: Layer-3 venue skips, a pinned issuer pool and
    // a reviewed vault share whose own venue is the matched project.
    ACTIVE_YIELD_BEARING_STABLECOINS: [
      "eursafo-spiko",
      "susd-solayer",
      "apyusd-apyx",
      "susde-ethena",
      "usdo-openeden",
      "gtusdcp-gauntlet",
    ].map((id) => registry.TRACKED_META_BY_ID.get(id)!),
  };
});
vi.mock("../sources-optional", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sources-optional")>();

  return {
    ...actual,
    TRACKED_OPTIONAL_SOURCE_REGISTRY_BY_ID: new Map(),
    STANDALONE_TRACKED_OPTIONAL_SOURCE_REGISTRY: [],
  };
});
vi.mock("../state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state")>();

  return {
    ...actual,
    getPriceDerivedApy: vi.fn(async () => null),
  };
});

import { DAY_SECONDS } from "@shared/lib/time-constants";
import { YIELD_POOL_MAP } from "../../../lib/yield-config/yield-config-pools";
import { appendLinkedVariantParentYieldSources, resolveTrackedYieldSources } from "../resolve";
import { evaluateYieldSourcesCooperative } from "../evaluation";
import { getPriceDerivedApy } from "../state";
import type { DlPool, ResolvedYieldEntry } from "../types";
import { baseEvaluationInput, freshUsdBenchmark } from "../../__tests__/yield-evaluation.test-support";

const START_SEC = 1_783_641_600;

function pool(overrides: Partial<DlPool>): DlPool {
  return {
    pool: "pool-1",
    symbol: "USDC",
    chain: "Ethereum",
    project: "unrelated-issuer",
    tvlUsd: 2_000_000,
    apy: 5,
    apyBase: 5,
    apyReward: null,
    apyMean30d: 5,
    stablecoin: true,
    exposure: "single",
    underlyingTokens: null,
    ...overrides,
  };
}

async function resolvePools(dlPools: DlPool[]): Promise<ResolvedYieldEntry[]> {
  const { resolved } = await resolveTrackedYieldSources({
    db: mockD1(),
    startSec: START_SEC,
    sevenDaysAgoSec: START_SEC - 7 * DAY_SECONDS,
    dlPools,
    onChainRates: new Map(),
    safetyScores: new Map(),
    riskFreeRates: {
      ...baseEvaluationInput().riskFreeRates,
      USD: freshUsdBenchmark(START_SEC),
      EUR: { ...freshUsdBenchmark(START_SEC), key: "EUR" as const, currency: "EUR" },
    },
  });
  return resolved;
}

async function evaluate(entries: ResolvedYieldEntry[], ids: string[]) {
  return evaluateYieldSourcesCooperative(baseEvaluationInput({
    resolved: entries,
    startSec: START_SEC,
    safetyScores: new Map(ids.map((id) => [id, { score: 80, grade: "B+" }])),
    stablecoinSupplyById: new Map(ids.map((id) => [id, 10_000_000])),
    dlPoolsMeta: { mode: "dex-cache", updatedAt: START_SEC, ageSeconds: 0, poolCount: 1, fallbackMode: null },
    riskFreeRates: {
      ...baseEvaluationInput().riskFreeRates,
      USD: freshUsdBenchmark(START_SEC),
      EUR: { ...freshUsdBenchmark(START_SEC), key: "EUR" as const, currency: "EUR" },
    },
  }), { yieldToEventLoop: () => Promise.resolve() });
}

function hasSource(entries: ResolvedYieldEntry[], stablecoinId: string, sourcePool: string): boolean {
  return entries.some((entry) => entry.id === stablecoinId && entry.yield?.sourceKey === sourcePool);
}

beforeEach(() => {
  vi.mocked(getPriceDerivedApy).mockResolvedValue(null);
});

describe("Layer 3 never adopts a lending-venue pool", () => {
  it("skips a Morpho Blue market instead of publishing it as EURSAFO's own yield", async () => {
    const morphoPool = pool({
      pool: "e0c3e6dc-128a-5b72-8106-239bc4577f7b",
      symbol: "EURSAFO",
      chain: "Ethereum",
      project: "morpho-blue",
      tvlUsd: 810_355,
      apy: 2.19,
      apyBase: 2.19,
      underlyingTokens: ["0x0990b149e915cb08e2143a5c6f669c907eddc8b0"],
    });
    const resolved = await resolvePools([morphoPool]);

    expect(hasSource(resolved, "eursafo-spiko", morphoPool.pool)).toBe(false);
  });

  it("skips a Project 0 Solana market instead of publishing a sUSD venue row", async () => {
    const projectZeroPool = pool({
      pool: "a16d8967-12a0-458e-9b9f-7e9bd5fed450",
      symbol: "sUSD",
      chain: "Solana",
      project: "project-0",
      tvlUsd: 59_824,
      apy: 3.4,
      apyBase: 3.4,
      underlyingTokens: ["susdabGDNbhrnCa6ncrYo81u4s9GM8ecK2UwMyZiq4X"],
    });
    const resolved = await resolvePools([projectZeroPool]);

    expect(hasSource(resolved, "susd-solayer", projectZeroPool.pool)).toBe(false);
  });

  it("skips a Kamino market and projects nothing onto apxUSD", async () => {
    const kaminoPool = pool({
      pool: "675dcb0e-d8d7-5930-93d6-ccde2777466c",
      symbol: "apyUSD",
      chain: "Solana",
      project: "kamino-lend",
      tvlUsd: 783_622,
      apy: 0,
      apyBase: 0,
      underlyingTokens: ["Ex8hKasfFCfj3yGuN5TyYRUjHePgVs3uYUJRT8geT7rv"],
    });
    const resolved = await resolvePools([kaminoPool]);

    expect(hasSource(resolved, "apyusd-apyx", kaminoPool.pool)).toBe(false);
    expect(resolved.some((entry) => entry.id === "apyusd-apyx" && entry.yield != null)).toBe(false);
    expect(appendLinkedVariantParentYieldSources(resolved)).toBe(0);
    expect(resolved.some((entry) => entry.id === "apxusd-apyx")).toBe(false);
  });

  it("publishes no 0% venue row through Layer 3", async () => {
    const projectZeroPool = pool({
      pool: "a16d8967-12a0-458e-9b9f-7e9bd5fed450",
      symbol: "sUSD",
      chain: "Solana",
      project: "project-0",
      tvlUsd: 59_824,
      apy: 0,
      apyBase: 0,
      underlyingTokens: ["susdabGDnbhrnCa6ncrYo81u4s9GM8ecK2UwMyZiq4X"],
    });
    const resolved = await resolvePools([projectZeroPool]);

    expect(hasSource(resolved, "susd-solayer", projectZeroPool.pool)).toBe(false);
    const evaluated = await evaluate(resolved, ["susd-solayer"]);
    expect(evaluated.evaluatedSources.some((source) => source.sourceKey === projectZeroPool.pool)).toBe(false);
  });

  it("runs the price-derived native fallback when the only DeFiLlama match is a skipped venue pool", async () => {
    const kaminoPool = pool({
      pool: "675dcb0e-d8d7-5930-93d6-ccde2777466c",
      symbol: "apyUSD",
      chain: "Solana",
      project: "kamino-lend",
      tvlUsd: 783_622,
      apy: 3.2,
      apyBase: 3.2,
      underlyingTokens: ["Ex8hKasfFCfj3yGuN5TyYRUjHePgVs3uYUJRT8geT7rv"],
    });
    vi.mocked(getPriceDerivedApy).mockResolvedValueOnce({
      apy: 9.2,
      sourceObservedAt: START_SEC,
      comparisonAnchorObservedAt: START_SEC - 14 * DAY_SECONDS,
    });
    const resolved = await resolvePools([kaminoPool]);

    expect(hasSource(resolved, "apyusd-apyx", kaminoPool.pool)).toBe(false);
    const fallback = resolved.find(
      (entry) => entry.id === "apyusd-apyx" && entry.yield?.dataSource === "price-derived",
    );
    expect(fallback?.yield).toMatchObject({
      currentApy: 9.2,
      sourceKey: "price-derived",
    });
  });

  it("keeps a reviewed vault share's own venue when the pool project matches", async () => {
    const vaultPool = pool({
      pool: "gtusdcp-ethereum-morpho",
      symbol: "gtUSDCp",
      chain: "Ethereum",
      project: "morpho-blue",
      tvlUsd: 23_000_000,
      apy: 4.6,
      apyBase: 4.6,
      underlyingTokens: ["0x8c106eedad96553e64287a5a6839c3cc78afa3d0"],
    });
    const resolved = await resolvePools([vaultPool]);
    const row = resolved.find((entry) => entry.id === "gtusdcp-gauntlet" && entry.yield?.sourceKey === vaultPool.pool);

    expect(row?.yield).toMatchObject({
      dataSource: "defillama",
      yieldType: "lending-vault",
    });
    const evaluated = (await evaluate(resolved, ["gtusdcp-gauntlet"])).evaluatedSources.find(
      (source) => source.id === "gtusdcp-gauntlet" && source.sourceKey === vaultPool.pool,
    );
    expect(evaluated?.yieldSource).toBe("Gauntlet USDC Prime MetaMorpho vault");
  });

  it("keeps a Layer 3 match native when its project is not a lending venue", async () => {
    const issuerPool = pool({
      pool: "spiko-eursafo-pool",
      symbol: "EURSAFO",
      chain: "Ethereum",
      project: "spiko",
      tvlUsd: 900_000_000,
      apy: 2.3,
      apyBase: 2.3,
      underlyingTokens: ["0x0990b149e915cb08e2143a5c6f669c907eddc8b0"],
    });
    const resolved = await resolvePools([issuerPool]);
    const row = resolved.find((entry) => entry.id === "eursafo-spiko" && entry.yield?.sourceKey === issuerPool.pool);

    expect(row?.yield).toMatchObject({
      dataSource: "defillama",
      yieldType: "nav-appreciation",
    });
  });
});

describe("curated native identities", () => {
  it("keeps a pinned native pool's own label and type", async () => {
    const nativePool = pool({
      pool: YIELD_POOL_MAP["susde-ethena"]!,
      symbol: "sUSDe",
      chain: "Ethereum",
      project: "ethena",
      tvlUsd: 500_000_000,
      apy: 5,
      apyBase: 5,
    });
    const resolved = await resolvePools([nativePool]);
    const row = resolved.find((entry) => entry.id === "susde-ethena" && entry.yield?.sourceKey === nativePool.pool);

    expect(row?.yield).toMatchObject({
      dataSource: "defillama",
      yieldType: "nav-appreciation",
      sourcePool: YIELD_POOL_MAP["susde-ethena"],
    });
    expect(row?.yield?.yieldSource).toBeUndefined();
  });

  it("resolves USDO from its pinned native pool, not a deposited openeden-usdo market", async () => {
    const pinnedPoolId = YIELD_POOL_MAP["usdo-openeden"];
    expect(pinnedPoolId).toBe("85d9b9d3-3ca0-410c-bde0-d8ab07fe21c3");

    const bscPool = pool({
      pool: pinnedPoolId!,
      symbol: "USDO",
      chain: "BSC",
      project: "openeden-usdo",
      tvlUsd: 144_368,
      apy: 3.45346,
      apyBase: 3.45346,
    });
    // Layer 3 would previously pick the larger Ethereum instrument; the pin
    // keeps USDO on the BSC pool it published before venue matches were skipped.
    const largerEthereumPool = pool({
      pool: "f083596e-032d-4d6b-a7a8-1836d3f99bcd",
      symbol: "USDO",
      chain: "Ethereum",
      project: "openeden-usdo",
      tvlUsd: 12_600_000,
      apy: 3.1,
      apyBase: 3.1,
      underlyingTokens: ["0x8238884ec9668ef77b90c6dff4d1a9f4f4823bfe"],
    });
    const resolved = await resolvePools([bscPool, largerEthereumPool]);
    const usdoRows = resolved.filter((entry) => entry.id === "usdo-openeden");

    expect(usdoRows).toHaveLength(1);
    expect(usdoRows[0]?.yield).toMatchObject({
      dataSource: "defillama",
      yieldType: "rebase",
      sourcePool: pinnedPoolId,
    });
    const evaluated = (await evaluate(resolved, ["usdo-openeden"])).evaluatedSources.find(
      (source) => source.id === "usdo-openeden" && source.sourceKey === pinnedPoolId,
    );
    expect(evaluated?.yieldSource).toBe("OpenEden USDO daily rebase");
  });
});
