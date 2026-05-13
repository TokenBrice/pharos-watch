import { describe, expect, it } from "vitest";
import { appendLinkedVariantParentYieldSources } from "../yield-sync/resolve-helpers";
import type { ResolvedYield, ResolvedYieldEntry } from "../yield-sync/types";

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
    ...overrides,
  };
}

describe("appendLinkedVariantParentYieldSources", () => {
  it("projects tracked variant yield onto the active parent with variant labels preserved", () => {
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
    expect(projected?.yield?.yieldType).toBe("lending-vault");
    expect(projected?.yield?.dataSource).toBe("price-derived");
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
});
