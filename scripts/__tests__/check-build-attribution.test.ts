import { describe, expect, it } from "vitest";
import { findBuildAttributionFailures } from "../ci/check-build-attribution.mjs";

function reportEntry(classifications: string[], size: number, chunk = "chunk.js") {
  return { chunk, classifications, size };
}

describe("build attribution policy", () => {
  it("requires review for an unseen classified group", () => {
    const failures = findBuildAttributionFailures({
      baseline: { groups: [] },
      report: { entries: [reportEntry(["new-feature"], 32 * 1024)] },
    });

    expect(failures).toEqual([
      expect.stringMatching(/new-feature is a new classified group at 32\.0 KiB; review it before refreshing the baseline/),
    ]);
  });

  it("applies an absolute limit to unseen classified groups", () => {
    const failures = findBuildAttributionFailures({
      baseline: { groups: [] },
      report: { entries: [reportEntry(["oversized-feature"], 201 * 1024)] },
    });

    expect(failures).toEqual([
      expect.stringMatching(/oversized-feature is a new classified group at 201 KiB, above the 200 KiB absolute limit/),
    ]);
  });

  it("retains the growth ratchet for reviewed groups", () => {
    const failures = findBuildAttributionFailures({
      baseline: { groups: [{ key: "known-feature", totalBytes: 10 * 1024 }] },
      report: { entries: [reportEntry(["known-feature"], 61 * 1024)] },
    });

    expect(failures).toEqual([
      expect.stringMatching(/known-feature grew by 51\.0 KiB .* limit 50\.0 KiB/),
    ]);
  });

  it("retains the per-chunk limit for unclassified output", () => {
    const failures = findBuildAttributionFailures({
      baseline: { groups: [] },
      report: { entries: [reportEntry([], 201 * 1024, "unclassified.js")] },
    });

    expect(failures).toEqual([
      expect.stringMatching(/unclassified chunk unclassified\.js is 201 KiB \(limit 200 KiB\)/),
    ]);
  });
});
