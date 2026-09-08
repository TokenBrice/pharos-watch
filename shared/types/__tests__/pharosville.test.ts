import { describe, expect, it } from "vitest";
import { makeReportCardsV9Card, makeReportCardsV9Response } from "@shared/test-utils/report-cards-v9";
import { PHAROSVILLE_API_CONTRACT_VERSION, PHAROSVILLE_API_ENDPOINT_KEYS, PharosVilleApiPayloadsSchema } from "../pharosville";

const methodology = {
  version: "test", versionLabel: "Test", currentVersion: "test", currentVersionLabel: "Test",
  changelogPath: "/methodology/test", asOf: 1, isCurrent: true,
};
const payload = {
  stablecoins: { peggedAssets: [] },
  chains: {
    chains: [], globalTotalUsd: 0, chainAttributedTotalUsd: 0, unattributedTotalUsd: 0,
    globalChange24hPct: 0, globalChange7dPct: 0, globalChange30dPct: 0,
    updatedAt: 1, healthMethodologyVersion: "test",
  },
  stability: { current: null, history: [], methodology },
  pegSummary: { coins: [], summary: null, methodology },
  stress: { signals: {}, updatedAt: 1, methodology },
  reportCards: makeReportCardsV9Response({
    safetyScoreIdentity: {
      model: "v9", schemaVersion: 1, methodologyVersion: "9.0", policyId: "safety-score-v9",
      policyDigest: "a".repeat(64), evaluationBuildDigest: "b".repeat(64),
      baseInputGenerationId: `report-cards-input:v1:${"c".repeat(64)}`,
      publicationGenerationId: "v9-publication-1",
    },
    defaultUpdatedAt: 1, asOfSec: 1,
    source: {
      candidateId: "safety-score-v9:v1:2026-07-15", factSetDigest: "c".repeat(64),
      resultDigest: "d".repeat(64), sourceGenerations: { reportCards: "source-1" },
    },
  }, makeReportCardsV9Card, { cards: [] }),
};

describe("PharosVille shared payload contract", () => {
  it("pins the endpoint key set and version", () => {
    expect(PHAROSVILLE_API_CONTRACT_VERSION).toBe(1);
    expect(PHAROSVILLE_API_ENDPOINT_KEYS).toEqual([
      "stablecoins", "chains", "stability", "pegSummary", "stress", "reportCards",
    ]);
  });

  it("accepts a complete six-endpoint bundle", () => {
    expect(PharosVilleApiPayloadsSchema.parse(payload)).toEqual(payload);
  });

  it.each([
    ["stablecoins", { peggedAssets: "invalid" }, ["stablecoins", "peggedAssets"]],
    ["chains", { ...payload.chains, chains: "invalid" }, ["chains", "chains"]],
    ["stability", { ...payload.stability, history: "invalid" }, ["stability", "history"]],
    ["pegSummary", { ...payload.pegSummary, coins: "invalid" }, ["pegSummary", "coins"]],
    ["stress", { ...payload.stress, updatedAt: "invalid" }, ["stress", "updatedAt"]],
    ["reportCards", { ...payload.reportCards, cards: "invalid" }, ["reportCards", "cards"]],
  ] as const)("%s rejects a malformed endpoint inside an otherwise valid bundle", (endpoint, invalid, path) => {
    const result = PharosVilleApiPayloadsSchema.safeParse({ ...payload, [endpoint]: invalid });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toContainEqual(expect.objectContaining({ path }));
  });
});
