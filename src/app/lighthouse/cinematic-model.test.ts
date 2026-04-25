import { describe, expect, it } from "vitest";
import type { ChainSummary, StablecoinData, StressSignalsAllResponse } from "@shared/types";
import type { StabilityIndexCurrent } from "@shared/types/stability";
import { buildLighthouseCinematicModel, LIGHTHOUSE_VISIBLE_HARBORS } from "./cinematic-model";

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

function makeStablecoin(overrides: Partial<StablecoinData> & Pick<StablecoinData, "id" | "name" | "symbol">): StablecoinData {
  return {
    id: overrides.id,
    name: overrides.name,
    symbol: overrides.symbol,
    geckoId: overrides.geckoId ?? null,
    pegType: overrides.pegType ?? "peggedEUR",
    pegMechanism: overrides.pegMechanism ?? "fiat-backed",
    price: overrides.price ?? 1,
    priceSource: overrides.priceSource ?? "test",
    priceConfidence: overrides.priceConfidence ?? null,
    priceUpdatedAt: overrides.priceUpdatedAt ?? null,
    priceObservedAt: overrides.priceObservedAt ?? null,
    priceObservedAtMode: overrides.priceObservedAtMode ?? null,
    priceSyncedAt: overrides.priceSyncedAt ?? null,
    consensusSources: overrides.consensusSources ?? [],
    agreeSources: overrides.agreeSources ?? [],
    supplySource: overrides.supplySource,
    circulating: overrides.circulating ?? { peggedEUR: 120_000_000 },
    circulatingPrevDay: overrides.circulatingPrevDay ?? {},
    circulatingPrevWeek: overrides.circulatingPrevWeek ?? {},
    circulatingPrevMonth: overrides.circulatingPrevMonth ?? {},
    chainCirculating: overrides.chainCirculating ?? {},
    chains: overrides.chains ?? ["ethereum"],
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

describe("buildLighthouseCinematicModel", () => {
  it("builds deterministic top harbor marks and default selection", () => {
    const chains = [
      makeChain({ id: "base", name: "Base", totalUsd: 100_000_000 }),
      makeChain({ id: "ethereum", name: "Ethereum", totalUsd: 500_000_000, healthBand: "robust" }),
      makeChain({ id: "tron", name: "Tron", totalUsd: 300_000_000, healthBand: "concentrated" }),
    ];

    const first = buildLighthouseCinematicModel({
      chains,
      totalUsd: 900_000_000,
      stabilityIndex: PSI,
      stressSignals: STRESS,
      stablecoins: [],
      selectedHarborId: null,
    });
    const second = buildLighthouseCinematicModel({
      chains,
      totalUsd: 900_000_000,
      stabilityIndex: PSI,
      stressSignals: STRESS,
      stablecoins: [],
      selectedHarborId: null,
    });

    expect(first.harbors.visible.map((harbor) => harbor.id)).toEqual(["ethereum", "tron", "base"]);
    expect(first.stage.selectedHarborId).toBe("ethereum");
    expect(first.stage.activeModuleId).toBe("harbors");
    expect(first.stage.modules.harbors.isActive).toBe(true);
    expect(first.stage.activeTarget).toEqual(first.harbors.visible[0]?.target);
    expect(first).toEqual(second);
  });

  it("caps the visible harbor set and builds an aggregate tail", () => {
    const chains = Array.from({ length: LIGHTHOUSE_VISIBLE_HARBORS + 3 }, (_, index) =>
      makeChain({
        id: `chain-${index}`,
        name: `Chain ${index}`,
        totalUsd: 100_000_000 - index * 1_000_000,
      }),
    );

    const model = buildLighthouseCinematicModel({
      chains,
      totalUsd: 1_000_000_000,
      stabilityIndex: PSI,
      stressSignals: null,
      stablecoins: [],
      selectedHarborId: "missing",
    });

    expect(model.harbors.visible).toHaveLength(LIGHTHOUSE_VISIBLE_HARBORS);
    expect(model.harbors.tail?.remainingCount).toBe(3);
    expect(model.harbors.tail?.lights.length).toBe(3);
    expect(model.stage.selectedHarborId).toBe("chain-0");
  });

  it("keeps numeric geometry finite with hostile input values", () => {
    const model = buildLighthouseCinematicModel({
      chains: [
        makeChain({
          id: "broken",
          name: "Broken",
          totalUsd: Number.NaN,
          change7dPct: Number.NaN,
          healthBand: null,
          dominantStablecoin: { id: "bad", symbol: "BAD", share: Number.NaN },
        }),
      ],
      totalUsd: Number.NaN,
      stabilityIndex: { ...PSI, score: 250, band: "UNKNOWN" },
      stressSignals: STRESS,
      stablecoins: [],
      selectedHarborId: null,
    });

    const harbor = model.harbors.visible[0];
    expect(harbor?.healthColorHex).toBe("#64748b");
    expect(model.lens.score).toBe(100);
    expect(model.lens.colorHex).toBe("#f8d77a");
    expect(JSON.stringify(model)).not.toMatch(/NaN|Infinity/);
  });

  it("maps DEWS data as aggregate radar marks and ignores malformed bands", () => {
    const model = buildLighthouseCinematicModel({
      chains: [makeChain({ id: "ethereum", name: "Ethereum", totalUsd: 500_000_000 })],
      totalUsd: 500_000_000,
      stabilityIndex: PSI,
      stressSignals: STRESS,
      stablecoins: [],
      selectedHarborId: null,
      mode: "radar",
    });

    expect(model.stage.mode).toBe("radar");
    expect(model.stage.activeModuleId).toBe("radar");
    expect(model.stage.activeTarget).toEqual(model.stage.modules.radar.target);
    expect(model.radar.highestBand).toBe("DANGER");
    expect(model.radar.bandCounts.DANGER).toBe(1);
    expect(model.radar.bandCounts.CALM).toBe(1);
    expect(model.radar.elevated.map((mark) => mark.id)).not.toContain("malformed");
  });

  it("builds an empty but renderable alt-peg projection", () => {
    const model = buildLighthouseCinematicModel({
      chains: [],
      totalUsd: 0,
      stabilityIndex: null,
      stressSignals: null,
      stablecoins: [],
      selectedHarborId: null,
      mode: "atlas",
    });

    expect(model.stage.mode).toBe("atlas");
    expect(model.stage.activeModuleId).toBe("atlas");
    expect(model.altPeg.visibleCoinCount).toBe(0);
    expect(model.altPeg.clusters).toEqual([]);
    expect(model.fallbackRows.find((row) => row.id === "alt-pegs")?.value).toBe("0 visible marks");
  });

  it("projects existing alt-peg data when supplied", () => {
    const model = buildLighthouseCinematicModel({
      chains: [makeChain({ id: "ethereum", name: "Ethereum", totalUsd: 500_000_000 })],
      totalUsd: 500_000_000,
      stabilityIndex: PSI,
      stressSignals: null,
      stablecoins: [
        makeStablecoin({
          id: "eurc-circle",
          name: "EURC",
          symbol: "EURC",
          circulating: { peggedEUR: 120_000_000 },
        }),
        makeStablecoin({
          id: "xaut-tether",
          name: "Tether Gold",
          symbol: "XAUT",
          pegType: "peggedVAR",
          circulating: { peggedVAR: 700_000_000 },
        }),
      ],
      selectedHarborId: null,
    });

    expect(model.altPeg.visibleCoinCount).toBeGreaterThan(0);
    expect(JSON.stringify(model.altPeg)).not.toMatch(/NaN|Infinity/);
  });
});
