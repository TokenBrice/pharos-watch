import { describe, expect, it } from "vitest";
import miniCapture from "./fixtures/safety-score-v9-rateable-mini-capture.json";
import { buildSafetyScoreV9ReplayArtifact } from "../../../scripts/replay-safety-score-v9";
import { createReportCardsFixedInput, type ReportCardsFixedInputDraft } from "../report-cards-fixed-input";

// Frozen producer rows for usdt-tether and usdc-circle from the 2026-07-13
// exact publication capture. Fingerprints and the registry extension are
// rebuilt against the live registry at test time, so this guards the exact
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
  });
});
