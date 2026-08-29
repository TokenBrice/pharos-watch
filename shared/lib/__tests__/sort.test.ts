import { describe, expect, it } from "vitest";
import { compareFiniteDesc } from "../sort";

type SortRow = { id: string; value: number };

describe("compareFiniteDesc", () => {
  it("sorts finite values descending and leaves equal values in insertion order", () => {
    const rows: SortRow[] = [
      { id: "first", value: 10 },
      { id: "second", value: 10 },
      { id: "largest", value: 20 },
    ];

    expect([...rows].sort(compareFiniteDesc<SortRow>((row) => row.value)).map((row) => row.id)).toEqual([
      "largest",
      "first",
      "second",
    ]);
  });

  it("supports an explicit secondary comparator", () => {
    const rows: SortRow[] = [
      { id: "b", value: 10 },
      { id: "a", value: 10 },
    ];

    expect([...rows].sort(compareFiniteDesc<SortRow>(
      (row) => row.value,
      (left, right) => left.id.localeCompare(right.id),
    )).map((row) => row.id)).toEqual(["a", "b"]);
  });

  it("puts non-finite values after finite values", () => {
    const rows: SortRow[] = [
      { id: "nan", value: Number.NaN },
      { id: "finite", value: 1 },
      { id: "infinite", value: Number.POSITIVE_INFINITY },
    ];

    expect([...rows].sort(compareFiniteDesc<SortRow>((row) => row.value)).map((row) => row.id)).toEqual([
      "finite",
      "nan",
      "infinite",
    ]);
  });
});
