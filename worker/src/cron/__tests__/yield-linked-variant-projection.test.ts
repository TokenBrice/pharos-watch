import { describe, expect, it } from "vitest";
import { buildHardcodedUsdBenchmark } from "../yield-sync/benchmarks";
import { deriveYieldSourceRole } from "../yield-sync/decision-public";
import { evaluateYieldSources, type EvaluateYieldSourcesInput } from "../yield-sync/evaluation";
import { appendLinkedVariantParentYieldSources } from "../yield-sync/resolve-helpers";
import { buildYieldSourceRisk } from "../yield-sync/source-risk";
import type { ResolvedYield, ResolvedYieldEntry } from "../yield-sync/types";
import { resolveYieldSourceUrl } from "../../lib/yield-source-links";

const START_SEC = 1_783_641_600;

function source(overrides: Partial<ResolvedYield> = {}): ResolvedYield {
  return {
    currentApy: 4.2,
    apyBase: 4.2,
    apyReward: null,
    sourcePool: "pool-linked",
    sourceTvlUsd: 1_000_000,
    dataSource: "defillama",
    exchangeRate: null,
    sourceKey: "pool-linked",
    sourceObservedAt: START_SEC,
    ...overrides,
  };
}

function evaluate(resolved: ResolvedYieldEntry[]) {
  const input: EvaluateYieldSourcesInput = {
    resolved,
    startSec: START_SEC,
    sevenDaysAgoSec: START_SEC - 7 * 86_400,
    safetyScores: new Map(resolved.map((entry) => [entry.id, { score: 80, grade: "B+" }])),
    riskFreeRates: {
      USD: buildHardcodedUsdBenchmark("linked-variant-test"),
      EUR: null,
      CHF: null,
      GBP: null,
      JPY: null,
      MXN: null,
      BRL: null,
      AUD: null,
      CAD: null,
      RUB: null,
      TRY: null,
      SGD: null,
    },
    tier1PrevRates: new Map(),
    sourceHistory: new Map(),
    onChainCompatibilityHistoryById: new Map(),
    legacyDeterministicOnChainHistoryById: new Map(),
    legacyHistoryById: new Map(),
    prevTvlBySource: new Map(),
    legacyPrevTvlById: new Map(),
    prevBestSourceKeyByCoin: new Map(),
    sourceSwitchCount30dByCoin: new Map(),
    stablecoinSupplyById: new Map(resolved.map((entry) => [entry.id, 10_000_000])),
  };
  return evaluateYieldSources(input);
}

