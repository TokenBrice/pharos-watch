import { describe, expect, it } from "vitest";
import { createReportCardRawInputs } from "@shared/lib/report-card-raw-inputs";
import type { ReportCard, ReportCardGrade } from "@shared/types/report-cards";
import { compareReportCardPayloads, serializeReportCardDiff } from "../lib/report-card-diff";
import cohort from "./fixtures/report-card-diff/cohort.json";

function card(id: string, score: number | null, grade: ReportCardGrade): ReportCard {
  const dimension = { grade, score, detail: "fixture" };
  return {
    id,
    name: id,
    symbol: id.toUpperCase(),
    overallGrade: grade,
    overallScore: score,
    baseScore: score,
    dimensions: {
      pegStability: dimension,
      liquidity: dimension,
      resilience: dimension,
      decentralization: dimension,
      dependencyRisk: dimension,
    },
    ratedDimensions: score == null ? 0 : 5,
    rawInputs: createReportCardRawInputs(),
    isDefunct: false,
  };
}

function payload(cards = [card("anchor", 85, "A")], version = "8.13") {
  return {
    cards,
    methodology: {
      version,
      weights: { pegStability: 0, liquidity: 0.3, resilience: 0.2, decentralization: 0.15, dependencyRisk: 0.25 },
      pegMultiplierExponent: 0.4,
      thresholds: [],
    },
    dependencyGraph: { edges: [] },
    updatedAt: 1_700_000_000,
  };
}

const options = { generatedAt: "2026-07-12T12:00:00.000Z" };

describe("report-card deterministic diff", () => {
  it("produces a byte-stable no-op report", () => {
    const first = serializeReportCardDiff(compareReportCardPayloads(payload(), payload(), options));
    const second = serializeReportCardDiff(compareReportCardPayloads(payload(), payload(), options));
    expect(first).toBe(second);
    expect(JSON.parse(first).summary).toMatchObject({
      scoreChanges: 0,
      gradeChanges: 0,
      graphEdgesAdded: 0,
      graphEdgesRemoved: 0,
    });
  });

  it("reports grade crossings, NR transitions, asset changes, and dependency edges", () => {
    const before = payload([card("anchor", 85, "A"), card("removed", 70, "B"), card("nr-exit", null, "NR")]);
    const after = payload([card("anchor", 70, "B"), card("added", null, "NR"), card("nr-exit", 70, "B")]);
    before.dependencyGraph.edges.push({ from: "removed", to: "anchor", weight: 1, type: "wrapper" });
    after.dependencyGraph.edges.push({ from: "nr-exit", to: "anchor", weight: 0.5, type: "collateral" });

    const report = compareReportCardPayloads(before, after, options);
    expect(report.summary).toMatchObject({
      addedAssets: 1,
      removedAssets: 1,
      gradeChanges: 4,
      nrEntries: 1,
      nrExits: 1,
      graphEdgesAdded: 1,
      graphEdgesRemoved: 1,
    });
    expect(report.assetChanges.find((change) => change.id === "anchor")).toMatchObject({
      absoluteScoreChange: 15,
    });
  });

  it("distinguishes input and methodology changes", () => {
    const before = payload();
    const after = payload([card("anchor", 80, "A")], "8.14");
    after.cards[0].rawInputs.dependencies = [{ id: "upstream", weight: 1, type: "wrapper" }];

    expect(() => compareReportCardPayloads(before, after, options)).toThrow("Methodology mismatch");
    const report = compareReportCardPayloads(before, after, { ...options, allowMethodologyMismatch: true });
    expect(report.assetChanges[0].classification).toBe("mixed");
  });

  it("classifies a derived binding-ceiling change with identical inputs as methodology-only", () => {
    const before = payload();
    const changedCard = card("anchor", 80, "A");
    changedCard.dimensions.dependencyRisk = {
      grade: "A",
      score: 80,
      detail: "Ceiling: wrapper dependency ceiling (80)",
      detailItems: [{ label: "Ceiling", value: "wrapper dependency ceiling (80)" }],
    };
    const after = payload([changedCard], "8.15");

    const report = compareReportCardPayloads(before, after, {
      ...options,
      allowMethodologyMismatch: true,
    });

    expect(report.assetChanges[0]).toMatchObject({
      classification: "methodology",
      bindingSignalChanges: { dependencyCeiling: { before: null, after: "wrapper dependency ceiling (80)" } },
    });
  });

  it("rejects duplicate IDs and malformed or non-finite cards", () => {
    expect(() =>
      compareReportCardPayloads(payload([card("dup", 85, "A"), card("dup", 70, "B")]), payload(), options),
    ).toThrow("duplicate ID");
    expect(() =>
      compareReportCardPayloads(
        { ...payload(), cards: [{ ...card("bad", 85, "A"), overallScore: Number.NaN }] },
        payload(),
        options,
      ),
    ).toThrow("malformed");
    expect(() => compareReportCardPayloads({ cards: [] }, payload(), options)).toThrow("malformed");
  });

  it("covers the compact pre-v9 calibration cohort", () => {
    const before = payload(
      cohort.map((entry) => card(entry.id, entry.beforeScore, entry.beforeGrade as ReportCardGrade)),
    );
    const after = payload(cohort.map((entry) => card(entry.id, entry.afterScore, entry.afterGrade as ReportCardGrade)));
    const report = compareReportCardPayloads(before, after, options);

    expect(new Set(cohort.map((entry) => entry.kind))).toEqual(
      new Set([
        "mature-issuer",
        "wrapper",
        "cdp",
        "synthetic",
        "active-depeg",
        "unavailable-upstream",
        "missing-liquidity",
      ]),
    );
    expect(report.summary).toMatchObject({ gradeChanges: 6, nrEntries: 1, nrExits: 1 });
  });
});
