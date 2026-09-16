import { describe, expect, it } from "vitest";
import { DEWS_THREAT_BANDS, dewsBandRanges } from "@shared/lib/dews-config";

describe("dewsBandRanges", () => {
  it("maps each canonical threat band to a contiguous inclusive score span", () => {
    const ranges = dewsBandRanges();

    expect(ranges).toHaveLength(DEWS_THREAT_BANDS.length);
    ranges.forEach(([lower, upper], index) => {
      expect(upper).toBe(DEWS_THREAT_BANDS[index].upper);
      expect(lower).toBe(index === 0 ? 0 : DEWS_THREAT_BANDS[index - 1].upper + 1);
    });
  });
});
