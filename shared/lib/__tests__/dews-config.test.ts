import { describe, expect, it } from "vitest";
import { dewsBandRanges } from "@shared/lib/dews-config";

describe("dewsBandRanges", () => {
  it("maps each canonical threat band to a contiguous inclusive score span", () => {
    expect(dewsBandRanges()).toEqual([[0, 15], [16, 35], [36, 55], [56, 75], [76, 100]]);
  });
});
