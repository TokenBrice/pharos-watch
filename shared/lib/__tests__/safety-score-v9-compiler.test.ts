import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { ReportCard } from "@shared/types/report-cards";
import {
  compileHistoricalFixtureToV9Input,
  compileReportCardSetToV9Inputs,
  compileReportCardToV9Input,
  computeConservativeTrackRecordMonths,
  resolveConservativeImplementationDate,
} from "../safety-score-v9-compiler";
import type { HistoricalV9Fixture } from "@shared/types/safety-score-v9";

const meta: StablecoinMeta = {
  id: "test-usd",
  name: "Test USD",
  symbol: "TUSD",
  flags: {
    backing: "crypto-backed",
    pegCurrency: "USD",
    governance: "decentralized",
    yieldBearing: false,
    rwa: false,
    navToken: false,
  },
  mechanismArchetype: "cdp",
  launchDate: "2020",
  collateralQuality: "native",
};

const card = {
  id: "test-usd",
  dimensions: {
    pegStability: { score: 95 },
    liquidity: { score: 75 },
    resilience: { score: 85 },
    decentralization: { score: 80 },
    dependencyRisk: { score: 90 },
  },
  rawInputs: { activeDepegBps: null, liquidityHasMeasuredEvidence: true, redemptionImmediateCapacityUsd: null },
} as ReportCard;

const options = {
  asOf: "2026-06-30T00:00:00.000Z",
  compiledAt: "2026-07-01T00:00:00.000Z",
  methodologyVersion: "8.16",
};

describe("production-to-v9 research compiler", () => {
  it("uses conservative lower bounds for fuzzy launch dates", () => {
    expect(resolveConservativeImplementationDate("2020")).toBe("2020-12-31");
    expect(resolveConservativeImplementationDate("2020-02")).toBe("2020-02-29");
    expect(resolveConservativeImplementationDate("2020-02-03")).toBe("2020-02-03");
    expect(computeConservativeTrackRecordMonths("2020-12-31", options.asOf)).toBe(65);
  });

  it("compiles evidence and signals without authored expectations or caps", () => {
    const compiled = compileReportCardToV9Input(meta, card, {
      ...options,
      metaById: new Map([[meta.id, meta]]),
    });
    expect(compiled.pillars.backing.score).toBe(87);
    expect(compiled.implementationLaunchDate).toBe("2020-12-31");
    expect(compiled).not.toHaveProperty("expected");
    expect(compiled).not.toHaveProperty("structuralCaps");
  });

  it("fails closed on all-set omissions and ID mismatches", () => {
    expect(() => compileReportCardSetToV9Inputs([meta], [], options)).toThrow("missing report cards");
    expect(() =>
      compileReportCardToV9Input(meta, { ...card, id: "wrong" }, { ...options, metaById: new Map() }),
    ).toThrow("ID mismatch");
  });

  it("compiles historical facts without reading the labeled outcome", () => {
    const fixture: HistoricalV9Fixture = {
      schemaVersion: 1,
      id: "outcome-blind",
      assetId: "historical-usd",
      asOf: "2022-01-01T00:00:00.000Z",
      factsVersion: 1,
      facts: {
        archetype: "cdp",
        implementationAgeMonths: 12,
        signals: ["documented collateral"],
        riskSignals: [
          {
            pillar: "backing",
            kind: "critical-dependency",
            severity: "moderate",
            reason: "One reviewed dependency.",
          },
        ],
        unresolvedCriticalFacts: [],
      },
      sources: [
        {
          title: "Point-in-time documentation",
          url: "https://example.com/2021-docs",
          publishedAt: "2021-12-01T00:00:00.000Z",
          supports: ["collateral"],
        },
      ],
      outcome: {
        classification: "adverse",
        categories: ["backing"],
        observedFrom: "2022-02-01T00:00:00.000Z",
        observedThrough: "2022-03-01T00:00:00.000Z",
        summary: "Adverse label unavailable to the compiler.",
      },
      provenance: {
        reviewer: "research",
        reviewedAt: "2026-07-01T00:00:00.000Z",
        rationale: "Outcome-blind regression fixture.",
      },
    };
    const resilient = {
      ...fixture,
      outcome: {
        ...fixture.outcome,
        classification: "resilient" as const,
        categories: ["survivor" as const],
        summary: "Different outcome label and summary.",
      },
    };

    expect(compileHistoricalFixtureToV9Input(resilient)).toEqual(compileHistoricalFixtureToV9Input(fixture));
  });
});
