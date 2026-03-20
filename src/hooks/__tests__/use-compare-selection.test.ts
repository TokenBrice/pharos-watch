import { describe, expect, it } from "vitest";

import { normalizeCompareRange } from "@/hooks/use-compare-selection";

describe("normalizeCompareRange", () => {
  it("returns valid compare ranges unchanged", () => {
    expect(normalizeCompareRange("30d")).toBe("30d");
    expect(normalizeCompareRange("all")).toBe("all");
  });

  it("falls back to all for invalid compare ranges", () => {
    expect(normalizeCompareRange("lifetime")).toBe("all");
    expect(normalizeCompareRange(null)).toBe("all");
  });
});
