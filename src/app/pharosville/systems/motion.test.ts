import { describe, expect, it } from "vitest";
import { fixtureChains, fixturePegSummary, fixtureReportCards, fixtureStablecoins, fixtureStability, fixtureStress, makeAsset, makeChain, makePegCoin } from "../__fixtures__/pharosville-world";
import { buildPharosVilleWorld } from "./pharosville-world";
import { buildBaseMotionPlan, buildMotionPlan, buildShipWaterRoute, lighthouseFireFlickerSpeed, resolveShipMotionSample, sampleShipWaterPath, stableMotionPhase } from "./motion";
import { buildPharosVilleMap, isWaterTileKind, tileKindAt } from "./world-layout";
import type { PharosVilleMap, PharosVilleWorld } from "./world-types";

describe("motion", () => {
  const world = buildPharosVilleWorld({
    stablecoins: fixtureStablecoins,
    chains: fixtureChains,
    stability: fixtureStability,
    pegSummary: fixturePegSummary,
    stress: fixtureStress,
    reportCards: fixtureReportCards,
    cemeteryEntries: [],
    freshness: {},
  });

  it("animates every visible ship while keeping effect highlights focused", () => {
    const plan = buildMotionPlan(world, world.ships[0]?.detailId ?? null);

    expect(plan.animatedShipIds.size).toBe(world.ships.length);
    expect(world.ships.every((ship) => plan.animatedShipIds.has(ship.id))).toBe(true);
    expect(plan.effectShipIds.size).toBeLessThanOrEqual(plan.animatedShipIds.size);
    expect(plan.animatedShipIds.has(world.ships[0]!.id)).toBe(true);
    expect(plan.shipPhases.get(world.ships[0]!.id)).toBe(stableMotionPhase(world.ships[0]!.id));
  });

  it("builds deterministic routes for every visible ship", () => {
    const firstPlan = buildMotionPlan(world, null);
    const secondPlan = buildMotionPlan(world, null);

    expect(firstPlan.shipRoutes.size).toBe(world.ships.length);
    for (const ship of world.ships) {
      const route = firstPlan.shipRoutes.get(ship.id);
      const repeatedRoute = secondPlan.shipRoutes.get(ship.id);

      expect(route).toBeDefined();
      expect(route?.riskTile).toEqual(ship.riskTile);
      expect(route?.cycleSeconds).toBe(repeatedRoute?.cycleSeconds);
      expect(route?.phaseSeconds).toBe(repeatedRoute?.phaseSeconds);
      expect(route?.dockStopSchedule).toEqual(repeatedRoute?.dockStopSchedule);
      expect(route?.dockStops).toEqual(ship.dockVisits);
    }
  });

  it("reuses base route maps when only selection cue state changes", () => {
    const basePlan = buildBaseMotionPlan(world);
    const unselectedPlan = buildMotionPlan(world, null, basePlan);
    const selectedPlan = buildMotionPlan(world, world.ships[0]?.detailId ?? null, basePlan);

    expect(selectedPlan.shipRoutes).toBe(unselectedPlan.shipRoutes);
    expect(selectedPlan.shipPhases).toBe(unselectedPlan.shipPhases);
    expect(selectedPlan.animatedShipIds).toBe(unselectedPlan.animatedShipIds);
    expect(selectedPlan.moverShipIds).toBe(unselectedPlan.moverShipIds);
    expect(selectedPlan.effectShipIds.size).toBeGreaterThanOrEqual(unselectedPlan.effectShipIds.size);
  });

  it("shortens cycles and increases scheduled dock cadence with chain breadth", () => {
    const singleChainWorld = worldForShip({
      chainCirculating: chainCirculating(["Ethereum"]),
      chains: ["ethereum"],
    });
    const multiChainWorld = worldForShip({
      chainCirculating: chainCirculating(["Ethereum", "Tron", "Solana", "Arbitrum"]),
      chains: ["ethereum", "tron", "solana", "arbitrum"],
    });
    const singleRoute = onlyRoute(singleChainWorld);
    const multiRoute = onlyRoute(multiChainWorld);

    expect(singleRoute.cycleSeconds).toBeGreaterThanOrEqual(780);
    expect(multiRoute.cycleSeconds).toBeGreaterThanOrEqual(780);
    expect(multiRoute.cycleSeconds).toBeLessThan(singleRoute.cycleSeconds);
    expect(singleRoute.dockStopSchedule.slice(0, 1)).toHaveLength(1);
    expect(multiRoute.dockStopSchedule.slice(0, 3)).toHaveLength(3);
    expect(new Set(multiRoute.dockStopSchedule).size).toBeGreaterThan(new Set(singleRoute.dockStopSchedule).size);
  });

  it("returns the representative harbor tile for reduced-motion samples", () => {
    const ship = world.ships[0]!;
    const plan = buildMotionPlan(world, ship.detailId);
    const sample = resolveShipMotionSample({ plan, reducedMotion: true, ship, timeSeconds: 120 });

    expect(sample.tile).toEqual(ship.tile);
    expect(sample.state).toBe("risk-drift");
    expect(sample.wakeIntensity).toBe(0);
  });

  it("changes ship samples over time in normal motion", () => {
    const ship = world.ships[0]!;
    const plan = buildMotionPlan(world, ship.detailId);
    const route = plan.shipRoutes.get(ship.id)!;
    const first = resolveShipMotionSample({ plan, reducedMotion: false, ship, timeSeconds: 0 });
    const second = resolveShipMotionSample({ plan, reducedMotion: false, ship, timeSeconds: route.cycleSeconds / 2 });

    expect(second.tile).not.toEqual(first.tile);
  });

  it("keeps routed safe ships in transit for a visible share of the cycle", () => {
    const sampleWorld = worldForShip({
      chainCirculating: chainCirculating(["Ethereum", "Tron", "Solana"]),
      chains: ["ethereum", "tron", "solana"],
    });

    expect(stateCountsOverCycle(sampleWorld).transitSamples).toBeGreaterThanOrEqual(40);
  });

  it("routes dockless ships through open-water patrols instead of parking at the risk tile", () => {
    const sampleWorld = worldForShip({
      chainCirculating: {},
      chains: ["ethereum"],
    });
    const ship = sampleWorld.ships[0]!;
    const plan = buildMotionPlan(sampleWorld, ship.detailId);
    const route = plan.shipRoutes.get(ship.id)!;
    const samples = Array.from({ length: 80 }, (_, index) => resolveShipMotionSample({
      plan,
      reducedMotion: false,
      ship,
      timeSeconds: route.cycleSeconds * (index / 80) - route.phaseSeconds,
    }));

    expect(samples.some((sample) => sample.state === "sailing")).toBe(true);
    expect(Math.max(...samples.map((sample) => distance(sample.tile, route.riskTile)))).toBeGreaterThan(6);
    expect(samples.every((sample) => /water/.test(tileKindForSample(sample.tile)))).toBe(true);
  });

  it("keeps safe, muddy, and storm route samples on water tiles", () => {
    const worlds = [
      worldForShip({
        chainCirculating: chainCirculating(["Ethereum", "Tron"]),
        chains: ["ethereum", "tron"],
      }),
      worldForShip({
        chainCirculating: chainCirculating(["Ethereum", "Tron"]),
        chains: ["ethereum", "tron"],
        pegCoin: makePegCoin({ id: "usdc-circle", symbol: "USDC", currentDeviationBps: 100 }),
      }),
      worldForShip({
        chainCirculating: chainCirculating(["Ethereum", "Tron"]),
        chains: ["ethereum", "tron"],
        pegCoin: makePegCoin({ id: "usdc-circle", symbol: "USDC", activeDepeg: true }),
      }),
    ];

    for (const sampleWorld of worlds) {
      const ship = sampleWorld.ships[0]!;
      const plan = buildMotionPlan(sampleWorld, ship.detailId);
      const route = plan.shipRoutes.get(ship.id)!;

      expect(["safe", "muddy", "storm"]).toContain(route.zone);
      for (let index = 0; index < 40; index += 1) {
        const sample = resolveShipMotionSample({
          plan,
          reducedMotion: false,
          ship,
          timeSeconds: route.cycleSeconds * (index / 40) - route.phaseSeconds,
        });

        expect(inMapBounds(sampleWorld.map, sample.tile), `${route.zone} sample ${index} bounds`).toBe(true);
        expect(tileKindForSample(sample.tile), `${route.zone} sample ${index}`).toMatch(/water/);
      }
    }
  });

  it("routes over semantic water terrain only", () => {
    const map = buildPharosVilleMap();
    const route = buildShipWaterRoute({ from: { x: 52, y: 52 }, to: { x: 40, y: 44 }, map });

    expect(route.points.length).toBeGreaterThan(1);
    expect(terrainKindInMap(map, route.points[0]!)).toBe("storm-water");
    for (const point of route.points) {
      expect(inMapBounds(map, point)).toBe(true);
      expect(isWaterTileKind(terrainKindInMap(map, point) ?? "land"), `${point.x}.${point.y}`).toBe(true);
    }
  });

  it("uses semantic terrain when canonical tile kind is not water", () => {
    const map: PharosVilleMap = {
      height: 1,
      width: 3,
      waterRatio: 1,
      tiles: [
        { kind: "land", terrain: "storm-water", x: 0, y: 0 },
        { kind: "land", terrain: "warning-water", x: 1, y: 0 },
        { kind: "land", terrain: "harbor-water", x: 2, y: 0 },
      ],
    };
    const route = buildShipWaterRoute({ from: { x: 0, y: 0 }, to: { x: 2, y: 0 }, map });

    expect(route.points).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]);
    expect(route.points.every((point) => tileKindInMap(map, point) === "land")).toBe(true);
    expect(route.points.every((point) => isWaterTileKind(terrainKindInMap(map, point) ?? "land"))).toBe(true);
  });

  it("uses deterministic water-only detours for longer crossings", () => {
    const map = buildPharosVilleMap();
    const firstRoute = buildShipWaterRoute({ from: { x: 8, y: 16 }, to: { x: 55, y: 16 }, map });
    const secondRoute = buildShipWaterRoute({ from: { x: 8, y: 16 }, to: { x: 55, y: 16 }, map });

    expect(firstRoute.points).toEqual(secondRoute.points);
    expect(firstRoute.points.some((point) => pointLineDistance(point, firstRoute.from, firstRoute.to) > 2)).toBe(true);
    for (const point of firstRoute.points) {
      expect(inMapBounds(map, point)).toBe(true);
      expect(tileKindForSample(point)).toMatch(/water/);
    }
  });

  it("rotates weighted dock schedules across cycles instead of dropping later docks", () => {
    const sampleWorld = worldForShip({
      chainCirculating: chainCirculating(["Ethereum", "Tron", "Solana", "Arbitrum"]),
      chains: ["ethereum", "tron", "solana", "arbitrum"],
    });
    const ship = sampleWorld.ships[0]!;
    const plan = buildMotionPlan(sampleWorld, ship.detailId);
    const route = plan.shipRoutes.get(ship.id)!;
    const visitedDockIds = new Set<string>();

    for (let cycleIndex = 0; cycleIndex < 6; cycleIndex += 1) {
      for (let sampleIndex = 0; sampleIndex < 80; sampleIndex += 1) {
        const sample = resolveShipMotionSample({
          plan,
          reducedMotion: false,
          ship,
          timeSeconds: route.cycleSeconds * (cycleIndex + sampleIndex / 80) - route.phaseSeconds,
        });
        if (sample.state === "moored" && sample.currentDockId) {
          visitedDockIds.add(sample.currentDockId);
        }
      }
    }

    expect(visitedDockIds).toEqual(new Set(route.dockStops.map((stop) => stop.dockId)));
  });

  it("keeps disconnected fallback route samples on the available water tile", () => {
    const map: PharosVilleMap = {
      width: 5,
      height: 5,
      waterRatio: 2 / 25,
      tiles: Array.from({ length: 25 }, (_, index) => {
        const x = index % 5;
        const y = Math.floor(index / 5);
        return {
          x,
          y,
          kind: (x === 0 && y === 0) || (x === 4 && y === 4) ? "water" : "land",
        };
      }),
    };
    const route = buildShipWaterRoute({ from: { x: 0, y: 0 }, to: { x: 4, y: 4 }, map });

    expect(route.points).toEqual([{ x: 0, y: 0 }]);
    for (let index = 0; index <= 10; index += 1) {
      const sample = sampleShipWaterPath(route, index / 10);
      expect(tileKindInMap(map, sample.point)).toBe("water");
    }
  });

  it("keeps storm and fog ships near risk water more than docks", () => {
    const stormWorld = worldForShip({
      chainCirculating: chainCirculating(["Ethereum"]),
      chains: ["ethereum"],
      pegCoin: makePegCoin({ id: "usdc-circle", symbol: "USDC", activeDepeg: true }),
    });
    const fogWorld = worldForShip({
      chainCirculating: chainCirculating(["Ethereum"]),
      chains: ["ethereum"],
      freshness: { pegSummaryStale: true },
      pegCoin: makePegCoin({ id: "usdc-circle", symbol: "USDC", activeDepeg: true }),
    });

    expect(riskVsDockDwell(stormWorld).riskSamples).toBeGreaterThan(riskVsDockDwell(stormWorld).dockSamples);
    expect(riskVsDockDwell(fogWorld).riskSamples).toBeGreaterThan(riskVsDockDwell(fogWorld).dockSamples);
  });

  it("derives lighthouse fire flicker speed from PSI band and score", () => {
    expect(lighthouseFireFlickerSpeed("healthy", 100)).toBeGreaterThan(lighthouseFireFlickerSpeed("danger", 100));
    expect(lighthouseFireFlickerSpeed(null, null)).toBeGreaterThan(0);
  });

  it("uses deterministic per-entity phases", () => {
    expect(stableMotionPhase("usdt-tether")).toBe(stableMotionPhase("usdt-tether"));
    expect(stableMotionPhase("usdt-tether")).not.toBe(stableMotionPhase("usdc-circle"));
  });
});

