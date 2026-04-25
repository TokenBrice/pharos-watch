import { describe, expect, it } from "vitest";
import type { ChainSummary, StressSignalsAllResponse } from "@shared/types";
import type { StabilityIndexCurrent } from "@shared/types/stability";
import {
  buildLighthouse2Model,
  LIGHTHOUSE_2_VISIBLE_ALT_PEGS,
  LIGHTHOUSE_2_VISIBLE_CHAINS,
  LIGHTHOUSE_2_VISIBLE_DEWS,
} from "./nautical-model";

function makeChain(overrides: Partial<ChainSummary> & Pick<ChainSummary, "id" | "name" | "totalUsd">): ChainSummary {
  return {
    id: overrides.id,
    name: overrides.name,
    logoPath: overrides.logoPath ?? `/logos/${overrides.id}.svg`,
    type: overrides.type ?? "evm",
    totalUsd: overrides.totalUsd,
    change24h: overrides.change24h ?? 0,
    change24hPct: overrides.change24hPct ?? 0,
    change7d: overrides.change7d ?? 0,
    change7dPct: overrides.change7dPct ?? 0,
    change30d: overrides.change30d ?? 0,
    change30dPct: overrides.change30dPct ?? 0,
    stablecoinCount: overrides.stablecoinCount ?? 1,
    dominantStablecoin: overrides.dominantStablecoin ?? { id: `${overrides.id}-dominant`, symbol: "USDX", share: 0.4 },
    topStablecoins: overrides.topStablecoins,
    dominanceShare: overrides.dominanceShare ?? 0.05,
    healthScore: "healthScore" in overrides ? (overrides.healthScore ?? null) : 70,
    healthBand: "healthBand" in overrides ? (overrides.healthBand ?? null) : "healthy",
    healthFactors: overrides.healthFactors ?? {
      concentration: 0.1,
      quality: 0.7,
      pegStability: 0.8,
      backingDiversity: 0.6,
      chainEnvironment: 0.7,
    },
  };
}

const PSI: StabilityIndexCurrent = {
  score: 84,
  band: "BEDROCK",
  components: {
    severity: 8,
    breadth: 4,
    stressBreadth: 2,
    trend: -1,
  },
  computedAt: 1710000000,
  methodologyVersion: "v1",
  totalMcapUsd: 1_000_000_000,
  contributors: [],
};

const STRESS: StressSignalsAllResponse = {
  updatedAt: 1710000000,
  oldestComputedAt: 1709999000,
  malformedRows: 1,
  methodology: {} as StressSignalsAllResponse["methodology"],
  signals: {
    "coin-watch": { score: 20, band: "WATCH", signals: {}, computedAt: 1710000000, methodologyVersion: "v1" },
    "coin-danger": { score: 92, band: "DANGER", signals: {}, computedAt: 1710000000, methodologyVersion: "v1" },
    "coin-calm": { score: 4, band: "CALM", signals: {}, computedAt: 1710000000, methodologyVersion: "v1" },
    malformed: { score: Number.NaN, band: "BROKEN", signals: {}, computedAt: 1710000000, methodologyVersion: "v1" },
  },
};

describe("buildLighthouse2Model", () => {
  it("builds deterministic capped expedition marks", () => {
    const chains = Array.from({ length: LIGHTHOUSE_2_VISIBLE_CHAINS + 2 }, (_, index) =>
      makeChain({ id: `chain-${index}`, name: `Chain ${index}`, totalUsd: 100_000_000 - index * 2_000_000 }),
    );
    const first = buildLighthouse2Model({
      chains,
      totalUsd: 900_000_000,
      stabilityIndex: PSI,
      stressSignals: STRESS,
      stablecoins: [],
    });
    const second = buildLighthouse2Model({
      chains,
      totalUsd: 900_000_000,
      stabilityIndex: PSI,
      stressSignals: STRESS,
      stablecoins: [],
    });

    expect(first).toEqual(second);
    expect(first.chains.vessels).toHaveLength(LIGHTHOUSE_2_VISIBLE_CHAINS);
    expect(first.chains.remainingCount).toBe(2);
    expect(first.dews.buoys.length).toBeLessThanOrEqual(LIGHTHOUSE_2_VISIBLE_DEWS);
    expect(first.altPegs.islands.length).toBeLessThanOrEqual(LIGHTHOUSE_2_VISIBLE_ALT_PEGS);
    expect(first.stage.modules.chains.isActive).toBe(true);
  });

  it("clamps hostile values and falls back to neutral renderable state", () => {
    const model = buildLighthouse2Model({
      chains: [
        makeChain({
          id: "broken",
          name: "Broken",
          totalUsd: Number.NaN,
          healthBand: null,
          dominantStablecoin: { id: "bad", symbol: "BAD", share: Number.NaN },
        }),
      ],
      totalUsd: Number.NaN,
      stabilityIndex: { ...PSI, score: 250, band: "UNKNOWN" },
      stressSignals: STRESS,
      stablecoins: [],
      activeModuleId: "psi",
    });

    expect(model.psi.score).toBe(100);
    expect(model.psi.needleAngleDeg).toBeCloseTo(58);
    expect(model.psi.colorHex).toBe("#d6a64b");
    expect(model.chains.vessels[0]?.colorHex).toBe("#64748b");
    expect(JSON.stringify(model)).not.toMatch(/NaN|Infinity/);
  });

  it("targets selected marks before module centers", () => {
    const base = buildLighthouse2Model({
      chains: [makeChain({ id: "ethereum", name: "Ethereum", totalUsd: 500_000_000 })],
      totalUsd: 500_000_000,
      stabilityIndex: PSI,
      stressSignals: STRESS,
      stablecoins: [],
      activeModuleId: "dews",
    });
    const targetId = base.dews.buoys[0]?.id;
    expect(targetId).toBeTruthy();
    const selected = buildLighthouse2Model({
      chains: [makeChain({ id: "ethereum", name: "Ethereum", totalUsd: 500_000_000 })],
      totalUsd: 500_000_000,
      stabilityIndex: PSI,
      stressSignals: STRESS,
      stablecoins: [],
      activeModuleId: "dews",
      selectedMarkId: targetId,
    });

    expect(selected.stage.activeTarget).toEqual({ x: selected.dews.buoys[0]?.x, y: selected.dews.buoys[0]?.y });
    expect(selected.dews.buoys[0]?.isSelected).toBe(true);
  });
});
