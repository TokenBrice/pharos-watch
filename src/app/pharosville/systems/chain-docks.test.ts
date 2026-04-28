import { describe, expect, it } from "vitest";
import { fixtureChains, makeChain } from "../__fixtures__/pharosville-world";
import { buildChainDocks } from "./chain-docks";

describe("buildChainDocks", () => {
  it("sizes docks from chain totalUsd and keeps concentration separate", () => {
    const docks = buildChainDocks(fixtureChains);

    expect(docks[0]?.chainId).toBe("ethereum");
    expect(docks[0]?.totalUsd).toBe(8_000_000_000);
    expect(docks[0]?.concentration).toBe(0.4);
    expect(docks[0]?.size).toBeGreaterThan(docks[1]?.size ?? 0);
    expect(docks[0]?.size).toBeGreaterThanOrEqual(7);
    expect(docks[1]?.size).toBeGreaterThanOrEqual(6);
    expect(docks[0]?.assetId).toBe("dock.grand-quay");
  });

  it("keeps billion-dollar hubs large even when their global share is modest", () => {
    const docks = buildChainDocks({
      ...fixtureChains,
      globalTotalUsd: 150_000_000_000,
      chains: [
        makeChain({ id: "ethereum", totalUsd: 95_000_000_000 }),
        makeChain({ id: "base", totalUsd: 6_000_000_000 }),
        makeChain({ id: "arbitrum", totalUsd: 2_500_000_000 }),
        makeChain({ id: "small", totalUsd: 20_000_000 }),
      ],
    });

    expect(docks.find((dock) => dock.chainId === "ethereum")?.size).toBe(10);
    expect(docks.find((dock) => dock.chainId === "base")?.size).toBe(7);
    expect(docks.find((dock) => dock.chainId === "arbitrum")?.size).toBe(6);
    expect(docks.find((dock) => dock.chainId === "small")?.size).toBe(1);
  });

  it("emits only the top six chain harbors and preserves top stablecoin cargo", () => {
    const chains = Array.from({ length: 8 }, (_, index) => makeChain({
      id: `chain-${index}`,
      totalUsd: 8_000_000_000 - index * 1_000_000_000,
      topStablecoins: [
        { id: `coin-${index}-a`, symbol: `A${index}`, share: 0.6, supplyUsd: 600_000_000 },
        { id: `coin-${index}-b`, symbol: `B${index}`, share: 0.4, supplyUsd: 400_000_000 },
      ],
    }));

    const docks = buildChainDocks({
      ...fixtureChains,
      chains,
      globalTotalUsd: 36_000_000_000,
    });

    expect(docks).toHaveLength(6);
    expect(docks.map((dock) => dock.chainId)).toEqual([
      "chain-0",
      "chain-1",
      "chain-2",
      "chain-3",
      "chain-4",
      "chain-5",
    ]);
    expect(docks.map((dock) => dock.tile)).not.toContainEqual({ x: 15, y: 42 });
    expect(docks[0]?.harboredStablecoins.map((coin) => coin.symbol)).toEqual(["A0", "B0"]);
  });
});
