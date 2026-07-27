import { describe, expect, it } from "vitest";
import type { SafetyScoreV9CurrentCard } from "@shared/types/safety-score-v9-public";
import { makeReportCardsV9Response, makeV9Card } from "@/test/fixtures/safety-score-v9";
import {
  buildDataCoverageModel,
  describeDataCoverageHoldCauses,
} from "./data-coverage-view-model";

function withGaps(
  card: SafetyScoreV9CurrentCard,
  summaries: Array<{
    responsibility: "integration-missing" | "issuer-undisclosed" | "measured-adverse" | "method-unsupported" | "producer-failed";
    factCount: number;
    criticalFactCount: number;
    reasonCodes: string[];
  }>,
): SafetyScoreV9CurrentCard {
  const base = card.scoreTrace.evidenceResponsibility.summaries.map((summary) => {
    const override = summaries.find((entry) => entry.responsibility === summary.responsibility);
    return override ? { ...summary, ...override } : summary;
  }) as SafetyScoreV9CurrentCard["scoreTrace"]["evidenceResponsibility"]["summaries"];
  return {
    ...card,
    scoreTrace: {
      ...card.scoreTrace,
      evidenceResponsibility: {
        ...card.scoreTrace.evidenceResponsibility,
        totalFactCount: base.reduce((sum, summary) => sum + summary.factCount, 0),
        summaries: base,
      },
    },
  };
}

describe("buildDataCoverageModel", () => {
  it("returns null without a response", () => {
    expect(buildDataCoverageModel(null)).toBeNull();
    expect(buildDataCoverageModel(undefined)).toBeNull();
  });

  it("reconciles completeness, inputs, and open gaps across cards", () => {
    const response = makeReportCardsV9Response({
      cards: [
        withGaps(makeV9Card({ id: "aaa-one" }), [
          {
            responsibility: "issuer-undisclosed",
            factCount: 3,
            criticalFactCount: 1,
            reasonCodes: ["missing-reserve-composition"],
          },
        ]),
        withGaps(makeV9Card({ id: "bbb-two" }), [
          {
            responsibility: "issuer-undisclosed",
            factCount: 2,
            criticalFactCount: 0,
            reasonCodes: ["missing-reserve-composition"],
          },
          {
            responsibility: "producer-failed",
            factCount: 4,
            criticalFactCount: 0,
            reasonCodes: ["missing-runtime-route-evidence"],
          },
        ]),
      ],
    });

    const model = buildDataCoverageModel(response)!;

    expect(model.assetCount).toBe(2);
    expect(model.ratedCount).toBe(2);
    expect(model.notRatedCount).toBe(0);
    // Each fixture card contributes 1 backing + 6 exit route + 1 control component.
    expect(model.inputsByPillar).toEqual([
      { key: "backing", label: "Backing", count: 2 },
      { key: "exit", label: "Exit", count: 12 },
      { key: "control", label: "Econ. control", count: 2 },
    ]);
    expect(model.inputsEvaluated).toBe(16);
    expect(model.openGapCount).toBe(9);
    expect(model.criticalGapCount).toBe(1);
    expect(model.backingObservedCount).toBe(2);
    expect(model.backingKnownCount).toBe(2);
  });

  it("ranks gap owners by size and drops empty owners", () => {
    const response = makeReportCardsV9Response({
      cards: [
        withGaps(makeV9Card({ id: "aaa-one" }), [
          { responsibility: "issuer-undisclosed", factCount: 1, criticalFactCount: 0, reasonCodes: [] },
          { responsibility: "producer-failed", factCount: 5, criticalFactCount: 0, reasonCodes: [] },
        ]),
      ],
    });

    const model = buildDataCoverageModel(response)!;

    expect(model.gapOwners.map((owner) => owner.key)).toEqual([
      "producer-failed",
      "issuer-undisclosed",
    ]);
    expect(model.gapOwners[0]!.share).toBeCloseTo(5 / 6);
  });

  it("counts gap types by affected assets and labels them in plain English", () => {
    const response = makeReportCardsV9Response({
      cards: [
        withGaps(makeV9Card({ id: "aaa-one" }), [
          {
            responsibility: "issuer-undisclosed",
            factCount: 1,
            criticalFactCount: 0,
            reasonCodes: ["missing-reserve-composition", "missing-access-review"],
          },
        ]),
        withGaps(makeV9Card({ id: "bbb-two" }), [
          {
            responsibility: "issuer-undisclosed",
            factCount: 1,
            criticalFactCount: 0,
            reasonCodes: ["missing-reserve-composition"],
          },
        ]),
      ],
    });

    const model = buildDataCoverageModel(response)!;

    expect(model.gapTypes[0]).toEqual({
      code: "missing-reserve-composition",
      label: "Reserve composition not published",
      assetCount: 2,
    });
    expect(model.gapTypes[1]!.assetCount).toBe(1);
    expect(model.gapTypes.every((gap) => !gap.label.includes("-"))).toBe(true);
  });

  it("counts gaps carried by not-rated cards", () => {
    const notRated = withGaps(
      makeV9Card({
        id: "ccc-three",
        score: null,
        grade: "NR",
        qualityScore: null,
        pegMultiplier: null,
        pegAdjustedScore: null,
        nrReasons: [
          {
            code: "insufficient-evidence",
            message: "Not enough evidence",
            field: null,
            origin: "asset",
          },
        ],
      }),
      [
        {
          responsibility: "integration-missing",
          factCount: 7,
          criticalFactCount: 2,
          reasonCodes: ["insufficient-evidence"],
        },
      ],
    );
    const model = buildDataCoverageModel(
      makeReportCardsV9Response({ cards: [notRated] }),
    )!;

    expect(model.notRatedCount).toBe(1);
    expect(model.openGapCount).toBe(7);
    expect(model.criticalGapCount).toBe(2);
    // NR cards publish no component breakdowns.
    expect(model.inputsEvaluated).toBe(0);
  });

  it("reports no hold when the publication is current", () => {
    expect(buildDataCoverageModel(makeReportCardsV9Response())!.hold).toBeNull();
  });
});

