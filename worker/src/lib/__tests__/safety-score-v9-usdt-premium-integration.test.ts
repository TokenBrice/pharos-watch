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
} from "../../test-helpers/report-cards-fixed-input";
import { buildSafetyScoreV9BaselineExtensionFromNormalizedInput } from "../safety-score-v9/extension";
import { compileSafetyScoreV9FactSetFromNormalizedInput } from "../safety-score-v9/fact-set";
import { capturedAccessMetaById } from "./safety-score-v9-capture.test-support";

const EXPECTED_MARKET_ORDER = [
  "usdt-tether",
  "usdc-circle",
  "dai-makerdao",
  "susdt-spark",
] as const;

// Scoped from the recovered 2026-07-24 exact production capture so the
// integration test retains USDT's measured Curve routes and real wrapper facts.
// Producer epochs retain their relative ages at the 2026-10-23 scoring clock,
// after the live registry's 2026-10-22 oracle review. Access reviews are captured
// separately so later catalog reviews cannot quarantine this historical input.
// susdt-spark live rows are refreshed to the erc4626-single-asset adapter's
// current keyed two-slice emission so the capture tracks the 2026-09-29
// spUSDT re-curation instead of the retired single unkeyed row.
describe("Safety Score v9 USDT premium production integration", () => {
  it("preserves the serial parent after a reserve non-link without inheriting USDT's asset premium", () => {
    const fixedInput = createReportCardsFixedInput(
      productionCapture.draft as unknown as ReportCardsFixedInputDraft,
    );
    const extension =
      buildSafetyScoreV9BaselineExtensionFromNormalizedInput(fixedInput, {
        metaById: capturedAccessMetaById,
        // Freeze optional transfer overlays as well as blacklist evidence.
        reviewedTransferFacts: new Map(),
      });
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
    // The longevity premium is public-only. Pending TRON maturity research
    // retains uncertainty without an authored-failure deployment charge.
    expect(usdt.trace).toMatchObject({
      scoreAdjustments: [{ kind: "market-anchor-longevity", configuredPoints: 12, appliedPoints: 12 }],
    });
    expect(usdt.trace.deploymentAdjustments).not.toContainEqual(
      expect.objectContaining({ failureDomainKey: "chain:tron" }),
    );
    // Independently reviewed bridge representations still price their own risks.
    expect(usdt.trace.deploymentAdjustments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        exposureKey: "deployment-slice:bsc:0x55d398326f99059ff775485246999027b3197955",
        exposedScore: 45,
        riskEventKey: expect.stringContaining("deployment-event:peripheral-bridge:"),
      }),
      expect.objectContaining({
        exposureKey: "deployment-slice:fantom:0x049d68029688eabf473097a2fc38ef61633a3c7a",
        exposedScore: 25,
        riskEventKey: expect.stringContaining("deployment-event:active-control-incident:"),
      }),
    ]));
    // The publication maximum can truncate the visible lift; downstream claims
    // inherit the ordinary score, not the capped published score minus 12.
    expect(usdt.trace.inheritableScore).toBe(usdt.trace.scoreAdjustments[0]!.publishedScoreBefore);
    expect(usdt.trace.inheritableScore).toBeLessThan(usdt.trace.finalScore!);

    const childFacts = factsById.get("susdt-spark")!;
    // The 2026-09-29 re-curation measured the spUSDT vault on-chain (block
    // 26079396): the 19.59% idle USDT slice is a live-mapped wrapper claim,
    // while only the 80.41% deployed strategy basket stays a non-link.
    expect(childFacts.dependencies).toMatchObject({
      source: "variant",
      baseSource: "live-reserve",
      dependencyFromLive: true,
      fallbackReason: null,
      rejectionReasons: [{ sliceIndex: 1, reason: "non-link" }],
      edges: [{ upstreamAssetId: "usdt-tether", dependencyType: "wrapper", economicRole: "serial-claim", weight: 1 }],
    });
    expect(childFacts.dependencies.mappedLiveReserveWeight).toBeCloseTo(0.19590965651347, 12);

    const child = evaluatedById.get("susdt-spark")!;
    expect(child.dependencyInputs.serial).toMatchObject([
      { upstreamAssetId: "usdt-tether", score: usdt.trace.inheritableScore, blocked: false },
    ]);
    expect(child.trace.wrapperParentLimit).toMatchObject({ parentScore: usdt.trace.inheritableScore });
    expect(child.trace.scoreAdjustments).not.toContainEqual(
      expect.objectContaining({ kind: "market-anchor-longevity" }),
    );
  });
});
