import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types";
import {
  buildCoverageRow,
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
});
