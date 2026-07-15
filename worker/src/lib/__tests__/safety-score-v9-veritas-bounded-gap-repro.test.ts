import { describe, expect, it } from "vitest";
import { evaluateV9FactSet } from "@shared/lib/safety-score-v9/evaluate-set";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import miniCapture from "./fixtures/safety-score-v9-rateable-mini-capture.json";
import { createReportCardsFixedInput, type ReportCardsFixedInputDraft } from "../report-cards-fixed-input";
import { compileSafetyScoreV9FactSetFromNormalizedInput } from "../safety-score-v9-fact-set";
import {
  buildSafetyScoreV9BaselineExtensionFromNormalizedInput,
  type V9ExtensionRegistryMeta,
} from "../safety-score-v9-extension";

// VER-012: ordinary missing access reviews compile with the evidence-owned
// `missing-pillar-evidence` reason even though the facts are control-owned.
// This is a work-queue binding defect; Access does not enter the score pillars.
describe.skip("VERITAS finding VER-012: access gaps violate their reason owner contract", () => {
  it("keeps every ordinary access gap bound to a reason with the same owner", () => {
    const fixedInput = createReportCardsFixedInput(miniCapture.draft as unknown as ReportCardsFixedInputDraft);
    const metaById = new Map<string, V9ExtensionRegistryMeta>(
      fixedInput.activeAssetIds.map((assetId) => [assetId, { id: assetId, mechanismArchetype: "fiat-cash" }]),
    );
    const extension = buildSafetyScoreV9BaselineExtensionFromNormalizedInput(fixedInput, {
      metaById,
      registryFingerprint: fixedInput.registryFingerprint,
    });
    const compiled = compileSafetyScoreV9FactSetFromNormalizedInput(fixedInput, extension);
    const evaluated = evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1);

    expect(evaluated.assets.every((asset) => asset.trace.finalGrade !== "NR")).toBe(true);

    const accessGaps = compiled.assets.flatMap((asset) =>
      asset.gaps.flatMap((gap) =>
        gap.path.kind === "local-component" && gap.path.componentKey.startsWith("access:") ? [gap] : [],
      ),
    );
    expect(accessGaps.length).toBeGreaterThan(0);
    for (const gap of accessGaps) {
      const reason = V9_CANDIDATE_POLICY_V1.policy.reasonRegistry.find((entry) => entry.code === gap.reasonCode)!;
      const componentKey = gap.path.kind === "local-component" ? gap.path.componentKey : gap.path.kind;
      expect(reason.ownerDomain, `${gap.reasonCode} is misbound at ${componentKey}`).toBe(gap.ownerDomain);
    }
  });
});
