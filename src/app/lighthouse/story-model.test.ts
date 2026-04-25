import { describe, expect, it } from "vitest";
import type { StressSignalsAllResponse } from "@shared/types/market";
import type { StabilityIndexCurrent } from "@shared/types/stability";
import type { LighthouseSceneModel } from "./view-model";
import { buildLighthouseStoryModel, buildStormModel } from "./story-model";

const SHIP = {
  id: "ethereum",
  name: "Ethereum",
  logoPath: "/logos/ethereum.svg",
  totalUsd: 70_000_000,
  sharePct: 70,
  change7dPct: 0.02,
  healthScore: 88,
  healthBand: "robust" as const,
  dominantSymbol: "USDT",
  dominantSharePct: 46,
  dominantCargoUsd: 32_200_000,
  stablecoinCount: 12,
  cargoCount: 4,
  pennantWidth: 52,
  draftLayers: 3 as const,
  hullWidth: 144,
  hullHeight: 42,
  mastHeight: 110,
  wakeDirection: 1 as const,
  wakeLength: 0.1,
  centerX: 220,
  deckY: 366,
  isSelected: true,
};

const SCENE: LighthouseSceneModel = {
  totalUsd: 100_000_000,
  chainCount: 1,
  visibleShipCount: 1,
  ships: [SHIP],
  tailFleet: null,
  selectedId: "ethereum",
  selectedShip: SHIP,
  fleetBand: "sun",
  watchScore: 72,
  watchBand: "STEADY",
  watchLabel: "STEADY 72.0",
  sceneSummary: "Pharos Lighthouse watching 1 chain harbor, largest Ethereum.",
  sceneSubtitle: "PSI STEADY 72 · clear watch",
  largestHarbor: "Ethereum",
  lighthouseX: 1184,
  lighthouseY: 170,
  waterlineY: 382,
};

const PSI: StabilityIndexCurrent = {
  score: 72,
  band: "STEADY",
  components: {
    severity: 18,
    breadth: 11,
    stressBreadth: 4,
    trend: 2,
  },
  computedAt: 1710000000,
  methodologyVersion: "v1",
  totalMcapUsd: 1_000_000_000,
  contributors: [],
};

const STRESS: StressSignalsAllResponse = {
  signals: {
    usdc: {
      score: 41,
      band: "WARNING",
      signals: {},
      computedAt: 1710000000,
      methodologyVersion: "v1",
    },
    usdt: {
      score: 63,
      band: "ALERT",
      signals: {},
      computedAt: 1710000000,
      methodologyVersion: "v1",
    },
    dai: {
      score: 82,
      band: "DANGER",
      signals: {},
      computedAt: 1710000000,
      methodologyVersion: "v1",
    },
  },
  updatedAt: 1710000100,
  oldestComputedAt: 1710000000,
  methodology: {
    version: "v1",
    versionLabel: "v1",
    currentVersion: "v1",
    currentVersionLabel: "v1",
    changelogPath: "/methodology/dews-changelog/",
    asOf: 1710000000,
    isCurrent: true,
  },
};

describe("buildLighthouseStoryModel", () => {
  it("orders chapters and resolves an available active chapter", () => {
    const story = buildLighthouseStoryModel({
      scene: SCENE,
      stabilityIndex: PSI,
      stressSignals: STRESS,
      activeChapterId: "lens",
    });

    expect(story.chapters.map((chapter) => chapter.id)).toEqual(["harbor", "lens", "storm", "ledger", "dawn"]);
    expect(story.activeChapterId).toBe("lens");
    expect(story.lens?.scoreLabel).toContain("STEADY");
    expect(story.ledger.selectedChainHref).toBe("/chains/ethereum/");
  });

  it("falls back to harbor and records unavailable reasons when optional data is missing", () => {
    const story = buildLighthouseStoryModel({
      scene: SCENE,
      stabilityIndex: null,
      stressSignals: null,
      activeChapterId: "storm",
    });

    expect(story.activeChapterId).toBe("harbor");
    expect(story.lens).toBeNull();
    expect(story.storm).toBeNull();
    expect(story.unavailableReasons).toContain("psi-unavailable");
    expect(story.unavailableReasons).toContain("stress-signals-unavailable");
  });

  it("aggregates DEWS pressure counts without assigning them to chains", () => {
    const storm = buildStormModel({ ...STRESS, malformedRows: 2 });

    expect(storm?.warning).toBe(1);
    expect(storm?.alert).toBe(1);
    expect(storm?.danger).toBe(1);
    expect(storm?.totalPressure).toBe(3);
    expect(storm?.malformedRows).toBe(2);
    expect(storm?.caveat).toContain("aggregate DEWS counts");
  });

  it("keeps numeric story fields finite", () => {
    const story = buildLighthouseStoryModel({
      scene: SCENE,
      stabilityIndex: { ...PSI, score: Number.NaN, components: { severity: Number.NaN, breadth: 8, trend: 2 } },
      stressSignals: STRESS,
      activeChapterId: "lens",
    });

    expect(Number.isFinite(story.lens?.lightReachPct)).toBe(true);
    expect(story.lens?.slats.every((slat) => Number.isFinite(slat.widthPct))).toBe(true);
  });
});
