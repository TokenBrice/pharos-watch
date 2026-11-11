import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildYieldDetailModel,
  type YieldDetailModelMode,
  type YieldDetailRegistryStatus,
} from "@/components/yield-detail-section-model";
import { deriveYieldRowDisplay } from "@/lib/yield-row-display";
import { buildYieldPresentationContext } from "@/lib/yield-presentation-context";
import type { StablecoinStatus, YieldRanking, YieldRankingsResponse } from "@shared/types";
import { makeYieldDetailRanking, makeYieldDetailResponse } from "./yield-detail.test-support";
import { makeYieldViewModelRow, REGISTRY_WITH_EUR } from "./yield-test-support";

function makeRanking(overrides: Partial<YieldRanking> = {}): YieldRanking {
  return makeYieldDetailRanking({
    id: "model-coin",
    symbol: "MODEL",
    name: "Model Coin",
    ...overrides,
  });
}

function makeResponse(rankings: YieldRanking[] = []): YieldRankingsResponse {
  return makeYieldDetailResponse(rankings);
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
    { signals: ["aging", "data-stale"], warnings: [], single: null },
    { signals: ["aging", "yield-spike"], warnings: ["yield-spike"], single: "yield-spike" },
    { signals: ["yield-spike", "future-key"], warnings: ["yield-spike", "future-key"], single: null },
  ])("lists only investment warnings for $signals", ({ signals, warnings, single }) => {
    const ranking = makeRanking({ warningSignals: signals });
    const model = buildYieldDetailModel(makeResponse([ranking]), registryStatus("active", "full-page", true), []);
    if (model.status !== "ready") throw new Error("expected ready");
    expect(model.warningSignals).toEqual(warnings);
    expect(model.singleWarning).toBe(single);
    expect(model.ranking.warningSignals).toEqual(signals);
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

  it("preserves an unavailable median rather than inventing a zero reference", () => {
    const model = buildYieldDetailModel(
      { ...makeResponse([makeRanking()]), medianApy: null },
      registryStatus("active", "embedded", true),
      [],
    );
    expect(model.status).toBe("ready");
    if (model.status === "ready") expect(model.medianApy).toBeNull();
  });

  it("returns the shared PYS, source explorer, and benchmark projection", () => {
    const model = buildYieldDetailModel(
      makeResponse([
        makeRanking({
          benchmarkRate: undefined,
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

describe("display breakdown reference evidence", () => {
  beforeEach(() => vi.useFakeTimers({ now: Date.parse("2026-09-27T12:00:00Z") }));
  afterEach(() => vi.useRealTimers());

  it.each([
    { version: "8.44", fallback: true, expected: 4.3864 },
    { version: "8.44", fallback: false, expected: 8.672 },
  ])("matches API effective yield for $version with fallback=$fallback", ({ version, fallback, expected }) => {
    const ranking = makeYieldDetailRanking({
      id: "zchf-frankencoin", apy30d: 3.5, benchmarkKey: "CHF",
      benchmarkCurrency: "CHF", benchmarkRate: -0.0456,
      safetyScore: 80, yieldStability: 1,
    });
    const response = makeYieldDetailResponse([ranking]);
    response.riskFreeRate = 4.24;
    response.methodology = {
      version, versionLabel: `v${version}`, currentVersion: "8.44", currentVersionLabel: "v8.44",
      changelogPath: "/methodology/yield", asOf: Date.now() / 1000, isCurrent: version === "8.44",
    };
    response.benchmarks = {
      USD: { ...REGISTRY_WITH_EUR.USD, rate: 4.24, fetchedAt: Date.now() / 1000,
        recordDate: "2026-09-27", maxRecordAgeSec: 5 * 86400, isFallback: fallback },
    };
    const model = buildYieldDetailModel(response, {
      stablecoinId: ranking.id, lifecycle: "active", mode: "embedded", shouldHaveYieldData: false,
      inactiveReason: "",
    }, []);
    expect(model.status).toBe("ready");
    if (model.status !== "ready") throw new Error("Expected detail breakdown");
    expect(model.pysBreakdown.effectiveYield).toBeCloseTo(expected, 4);
    const board = deriveYieldRowDisplay(makeYieldViewModelRow(ranking), buildYieldPresentationContext({
      methodologyVersion: version,
      riskFreeRate: response.riskFreeRate,
      benchmarks: response.benchmarks,
      scalingFactor: response.scalingFactor,
    }));
    expect(board.breakdown.effectiveYield).toBeCloseTo(expected, 4);
  });
});
