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

  const review = Date.parse("2026-10-01T00:00:00Z") / 1000;
  const observed = review - 86400;
  it.each([
    { reviewedAt: "2026-10-01", observedAt: "2026-09-30" },
    { reviewedAtSec: review, observedAt: "2026-09-30" },
    { reviewedAt: "2026-10-01", observedAtSec: observed },
    { reviewedAtSec: review, observedAtSec: observed },
  ])("preserves the original valid clock representation in the full envelope and bindings: %j", (dates) => {
    const canonicalInputs: string[] = [];
    const builder = new ReviewEvidenceBuilder("asset", review + 86400, (chunks) => {
      const canonical = [...chunks].join("");
      canonicalInputs.push(canonical);
      return createHash("sha256").update(canonical).digest("hex");
    });
    const payload = { reviewed: true };
    const envelope = { domain: "safety-score-v9.reviewed-metadata-evidence.v2", payload: {
      assetId: "asset", sourceId: "review", reviewedAt: dates.reviewedAtSec ?? dates.reviewedAt,
      observedAt: dates.observedAtSec ?? dates.observedAt, publishedAt: null,
      publishedBy: "unknown", confidence: "manual-review", source: null, payload,
    } };
    const canonical = stableJsonStringifyV1(envelope);
    const contentSha256 = createHash("sha256").update(canonical).digest("hex");
    const evidenceKey = `review:0:${contentSha256.slice(0, 16)}`;
    expect(builder.add({ ...dates, componentKeys: ["mint"], sourceId: "review", payload })).toEqual([evidenceKey]);
    expect(canonicalInputs).toEqual([canonical]);
    expect(builder.finish()).toEqual({
      researchEvidence: [{ evidenceKey, sourceId: "review", observedAtSec: observed, publishedAtSec: null,
        url: null, contentSha256, confidence: "manual-review", maxAgeSec: null }],
      componentEvidence: [{ componentKey: "mint", evidenceKeys: [evidenceKey] }],
    });
  });

  it.each([
    { reviewedAt: "2026-10-01", observedAt: "2026-10-02" },
    { reviewedAtSec: review, observedAt: "2026-10-02" },
    { reviewedAt: "2026-10-01", observedAtSec: review + 1 },
    { reviewedAt: "1969-12-31", observedAt: "1969-12-30" },
    { reviewedAt: "2026-10-01", observedAt: "1969-12-31" },
    { reviewedAt: "2026-10-03", observedAt: "2026-10-01" },
  ])("rejects invalid chronology before hashing or changing either map: %j", (dates) => {
    const canonicalInputs: string[] = [];
    const builder = new ReviewEvidenceBuilder("asset", review + 86400, (chunks) => {
      const canonical = [...chunks].join("");
      canonicalInputs.push(canonical);
      return createHash("sha256").update(canonical).digest("hex");
    });
    builder.add({ componentKeys: ["existing"], sourceId: "valid", reviewedAtSec: review, payload: {} });
    const before = builder.finish();
    expect(() => builder.add({ ...dates, componentKeys: ["mint", "existing"], sourceId: "invalid", payload: {} })).toThrow();
    expect(builder.finish()).toEqual(before);
    expect(canonicalInputs).toHaveLength(1);
  });
});