function worldForShip(input: {
  chainCirculating: ReturnType<typeof chainCirculating>;
  chains: string[];
  freshness?: PharosVilleWorld["freshness"];
  pegCoin?: ReturnType<typeof makePegCoin>;
}): PharosVilleWorld {
  return buildPharosVilleWorld({
    stablecoins: {
      peggedAssets: [
        makeAsset({
          id: "usdc-circle",
          symbol: "USDC",
          chainCirculating: input.chainCirculating,
        }),
      ],
    },
    chains: {
      ...fixtureChains,
      chains: input.chains.map((chainId, index) => makeChain({
        id: chainId,
        name: chainId,
        totalUsd: 10_000_000_000 - index * 100_000_000,
      })),
    },
    stability: fixtureStability,
    pegSummary: {
      ...fixturePegSummary,
      coins: [input.pegCoin ?? makePegCoin({ id: "usdc-circle", symbol: "USDC" })],
    },
    stress: fixtureStress,
    reportCards: fixtureReportCards,
    cemeteryEntries: [],
    freshness: input.freshness ?? {},
  });
}

function chainCirculating(chainNames: string[]) {
  return Object.fromEntries(chainNames.map((chain, index) => [
    chain,
    {
      current: 1_000_000_000 / (index + 1),
      circulatingPrevDay: 1_000_000_000 / (index + 1),
      circulatingPrevWeek: 1_000_000_000 / (index + 1),
      circulatingPrevMonth: 1_000_000_000 / (index + 1),
    },
  ]));
}

