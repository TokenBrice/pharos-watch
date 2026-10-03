import { describe, expect, it } from "vitest";
import miniCapture from "./fixtures/safety-score-v9-rateable-mini-capture.json";
import { buildSafetyScoreV9ReplayArtifact } from "../../../scripts/replay-safety-score-v9";
import {
  createReportCardsFixedInput,
  type ReportCardsFixedInputDraft,
} from "../../test-helpers/report-cards-fixed-input";

// Frozen producer rows for usdt-tether and usdc-circle, originally captured
// on 2026-07-13 and coherently reclocked to 2026-10-02 so current registry
// reviews predate the scoring clock. Fingerprints and the registry extension
// are rebuilt against the live registry at test time, so this guards the exact
// failure mode the 2026-07-13 rescue fixed: a future extension or fact-set
// re-clamp silently regressing the shadow to 0 rateable assets. Registry
// review edits that genuinely remove the evidence these cards depend on are
// SUPPOSED to fail this test.
describe("Safety Score v9 rateable regression fixture", () => {
  it("keeps the frozen major-issuer capture rateable end to end", () => {
    const fixedInput = createReportCardsFixedInput(miniCapture.draft as unknown as ReportCardsFixedInputDraft);
    const artifact = buildSafetyScoreV9ReplayArtifact({
      fixedInput,
      publishedAtSec: miniCapture.publishedAtSec,
    });
    const cards = artifact.pipeline.candidate.cards;
    expect(cards.map((card) => card.id).sort()).toEqual(["usdc-circle", "usdt-tether"]);
    for (const card of cards) {
      expect(card.grade, `${card.id} must stay rateable (got NR: ${JSON.stringify(card.nrReasons)})`).not.toBe("NR");
      expect(card.score).not.toBeNull();
    }
    const usdc = cards.find((card) => card.id === "usdc-circle")!;
    // The frozen producer still carries the obsolete unkeyed SIFI/other-bank
    // split. Neither row may borrow the aggregate bank's reviewed identity.
    expect(usdc.pillars.backing.score).toBeCloseTo(84.40290725, 8);
    expect(usdc.reasonCodes).toContain("material-reserve-slice-unstructured");
  });

  it("admits the period-matched aggregate-bank fallback when Circle live reserves are absent", () => {
    const draft = structuredClone(miniCapture.draft as unknown as ReportCardsFixedInputDraft);
    delete draft.liveReserveMap["usdc-circle"];
    delete draft.liveReserveProvenanceMap["usdc-circle"];
    const artifact = buildSafetyScoreV9ReplayArtifact({
      fixedInput: createReportCardsFixedInput(draft),
      publishedAtSec: miniCapture.publishedAtSec,
    });
    const usdc = artifact.pipeline.candidate.cards.find((card) => card.id === "usdc-circle")!;
    expect(usdc.grade).not.toBe("NR");
    expect(usdc.nrReasons).toEqual([]);
    expect(usdc.reasonCodes).not.toContain("material-reserve-slice-unstructured");
  });
});
