import { describe, expect, it } from "vitest";
import { getNextSortState, shouldToggleSortOnKeyDown } from "@/hooks/use-sort";

type SortKey = "score" | "tvl";

describe("getNextSortState", () => {
  it("toggles direction when clicking the same key", () => {
    const next = getNextSortState<SortKey>({ key: "score", direction: "desc" }, "score");
    expect(next).toEqual({ key: "score", direction: "asc" });
  });

  it("resets to descending when switching columns", () => {
    const next = getNextSortState<SortKey>({ key: "score", direction: "asc" }, "tvl");
    expect(next).toEqual({ key: "tvl", direction: "desc" });
  });
});

describe("shouldToggleSortOnKeyDown", () => {
  it("accepts keyboard activation keys", () => {
    expect(shouldToggleSortOnKeyDown("Enter")).toBe(true);
    expect(shouldToggleSortOnKeyDown(" ")).toBe(true);
  });

  it("ignores non-activation keys", () => {
    expect(shouldToggleSortOnKeyDown("Tab")).toBe(false);
    expect(shouldToggleSortOnKeyDown("ArrowDown")).toBe(false);
  });
});
