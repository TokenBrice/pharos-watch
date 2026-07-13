import { describe, expect, it } from "vitest";
import type { DexLiquidityMap } from "@shared/types/market";
import type { CompiledV9AssetInput } from "@shared/types/safety-score-v9";
import { HistoricalV9FixtureCorpusSchema } from "@shared/types/safety-score-v9";
import historicalFixtures from "@shared/data/safety-score-v9/historical-fixtures-v1.json";
import {
  assessHistoricalEvidenceIntegrity,
  applyCalibratedDexEligibility,
  buildManualInputAudit,
  evaluateP4CoverageBlockers,
  selectExactActiveReportCards,
  summarizeRouteObservationCoverage,
} from "../maintenance/generate-safety-score-v9-readiness";

describe("v9 readiness audit helpers", () => {
  it("reports mutable sources and unverified historical authoring as no-go evidence blockers", () => {
    const corpus = HistoricalV9FixtureCorpusSchema.parse(historicalFixtures);
    const integrity = assessHistoricalEvidenceIntegrity(corpus.fixtures);

    expect(integrity).toMatchObject({
      sourceCount: 26,
      sourceCaptureStatuses: { unarchived: 26 },
      blindingModes: { "retrospective-unverified": 26 },
      outcomeAccess: { "not-attested": 26 },
      chronologyValidation: "passed",
      immutabilityValidation: "blocked",
      blindingValidation: "blocked",
    });
    expect(integrity.blockers).toEqual([
      "26 historical sources are mutable and unarchived",
      "26 historical fixtures lack independently verified outcome blinding",
      "26 fact-freeze records lack an outcome-access attestation",
    ]);
  });

  it("reports every manual input with computed class and criticality", () => {
    const compiled = [
      {
        assetId: "asset-b",
        unresolved: [
          {
            code: "unsupported-same-notional-route",
            reason: "No exact adapter.",
            critical: true,
            path: "exitRouteObservations",
          },
        ],
        peg: { unresolved: [] },
        pillars: {
          backing: {
            unresolved: [
              {
                code: "material-reserve-slice-unstructured",
                reason: "Missing reserve fields.",
                critical: true,
              },
            ],
          },
          exit: { unresolved: [] },
          control: {
            unresolved: [
              {
                code: "correlated-exit-routes",
                reason: "Shared operator.",
                critical: false,
              },
            ],
          },
        },
      },
    ] as unknown as CompiledV9AssetInput[];

    const audit = buildManualInputAudit(compiled);
    expect(audit.total).toBe(3);
    expect(audit.byClass).toEqual({
      "missing-data": 1,
      "unresolved-methodology": 1,
      "unsupported-design": 1,
    });
    expect(audit.byCriticality).toEqual({ critical: 2, noncritical: 1 });
    expect(audit.items.map((item) => item.code)).toEqual([
      "material-reserve-slice-unstructured",
      "correlated-exit-routes",
      "unsupported-same-notional-route",
    ]);
  });

  it("enforces calibrated coverage floors even when coverage is nonzero", () => {
    expect(
      evaluateP4CoverageBlockers({
        dexEligibleAssets: 6,
        redemptionEligibleAssets: 31,
        minimumDexEligibleAssets: 45,
        minimumRedemptionEligibleAssets: 27,
      }),
    ).toEqual(["DEX same-notional coverage is 6 eligible assets; calibrated floor is 45"]);
    expect(
      evaluateP4CoverageBlockers({
        dexEligibleAssets: 45,
        redemptionEligibleAssets: 27,
        minimumDexEligibleAssets: 45,
        minimumRedemptionEligibleAssets: 27,
      }),
    ).toEqual([]);
  });

  it("counts route eligibility by asset rather than observation count", () => {
    const eligibleObservation = {
      routeId: "route-1",
      scoreEligible: true,
      executableUsd: 100,
    };
    const dexMap = {
      eligible: {
        exitRouteObservations: [eligibleObservation, { ...eligibleObservation, routeId: "route-2" }],
        exitRouteObservationCoverage: { status: "populated", retainedPoolCount: 2 },
      },
      unsupported: {
        exitRouteObservations: [],
        exitRouteObservationCoverage: { status: "unsupported", retainedPoolCount: 1 },
      },
      inactive: {
        exitRouteObservations: [eligibleObservation],
        exitRouteObservationCoverage: { status: "populated", retainedPoolCount: 1 },
      },
    } as unknown as DexLiquidityMap;

    expect(summarizeRouteObservationCoverage(dexMap, new Set(["eligible", "unsupported"]))).toMatchObject({
      assets: 2,
      retainedPoolAssets: 2,
      retainedPools: 3,
      observations: 2,
      scoreEligibleObservations: 2,
      dexEligibleAssets: 1,
      statuses: { populated: 1, unsupported: 1 },
    });
  });

  it("separates raw positive observations from calibrated DEX eligibility", () => {
    expect(
      applyCalibratedDexEligibility(
        { assets: 7, dexEligibleAssets: 7, scoreEligibleObservations: 18 },
        { eligibleAssets: 0, eligibleObservations: 0 },
      ),
    ).toEqual({
      assets: 7,
      rawPositiveObservationAssets: 7,
      rawScoreEligibleObservations: 18,
      dexEligibleAssets: 0,
      scoreEligibleObservations: 0,
    });
  });

  it("selects an exact active report-card ID set without admitting unexpected rows", () => {
    const cards = [
      { id: "active-a", isDefunct: false },
      { id: "active-b", isDefunct: false },
      { id: "retired", isDefunct: true },
    ];
    expect(selectExactActiveReportCards(cards, ["active-a", "active-b"])).toEqual(cards.slice(0, 2));

    expect(() =>
      selectExactActiveReportCards(
        [
          { id: "active-a", isDefunct: false },
          { id: "active-a", isDefunct: false },
          { id: "unexpected", isDefunct: false },
        ],
        ["active-a", "active-b"],
      ),
    ).toThrow(
      "duplicate report card IDs: active-a; missing report cards: active-b; unexpected report cards: unexpected",
    );
  });
});
