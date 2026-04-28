import { describe, expect, it } from "vitest";
import { fixtureChains, fixturePegSummary, fixtureReportCards, fixtureStablecoins, fixtureStability, fixtureStress } from "../__fixtures__/pharosville-world";
import { buildPharosVilleWorld } from "./pharosville-world";
import { buildMotionPlan, lighthouseSweepSpeed, MAX_ANIMATED_WORLD_ENTITIES, stableMotionPhase } from "./motion";

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
    expect(plan.animatedShipIds.has(world.ships[0]!.id)).toBe(true);
    expect(plan.shipPhases.get(world.ships[0]!.id)).toBe(stableMotionPhase(world.ships[0]!.id));
  });

  it("derives lighthouse sweep speed from PSI band and score", () => {
    expect(lighthouseSweepSpeed("healthy", 100)).toBeGreaterThan(lighthouseSweepSpeed("danger", 100));
    expect(lighthouseSweepSpeed(null, null)).toBeGreaterThan(0);
  });

  it("uses deterministic per-entity phases", () => {
    expect(stableMotionPhase("usdt-tether")).toBe(stableMotionPhase("usdt-tether"));
    expect(stableMotionPhase("usdt-tether")).not.toBe(stableMotionPhase("usdc-circle"));
  });
});
