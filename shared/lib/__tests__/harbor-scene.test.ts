import { describe, expect, it } from "vitest";
import {
  buildHarborScene,
  harborHash,
  parseHarborHash,
  stepHarborBerth,
  CRAFT_MIN_USD,
  HARBOR_UNIT_USD,
  MAX_BAYS_PER_TIER,
  MAX_CRAFT,
  MAX_SHIPS,
  SHIP_MIN_USD,
  SLIVER_FLOOR,
  type HarborChainInput,
  type HarborSceneInput,
} from "../harbor-scene";
import { HARBOR_LIVE, scaleHarborInput as scale } from "./harbor-scene.test-support";

const LIVE = HARBOR_LIVE;

function chain(id: string, totalUsd: number, extra: Partial<HarborChainInput> = {}): HarborChainInput {
  return {
    id,
    name: id.toUpperCase(),
    logoPath: `/chains/${id}.png`,
    totalUsd,
    change7d: 0,
    change7dPct: 0,
    stablecoinCount: 1,
    topStablecoins: [{ id: "usdt-tether", symbol: "USDT", share: 1, supplyUsd: totalUsd }],
    dominanceShare: 0,
    healthScore: 70,
    healthBand: "healthy",
    unavailableSupplyObservationCount: 0,
    ...extra,
  };
}

function world(chains: HarborChainInput[], unattributedTotalUsd = 0): HarborSceneInput {
  const attributed = chains.reduce((sum, c) => sum + c.totalUsd, 0);
  return {
    chains,
    globalTotalUsd: attributed + unattributedTotalUsd,
    chainAttributedTotalUsd: attributed,
    unattributedTotalUsd,
    attributionDiscrepancyUsd: -unattributedTotalUsd,
    updatedAt: 1_791_786_619,
    _meta: { status: "fresh", dependencies: { reportCards: { status: "fresh" } } },
  };
}


const containerUsd = (containers: { length: number }[]) => containers.reduce((sum, c) => sum + c.length, 0) * HARBOR_UNIT_USD;

describe("buildHarborScene on the 2026-10-12 payload", () => {
  const scene = buildHarborScene(LIVE);

  it("conserves supply: containers sum to attributed + unattributed within $1", () => {
    expect(scene.conservation.ok).toBe(true);
    expect(Math.abs(scene.conservation.drawnUsd - (LIVE.chainAttributedTotalUsd + LIVE.unattributedTotalUsd))).toBeLessThanOrEqual(1);
  });

  it("splits ships, craft and the tail by threshold", () => {
    expect(scene.ships.every((v) => v.totalUsd >= SHIP_MIN_USD)).toBe(true);
    expect(scene.craft.every((v) => v.totalUsd >= CRAFT_MIN_USD && v.totalUsd < SHIP_MIN_USD)).toBe(true);
    expect(scene.ships.map((v) => v.id).slice(0, 3)).toEqual(["ethereum", "tron", "bsc"]);
    expect(scene.ships).toHaveLength(LIVE.chains.filter((c) => c.totalUsd >= SHIP_MIN_USD).length);
  });

  it("takes the tail count and sum from the full chain list (R7)", () => {
    const drawn = new Set([...scene.ships, ...scene.craft].map((v) => v.id));
    const rest = LIVE.chains.filter((c) => !drawn.has(c.id));
    expect(scene.tail?.memberIds).toHaveLength(rest.length);
    expect(scene.tail?.totalUsd).toBeCloseTo(rest.reduce((s, c) => s + c.totalUsd, 0), 3);
    expect(scene.tail?.label.startsWith(`+${rest.length} more chains · $`)).toBe(true);
    for (const id of rest.map((c) => c.id)) expect(scene.berthOf[id]).toBe("harbor-tail");
  });

  it("draws a linear unit: Ethereum/Polygon container ratio equals the supply ratio ±1 container", () => {
    const eth = scene.ships.find((v) => v.id === "ethereum")!;
    const pol = scene.ships.find((v) => v.id === "polygon")!;
    expect(Math.abs(eth.containers.length - eth.totalUsd / HARBOR_UNIT_USD)).toBeLessThan(1);
    expect(Math.abs(eth.hullUnits / pol.hullUnits - eth.totalUsd / pol.totalUsd)).toBeLessThan(eth.totalUsd / pol.totalUsd / pol.hullUnits + 1e-9);
  });

  it("splits a straddling container at the exact cargo boundary", () => {
    const eth = scene.ships.find((v) => v.id === "ethereum")!;
    const usdt = eth.chain.topStablecoins.find((row) => row.id === "usdt-tether")!.supplyUsd / HARBOR_UNIT_USD;
    const straddle = eth.containers[Math.floor(usdt)];
    expect(straddle.bands.map((b) => b.kind)).toEqual(["usdt", "usdc"]);
    expect(straddle.bands[0].to).toBeCloseTo(usdt - Math.floor(usdt), 9);
    for (const c of eth.containers) {
      const covered = c.bands.reduce((s, b) => s + (b.to - b.from), 0);
      expect(covered).toBeCloseTo(c.length, 9);
    }
    expect(eth.containers[0].stencil).toBe("T");
  });

  it("marks partial and unrated chains without inventing values", () => {
    const solana = scene.ships.find((v) => v.id === "solana")!;
    expect(solana.partialRows).toBe(1);
    expect(solana.accessibleName).toContain("partial: 1 rows unobserved");
    const stellar = scene.craft.find((v) => v.id === "stellar")!;
    expect(stellar.flag).toEqual({ kind: "unrated", reason: "Not rated: insufficient Chain Health coverage" });
    expect(stellar.accessibleName).toContain("Chain Health not rated");
  });

  it("carries the unattributed residual on its own barge", () => {
    expect(scene.unattributed?.totalUsd).toBe(LIVE.unattributedTotalUsd);
    expect(scene.unattributed?.containers.every((c) => c.bands.every((b) => b.kind === "unattributed"))).toBe(true);
    expect(scene.overAttributionRatio).toBeNull();
    expect(scene.vessels.at(-1)?.id).toBe("harbor-unattributed");
  });

  it("is deterministic under shuffled input", () => {
    const reversed = { ...LIVE, chains: LIVE.chains.slice().reverse() };
    expect(JSON.stringify(buildHarborScene(reversed))).toBe(JSON.stringify(scene));
  });
});

