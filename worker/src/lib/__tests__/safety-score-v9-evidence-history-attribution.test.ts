import { describe, expect, it } from "vitest";
import { compileSafetyScoreV9FactSetFromFixedInput } from "../safety-score-v9/fact-set";
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

describe("Safety Score v10.01 current cause versus historical publisher", () => {
  it.each(["issuer", "unknown"] as const)("retains %s publication history without certifying current nondisclosure", (publisher) => {
    const asset = compileExpiredReserveHistory(publisher).assets[0]!;
    const gap = asset.gaps.find((row) => row.gapId === "alpha:gap:reserve-composition")!;
    expect(gap.causeProof).toMatchObject({ cause: "U", evidenceRefIds: [] });
    expect(gap.evidenceHistory).toEqual({ publishedBy: publisher, evidenceRefIds: ["alpha:research:expired-reserve-report"] });
    expect(asset.evidence.find((row) => row.evidenceId === gap.evidenceHistory!.evidenceRefIds[0])).toMatchObject({
      observedAtSec: 9_000, publishedAtSec: 9_100, freshness: { state: "stale" },
    });
    expect(asset.reserveExposures).toEqual([]);
    expect(asset.reserveResiduals).toMatchObject([{ weight: 1, status: { gapIds: [gap.gapId] } }]);
  });
});
