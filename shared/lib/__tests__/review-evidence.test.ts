import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ReviewEvidenceBuilder } from "../safety-score-v9/review-evidence";
import { stableJsonStringifyV1 } from "../stable-json";

describe("review evidence canonical payload reuse", () => {
  it("preserves every source-specific canonical envelope and digest", () => {
    const payload = { rows: Array.from({ length: 2_000 }, (_, id) => ({ id, text: "é😀\\\"" })) };
    const sources = [{ label: "second", url: "https://example.com/b" }, { label: "first", url: "https://example.com/a" }];
    const canonicalInputs: string[] = [];
    const builder = new ReviewEvidenceBuilder("test-asset", 1_800_000_000, (chunks) => {
      const canonical = [...chunks].join("");
      canonicalInputs.push(canonical);
      return createHash("sha256").update(canonical).digest("hex");
    });
    const evidenceKeys = builder.add({ componentKeys: ["mint", "control"], sourceId: "review", reviewedAt: "2026-10-01", sources, payload });
    for (const [index, source] of [...sources].reverse().entries()) {
      const canonical = stableJsonStringifyV1({ domain: "safety-score-v9.reviewed-metadata-evidence.v2", payload: {
        assetId: "test-asset", sourceId: "review", reviewedAt: "2026-10-01", observedAt: "2026-10-01",
        publishedAt: null, publishedBy: "unknown", confidence: "manual-review", source, payload,
      } });
      const digest = createHash("sha256").update(canonical).digest("hex");
      expect(canonicalInputs[index]).toBe(canonical);
      expect(evidenceKeys[index]).toBe(`review:${index}:${digest.slice(0, 16)}`);
      expect(builder.evidence.get(evidenceKeys[index]!)?.contentSha256).toBe(digest);
    }
    expect(builder.finish().componentEvidence).toEqual([
      { componentKey: "control", evidenceKeys: [...evidenceKeys].sort() },
      { componentKey: "mint", evidenceKeys: [...evidenceKeys].sort() },
    ]);
    expect(sources[0]?.label).toBe("second");
    expect(Object.isFrozen(payload)).toBe(false);
  });
});