describe("buildHarborScene edge cases", () => {
  it("keeps the sliver floor out of exact lengths and labels", () => {
    const scene = buildHarborScene(world([chain("a", 3.01e9)]));
    const last = scene.ships[0].containers.at(-1)!;
    expect(last.length).toBeCloseTo(0.01, 9);
    expect(last.drawLength).toBe(SLIVER_FLOOR);
    expect(scene.ships[0].accessibleName).toContain("$3.01B");
    expect(scene.conservation.ok).toBe(true);
  });

  it("names the NR reason when report-card inputs are not fresh", () => {
    const input = world([chain("a", 2e9, { healthBand: null, healthScore: null })]);
    input._meta = { status: "degraded", dependencies: { reportCards: { status: "stale", reason: "report cards lagging" } } };
    const scene = buildHarborScene(input);
    expect(scene.ships[0].flag).toEqual({ kind: "unrated", reason: "Inputs unavailable: report cards lagging" });
    expect(scene.retained).toBe(true);
  });

  it("encodes wake linearly to ±10% with a break, and new supply as 'new'", () => {
    const scene = buildHarborScene(world([
      chain("up", 5e9, { change7dPct: 0.05 }),
      chain("big", 4e9, { change7dPct: -0.143 }),
      chain("flat", 3e9, { change7dPct: 0.004 }),
      chain("fresh", 2e9, { change7d: 2e9, change7dPct: null }),
      chain("gone", 1.5e9, { change7d: null, change7dPct: null }),
    ]));
    const wake = Object.fromEntries(scene.ships.map((v) => [v.id, v.wake]));
    expect(wake.up).toEqual({ kind: "wake", direction: "up", pct: 5, magnitude: 0.5, broken: false });
    expect(wake.big).toMatchObject({ kind: "wake", direction: "down", magnitude: 1, broken: true });
    expect(wake.flat).toEqual({ kind: "none", reason: "below-threshold" });
    expect(wake.fresh).toEqual({ kind: "new" });
    expect(wake.gone).toEqual({ kind: "none", reason: "unavailable" });
  });

  it("drops the unattributed barge and discloses over-attribution", () => {
    const input = world([chain("a", 5e9)]);
    input.globalTotalUsd = 4e9;
    input.attributionDiscrepancyUsd = 1e9;
    const scene = buildHarborScene(input);
    expect(scene.unattributed).toBeNull();
    expect(scene.overAttributionRatio).toBeCloseTo(0.25, 9);
    expect(scene.conservation.ok).toBe(true);
  });

  it("handles an empty response", () => {
    const scene = buildHarborScene(world([]));
    expect(scene.vessels).toEqual([]);
    expect(scene.conservation).toEqual({ ok: true, drawnUsd: 0, expectedUsd: 0 });
  });

  it("moves ships and craft beyond the caps to the tail barge", () => {
    const chains = [
      ...Array.from({ length: MAX_SHIPS + 3 }, (_, k) => chain(`s${String(k).padStart(2, "0")}`, 2e9 + k)),
      ...Array.from({ length: MAX_CRAFT + 5 }, (_, k) => chain(`c${String(k).padStart(2, "0")}`, 2e8 + k)),
    ];
    const scene = buildHarborScene(world(chains));
    expect(scene.ships).toHaveLength(MAX_SHIPS);
    expect(scene.craft).toHaveLength(MAX_CRAFT);
    expect(scene.tail?.memberIds).toHaveLength(8);
    expect(scene.conservation.ok).toBe(true);
  });

  it("stacks a second tier from the stern beyond $160B and conserves", () => {
    const scene = buildHarborScene(scale(LIVE, 4));
    const eth = scene.ships[0];
    expect(scene.tiered).toBe(true);
    expect(eth.bays).toBe(MAX_BAYS_PER_TIER);
    expect(eth.containers.filter((c) => c.tier === 1)[0].position).toBe(MAX_BAYS_PER_TIER * 10 - 1);
    expect(containerUsd(eth.containers)).toBeCloseTo(eth.totalUsd, 0);
    expect(scene.conservation.ok).toBe(true);
  });
});

describe("harbor deep links and keys", () => {
  const known = new Set(["ethereum", "tron"]);
  it("parses #chain-<id> only for known chains", () => {
    expect(parseHarborHash("#chain-tron", known)).toBe("tron");
    expect(parseHarborHash(harborHash("ethereum"), known)).toBe("ethereum");
    expect(parseHarborHash("#chain-nope", known)).toBeNull();
    expect(parseHarborHash("#tron", known)).toBeNull();
    expect(parseHarborHash("#chain-%E0%A4%A", known)).toBeNull();
  });

  it("steps berths in rank order and clamps at the ends", () => {
    const vessels = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(stepHarborBerth(vessels, "a", "ArrowDown")).toBe("b");
    expect(stepHarborBerth(vessels, "a", "ArrowUp")).toBe("a");
    expect(stepHarborBerth(vessels, "b", "End")).toBe("c");
    expect(stepHarborBerth(vessels, null, "ArrowDown")).toBe("a");
    expect(stepHarborBerth([], null, "Home")).toBeNull();
  });
});
