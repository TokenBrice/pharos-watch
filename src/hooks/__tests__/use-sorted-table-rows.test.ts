import { describe, expect, it } from "vitest";
import {
  sortTableRows,
  type TableSortState,
} from "@/hooks/use-sorted-table-rows";

type SortKey = "score" | "name";

interface Row {
  name: string;
  score: number;
}

const rows: Row[] = [
  { name: "USDC", score: 99 },
  { name: "USDT", score: 97 },
  { name: "DAI", score: 98 },
];

function compareRows(a: Row, b: Row, sort: TableSortState<SortKey>): number {
  if (sort.key === "name") {
    return sort.direction === "asc"
      ? a.name.localeCompare(b.name)
      : b.name.localeCompare(a.name);
  }
  return sort.direction === "asc" ? a.score - b.score : b.score - a.score;
}

describe("sortTableRows", () => {
  it("sorts by descending score", () => {
    const sorted = sortTableRows(rows, { key: "score", direction: "desc" }, compareRows);
    expect(sorted.map((row) => row.name)).toEqual(["USDC", "DAI", "USDT"]);
  });

  it("sorts by ascending name", () => {
    const sorted = sortTableRows(rows, { key: "name", direction: "asc" }, compareRows);
    expect(sorted.map((row) => row.name)).toEqual(["DAI", "USDC", "USDT"]);
  });

  it("does not mutate original rows", () => {
    const original = [...rows];
    void sortTableRows(rows, { key: "score", direction: "asc" }, compareRows);
    expect(rows).toEqual(original);
  });
});
