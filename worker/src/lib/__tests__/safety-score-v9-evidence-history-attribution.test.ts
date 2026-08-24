import { describe, expect, it } from "vitest";
import { compileSafetyScoreV9FactSetFromFixedInput } from "../safety-score-v9-fact-set";
import {
  makeV9Extension,
  makeV9FixedInput,
} from "../../test-helpers/v9-fixed-input";

function compileExpiredReserveHistory(publishedBy: "issuer" | "unknown") {
  const fixed = makeV9FixedInput({ omitLiveReserve: true });
  const overlay = makeV9Extension({
    clockSec: fixed.clockSec,
    registryFingerprint: fixed.registryFingerprint,
  });
  const asset = overlay.assets[0]!;
  asset.researchEvidence = [
    {
      evidenceKey: "expired-reserve-report",
      sourceId: "fixture.expired-reserve-report",
      observedAtSec: fixed.clockSec - 1_000,
      publishedAtSec: fixed.clockSec - 900,
      publishedBy,
      url: "https://example.com/expired-reserve-report.pdf",
      contentSha256: "e".repeat(64),
      confidence: "verified",
      maxAgeSec: 500,
    },
  ];
  asset.componentEvidence = [
    {
      componentKey: "reserve-composition-history",
      evidenceKeys: ["expired-reserve-report"],
    },
  ];
  return compileSafetyScoreV9FactSetFromFixedInput(fixed, overlay);
}

describe("Safety Score v9 Worker evidence-history attribution", () => {
  it("attributes an expired issuer-published reserve document to published-evidence-expired", () => {
    const compiled = compileExpiredReserveHistory("issuer");
    const reserveGap = compiled.assets[0]!.gaps.find(
      (gap) => gap.gapId === "alpha:gap:reserve-composition",
    );

    expect(reserveGap).toMatchObject({
      observationState: "stale",
      responsibility: "published-evidence-expired",
      evidenceRefIds: ["alpha:research:expired-reserve-report"],
    });
  });

  it("keeps an expired reserve document with unknown publisher at issuer-undisclosed", () => {
    const compiled = compileExpiredReserveHistory("unknown");
    const reserveGap = compiled.assets[0]!.gaps.find(
      (gap) => gap.gapId === "alpha:gap:reserve-composition",
    );

    expect(reserveGap).toMatchObject({
      observationState: "stale",
      responsibility: "issuer-undisclosed",
      evidenceRefIds: ["alpha:research:expired-reserve-report"],
    });
  });
});
