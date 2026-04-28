import { describe, expect, it } from "vitest";
import { fixtureChains, fixturePegSummary, fixtureReportCards, fixtureStablecoins, fixtureStability, fixtureStress, makeAsset, makeChain, makePegCoin } from "../__fixtures__/pharosville-world";
import { buildPharosVilleWorld } from "./pharosville-world";
import { buildMotionPlan, buildShipWaterRoute, lighthouseFireFlickerSpeed, MAX_ANIMATED_WORLD_ENTITIES, resolveShipMotionSample, sampleShipWaterPath, stableMotionPhase } from "./motion";
import { buildPharosVilleMap, tileKindAt } from "./world-layout";
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

  it("keeps animated entity count within the v0.1 budget", () => {
    const plan = buildMotionPlan(world, world.ships[0]?.detailId ?? null);

    expect(plan.animatedShipIds.size).toBeLessThanOrEqual(MAX_ANIMATED_WORLD_ENTITIES);
    expect(plan.effectShipIds.size).toBeLessThanOrEqual(MAX_ANIMATED_WORLD_ENTITIES);
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
      expect(route?.riskTile).toEqual(ship.tile);
      expect(route?.cycleSeconds).toBe(repeatedRoute?.cycleSeconds);
      expect(route?.phaseSeconds).toBe(repeatedRoute?.phaseSeconds);
      expect(route?.dockStopSchedule).toEqual(repeatedRoute?.dockStopSchedule);
      expect(route?.dockStops).toEqual(ship.dockVisits);
    }
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

    expect(multiRoute.cycleSeconds).toBeLessThan(singleRoute.cycleSeconds);
    expect(singleRoute.dockStopSchedule.slice(0, 1)).toHaveLength(1);
    expect(multiRoute.dockStopSchedule.slice(0, 3)).toHaveLength(3);
    expect(new Set(multiRoute.dockStopSchedule).size).toBeGreaterThan(new Set(singleRoute.dockStopSchedule).size);
  });

  it("returns the static risk tile for reduced-motion samples", () => {
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

        expect(tileKindForSample(sample.tile), `${route.zone} sample ${index}`).toMatch(/water/);
      }
    }
  });

  it("routes over water and deep-water tiles only", () => {
    const map = buildPharosVilleMap();
    const route = buildShipWaterRoute({ from: { x: 32, y: 36 }, to: { x: 18, y: 31 }, map });

    expect(route.points.length).toBeGreaterThan(1);
    for (const point of route.points) {
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

function distance(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