function onlyRoute(sampleWorld: PharosVilleWorld) {
  const ship = sampleWorld.ships[0]!;
  return buildMotionPlan(sampleWorld, ship.detailId).shipRoutes.get(ship.id)!;
}

function tileKindForSample(tile: { x: number; y: number }) {
  return tileKindAt(Math.round(tile.x), Math.round(tile.y));
}

function tileKindInMap(map: PharosVilleMap, tile: { x: number; y: number }) {
  const x = Math.round(tile.x);
  const y = Math.round(tile.y);
  return map.tiles[y * map.width + x]?.kind;
}

function terrainKindInMap(map: PharosVilleMap, tile: { x: number; y: number }) {
  const x = Math.round(tile.x);
  const y = Math.round(tile.y);
  const tileEntry = map.tiles[y * map.width + x];
  return tileEntry?.terrain ?? tileEntry?.kind;
}

function inMapBounds(map: PharosVilleMap, tile: { x: number; y: number }) {
  const x = Math.round(tile.x);
  const y = Math.round(tile.y);
  return x >= 0 && y >= 0 && x < map.width && y < map.height;
}

function riskVsDockDwell(sampleWorld: PharosVilleWorld): { dockSamples: number; riskSamples: number } {
  const ship = sampleWorld.ships[0]!;
  const plan = buildMotionPlan(sampleWorld, ship.detailId);
  const route = plan.shipRoutes.get(ship.id)!;
  const dockTiles = ship.dockVisits.map((visit) => visit.mooringTile);
  let riskSamples = 0;
  let dockSamples = 0;

  for (let index = 0; index < 100; index += 1) {
    const sample = resolveShipMotionSample({
      plan,
      reducedMotion: false,
      ship,
      timeSeconds: route.cycleSeconds * (index / 100) - route.phaseSeconds,
    });
    if (distance(sample.tile, route.riskTile) <= 2) riskSamples += 1;
    if (dockTiles.some((tile) => distance(sample.tile, tile) <= 2)) dockSamples += 1;
  }

  return { dockSamples, riskSamples };
}

function stateCountsOverCycle(sampleWorld: PharosVilleWorld): { transitSamples: number } {
  const ship = sampleWorld.ships[0]!;
  const plan = buildMotionPlan(sampleWorld, ship.detailId);
  const route = plan.shipRoutes.get(ship.id)!;
  let transitSamples = 0;

  for (let index = 0; index < 100; index += 1) {
    const sample = resolveShipMotionSample({
      plan,
      reducedMotion: false,
      ship,
      timeSeconds: route.cycleSeconds * (index / 100) - route.phaseSeconds,
    });
    if (sample.state === "departing" || sample.state === "arriving") transitSamples += 1;
  }

  return { transitSamples };
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pointLineDistance(point: { x: number; y: number }, from: { x: number; y: number }, to: { x: number; y: number }) {
  const numerator = Math.abs((to.y - from.y) * point.x - (to.x - from.x) * point.y + to.x * from.y - to.y * from.x);
  const denominator = Math.hypot(to.y - from.y, to.x - from.x);
  return denominator === 0 ? 0 : numerator / denominator;
}
