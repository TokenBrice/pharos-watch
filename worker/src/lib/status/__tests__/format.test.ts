import { describe, expect, it } from "vitest";
import { formatRatio } from "../format";

describe("formatRatio", () => {
  it("formats ratios as fixed two-decimal percentages", () => {
    expect(formatRatio(0)).toBe("0.00%");
    expect(formatRatio(0.12345)).toBe("12.35%");
    expect(formatRatio(1)).toBe("100.00%");
  });
});
