import { describe, expect, it } from "vitest";
import { buildV9RadarDataset } from "@/components/radar-chart-v9";
import { makeReportCardsV9Response, makeV9Card, makeV9Pillars } from "@/test/fixtures/safety-score-v9";

describe("V9 radar cohorts", () => {
  it("builds exactly three pillars and a same-identity cohort median", () => {
    const response = makeReportCardsV9Response();
    const series = [
      makeV9Card({ id: "asset-a", pillars: makeV9Pillars({ backing: 90, exit: 10, control: 60 }) }),
      makeV9Card({ id: "asset-b", pillars: makeV9Pillars({ backing: 20, exit: 80, control: 30 }) }),
      makeV9Card({ id: "asset-c", pillars: makeV9Pillars({ backing: 50, exit: 40, control: 90 }) }),
    ].map((card) => ({ card, identity: response.safetyScoreIdentity, color: "#123456" }));
    const result = buildV9RadarDataset(series, series);
    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    expect(result.value.rows.map((row) => row.pillar)).toEqual(["Backing", "Exit", "Control"]);
    expect(result.value.cohortMedians).toEqual({ backing: 50, exit: 40, control: 60 });
    expect(result.value.rows).toEqual([
      { pillar: "Backing", fullMark: 100, "asset-a": 90, "asset-b": 20, "asset-c": 50, __cohortMedian: 50 },
      { pillar: "Exit", fullMark: 100, "asset-a": 10, "asset-b": 80, "asset-c": 40, __cohortMedian: 40 },
      { pillar: "Control", fullMark: 100, "asset-a": 60, "asset-b": 30, "asset-c": 90, __cohortMedian: 60 },
    ]);
    expect(buildV9RadarDataset(series, series.slice(0, 2))).toMatchObject({
      status: "available", value: { cohortMedians: null },
    });
  });

  it("rejects mixed models and policy/publication identities", () => {
    const response = makeReportCardsV9Response();
    const card = makeV9Card();
    const v8Identity = {
      model: "v8" as const,
      schemaVersion: 1 as const,
      methodologyVersion: "v8.17",
      evaluationBuildDigest: "b".repeat(64),
      baseInputGenerationId: `report-cards-input:v1:${"c".repeat(64)}`,
      publicationGenerationId: "v8-publication",
    };
    expect(buildV9RadarDataset([
      { card, identity: response.safetyScoreIdentity, color: "#123456" },
      { card: { ...card, id: "asset-b" }, identity: v8Identity, color: "#654321" },
    ])).toEqual({ status: "unavailable", reason: "identity-mismatch" });
    expect(buildV9RadarDataset([
      { card, identity: response.safetyScoreIdentity, color: "#123456" },
      {
        card: { ...card, id: "asset-b" },
        identity: { ...response.safetyScoreIdentity, policyId: "other-policy" },
        color: "#654321",
      },
    ])).toEqual({ status: "unavailable", reason: "identity-mismatch" });
  });

  it("rejects null displayed pillars and suppresses incomplete cohort medians", () => {
    const identity = makeReportCardsV9Response().safetyScoreIdentity;
    const displayed = { card: makeV9Card(), identity, color: "#123456" };
    const missing = { ...displayed, card: makeV9Card() };
    missing.card.pillars.backing.score = null;
    expect(buildV9RadarDataset([missing])).toEqual({ status: "unavailable", reason: "card-unavailable" });
    const result = buildV9RadarDataset([displayed], [missing, missing, missing]);
    expect(result).toMatchObject({ status: "available", value: { cohortMedians: null } });
    if (result.status !== "available") throw new Error("Expected available displayed card");
    expect(result.value.rows.every((row) => !("__cohortMedian" in row))).toBe(true);
  });

  it("rejects cohort-only identity mismatch and empty displayed series", () => {
    const identity = makeReportCardsV9Response().safetyScoreIdentity;
    const displayed = { card: makeV9Card(), identity, color: "#123456" };
    expect(buildV9RadarDataset([displayed], [{
      ...displayed, identity: { ...identity, policyId: "different" },
    }])).toEqual({ status: "unavailable", reason: "identity-mismatch" });
    expect(buildV9RadarDataset([], [displayed])).toEqual({ status: "unavailable", reason: "invalid-v9-response" });
  });
});