describe("describeDataCoverageHoldCauses", () => {
  it("folds repeated producer failures into one asset-scoped sentence", () => {
    const causes = describeDataCoverageHoldCauses([
      {
        code: "producer-failed-downgrade",
        assetId: "msusd-metronome",
        source: "reason",
        reasonCode: "missing-runtime-route-evidence",
        path: "exit:missing-runtime-route-evidence",
        effect: "score-or-grade-downgrade",
      },
      {
        code: "producer-failed-downgrade",
        assetId: "msusd-metronome",
        source: "reason",
        reasonCode: "missing-same-notional-route",
        path: "exit:missing-same-notional-route",
        effect: "score-or-grade-downgrade",
      },
      {
        code: "producer-failed-nr",
        assetId: "cdxusd-cod3x",
        source: "reason",
        reasonCode: "missing-runtime-route-evidence",
        path: "exit:missing-runtime-route-evidence",
        effect: "not-rated",
      },
    ]);

    expect(causes).toHaveLength(1);
    expect(causes[0]).toContain("2 assets");
    expect(causes[0]).toContain("rely on a data feed that did not deliver");
    expect(causes[0]).not.toContain("missing-runtime-route-evidence");
    expect(causes[0]).not.toContain("exit:");
  });

  it("never echoes internal assessment detail", () => {
    const causes = describeDataCoverageHoldCauses([
      {
        code: "assessment-failed",
        detail: '[{"code":"custom","path":["candidate","lifecycle"]}]',
      },
    ]);

    expect(causes).toEqual(["The latest ratings update could not be verified."]);
    expect(causes.join(" ")).not.toContain("candidate");
    expect(causes.join(" ")).not.toContain("lifecycle");
  });

  it("describes input-health and coverage-floor holds without raw identifiers", () => {
    const causes = describeDataCoverageHoldCauses([
      { code: "dex-stale" },
      { code: "live-reserves-unavailable" },
      { code: "coverage-floor-failed", floorIds: ["floor-a", "floor-b"] },
    ]);

    expect(causes).toEqual([
      "DEX liquidity data is behind schedule.",
      "Live reserve data is unavailable.",
      "Coverage fell below the required floor for 2 checks.",
    ]);
    expect(causes.join(" ")).not.toContain("floor-a");
  });

  it("returns nothing for an empty reason set", () => {
    expect(describeDataCoverageHoldCauses([])).toEqual([]);
  });
});
