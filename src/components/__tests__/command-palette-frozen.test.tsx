import { describe, expect, it } from "vitest";
import { rankCommandPaletteResults } from "../command-palette";

describe("command palette ranking", () => {
  it("demotes frozen entries on tied scores", () => {
    const candidates = [
      { id: "active-coin", score: 5, status: "active" as const },
      { id: "frozen-coin", score: 5, status: "frozen" as const },
    ];
    const ranked = rankCommandPaletteResults(candidates);
    expect(ranked[0].id).toBe("active-coin");
    expect(ranked[1].id).toBe("frozen-coin");
  });

  it("keeps higher-scored frozen entries above lower-scored active ones", () => {
    const candidates = [
      { id: "active-coin", score: 3, status: "active" as const },
      { id: "frozen-coin", score: 5, status: "frozen" as const },
    ];
    const ranked = rankCommandPaletteResults(candidates);
    expect(ranked[0].id).toBe("frozen-coin");
  });

  it("does not mutate the input array", () => {
    const candidates = [
      { id: "frozen-coin", score: 5, status: "frozen" as const },
      { id: "active-coin", score: 5, status: "active" as const },
    ];
    const original = [...candidates];
    rankCommandPaletteResults(candidates);
    expect(candidates).toEqual(original);
  });
});
