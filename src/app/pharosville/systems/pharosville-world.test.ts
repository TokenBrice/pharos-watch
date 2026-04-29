import { describe, expect, it } from "vitest";
import { CEMETERY_ENTRIES } from "@shared/lib/cemetery-merged";
import { ACTIVE_IDS } from "@shared/lib/stablecoins";
import { BLACKLIST_STABLECOINS, DEX_GLOBAL_KEY, type BlacklistSummaryResponse, type DexLiquidityData, type MintBurnFlowsResponse, type RedemptionBackstopsResponse, type ReportCardsResponse, type YieldRankingsResponse } from "@shared/types";
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
  makeReportCard,
} from "../__fixtures__/pharosville-world";
import { buildPharosVilleWorld, SHIP_WATER_ANCHORS } from "./pharosville-world";
import {
  CEMETERY_CENTER,
  CEMETERY_RADIUS,
  CIVIC_CORE_CENTER,
  CIVIC_CORE_RADIUS,
  DOCK_TILES,
  isWaterTileKind,
  terrainKindAt,
  tileKindAt,
} from "./world-layout";

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
    expect(world.map.waterRatio).toBeGreaterThanOrEqual(0.85);
    expect(world.map.waterRatio).toBeLessThanOrEqual(0.88);
    expect(world.lighthouse.unavailable).toBe(false);
    expect(world.docks).toHaveLength(2);
    expect(world.ships.map((ship) => ship.id)).toEqual(["usdt-tether", "usdc-circle"]);
    expect(world.ships.every((ship) => ["water", "deep-water"].includes(tileKindAt(ship.tile.x, ship.tile.y)))).toBe(true);
    expect(world.ships.every((ship) => ["water", "deep-water"].includes(tileKindAt(ship.riskTile.x, ship.riskTile.y)))).toBe(true);
    expect(new Set(world.ships.map((ship) => `${ship.tile.x}.${ship.tile.y}`)).size).toBe(world.ships.length);
    expect(world.ships.find((ship) => ship.id === "usdt-tether")?.logoSrc).toBe("/logos/1-usdt.svg");
    expect(world.detailIndex["ship.usdt-tether"]?.facts).toEqual(expect.arrayContaining([
      { label: "Ship class", value: "CeFi" },
      { label: "Size tier", value: "Flagship" },
    ]));
    expect(world.graves).toHaveLength(3);
    expect(world.graves[0]?.logoSrc).toBe("/logos/cemetery/nubits.png");
    expect(world.detailIndex["lighthouse"]).toBeDefined();
    expect(world.buildings).toHaveLength(4);
    expect(Object.fromEntries(world.buildings.map((building) => [building.buildingType, building.tile]))).toEqual({
      "mint-burn-foundry": { x: 28, y: 30 },
      "exit-route-gatehouse": { x: 33, y: 36 },
      "yield-orchard-moonwell": { x: 40, y: 31 },
      "dependency-loom-chainworks": { x: 34, y: 24 },
    });
    expect(world.buildings.every((building) => tileKindAt(building.tile.x, building.tile.y) === "land")).toBe(true);
    expect(world.buildings.every((building) => distance(building.tile, CIVIC_CORE_CENTER) <= CIVIC_CORE_RADIUS)).toBe(true);
    expect(world.buildings.every((building) => cemeteryValue(building.tile) > 1.08)).toBe(true);
    expect(world.buildings.every((building) => DOCK_TILES.every((dock) => distance(building.tile, dock) > 4))).toBe(true);
    expect(minPairDistance(world.buildings.map((building) => building.tile))).toBeGreaterThanOrEqual(7.75);
    expect(terrainKindAt(0, 0)).toBe("frozen-water");
    expect(world.detailIndex["building.mint-burn-foundry"]?.title).toBe("Royal Mint And Burn Foundry");
    expect(world.detailIndex["area.north-froze-pole"]?.title).toBe("North Froze Pole");
    expect(world.visualCues.length).toBeGreaterThan(0);
  });

  it("derives thematic building states from existing Pharos data payloads", () => {
    const reportCards = {
      ...fixtureReportCards,
      cards: [
        makeReportCard({ id: "usdc-circle", symbol: "USDC" }),
        makeReportCard({ id: "usdt-tether", symbol: "USDT" }),
        makeReportCard({ id: "pyusd-paypal", symbol: "PYUSD" }),
        makeReportCard({ id: "usdp-paxos", symbol: "USDP" }),
        makeReportCard({ id: "gusd-gemini", symbol: "GUSD" }),
        makeReportCard({ id: "tusd-trueusd", symbol: "TUSD" }),
      ],
      dependencyGraph: {
        edges: [
          { from: "usdc-circle", to: "usdt-tether", type: "collateral", weight: 0.4 },
          { from: "usdc-circle", to: "pyusd-paypal", type: "collateral", weight: 0.3 },
          { from: "usdc-circle", to: "usdp-paxos", type: "wrapper", weight: 0.2 },
          { from: "usdc-circle", to: "gusd-gemini", type: "mechanism", weight: 0.1 },
          { from: "usdc-circle", to: "tusd-trueusd", type: "mechanism", weight: 0.1 },
        ],
      },
    } as unknown as ReportCardsResponse;
    const world = buildPharosVilleWorld({
      stablecoins: fixtureStablecoins,
      chains: fixtureChains,
      stability: fixtureStability,
      pegSummary: fixturePegSummary,
      stress: fixtureStress,
      reportCards,
      mintBurnFlows: mintBurnFixture({ score: 44 }),
      blacklistSummary: blacklistSummaryFixture(),
      dexLiquidity: dexLiquidityFixture({ liquidityScore: 82 }),
      redemptionBackstops: redemptionFixture({ effectiveExitScore: 84 }),
      yieldRankings: yieldRankingsFixture(),
      cemeteryEntries: [],
      freshness: {},
    });
    const statuses = Object.fromEntries(world.buildings.map((building) => [building.buildingType, building.status]));

    expect(statuses).toMatchObject({
      "mint-burn-foundry": "minting",
      "exit-route-gatehouse": "deep-exit",
      "yield-orchard-moonwell": "broad-coverage",
      "dependency-loom-chainworks": "high-hub-concentration",
    });
    expect(world.areas.find((area) => area.id === "area.north-froze-pole")).toMatchObject({
      kind: "area",
      dataAreaType: "north-froze-pole",
      status: "recent-freeze",
    });
    expect(world.detailIndex["building.exit-route-gatehouse"]?.facts).toEqual(expect.arrayContaining([
      { label: "Caveat", value: "DEX telemetry and modeled redemption routes are not guarantees of executable exit capacity." },
    ]));
  });

  it("spreads safe ships across the northern calm anchorage", () => {
    const ids = Array.from(ACTIVE_IDS).slice(0, 36);
    const world = buildPharosVilleWorld({
      stablecoins: {
        peggedAssets: ids.map((id, index) => makeAsset({
          id,
          symbol: `S${index}`,
          circulating: { peggedUSD: 1_000_000_000 - index },
        })),
      },
      chains: fixtureChains,
      stability: fixtureStability,
      pegSummary: {
        ...fixturePegSummary,
        coins: ids.map((id, index) => makePegCoin({ id, symbol: `S${index}` })),
      },
      stress: { ...fixtureStress, signals: {} },
      reportCards: fixtureReportCards,
      cemeteryEntries: [],
      freshness: {},
    });
    const xs = world.ships.map((ship) => ship.riskTile.x);
    const ys = world.ships.map((ship) => ship.riskTile.y);

    expect(world.ships.length).toBeGreaterThan(24);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThanOrEqual(12);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThanOrEqual(10);
    expect(world.ships.every((ship) => terrainKindAt(ship.riskTile.x, ship.riskTile.y) === "calm-water")).toBe(true);
  });

  it("keeps every authored ship anchor on water after island layout changes", () => {
    for (const [placement, anchors] of Object.entries(SHIP_WATER_ANCHORS)) {
      for (const anchor of anchors) {
        expect(
          isWaterTileKind(terrainKindAt(anchor.x, anchor.y)),
          `${placement} anchor ${anchor.x}.${anchor.y} should remain water`,
        ).toBe(true);
      }
    }
  });

  it("anchors rendered ships at harbor moorings while preserving the risk tile", () => {
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
    expect(ethereumVisit?.mooringTile).toEqual(usdt?.tile);
    expect(ethereumVisit?.mooringTile).not.toEqual(usdt?.riskTile);
    expect(ethereumVisit?.mooringTile).toBeDefined();
    expect(["water", "deep-water"]).toContain(tileKindAt(ethereumVisit?.mooringTile.x ?? -1, ethereumVisit?.mooringTile.y ?? -1));
    expect(["water", "deep-water"]).toContain(tileKindAt(usdt?.riskTile.x ?? -1, usdt?.riskTile.y ?? -1));
    expect(repeatedUsdt?.dockVisits).toEqual(usdt?.dockVisits);
    expect(repeatedUsdt?.tile).toEqual(usdt?.tile);
    expect(repeatedUsdt?.riskTile).toEqual(usdt?.riskTile);
    expect(usdt?.riskPlacement).toBe("safe-harbor");
    expect(usdt?.riskZone).toBe("safe");
  });

  it("names DEWS water areas from live band counts and anchors ships to matching risk water", () => {
    const stress = {
      ...fixtureStress,
      signals: {
        ...bandSignals("ALERT", 3),
        ...bandSignals("WATCH", 58),
        ...bandSignals("CALM", 107),
        "usdc-circle": {
          score: 55,
          band: "ALERT",
          signals: {},
          computedAt: 1_700_000_000,
          methodologyVersion: "fixture",
        },
      },
    };
    const world = buildPharosVilleWorld({
      stablecoins: {
        peggedAssets: [
          makeAsset({ id: "usdc-circle", symbol: "USDC" }),
        ],
      },
      chains: fixtureChains,
      stability: fixtureStability,
      pegSummary: {
        ...fixturePegSummary,
        coins: [makePegCoin({ id: "usdc-circle", symbol: "USDC" })],
      },
      stress,
      reportCards: fixtureReportCards,
      cemeteryEntries: [],
      freshness: {},
    });
    const counts = Object.fromEntries(
      world.areas
        .filter((area) => area.band)
        .map((area) => [area.band, area.count]),
    );
    const alertArea = world.areas.find((area) => area.band === "ALERT");
    const usdc = world.ships[0];

    expect(counts).toMatchObject({
      DANGER: 0,
      WARNING: 0,
      ALERT: 4,
      WATCH: 58,
      CALM: 107,
    });
    expect(world.areas.find((area) => area.band === "CALM")?.label).toBe("Calm Anchorage");
    expect(alertArea?.label).toBe("Alert Channel");
    expect(alertArea?.riskPlacement).toBe("harbor-mouth-watch");
    expect(alertArea?.tile ? terrainKindAt(alertArea.tile.x, alertArea.tile.y) : null).toBe("alert-water");
    expect(world.areas.find((area) => area.band === "WARNING")?.tile).toEqual({ x: 37, y: 6 });
    expect(world.areas.find((area) => area.band === "DANGER")?.tile).toEqual({ x: 42, y: 0 });
    expect(world.areas.find((area) => area.id === "area.north-froze-pole")?.tile).toEqual({ x: 0, y: 0 });
    expect(terrainKindAt(0, 0)).toBe("frozen-water");
    expect(terrainKindAt(37, 6)).toBe("warning-water");
    expect(terrainKindAt(42, 0)).toBe("storm-water");
    expect(usdc?.riskPlacement).toBe("harbor-mouth-watch");
    expect(usdc?.riskZone).toBe("muddy");
  });

  it("maps warning and danger DEWS ships to escalating water terrain", () => {
    const world = buildPharosVilleWorld({
      stablecoins: fixtureStablecoins,
      chains: fixtureChains,
      stability: fixtureStability,
      pegSummary: fixturePegSummary,
      stress: {
        ...fixtureStress,
        signals: {
          "usdc-circle": {
            score: 76,
            band: "WARNING",
            signals: {},
            computedAt: 1_700_000_000,
            methodologyVersion: "fixture",
          },
          "usdt-tether": {
            score: 94,
            band: "DANGER",
            signals: {},
            computedAt: 1_700_000_000,
            methodologyVersion: "fixture",
          },
        },
      },
      reportCards: fixtureReportCards,
      cemeteryEntries: [],
      freshness: {},
    });
    const usdc = world.ships.find((ship) => ship.id === "usdc-circle");
    const usdt = world.ships.find((ship) => ship.id === "usdt-tether");

    expect(usdc?.riskPlacement).toBe("outer-rough-water");
    expect(usdc?.riskTile ? terrainKindAt(usdc.riskTile.x, usdc.riskTile.y) : null).toBe("warning-water");
    expect(usdt?.riskPlacement).toBe("storm-shelf");
    expect(usdt?.riskTile ? terrainKindAt(usdt.riskTile.x, usdt.riskTile.y) : null).toBe("storm-water");
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
    expect(usdc?.tile).toEqual(usdc?.riskTile);
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
    expect(usdc?.dockVisits?.[0]?.mooringTile).toEqual(usdc?.tile);
    expect(usdc?.dockVisits?.[0]?.mooringTile).not.toEqual(usdc?.riskTile);
    expect(["water", "deep-water"]).toContain(tileKindAt(usdc?.dockVisits?.[0]?.mooringTile.x ?? -1, usdc?.dockVisits?.[0]?.mooringTile.y ?? -1));
    expect(["water", "deep-water"]).toContain(tileKindAt(usdc?.riskTile.x ?? -1, usdc?.riskTile.y ?? -1));
  });

  it("keeps long-tail clusters on water tiles", () => {
    const assets = Array.from({ length: 132 }, (_, index) => makeAsset({
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

function cemeteryValue(tile: { x: number; y: number }) {
  return ((tile.x - CEMETERY_CENTER.x) / CEMETERY_RADIUS.x) ** 2
    + ((tile.y - CEMETERY_CENTER.y) / CEMETERY_RADIUS.y) ** 2;
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function minPairDistance(tiles: Array<{ x: number; y: number }>) {
  let minimum = Number.POSITIVE_INFINITY;
  for (let first = 0; first < tiles.length; first += 1) {
    for (let second = first + 1; second < tiles.length; second += 1) {
      minimum = Math.min(minimum, distance(tiles[first]!, tiles[second]!));
    }
  }
  return minimum;
}

function bandSignals(band: "ALERT" | "WATCH" | "CALM", count: number) {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [
    `${band.toLowerCase()}-${index}`,
    {
      score: band === "ALERT" ? 55 : band === "WATCH" ? 30 : 5,
      band,
      signals: {},
      computedAt: 1_700_000_000,
      methodologyVersion: "fixture",
    },
  ]));
}

function mintBurnFixture({ score }: { score: number }): MintBurnFlowsResponse {
  return {
    gauge: {
      score,
      band: "Mint pressure",
      intensitySemantics: "signed-v2",
      flightToQuality: false,
      flightIntensity: 0,
      trackedCoins: 2,
      trackedMcapUsd: 11_000_000_000,
    },
    coins: [
      {
        stablecoinId: "usdc-circle",
        symbol: "USDC",
        flowIntensity: score,
        pressureShiftScore: score,
        pressureShiftState: "steady",
        netFlowDirection24h: "mint",
        has24hActivity: true,
        baselineDailyNetUsd: null,
        baselineDailyAbsUsd: null,
        baselineDataDays: null,
        netFlow24hUsd: 80_000_000,
        mintVolume24hUsd: 100_000_000,
        burnVolume24hUsd: 20_000_000,
        mintCount24h: 3,
        burnCount24h: 1,
        netFlow7dUsd: 90_000_000,
        netFlow30dUsd: 120_000_000,
        netFlow90dUsd: 120_000_000,
        largestEvent24h: {
          direction: "mint",
          amountUsd: 60_000_000,
          txHash: "0xfixture",
          timestamp: 1_700_000_000,
        },
      },
    ],
    hourly: [{ hourTs: 1_700_000_000, mintVolumeUsd: 100_000_000, burnVolumeUsd: 20_000_000, netFlowUsd: 80_000_000 }],
    updatedAt: 1_700_000_000,
    scope: { chainIds: ["ethereum"], label: "Configured issuance-chain events" },
    sync: { lastSuccessfulSyncAt: 1_700_000_000, freshnessStatus: "fresh", warning: null, criticalLaneHealthy: true },
  } as unknown as MintBurnFlowsResponse;
}

function blacklistSummaryFixture(): BlacklistSummaryResponse {
  const zeroRecord = Object.fromEntries(BLACKLIST_STABLECOINS.map((symbol) => [symbol, 0]));
  return {
    stats: {
      usdcBlacklisted: 0,
      usdtBlacklisted: 0,
      goldBlacklisted: 0,
      frozenAddresses: 12,
      destroyedTotal: 0,
      activeAddressCount: 8,
      activeFrozenTotal: 15_000_000,
      activeAmountGapCount: 1,
      recentCount: 3,
      recentCount24h: 1,
      recoverableGapCount: 1,
      perCoinBlacklistCounts: zeroRecord,
      perCoinTotalEvents: zeroRecord,
      perCoinFrozenAddressCount: zeroRecord,
      perCoinFrozenTotal: { ...zeroRecord, USDC: 15_000_000 },
      perCoinDestroyedTotal: zeroRecord,
      perCoinQuarterlyEventTypes: Object.fromEntries(BLACKLIST_STABLECOINS.map((symbol) => [symbol, []])),
    },
    chart: [],
    chains: [{ id: "ethereum", name: "Ethereum" }],
    totalEvents: 12,
    methodology: {
      version: "fixture",
      versionLabel: "Fixture",
      currentVersion: "fixture",
      currentVersionLabel: "Fixture",
      changelogPath: "/methodology/",
      asOf: 1_700_000_000,
      isCurrent: true,
    },
  } as unknown as BlacklistSummaryResponse;
}

function dexLiquidityFixture({ liquidityScore }: { liquidityScore: number }) {
  const data = {
    totalTvlUsd: 120_000_000,
    totalVolume24hUsd: 40_000_000,
    totalVolume7dUsd: 210_000_000,
    liquidityScore,
    coverageConfidence: 0.9,
    concentrationHhi: 0.2,
    protocolTvl: { curve: 45_000_000, uniswap: 40_000_000, balancer: 35_000_000 },
    effectiveTvlUsd: 100_000_000,
  } as unknown as DexLiquidityData;
  return {
    [DEX_GLOBAL_KEY]: data,
    "usdc-circle": data,
  };
}

function redemptionFixture({ effectiveExitScore }: { effectiveExitScore: number }): RedemptionBackstopsResponse {
  const entry = {
    stablecoinId: "usdc-circle",
    score: effectiveExitScore,
    effectiveExitScore,
    routeFamily: "stablecoin-redeem",
    accessModel: "permissionless-onchain",
    settlementModel: "immediate",
    routeStatus: "open",
    capacityConfidence: "live-direct",
    immediateCapacityUsd: 75_000_000,
  };
  return {
    coins: {
      "usdc-circle": entry,
      "usdt-tether": { ...entry, stablecoinId: "usdt-tether" },
      "pyusd-paypal": { ...entry, stablecoinId: "pyusd-paypal" },
    },
    methodology: {
      version: "fixture",
      versionLabel: "Fixture",
      currentVersion: "fixture",
      currentVersionLabel: "Fixture",
      changelogPath: "/methodology/",
      asOf: 1_700_000_000,
      isCurrent: true,
      componentWeights: { access: 1, settlement: 1, executionCertainty: 1, capacity: 1, outputAssetQuality: 1, cost: 1 },
      effectiveExitModel: { model: "fixture", diversificationFactor: 1 },
      routeFamilyCaps: { queueRedeem: 1, offchainIssuer: 1 },
    },
    updatedAt: 1_700_000_000,
  } as unknown as RedemptionBackstopsResponse;
}

function yieldRankingsFixture(): YieldRankingsResponse {
  return {
    rankings: ["a", "b", "c", "d"].map((suffix, index) => ({
      id: `yield-${suffix}`,
      symbol: `Y${index}`,
      name: `Yield ${suffix}`,
      currentApy: 4 + index,
      apy7d: 4 + index,
      apy30d: 4 + index,
      yieldSource: `Source ${suffix}`,
      yieldType: "lending",
      dataSource: "fixture",
      sourceTvlUsd: 1_000_000,
      safetyScore: 80,
      safetyGrade: "A",
      warningSignals: [],
      altSources: [],
      provenance: {
        sourceKey: `source-${suffix}`,
        sourceObservedAt: 1_700_000_000,
        sourceAgeSeconds: 30,
        confidenceTier: "deterministic",
        selectionMethod: "confidence-weighted",
        selectionReason: "fixture",
        sourceSwitch: false,
        previousBestSourceKey: null,
        usedLegacyHistory: false,
        usedDefaultSafety: false,
        benchmarkRecordDate: null,
        benchmarkIsFallback: false,
        benchmarkFallbackMode: null,
        anomalies: [],
      },
    })),
    riskFreeRate: 3,
    scalingFactor: 1,
    medianApy: 4.5,
    updatedAt: 1_700_000_000,
    provenance: {
      selectionMethod: "confidence-weighted",
      benchmark: { rate: 3, recordDate: null, fetchedAt: 1_700_000_000, ageSeconds: 30, source: "fixture", isFallback: false, fallbackMode: null, label: "Fixture benchmark" },
      dlPools: { mode: "dex-cache", updatedAt: 1_700_000_000, ageSeconds: 30, poolCount: 4, fallbackMode: null },
      safetySnapshot: { kind: "ok", coverageRatio: 1, coveredCount: 4, trackedCount: 4, reason: null },
    },
  } as unknown as YieldRankingsResponse;
}
