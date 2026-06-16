import { describe, expect, it } from "vitest";
import type { DeadStablecoin } from "@shared/types";
import { buildCemeteryYearSections } from "@/lib/cemetery";

// buildCemeteryYearSections only reads `deathDate`; a minimal partial is enough.
function coin(id: string, deathDate: string | undefined): DeadStablecoin {
  return { id, deathDate } as unknown as DeadStablecoin;
}

describe("buildCemeteryYearSections", () => {
  it("groups pre-sorted coins into contiguous year sections", () => {
    const sections = buildCemeteryYearSections([
      coin("a", "2023-03-10"),
      coin("b", "2023-01-02"),
      coin("c", "2022-12-31"),
    ]);

    expect(sections.map((s) => s.year)).toEqual(["2023", "2022"]);
    expect(sections[0]?.coins.map((c) => c.id)).toEqual(["a", "b"]);
    expect(sections[1]?.coins.map((c) => c.id)).toEqual(["c"]);
  });

  it("buckets a missing or malformed deathDate under 'Unknown' instead of an undefined key", () => {
    const sections = buildCemeteryYearSections([
      coin("a", "2023-03-10"),
      coin("b", undefined),
    ]);

    expect(sections.map((s) => s.year)).toEqual(["2023", "Unknown"]);
    expect(sections[1]?.coins.map((c) => c.id)).toEqual(["b"]);
  });
});
