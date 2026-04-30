import { describe, expect, it } from "vitest";
import { fixtureChains, makeChain } from "../__fixtures__/pharosville-world";
import { buildChainDocks } from "./chain-docks";
import {
  EVM_BAY_DOCK_TILES,
  isLandTileKind,
  isWaterTileKind,
  OUTER_HARBOR_DOCK_TILES,
  PREFERRED_DOCK_TILES,
  tileKindAt,
} from "./world-layout";

describe("buildChainDocks", () => {
  it("sizes docks from chain totalUsd and keeps concentration separate", () => {
    const docks = buildChainDocks(fixtureChains);

    expect(docks[0]?.chainId).toBe("ethereum");
    expect(docks[0]?.totalUsd).toBe(8_000_000_000);
    expect(docks[0]?.concentration).toBe(0.4);
    expect(docks[0]?.size).toBeGreaterThan(docks[1]?.size ?? 0);
    expect(docks[0]?.size).toBeGreaterThanOrEqual(7);
    expect(docks[1]?.size).toBeGreaterThanOrEqual(6);
    expect(docks[0]?.assetId).toBe("dock.ethereum-harbor-hub");
    expect(docks[0]?.logoSrc).toBeNull();
  });

  it("anchors rendered docks on land-adjacent harbor water", () => {
    const docks = buildChainDocks(fixtureChains);

    expect(docks.find((dock) => dock.chainId === "ethereum")?.tile).toEqual(PREFERRED_DOCK_TILES.ethereum);
    expect(docks.find((dock) => dock.chainId === "tron")?.tile).toEqual(PREFERRED_DOCK_TILES.tron);
    expect(docks.every((dock) => isLandTileKind(tileKindAt(dock.tile.x, dock.tile.y)))).toBe(true);
    expect(docks.every((dock) => cardinalNeighbors(dock.tile).some((neighbor) => (
      isWaterTileKind(tileKindAt(neighbor.x, neighbor.y))
    )))).toBe(true);
  });

  it("keeps the Ethereum and L2 extension harbors in the EVM bay and distributes alt L1s outside it", () => {
    const docks = buildChainDocks({
      ...fixtureChains,
      chains: [
        makeChain({ id: "ethereum", name: "Ethereum", totalUsd: 100, logoPath: "/chains/ethereum.png" }),
        makeChain({ id: "tron", name: "Tron", totalUsd: 90 }),
        makeChain({ id: "bsc", name: "BSC", totalUsd: 80 }),
        makeChain({ id: "base", name: "Base", totalUsd: 70, logoPath: "/chains/base.png" }),
        makeChain({ id: "solana", name: "Solana", totalUsd: 60 }),
        makeChain({ id: "arbitrum", name: "Arbitrum", totalUsd: 50 }),
        makeChain({ id: "polygon", name: "Polygon", totalUsd: 40 }),
        makeChain({ id: "aptos", name: "Aptos", totalUsd: 30 }),
        makeChain({ id: "optimism", name: "Optimism", totalUsd: 20 }),
        makeChain({ id: "mantle", name: "Mantle", totalUsd: 10 }),
      ],
      globalTotalUsd: 550,
    });
    const byChain = new Map(docks.map((dock) => [dock.chainId, dock.tile]));

    expect(byChain.get("ethereum")).toEqual(PREFERRED_DOCK_TILES.ethereum);
    expect(byChain.get("base")).toEqual(PREFERRED_DOCK_TILES.base);
    expect(byChain.get("arbitrum")).toEqual(PREFERRED_DOCK_TILES.arbitrum);
    expect(byChain.get("optimism")).toEqual(PREFERRED_DOCK_TILES.optimism);
    expect(byChain.get("polygon")).toEqual(PREFERRED_DOCK_TILES.polygon);
    expect(byChain.get("mantle")).toEqual(PREFERRED_DOCK_TILES.mantle);
    expect(docks.find((dock) => dock.chainId === "ethereum")?.assetId).toBe("dock.ethereum-harbor-hub");
    expect(docks.find((dock) => dock.chainId === "base")?.assetId).toBe("dock.rollup-ferry-slip");
    expect(docks.find((dock) => dock.chainId === "arbitrum")?.assetId).toBe("dock.bridge-pontoon");
    expect(docks.find((dock) => dock.chainId === "optimism")?.assetId).toBe("dock.relay-pontoon");
    expect(docks.find((dock) => dock.chainId === "polygon")?.assetId).toBe("dock.market-marina");
    expect(docks.find((dock) => dock.chainId === "mantle")?.assetId).toBe("dock.vault-quay");
    expect(docks.find((dock) => dock.chainId === "ethereum")?.logoSrc).toBe("/chains/ethereum.png");
    expect(docks.find((dock) => dock.chainId === "base")?.logoSrc).toBe("/chains/base.png");
    expect(docks.find((dock) => dock.chainId === "tron")?.logoSrc).toBeNull();
    expect(byChain.get("bsc")).toEqual(PREFERRED_DOCK_TILES.bsc);
    expect(byChain.get("tron")).toEqual(PREFERRED_DOCK_TILES.tron);
    expect(byChain.get("solana")).toEqual(PREFERRED_DOCK_TILES.solana);
    expect(byChain.get("aptos")).toEqual(PREFERRED_DOCK_TILES.aptos);

    for (const chainId of ["ethereum", "base", "arbitrum", "optimism", "polygon", "mantle"]) {
      expect(EVM_BAY_DOCK_TILES).toContainEqual(byChain.get(chainId));
    }
    for (const chainId of ["bsc", "tron", "solana", "aptos"]) {
      expect(EVM_BAY_DOCK_TILES).not.toContainEqual(byChain.get(chainId));
      expect(OUTER_HARBOR_DOCK_TILES).toContainEqual(byChain.get(chainId));
    }
    expect(new Set(docks.map((dock) => `${dock.tile.x}.${dock.tile.y}`)).size).toBe(docks.length);
  });

  it("reserves key Ethereum L2 extension slips before lower-ranked outer harbors", () => {
    const docks = buildChainDocks({
      ...fixtureChains,
      chains: [
        makeChain({ id: "ethereum", totalUsd: 100 }),
        makeChain({ id: "tron", totalUsd: 90 }),
        makeChain({ id: "bsc", totalUsd: 80 }),
        makeChain({ id: "solana", totalUsd: 70 }),
        makeChain({ id: "hyperliquid", totalUsd: 60 }),
        makeChain({ id: "base", totalUsd: 50 }),
        makeChain({ id: "arbitrum", totalUsd: 40 }),
        makeChain({ id: "polygon", totalUsd: 30 }),
        makeChain({ id: "aptos", totalUsd: 20 }),
        makeChain({ id: "avalanche", totalUsd: 19 }),
        makeChain({ id: "xlayer", totalUsd: 18 }),
        makeChain({ id: "mantle", totalUsd: 5 }),
        makeChain({ id: "optimism", totalUsd: 4 }),
      ],
      globalTotalUsd: 586,
    });

    expect(docks).toHaveLength(10);
    expect(docks.map((dock) => dock.chainId)).toEqual([
      "ethereum",
      "tron",
      "bsc",
      "solana",
      "hyperliquid",
      "base",
      "arbitrum",
      "polygon",
      "mantle",
      "optimism",
    ]);
    expect(docks.map((dock) => dock.chainId)).not.toContain("aptos");
    expect(docks.map((dock) => dock.chainId)).not.toContain("avalanche");
    expect(docks.map((dock) => dock.chainId)).not.toContain("xlayer");
    expect(docks.find((dock) => dock.chainId === "optimism")?.tile).toEqual(PREFERRED_DOCK_TILES.optimism);
    expect(docks.find((dock) => dock.chainId === "mantle")?.tile).toEqual(PREFERRED_DOCK_TILES.mantle);
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

  it("emits only the top ten chain harbors and preserves top stablecoin cargo", () => {
    const chains = Array.from({ length: 12 }, (_, index) => makeChain({
      id: `chain-${index}`,
      totalUsd: 12_000_000_000 - index * 1_000_000_000,
      topStablecoins: [
        { id: `coin-${index}-a`, symbol: `A${index}`, share: 0.6, supplyUsd: 600_000_000 },
        { id: `coin-${index}-b`, symbol: `B${index}`, share: 0.4, supplyUsd: 400_000_000 },
      ],
    }));

    const docks = buildChainDocks({
      ...fixtureChains,
      chains,
      globalTotalUsd: 78_000_000_000,
    });

    expect(docks).toHaveLength(10);
    expect(docks.map((dock) => dock.chainId)).toEqual([
      "chain-0",
      "chain-1",
      "chain-2",
      "chain-3",
      "chain-4",
      "chain-5",
      "chain-6",
      "chain-7",
      "chain-8",
      "chain-9",
    ]);
    expect(docks.map((dock) => dock.tile)).toEqual(OUTER_HARBOR_DOCK_TILES.slice(0, 10));
    expect(docks.map((dock) => dock.assetId)).toEqual([
      "dock.harbor-ring-quay",
      "dock.compact-harbor-pier",
      "dock.grand-quay",
      "dock.container-wharf",
      "dock.twin-slip",
      "dock.stone-breakwater",
      "dock.market-marina",
      "dock.relay-pontoon",
      "dock.rollup-ferry-slip",
      "dock.vault-quay",
    ]);
    expect(docks[0]?.harboredStablecoins.map((coin) => coin.symbol)).toEqual(["A0", "B0"]);
  });
});

function cardinalNeighbors(tile: { x: number; y: number }): { x: number; y: number }[] {
  return [
    { x: tile.x + 1, y: tile.y },
    { x: tile.x - 1, y: tile.y },
    { x: tile.x, y: tile.y + 1 },
    { x: tile.x, y: tile.y - 1 },
  ];
}
