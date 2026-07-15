import { describe, expect, it } from "vitest";
import { buildV9RadarDataset } from "@/components/radar-chart-v9";
import { makeReportCardsV9Response, makeV9Card } from "@/test/fixtures/safety-score-v9";

describe("V9 radar cohorts", () => {
  it("builds exactly three pillars and a same-identity cohort median", () => {
    const response = makeReportCardsV9Response();
    const series = [
      makeV9Card({ id: "asset-a" }),
      makeV9Card({ id: "asset-b" }),
      makeV9Card({ id: "asset-c" }),
    ].map((card) => ({ card, identity: response.safetyScoreIdentity, color: "#123456" }));
    const result = buildV9RadarDataset(series, series);
    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    expect(result.value.rows.map((row) => row.pillar)).toEqual(["Backing", "Exit", "Control"]);
    expect(result.value.cohortMedians).toEqual({ backing: 88, exit: 82, control: 84 });
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
});
