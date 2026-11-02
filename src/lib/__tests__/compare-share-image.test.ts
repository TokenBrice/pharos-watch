import { describe, expect, it } from "vitest";
import { buildCompareShareFooter } from "@/lib/compare-share-image";

describe("buildCompareShareFooter", () => {
  it("appends the producer generation to the existing footer line", () => {
    expect(buildCompareShareFooter(1_700_000_000)).toBe(
      "pharos.watch/compare · As of 14 Nov 2023, 22:13 UTC",
    );
  });

  it("omits the stamp when no producer clock is available", () => {
    expect(buildCompareShareFooter(null)).toBe("pharos.watch/compare");
  });
});
