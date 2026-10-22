import { describe, expect, it } from "vitest";
import miniCapture from "./fixtures/safety-score-v9-rateable-mini-capture.json";
import { buildSafetyScoreV9ReplayArtifact } from "../../../scripts/replay-safety-score-v9";
import {
  createReportCardsFixedInput,
  type ReportCardsFixedInputDraft,
} from "../../test-helpers/report-cards-fixed-input";
import { buildSafetyScoreV9BaselineExtension } from "../safety-score-v9/extension";
import { capturedAccessMetaById } from "./safety-score-v9-capture.test-support";

// Frozen producer rows for usdt-tether and usdc-circle, originally captured
// on 2026-07-13 and coherently reclocked to 2026-10-02. Access evidence
// available at that clock is frozen alongside the producer rows;
// other registry evidence still exercises current adapters.
// This guards the July 13 rescue against compiler changes silently removing
// rateable major issuers, without admitting later reviews at a historical clock.
describe("Safety Score v9 rateable regression fixture", () => {
  it("keeps the frozen major-issuer capture rateable end to end", () => {
    const fixedInput = createReportCardsFixedInput(miniCapture.draft as unknown as ReportCardsFixedInputDraft);
    const artifact = buildSafetyScoreV9ReplayArtifact({
      fixedInput,
      extension: buildSafetyScoreV9BaselineExtension(fixedInput, { metaById: capturedAccessMetaById }),
      publishedAtSec: miniCapture.publishedAtSec,
    });
    const cards = artifact.pipeline.candidate.cards;
    expect(cards.map((card) => card.id).sort()).toEqual(["usdc-circle", "usdt-tether"]);
    for (const card of cards) {
      expect(card.ratingStatus, `${card.id}: ${JSON.stringify(card.nrReasons)}`).toBe("rated");
      expect(card.score).not.toBeNull();
    }
    const usdc = cards.find((card) => card.id === "usdc-circle")!;
    // The frozen producer still carries the obsolete unkeyed SIFI/other-bank
    // split. Neither row may borrow the aggregate bank's reviewed identity.
    expect(usdc.pillars.backing.score).toBeGreaterThan(0);
    expect(usdc.pillars.backing.score).toBeLessThan(100);
    expect(usdc.reasonCodes).toContain("material-reserve-slice-unstructured");
  });

  it("admits the period-matched aggregate-bank fallback when Circle live reserves are absent", () => {
    const draft = structuredClone(miniCapture.draft as unknown as ReportCardsFixedInputDraft);
    delete draft.liveReserveMap["usdc-circle"];
    delete draft.liveReserveProvenanceMap["usdc-circle"];
    const fixedInput = createReportCardsFixedInput(draft);
    const artifact = buildSafetyScoreV9ReplayArtifact({
      fixedInput,
      extension: buildSafetyScoreV9BaselineExtension(fixedInput, { metaById: capturedAccessMetaById }),
      publishedAtSec: miniCapture.publishedAtSec,
    });
    const usdc = artifact.pipeline.candidate.cards.find((card) => card.id === "usdc-circle")!;
    expect(usdc.grade).not.toBe("NR");
    expect(usdc.nrReasons).toEqual([]);
    const evaluated = artifact.pipeline.evaluatedSet.assets.find((asset) => asset.assetId === "usdc-circle")!;
    expect(evaluated.backing.contributions.some((row) =>
      row.source === "reserve-exposure" && row.score !== null && row.score > 0 && row.effectiveScoringWeight > 0,
    )).toBe(true);
  });
});
