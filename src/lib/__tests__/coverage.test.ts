import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types";
import {
  buildCoverageFeatureSummary,
  buildCoverageRow,
  COVERAGE_FEATURES,
  resolveDexCoverage,
  resolveFlowCoverage,
  resolvePriceCoverage,
  resolveReserveCoverage,
} from "@/lib/coverage";

function makeCoin(overrides?: Partial<StablecoinMeta>): StablecoinMeta {
  return {
    id: "test-usd",
    name: "Test USD",
    symbol: "TUSDX",
    flags: {
      backing: "rwa-backed",
      governance: "centralized",
      pegCurrency: "USD",
      yieldBearing: false,
      rwa: true,
      navToken: false,
    },
    ...overrides,
  };
}

describe("coverage helpers", () => {
  it("marks NAV tokens as price-only instead of depeg-tracked", () => {
    const status = resolvePriceCoverage(
      makeCoin({
        flags: {
          backing: "rwa-backed",
          governance: "centralized",
          pegCurrency: "USD",
          yieldBearing: true,
          rwa: true,
          navToken: true,
        },
      }),
      false,
    );

    expect(status.kind).toBe("price-only");
    expect(status.available).toBe(true);
  });

  it("maps DEX coverage classes into user-facing labels", () => {
    expect(resolveDexCoverage("primary").label).toBe("Primary");
    expect(resolveDexCoverage("fallback").label).toBe("Fallback");
    expect(resolveDexCoverage("unobserved").available).toBe(false);
  });

  it("marks live reserve sync separately from curated or estimated reserves", () => {
    expect(
      resolveReserveCoverage(
        makeCoin({
          liveReservesConfig: {
            adapter: "test",
            version: 1,
            semantics: "attestation-mix",
            inputs: {
              primary: { kind: "http-json", url: "https://example.com/reserves" },
            },
          },
        }),
      ).kind,
    ).toBe("live");

    expect(
      resolveReserveCoverage(
        makeCoin({
          reserves: [{ name: "Cash", pct: 100, risk: "very-low" }],
        }),
      ).kind,
    ).toBe("curated");

    expect(resolveReserveCoverage(makeCoin()).kind).toBe("estimated");
  });

  it("maps mint/burn coverage states into visible labels", () => {
    expect(resolveFlowCoverage("full").label).toBe("Full");
    expect(resolveFlowCoverage("partial-history").label).toBe("Partial");
    expect(resolveFlowCoverage("bootstrapping").kind).toBe("bootstrapping");
    expect(resolveFlowCoverage("bootstrapping").spokenLabel).toBe("Bootstrapping");
    expect(resolveFlowCoverage(null).available).toBe(false);
  });

  it("counts only available features when building rows", () => {
    const row = buildCoverageRow({
      coin: makeCoin({
        reserves: [{ name: "Cash", pct: 100, risk: "very-low" }],
      }),
      marketCapUsd: 1_000_000,
      hasPegCoverage: true,
      safetyScore: 82,
      dexCoverageClass: "primary",
      hasYieldCoverage: false,
      flowCoverageStatus: "partial-history",
      bluechipGrade: "A",
      hasDependencyCoverage: false,
    });

    expect(row.coverageCount).toBe(6);
    expect(row.advancedCoverageCount).toBe(5);
    expect(row.statuses.yield.available).toBe(false);
    expect(row.statuses.blacklist.available).toBe(false);
  });

  it("builds per-feature summaries with breakdown text and market-cap share", () => {
    const rows = [
      buildCoverageRow({
        coin: makeCoin({
          id: "one",
          symbol: "ONE",
          reserves: [{ name: "Cash", pct: 100, risk: "very-low" }],
        }),
        marketCapUsd: 800,
        hasPegCoverage: true,
        safetyScore: 82,
        dexCoverageClass: "primary",
        hasYieldCoverage: true,
        flowCoverageStatus: "full",
        bluechipGrade: "A",
        hasDependencyCoverage: true,
      }),
      buildCoverageRow({
        coin: makeCoin({
          id: "two",
          symbol: "TWO",
          flags: {
            backing: "rwa-backed",
            governance: "centralized",
            pegCurrency: "USD",
            yieldBearing: false,
            rwa: true,
            navToken: true,
          },
        }),
        marketCapUsd: 200,
        hasPegCoverage: false,
        safetyScore: null,
        dexCoverageClass: "unobserved",
        hasYieldCoverage: false,
        flowCoverageStatus: null,
        bluechipGrade: null,
        hasDependencyCoverage: false,
      }),
    ];

    const summary = buildCoverageFeatureSummary(
      COVERAGE_FEATURES.find((feature) => feature.key === "price")!,
      rows,
      1_000,
    );

    expect(summary.availableCount).toBe(2);
    expect(summary.coveragePct).toBe(100);
    expect(summary.mcapSharePct).toBe(100);
    expect(summary.breakdown).toBe("tracked 1 · price-only 1");
  });

  it("sets sourceCount and sourceNames on tracked price coverage when consensusSources provided", () => {
    const status = resolvePriceCoverage(makeCoin(), true, ["coingecko", "defillama", "pyth"], "high");

    expect(status.kind).toBe("tracked");
    expect(status.sourceCount).toBe(3);
    expect(status.sourceNames).toEqual(["coingecko", "defillama", "pyth"]);
    expect(status.priceConfidence).toBe("high");
  });

  it("sets sourceCount on tracked price coverage with empty sources", () => {
    const status = resolvePriceCoverage(makeCoin(), true, [], "single-source");

    expect(status.kind).toBe("tracked");
    expect(status.sourceCount).toBe(0);
    expect(status.sourceNames).toEqual([]);
    expect(status.priceConfidence).toBe("single-source");
  });

  it("does not set sourceCount when consensusSources omitted (backward compat)", () => {
    const status = resolvePriceCoverage(makeCoin(), true);

    expect(status.kind).toBe("tracked");
    expect(status.sourceCount).toBeUndefined();
    expect(status.sourceNames).toBeUndefined();
    expect(status.priceConfidence).toBeUndefined();
  });

  it("uses live reserve tracking as the headline metric for reserve summaries", () => {
    const rows = [
      buildCoverageRow({
        coin: makeCoin({
          id: "live",
          symbol: "LIVE",
          liveReservesConfig: {
            adapter: "test",
            version: 1,
            semantics: "attestation-mix",
            inputs: {
              primary: { kind: "http-json", url: "https://example.com/reserves" },
            },
          },
        }),
        marketCapUsd: 700,
        hasPegCoverage: true,
        safetyScore: 82,
        dexCoverageClass: "primary",
        hasYieldCoverage: false,
        flowCoverageStatus: null,
        bluechipGrade: null,
        hasDependencyCoverage: false,
      }),
      buildCoverageRow({
        coin: makeCoin({
          id: "curated",
          symbol: "CUR",
          reserves: [{ name: "Cash", pct: 100, risk: "very-low" }],
        }),
        marketCapUsd: 300,
        hasPegCoverage: true,
        safetyScore: 82,
        dexCoverageClass: "primary",
        hasYieldCoverage: false,
        flowCoverageStatus: null,
        bluechipGrade: null,
        hasDependencyCoverage: false,
      }),
    ];

    const summary = buildCoverageFeatureSummary(
      COVERAGE_FEATURES.find((feature) => feature.key === "reserves")!,
      rows,
      1_000,
    );

    expect(summary.countLabel).toBe("Live tracking");
    expect(summary.availableCount).toBe(1);
    expect(summary.coveragePct).toBe(50);
    expect(summary.mcapSharePct).toBe(70);
    expect(summary.coverageLabel).toBe("50% with live reserve tracking");
    expect(summary.shareLabel).toBe("Live reserve market-cap reach");
    expect(summary.breakdown).toBe("live 1 · curated 1 · estimated 0");
  });
});
