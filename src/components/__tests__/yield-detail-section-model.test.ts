import { describe, expect, it } from "vitest";
import {
  buildYieldDetailModel,
  type YieldDetailModelMode,
  type YieldDetailRegistryStatus,
} from "@/components/yield-detail-section-model";
import {
  makeAltYieldSource,
  makeYieldProvenance,
  makeYieldRanking,
} from "@shared/test-utils/yield-ranking-fixtures";
import type { StablecoinStatus, YieldRanking, YieldRankingsResponse } from "@shared/types";

function makeRanking(overrides: Partial<YieldRanking> = {}): YieldRanking {
  return makeYieldRanking({
    id: "model-coin",
    symbol: "MODEL",
    name: "Model Coin",
    yieldSource: "Primary Source",
    yieldSourceUrl: "https://example.com/primary",
    altSources: [
      makeAltYieldSource({
        sourceKey: "alt-source",
        yieldSource: "Alt Source",
        yieldSourceUrl: "https://example.com/alt",
      }),
    ],
    provenance: makeYieldProvenance({ sourceKey: "primary-source", confidenceTier: "curated" }),
    ...overrides,
  });
}

function makeResponse(rankings: YieldRanking[] = []): YieldRankingsResponse {
  return {
    rankings,
    riskFreeRate: 0.031,
    scalingFactor: 8,
    medianApy: 0.04,
    updatedAt: 1_710_500_000,
    provenance: null,
  };
}

function registryStatus(
  lifecycle: StablecoinStatus,
  mode: YieldDetailModelMode,
  shouldHaveYieldData: boolean,
): YieldDetailRegistryStatus {
  return {
    stablecoinId: "model-coin",
    lifecycle,
    mode,
    shouldHaveYieldData,
    inactiveReason: "Curated inactive reason.",
  };
}

describe("buildYieldDetailModel", () => {
  it.each<{
    name: string;
    lifecycle: StablecoinStatus;
    mode: YieldDetailModelMode;
    yieldBearing: boolean;
    rankings: YieldRanking[];
    expectedStatus: ReturnType<typeof buildYieldDetailModel>["status"];
  }>([
    {
      name: "embedded non-yield asset without a ranking stays hidden",
      lifecycle: "active",
      mode: "embedded",
      yieldBearing: false,
      rankings: [],
      expectedStatus: "hidden",
    },
    {
      name: "embedded yield-bearing asset without a ranking explains unavailability",
      lifecycle: "active",
      mode: "embedded",
      yieldBearing: true,
      rankings: [],
      expectedStatus: "unavailable",
    },
    {
      name: "embedded non-yield asset with a published opportunity renders",
      lifecycle: "active",
      mode: "embedded",
      yieldBearing: false,
      rankings: [makeRanking()],
      expectedStatus: "ready",
    },
    {
      name: "full page explains an active non-yield asset without a ranking",
      lifecycle: "active",
      mode: "full-page",
      yieldBearing: false,
      rankings: [],
      expectedStatus: "unavailable",
    },
    {
      name: "full page prioritizes pre-launch lifecycle over a retained ranking",
      lifecycle: "pre-launch",
      mode: "full-page",
      yieldBearing: true,
      rankings: [makeRanking()],
      expectedStatus: "pre-launch",
    },
    {
      name: "full page prioritizes inactive lifecycle over a retained ranking",
      lifecycle: "quarantined",
      mode: "full-page",
      yieldBearing: true,
      rankings: [makeRanking()],
      expectedStatus: "inactive",
    },
    {
      name: "full page explains a frozen asset when its ranking is absent",
      lifecycle: "frozen",
      mode: "full-page",
      yieldBearing: true,
      rankings: [],
      expectedStatus: "frozen",
    },
    {
      name: "full page preserves a frozen asset's retained ranking",
      lifecycle: "frozen",
      mode: "full-page",
      yieldBearing: true,
      rankings: [makeRanking()],
      expectedStatus: "ready",
    },
  ])("$name", ({ lifecycle, mode, yieldBearing, rankings, expectedStatus }) => {
    const model = buildYieldDetailModel(
      makeResponse(rankings),
      registryStatus(lifecycle, mode, yieldBearing),
      [],
    );

    expect(model.status).toBe(expectedStatus);
  });

  it.each([
    { requested: [], expected: [] },
    { requested: ["alt-source"], expected: ["alt-source"] },
    { requested: ["stale-source", "primary-source"], expected: ["primary-source"] },
    { requested: ["stale-source"], expected: [] },
  ])("validates requested source keys: $requested", ({ requested, expected }) => {
    const model = buildYieldDetailModel(
      makeResponse([makeRanking()]),
      registryStatus("active", "full-page", true),
      requested,
    );

    expect(model.status).toBe("ready");
    if (model.status !== "ready") return;
    expect(model.validatedSourceKeys).toEqual(expected);
    expect(model.externalSourceKeys).toEqual(expected.length > 0 ? expected : undefined);
  });

  it("returns the shared PYS, source explorer, and benchmark projection", () => {
    const model = buildYieldDetailModel(
      makeResponse([
        makeRanking({
          benchmarkRate: null,
          benchmarkSelectionMode: "fallback-usd",
          benchmarkIsFallback: true,
        }),
      ]),
      registryStatus("active", "full-page", true),
      ["alt-source"],
    );

    expect(model.status).toBe("ready");
    if (model.status !== "ready") return;
    expect(model.benchmarkRate).toBe(0.031);
    expect(model.benchmarkIsFallback).toBe(true);
    expect(model.medianApy).toBe(0.04);
    expect(model.pysBreakdown.scalingFactor).toBe(8);
    expect(model.sourceExplorer.historySources.map((source) => source.sourceKey)).toEqual([
      "primary-source",
      "alt-source",
    ]);
  });
});
