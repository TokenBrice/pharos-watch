import {
  evaluateV9FactSet,
  evaluateValidatedV9FactSet,
} from "@shared/lib/safety-score-v9/evaluate-set";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { describe, expect, it } from "vitest";
import productionCapture from "./fixtures/safety-score-v9-usdt-premium-capture.json";
import {
  createReportCardsFixedInput,
  type ReportCardsFixedInputDraft,
} from "../report-cards-fixed-input";
import { buildSafetyScoreV9BaselineExtensionFromNormalizedInput } from "../safety-score-v9-extension";
import { compileSafetyScoreV9FactSetFromNormalizedInput } from "../safety-score-v9-fact-set";

const EXPECTED_MARKET_ORDER = [
  "usdt-tether",
  "usdc-circle",
  "dai-makerdao",
  "susdt-spark",
] as const;

// Scoped from the recovered 2026-07-24 exact production capture so the
// integration test retains USDT's measured Curve routes and real wrapper facts.
describe("Safety Score v9 USDT premium production integration", () => {
  it("derives rank from supply and keeps the premium out of a real serial wrapper", () => {
    const fixedInput = createReportCardsFixedInput(
      productionCapture.draft as unknown as ReportCardsFixedInputDraft,
    );
    const extension =
      buildSafetyScoreV9BaselineExtensionFromNormalizedInput(fixedInput);
    const facts = compileSafetyScoreV9FactSetFromNormalizedInput(
      fixedInput,
      extension,
    );

    const strict = evaluateV9FactSet(facts, V9_CANDIDATE_POLICY_V1);
    const trusted = evaluateValidatedV9FactSet(
      facts,
      V9_CANDIDATE_POLICY_V1,
    );

    expect(trusted).toEqual(strict);

    const factsById = new Map(
      facts.assets.map((asset) => [asset.assetId, asset]),
    );
    const evaluatedById = new Map(
      trusted.assets.map((asset) => [asset.assetId, asset]),
    );
    const supplyOrder = [...facts.assets]
      .sort(
        (left, right) =>
          right.supply.circulatingUsd! - left.supply.circulatingUsd!,
      )
      .map((asset) => asset.assetId);

    expect(supplyOrder).toEqual(EXPECTED_MARKET_ORDER);
    expect(factsById.get("usdt-tether")).not.toHaveProperty("marketRank");
    for (const [index, assetId] of EXPECTED_MARKET_ORDER.entries()) {
      expect(evaluatedById.get(assetId)?.scoreInput.marketRank).toBe(index + 1);
    }

    const usdt = evaluatedById.get("usdt-tether")!;
    expect(usdt.trace).toMatchObject({
      finalScore: 87,
      inheritableScore: 83,
      finalGrade: "A+",
      scoreAdjustments: [{
        source: "asset-premium",
        kind: "market-anchor-longevity",
        label: "#1 & Longevity Premium",
        configuredPoints: 12,
        appliedPoints: 12,
        publishedScoreBefore: 83,
        publishedScoreAfter: 87,
      }],
    });

    const childFacts = factsById.get("susdt-spark")!;
    expect(childFacts.dependencies.edges).toContainEqual(
      expect.objectContaining({
        upstreamAssetId: "usdt-tether",
        dependencyType: "wrapper",
        pathKind: "serial-dependency",
        economicRole: "serial-claim",
        weight: 1,
      }),
    );

    const child = evaluatedById.get("susdt-spark")!;
    expect(child.dependencyInputs.serial).toEqual([{
      upstreamAssetId: "usdt-tether",
      score: 83,
      blocked: false,
    }]);
    expect(child.scoreInput.parent).toMatchObject({
      required: true,
      wrapperParentLimit: {
        parentScore: 83,
      },
    });
    expect(child.dependencyInputs.serial[0]!.score).not.toBe(
      usdt.trace.finalScore,
    );
  });
});
