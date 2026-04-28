import { describe, expect, it } from "vitest";
import { CEMETERY_ENTRIES } from "@shared/lib/cemetery-merged";
import {
  fixtureChains,
  fixturePegSummary,
  fixtureReportCards,
  fixtureStability,
  fixtureStablecoins,
  fixtureStress,
  makeAsset,
  makeChain,
  makePegCoin,
} from "../__fixtures__/pharosville-world";
import { buildPharosVilleWorld } from "./pharosville-world";
import { tileKindAt } from "./world-layout";

describe("buildPharosVilleWorld", () => {
  it("builds deterministic core entities without React or canvas", () => {
    const world = buildPharosVilleWorld({
      stablecoins: fixtureStablecoins,
      chains: fixtureChains,
      stability: fixtureStability,
      pegSummary: fixturePegSummary,
      stress: fixtureStress,
      reportCards: fixtureReportCards,
      cemeteryEntries: CEMETERY_ENTRIES.slice(0, 3),
      freshness: {},
    });

    expect(world.routeMode).toBe("world");
    expect(world.map.waterRatio).toBeGreaterThanOrEqual(0.83);
    expect(world.lighthouse.unavailable).toBe(false);
    expect(world.docks).toHaveLength(2);
    expect(world.ships.map((ship) => ship.id)).toEqual(["usdt-tether", "usdc-circle"]);
    expect(world.ships.every((ship) => ["water", "deep-water"].includes(tileKindAt(ship.tile.x, ship.tile.y)))).toBe(true);
    expect(new Set(world.ships.map((ship) => `${ship.tile.x}.${ship.tile.y}`)).size).toBe(world.ships.length);
    expect(world.ships.find((ship) => ship.id === "usdt-tether")?.logoSrc).toBe("/logos/1-usdt.svg");
    expect(world.detailIndex["ship.usdt-tether"]?.facts).toEqual(expect.arrayContaining([
      { label: "Ship class", value: "CeFi" },
      { label: "Size tier", value: "Flagship" },
    ]));
    expect(world.graves).toHaveLength(3);
    expect(world.graves[0]?.logoSrc).toBe("/logos/cemetery/nubits.png");
    expect(world.detailIndex["lighthouse"]).toBeDefined();
    expect(world.visualCues.length).toBeGreaterThan(0);
  });

  it("assigns rendered dock visits without overwriting the risk tile", () => {
    const input = {
      stablecoins: fixtureStablecoins,
      chains: fixtureChains,
      stability: fixtureStability,
      pegSummary: fixturePegSummary,
      stress: fixtureStress,
      reportCards: fixtureReportCards,
      cemeteryEntries: [],
      freshness: {},
    };
    const world = buildPharosVilleWorld(input);
    const repeatedWorld = buildPharosVilleWorld(input);
    const ethereumDock = world.docks.find((dock) => dock.chainId === "ethereum");
    const usdt = world.ships.find((ship) => ship.id === "usdt-tether");
    const repeatedUsdt = repeatedWorld.ships.find((ship) => ship.id === "usdt-tether");
    const ethereumVisit = usdt?.dockVisits?.find((visit) => visit.chainId === "ethereum");

    expect(ethereumDock).toBeDefined();
    expect(usdt?.dockChainId).toBe("ethereum");
    expect(usdt?.homeDockChainId).toBe("ethereum");
    expect(usdt?.dominantChainId).toBe("ethereum");
    expect(ethereumVisit).toBeDefined();
    expect(ethereumVisit?.dockId).toBe(ethereumDock?.id);
    expect(ethereumVisit?.mooringTile).not.toEqual(usdt?.tile);
    expect(ethereumVisit?.mooringTile).toBeDefined();
    expect(["water", "deep-water"]).toContain(tileKindAt(ethereumVisit?.mooringTile.x ?? -1, ethereumVisit?.mooringTile.y ?? -1));
    expect(repeatedUsdt?.dockVisits).toEqual(usdt?.dockVisits);
    expect(usdt?.riskPlacement).toBe("safe-harbor");
    expect(usdt?.riskZone).toBe("safe");
  });

  it("canonicalizes positive chain presence and normalizes shares", () => {
    const world = buildPharosVilleWorld({
      stablecoins: {
        peggedAssets: [
          makeAsset({
            id: "usdc-circle",
            symbol: "USDC",
            chainCirculating: {
              "OP Mainnet": {
                current: 400,
                circulatingPrevDay: 400,
                circulatingPrevWeek: 400,
                circulatingPrevMonth: 400,
              },
              optimism: {
                current: 600,
                circulatingPrevDay: 600,
                circulatingPrevWeek: 600,
                circulatingPrevMonth: 600,
              },
              Ethereum: {
                current: 0,
                circulatingPrevDay: 0,
                circulatingPrevWeek: 0,
                circulatingPrevMonth: 0,
              },
              Tron: {
                current: -50,
                circulatingPrevDay: -50,
                circulatingPrevWeek: -50,
                circulatingPrevMonth: -50,
              },
            },
          }),
        ],
      },
      chains: {
        ...fixtureChains,
        chains: [makeChain({ id: "optimism", name: "Optimism", totalUsd: 1_000 })],
      },
      stability: fixtureStability,
      pegSummary: fixturePegSummary,
      stress: fixtureStress,
      reportCards: fixtureReportCards,
      cemeteryEntries: [],
      freshness: {},
    });
    const usdc = world.ships[0];

    expect(usdc?.chainPresence).toEqual([
      {
        chainId: "optimism",
        currentUsd: 1_000,
        share: 1,
        hasRenderedDock: true,
      },
    ]);
    expect(usdc?.dockVisits).toHaveLength(1);
    expect(usdc?.dockVisits?.[0]?.chainId).toBe("optimism");
  });

  it("excludes frozen response rows from active ships", () => {
    const world = buildPharosVilleWorld({
      stablecoins: {
        peggedAssets: [
          ...fixtureStablecoins.peggedAssets,
          makeAsset({ id: "usdc-circle", symbol: "USDC", frozen: true }),
        ],
      },
      chains: fixtureChains,
      stability: fixtureStability,
      pegSummary: fixturePegSummary,
      stress: fixtureStress,
      reportCards: fixtureReportCards,
      cemeteryEntries: [],
      freshness: {},
    });

    expect(world.ships.filter((ship) => ship.id === "usdc-circle")).toHaveLength(1);
  });

  it("renders unavailable PSI as an unlit lighthouse", () => {
    const world = buildPharosVilleWorld({
      stablecoins: fixtureStablecoins,
      chains: fixtureChains,
      stability: { ...fixtureStability, current: null },
      pegSummary: fixturePegSummary,
      stress: fixtureStress,
      reportCards: fixtureReportCards,
      cemeteryEntries: [],
      freshness: { stabilityStale: true },
    });

    expect(world.lighthouse.unavailable).toBe(true);
    expect(world.detailIndex.lighthouse.summary).toContain("unavailable");
  });

  it("uses the largest rendered positive chain as home dock when the dominant chain is unrendered", () => {
    const world = buildPharosVilleWorld({
      stablecoins: {
        peggedAssets: [
          makeAsset({
            id: "usdc-circle",
            symbol: "USDC",
            chainCirculating: {
              Solana: {
                current: 1_000_000_000,
                circulatingPrevDay: 1_000_000_000,
                circulatingPrevWeek: 1_000_000_000,
                circulatingPrevMonth: 1_000_000_000,
              },
              Ethereum: {
                current: 500_000_000,
                circulatingPrevDay: 500_000_000,
                circulatingPrevWeek: 500_000_000,
                circulatingPrevMonth: 500_000_000,
              },
              Tron: {
                current: 100_000_000,
                circulatingPrevDay: 100_000_000,
                circulatingPrevWeek: 100_000_000,
                circulatingPrevMonth: 100_000_000,
              },
            },
          }),
        ],
      },
      chains: { ...fixtureChains, chains: fixtureChains.chains.slice(0, 1) },
      stability: fixtureStability,
      pegSummary: fixturePegSummary,
      stress: fixtureStress,
      reportCards: fixtureReportCards,
      cemeteryEntries: [],
      freshness: {},
    });
    const usdc = world.ships[0];

    expect(usdc?.dominantChainId).toBe("solana");
    expect(usdc?.homeDockChainId).toBe("ethereum");
    expect(usdc?.dockChainId).toBe("ethereum");
    expect(usdc?.chainPresence?.map((presence) => presence.chainId)).toEqual(["solana", "ethereum", "tron"]);
    expect(usdc?.chainPresence?.reduce((sum, presence) => sum + presence.share, 0)).toBeCloseTo(1);
    expect(usdc?.dockVisits?.map((visit) => visit.chainId)).toEqual(["ethereum"]);
    expect(usdc?.dockVisits?.[0]?.weight).toBe(1);
  });

  it("suppresses only dock visits when there is no positive chain presence", () => {
    const world = buildPharosVilleWorld({
      stablecoins: {
        peggedAssets: [
          makeAsset({
            id: "usdc-circle",
            symbol: "USDC",
            chainCirculating: {
              Ethereum: {
                current: 0,
                circulatingPrevDay: 0,
                circulatingPrevWeek: 0,
                circulatingPrevMonth: 0,
              },
              Tron: {
                current: -100,
                circulatingPrevDay: -100,
                circulatingPrevWeek: -100,
                circulatingPrevMonth: -100,
              },
            },
          }),
        ],
      },
      chains: fixtureChains,
      stability: fixtureStability,
      pegSummary: {
        ...fixturePegSummary,
        coins: [makePegCoin({ id: "usdc-circle", symbol: "USDC", activeDepeg: true })],
      },
      stress: fixtureStress,
      reportCards: fixtureReportCards,
      cemeteryEntries: [],
      freshness: {},
    });
    const usdc = world.ships[0];

    expect(usdc?.chainPresence).toEqual([]);
    expect(usdc?.dockVisits).toEqual([]);
    expect(usdc?.dominantChainId).toBeNull();
    expect(usdc?.homeDockChainId).toBeNull();
    expect(usdc?.dockChainId).toBeNull();
    expect(usdc?.riskPlacement).toBe("storm-shelf");
    expect(usdc?.riskZone).toBe("storm");
    expect(["water", "deep-water"]).toContain(tileKindAt(usdc?.tile.x ?? -1, usdc?.tile.y ?? -1));
  });

  it("keeps active-depeg ships in the storm zone even with rendered dock visits", () => {
    const world = buildPharosVilleWorld({
      stablecoins: {
        peggedAssets: [
          makeAsset({
            id: "usdc-circle",
            symbol: "USDC",
            chainCirculating: {
              Ethereum: {
                current: 1_000_000_000,
                circulatingPrevDay: 1_000_000_000,
                circulatingPrevWeek: 1_000_000_000,
                circulatingPrevMonth: 1_000_000_000,
              },
            },
          }),
        ],
      },
      chains: fixtureChains,
      stability: fixtureStability,
      pegSummary: {
        ...fixturePegSummary,
        coins: [makePegCoin({ id: "usdc-circle", symbol: "USDC", activeDepeg: true })],
      },
      stress: fixtureStress,
      reportCards: fixtureReportCards,
      cemeteryEntries: [],
      freshness: {},
    });
    const usdc = world.ships[0];

    expect(usdc?.riskPlacement).toBe("storm-shelf");
    expect(usdc?.riskZone).toBe("storm");
    expect(usdc?.dockVisits?.map((visit) => visit.chainId)).toEqual(["ethereum"]);
    expect(usdc?.dockVisits?.[0]?.mooringTile).not.toEqual(usdc?.tile);
    expect(["water", "deep-water"]).toContain(tileKindAt(usdc?.dockVisits?.[0]?.mooringTile.x ?? -1, usdc?.dockVisits?.[0]?.mooringTile.y ?? -1));
  });

  it("keeps long-tail clusters on water tiles", () => {
    const assets = Array.from({ length: 84 }, (_, index) => makeAsset({
      id: index % 2 === 0 ? "usdc-circle" : "usdt-tether",
      symbol: index % 2 === 0 ? "USDC" : "USDT",
      circulating: { peggedUSD: 1_000_000 - index },
    })).map((asset, index) => ({
      ...asset,
      id: index % 2 === 0 ? "usdc-circle" : "usdt-tether",
    }));
    const world = buildPharosVilleWorld({
      stablecoins: { peggedAssets: assets },
      chains: fixtureChains,
      stability: fixtureStability,
      pegSummary: fixturePegSummary,
      stress: fixtureStress,
      reportCards: fixtureReportCards,
      cemeteryEntries: [],
      freshness: {},
    });

    expect(world.shipClusters.length).toBeGreaterThan(0);
    expect(world.shipClusters.every((cluster) => ["water", "deep-water"].includes(tileKindAt(cluster.tile.x, cluster.tile.y)))).toBe(true);
  });
});
