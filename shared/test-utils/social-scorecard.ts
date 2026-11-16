import type { SocialScorecardMetadata } from "../types/social-scorecard";
import { sha256HexFromBytes } from "../lib/sha256";
import { SOCIAL_SCORECARD_RENDERER_REVISION } from "../lib/social-scorecard";

/** Header-sized renderer double; real PNG encoding belongs to renderer runtime tests. */
export function makeScorecardImageFixture(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 1200);
  view.setUint32(20, 630);
  return bytes;
}

export function makeScorecardMetadataFixture(nowSec = Math.floor(Date.now() / 1000)): SocialScorecardMetadata {
  return {
    schemaVersion: 1, rendererRevision: SOCIAL_SCORECARD_RENDERER_REVISION,
    publication: {
      model: "v9", schemaVersion: 1, methodologyVersion: "10.37",
      evaluationBuildDigest: "a".repeat(64),
      baseInputGenerationId: `report-cards-input:v1:${"b".repeat(64)}`,
      publicationGenerationId: "report-cards:v9:scorecard-test", policyId: "test-policy", policyDigest: "c".repeat(64),
    },
    asOfSec: nowSec - 120, publishedAtSec: nowSec - 60, freshnessBudgetSec: 86_400,
    // Deliberately not the raw numeric band: publication hysteresis owns the letter.
    subject: { kind: "stablecoin", id: "usdc-circle", name: "USD Coin", symbol: "USDC", score: 82, grade: "A", ratingStatus: "rated" },
    imageSha256: sha256HexFromBytes(makeScorecardImageFixture()),
  };
}
