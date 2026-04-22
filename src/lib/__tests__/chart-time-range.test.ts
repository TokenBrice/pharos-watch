import { describe, expect, it } from "vitest";
import { formatRangeTickDate } from "../chart-time-range";

describe("formatRangeTickDate", () => {
  const timestamp = Date.UTC(2026, 3, 22, 12);

  it("uses day-level labels for 7d and 30d ranges", () => {
    expect(formatRangeTickDate(timestamp, "7d")).toBe("Apr 22");
    expect(formatRangeTickDate(timestamp, "30d")).toBe("Apr 22");
  });

  it("keeps month-oriented labels for longer ranges", () => {
    expect(formatRangeTickDate(timestamp, "90d")).toBe("Apr '26");
    expect(formatRangeTickDate(timestamp, "1y")).toBe("Apr '26");
    expect(formatRangeTickDate(timestamp, "all")).toBe("Apr '26");
  });
});