describe("appendLinkedVariantParentYieldSources", () => {
  it("projects tracked variant yield onto the active parent as an external wrapper opportunity", () => {
    const resolved: ResolvedYieldEntry[] = [
      {
        id: "ybold-yearn",
        symbol: "yBOLD",
        yield: source({
          dataSource: "price-derived",
          sourcePool: null,
          sourceTvlUsd: null,
          sourceKey: "price-derived",
          yieldSource: undefined,
          yieldType: undefined,
        }),
      },
    ];

    const count = appendLinkedVariantParentYieldSources(resolved);

    expect(count).toBe(1);
    expect(resolved).toHaveLength(2);
    expect(resolved[0]?.id).toBe("ybold-yearn");

    const projected = resolved.find(
      (entry) =>
        entry.id === "bold-liquity" &&
        entry.yield?.sourceKey === "linked-variant:ybold-yearn:price-derived",
    );
    expect(projected?.symbol).toBe("BOLD");
    expect(projected?.yield?.currentApy).toBe(4.2);
    expect(projected?.yield?.yieldSource).toBe("Yearn yBOLD Stability Pool vault");
    expect(projected?.yield?.yieldType).toBe("lending-opportunity");
    expect(projected?.yield?.dataSource).toBe("price-derived");
    expect(projected?.yield?.sourceRisk).toMatchObject({
      deploymentPlace: "strategy-vault",
      venueProtocol: "yearn",
      venueChain: "ethereum",
    });
    expect(resolved[0]?.yield?.yieldType).toBeUndefined();
    expect(resolved[0]?.yield?.sourceRisk).toBeUndefined();

    const evaluatedProjection = evaluate(resolved).evaluatedSources.find(
      (candidate) => candidate.id === "bold-liquity" && candidate.sourceKey === projected?.yield?.sourceKey,
    );
    expect(evaluatedProjection && deriveYieldSourceRole(evaluatedProjection, { isSelected: true })).toBe(
      "external-opportunity",
    );
  });

  it.each([
    {
      ownerId: "syrupusdc-maple",
      parentId: "usdc-circle",
      venueProtocol: "maple",
      deploymentPlace: "strategy-vault",
    },
    {
      ownerId: "syrupusdt-maple",
      parentId: "usdt-tether",
      venueProtocol: "maple",
      deploymentPlace: "strategy-vault",
    },
    {
      ownerId: "susdc-spark",
      parentId: "usdc-circle",
      venueProtocol: "spark-savings",
      deploymentPlace: "native-wrapper",
    },
    {
      ownerId: "yvusdc-yearn",
      parentId: "usdc-circle",
      venueProtocol: "yearn",
      deploymentPlace: "strategy-vault",
    },
    {
      ownerId: "gtusdc-gauntlet",
      parentId: "usdc-circle",
      venueProtocol: "morpho-blue",
      deploymentPlace: "strategy-vault",
    },
  ])(
    "preserves $venueProtocol venue evidence for $ownerId projections",
    ({ ownerId, parentId, venueProtocol, deploymentPlace }) => {
      const childYield = source({
        dataSource: "onchain",
        sourcePool: null,
        sourceKey: `onchain:${ownerId}`,
        yieldType: "nav-appreciation",
        project: undefined,
        chain: undefined,
        sourceRisk: null,
      });
      const resolved: ResolvedYieldEntry[] = [{ id: ownerId, symbol: "WRAP", yield: childYield }];

      expect(appendLinkedVariantParentYieldSources(resolved)).toBe(1);

      const projected = resolved.find((entry) => entry.id === parentId);
      expect(projected?.yield).toMatchObject({
        yieldType: "lending-opportunity",
        project: venueProtocol,
        chain: "ethereum",
        sourceRisk: {
          deploymentPlace,
          venueProtocol,
          venueChain: "ethereum",
        },
      });
      expect(resolved[0]?.yield).toBe(childYield);
      expect(resolved[0]?.yield?.yieldType).toBe("nav-appreciation");
    },
  );

  it("retains explicit structured-wrapper risk evidence on the external parent projection", () => {
    const resolved: ResolvedYieldEntry[] = [
      {
        id: "srusde-strata",
        symbol: "srUSDe",
        yield: source({
          sourceKey: "structured-wrapper",
          yieldType: "nav-appreciation",
          sourceRisk: {
            deploymentPlace: "structured-tranche",
            venueProtocol: "strata",
            venueChain: "ethereum",
            venueRiskTier: "high",
            investabilityFlags: ["withdrawals-underlying-dependent"],
          },
        }),
      },
    ];

    expect(appendLinkedVariantParentYieldSources(resolved)).toBe(1);
    expect(resolved.find((entry) => entry.id === "usde-ethena")?.yield).toMatchObject({
      yieldType: "lending-opportunity",
      sourceRisk: {
        deploymentPlace: "structured-tranche",
        venueProtocol: "strata",
        venueChain: "ethereum",
        venueRiskTier: "high",
        investabilityFlags: ["withdrawals-underlying-dependent"],
      },
    });
  });

  it("publishes a selected Maple projection as an external opportunity with child-owned evidence", () => {
    const resolved: ResolvedYieldEntry[] = [
      {
        id: "syrupusdc-maple",
        symbol: "syrupUSDC",
        yield: source({
          currentApy: 5,
          dataSource: "onchain",
          sourcePool: null,
          sourceKey: "onchain:syrupusdc-maple",
          yieldSource: "Maple Finance lending",
          yieldType: "nav-appreciation",
        }),
      },
    ];
    appendLinkedVariantParentYieldSources(resolved);

    const evaluated = evaluate(resolved);
    const selectedKey = evaluated.bestSourceKeyByCoin.get("usdc-circle");
    const selected = evaluated.evaluatedSources.find(
      (candidate) => candidate.id === "usdc-circle" && candidate.sourceKey === selectedKey,
    );

    expect(selected?.sourceKey).toBe("linked-variant:syrupusdc-maple:onchain:syrupusdc-maple");
    expect(selected && deriveYieldSourceRole(selected, { isSelected: true })).toBe("external-opportunity");
    expect(selected && buildYieldSourceRisk({ source: selected, provenance: null, isBest: true })).toMatchObject({
      deploymentPlace: "strategy-vault",
      venueProtocol: "maple",
      venueChain: "ethereum",
      venueRiskTier: "medium",
      venueRiskConfidence: "verified",
    });
    expect(
      selected &&
        resolveYieldSourceUrl({
          stablecoinId: selected.id,
          sourceKey: selected.sourceKey,
          yieldSource: selected.yieldSource,
        }),
    ).toBe("https://app.maple.finance/earn");
  });

  it("keeps a lower-ranked linked wrapper external when retained as an alternate", () => {
    const resolved: ResolvedYieldEntry[] = [
      {
        id: "usdc-circle",
        symbol: "USDC",
        yield: source({
          currentApy: 6,
          dataSource: "onchain",
          sourcePool: null,
          sourceKey: "onchain:usdc-circle",
          yieldSource: "USDC holder program",
          yieldType: "governance-set",
        }),
      },
      {
        id: "yvusdc-yearn",
        symbol: "yvUSDC-1",
        yield: source({
          currentApy: 4,
          sourcePool: "yearn-pool",
          sourceKey: "yearn-pool",
          yieldSource: "Yearn v3 USDC vault",
          yieldType: "lending-vault",
          project: "yearn",
          chain: "ethereum",
        }),
      },
    ];
    appendLinkedVariantParentYieldSources(resolved);

    const evaluated = evaluate(resolved);
    expect(evaluated.bestSourceKeyByCoin.get("usdc-circle")).toBe("onchain:usdc-circle");
    const alternate = evaluated.evaluatedSources.find(
      (candidate) => candidate.id === "usdc-circle" && candidate.sourceKey.startsWith("linked-variant:"),
    );
    const child = evaluated.evaluatedSources.find((candidate) => candidate.id === "yvusdc-yearn");

    expect(alternate && deriveYieldSourceRole(alternate, { isSelected: false })).toBe("external-opportunity");
    expect(
      alternate &&
        resolveYieldSourceUrl({
          stablecoinId: alternate.id,
          sourceKey: alternate.sourceKey,
          yieldSource: alternate.yieldSource,
        }),
    ).toBe("https://yearn.fi/v3/1/0xbe53a109b494e5c9f97b9cd39fe969be68bf6204");
    expect(child?.yieldType).toBe("lending-vault");
    expect(child && deriveYieldSourceRole(child, { isSelected: true })).not.toBe("external-opportunity");
  });

  it("does not duplicate a parent source when the same pool is already present", () => {
    const resolved: ResolvedYieldEntry[] = [
      {
        id: "bold-liquity",
        symbol: "BOLD",
        yield: source({ sourcePool: "pool-sbold", sourceKey: "parent-sbold" }),
      },
      {
        id: "sbold-k3-capital",
        symbol: "sBOLD",
        yield: source({
          sourcePool: "pool-sbold",
          sourceKey: "child-sbold",
          yieldSource: "K3: sBOLD",
          yieldType: "lending-vault",
        }),
      },
    ];

    expect(appendLinkedVariantParentYieldSources(resolved)).toBe(0);
    expect(resolved).toHaveLength(2);
  });

  it("does not project third-party lending opportunities from variants to parents", () => {
    const resolved: ResolvedYieldEntry[] = [
      {
        id: "sbold-k3-capital",
        symbol: "sBOLD",
        yield: source({
          sourceKey: "third-party-lending",
          yieldSource: "Example lending market",
          yieldType: "lending-opportunity",
        }),
      },
    ];

    expect(appendLinkedVariantParentYieldSources(resolved)).toBe(0);
    expect(resolved).toHaveLength(1);
  });

  it("does not project auto-discovered lending rows using variant metadata defaults", () => {
    const resolved: ResolvedYieldEntry[] = [
      {
        id: "ybold-yearn",
        symbol: "yBOLD",
        yield: source({
          dataSource: "defillama-auto",
          sourcePool: "attacker-third-party-lending-pool",
          sourceKey: "attacker-third-party-lending-pool",
          project: "example-lender",
          yieldSource: undefined,
          yieldType: undefined,
        }),
      },
    ];

    expect(appendLinkedVariantParentYieldSources(resolved)).toBe(0);
    expect(resolved).toHaveLength(1);
  });

  it("does not project fixed-yield PT opportunities from variants to parents", () => {
    const resolved: ResolvedYieldEntry[] = [
      {
        id: "sbold-k3-capital",
        symbol: "sBOLD",
        yield: source({
          sourceKey: "protocol-api:pendle:ethereum:0xpt",
          yieldSource: "Pendle fixed yield: sBOLD PT-sBOLD",
          yieldType: "fixed-yield",
        }),
      },
    ];

    expect(appendLinkedVariantParentYieldSources(resolved)).toBe(0);
    expect(resolved).toHaveLength(1);
  });

  it("does not project fixed-yield markets from variants to parents", () => {
    const resolved: ResolvedYieldEntry[] = [
      {
        id: "sbold-k3-capital",
        symbol: "sBOLD",
        yield: source({
          sourceKey: "protocol-api:pendle:ethereum:0xpool",
          yieldSource: "Pendle fixed yield: sBOLD",
          yieldType: "fixed-yield",
        }),
      },
    ];

    expect(appendLinkedVariantParentYieldSources(resolved)).toBe(0);
    expect(resolved).toHaveLength(1);
  });

  it("does not project third-party structured tranches from variants to parents", () => {
    const resolved: ResolvedYieldEntry[] = [
      {
        id: "srusde-strata",
        symbol: "srUSDe",
        yield: source({
          sourceKey: "royco-dawn:ethereum:senior-tranche",
          yieldSource: "Royco Dawn senior tranche",
          yieldType: "structured-tranche",
        }),
      },
    ];

    expect(appendLinkedVariantParentYieldSources(resolved)).toBe(0);
    expect(resolved).toHaveLength(1);
  });
});
