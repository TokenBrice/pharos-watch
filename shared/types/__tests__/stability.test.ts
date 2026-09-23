import { describe, expect, it } from "vitest";

import {
  PSI_CONDITION_BAND_VALUES,
  StabilityIndexResponseSchema,
  UsdsStatusResponseOutputSchema,
  UsdsStatusResponseSchema,
} from "../stability";

const METHODOLOGY_ENVELOPE = {
  version: "3.61",
  versionLabel: "v3.61",
  currentVersion: "3.61",
  currentVersionLabel: "v3.61",
  changelogPath: "/methodology/stability-index",
  asOf: 1_790_000_000,
  isCurrent: true,
};

function psiResponse(band: string) {
  return {
    current: {
      score: 82.4,
      band,
      components: { severity: 0.1, breadth: 0.2, trend: 0.3 },
      computedAt: 1_790_000_000,
      methodologyVersion: "3.61",
    },
    history: [{ date: 1_789_900_000, score: 80.1, band, methodologyVersion: "3.61" }],
    methodology: METHODOLOGY_ENVELOPE,
  };
}

describe("PSI condition band contract", () => {
  it.each([...PSI_CONDITION_BAND_VALUES])("accepts the published band %s", (band) => {
    expect(StabilityIndexResponseSchema.safeParse(psiResponse(band)).success).toBe(true);
  });

  it("rejects a band outside the closed vocabulary anywhere it is published", () => {
    const current = StabilityIndexResponseSchema.safeParse(psiResponse("WEIRD"));
    expect(current.success).toBe(false);
    if (!current.success) {
      expect(current.error.issues.map((issue) => issue.path)).toContainEqual(["current", "band"]);
    }

    const history = StabilityIndexResponseSchema.safeParse({
      ...psiResponse("BEDROCK"),
      history: [{ date: 1_789_900_000, score: 80.1, band: "WEIRD", methodologyVersion: "3.61" }],
    });
    expect(history.success).toBe(false);

    const rollingAverage = StabilityIndexResponseSchema.safeParse({
      ...psiResponse("BEDROCK"),
      current: { ...psiResponse("BEDROCK").current, avg24h: 81.2, avg24hBand: "WEIRD" },
    });
    expect(rollingAverage.success).toBe(false);
  });

  it("keeps the malformed-row count optional for the no-history response", () => {
    const withoutCount = StabilityIndexResponseSchema.parse(psiResponse("STEADY"));
    expect(withoutCount.malformedRows).toBeUndefined();

    expect(StabilityIndexResponseSchema.parse({ ...psiResponse("STEADY"), malformedRows: 2 }).malformedRows).toBe(2);
    expect(
      StabilityIndexResponseSchema.safeParse({ ...psiResponse("STEADY"), malformedRows: "2" }).success,
    ).toBe(false);
  });

  it("accepts the unpriced-open-depeg degradation fields and keeps them optional", () => {
    const degraded = StabilityIndexResponseSchema.safeParse({
      ...psiResponse("TREMOR"),
      current: {
        ...psiResponse("TREMOR").current,
        inputDegradation: {
          dewsUnavailable: false,
          dewsFailureReason: null,
          depegEventsUnavailable: false,
          depegEventsFailureReason: null,
          openDepegNoPrice: true,
          openDepegsWithoutPrice: 1,
        },
      },
    });
    expect(degraded.success).toBe(true);

    const legacyDegradation = StabilityIndexResponseSchema.safeParse({
      ...psiResponse("TREMOR"),
      current: {
        ...psiResponse("TREMOR").current,
        inputDegradation: {
          dewsUnavailable: true,
          dewsFailureReason: "stress_signals unavailable",
          depegEventsUnavailable: false,
          depegEventsFailureReason: null,
        },
      },
    });
    expect(legacyDegradation.success).toBe(true);

    expect(
      StabilityIndexResponseSchema.safeParse({
        ...psiResponse("TREMOR"),
        current: {
          ...psiResponse("TREMOR").current,
          inputDegradation: {
            dewsUnavailable: false,
            dewsFailureReason: null,
            depegEventsUnavailable: false,
            depegEventsFailureReason: null,
            openDepegNoPrice: true,
            openDepegsWithoutPrice: "2",
          },
        },
      }).success,
    ).toBe(false);
  });
});

describe("USDS status served shape", () => {
  it("canonicalizes the address and defaults an absent check time", () => {
    const parsed = UsdsStatusResponseSchema.parse({
      implementationAddress: `  ${"0xAa".concat("1".repeat(38))}  `,
      freezeCapabilityPresent: true,
    });

    expect(parsed).toEqual({
      implementationAddress: `0xaa${"1".repeat(38)}`,
      freezeCapabilityPresent: true,
      lastChecked: 0,
    });
    expect(UsdsStatusResponseOutputSchema.safeParse(parsed).success).toBe(true);
  });

  it("rejects a payload the route cannot serve", () => {
    expect(
      UsdsStatusResponseSchema.safeParse({ implementationAddress: "0xnothex", freezeCapabilityPresent: false }).success,
    ).toBe(false);
    expect(
      UsdsStatusResponseOutputSchema.safeParse({
        implementationAddress: "0xnothex",
        freezeCapabilityPresent: false,
        lastChecked: 0,
      }).success,
    ).toBe(false);
  });
});
