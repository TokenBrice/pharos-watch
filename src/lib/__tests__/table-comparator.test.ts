import { describe, it, expect } from "vitest";
import { createTableComparator } from "../table-comparator";

interface TestRow {
  name: string;
  value: number;
  score: number | null;
}

describe("createTableComparator", () => {
  const compare = createTableComparator<"name" | "value" | "score", TestRow>({
    name: (r) => r.name,
    value: (r) => r.value,
    score: (r) => r.score,
  });

  describe("basic numeric sort", () => {
    it("sorts ascending", () => {
      const rows: TestRow[] = [
        { name: "B", value: 20, score: null },
        { name: "A", value: 10, score: null },
      ];
      rows.sort((a, b) => compare(a, b, { key: "value", direction: "asc" }));
      expect(rows[0].value).toBe(10);
      expect(rows[1].value).toBe(20);
    });

    it("sorts descending", () => {
      const rows: TestRow[] = [
        { name: "A", value: 10, score: null },
        { name: "B", value: 20, score: null },
      ];
      rows.sort((a, b) => compare(a, b, { key: "value", direction: "desc" }));
      expect(rows[0].value).toBe(20);
      expect(rows[1].value).toBe(10);
    });

    it("returns 0 for equal values", () => {
      const a: TestRow = { name: "A", value: 10, score: null };
      const b: TestRow = { name: "B", value: 10, score: null };
      expect(compare(a, b, { key: "value", direction: "asc" })).toBe(0);
    });
  });

  describe("string sort", () => {
    it("sorts strings ascending", () => {
      const rows: TestRow[] = [
        { name: "Banana", value: 1, score: null },
        { name: "Apple", value: 2, score: null },
      ];
      rows.sort((a, b) => compare(a, b, { key: "name", direction: "asc" }));
      expect(rows[0].name).toBe("Apple");
      expect(rows[1].name).toBe("Banana");
    });

    it("sorts strings descending", () => {
      const rows: TestRow[] = [
        { name: "Apple", value: 1, score: null },
        { name: "Banana", value: 2, score: null },
      ];
      rows.sort((a, b) => compare(a, b, { key: "name", direction: "desc" }));
      expect(rows[0].name).toBe("Banana");
      expect(rows[1].name).toBe("Apple");
    });
  });

  describe("null values sort to end by default", () => {
    it("null sorts after non-null regardless of direction (asc)", () => {
      const rows: TestRow[] = [
        { name: "A", value: 1, score: null },
        { name: "B", value: 2, score: 50 },
      ];
      rows.sort((a, b) => compare(a, b, { key: "score", direction: "asc" }));
      expect(rows[0].score).toBe(50);
      expect(rows[1].score).toBeNull();
    });

    it("null sorts after non-null regardless of direction (desc)", () => {
      const rows: TestRow[] = [
        { name: "A", value: 1, score: null },
        { name: "B", value: 2, score: 50 },
      ];
      rows.sort((a, b) => compare(a, b, { key: "score", direction: "desc" }));
      expect(rows[0].score).toBe(50);
      expect(rows[1].score).toBeNull();
    });

    it("two null values compare as equal", () => {
      const a: TestRow = { name: "A", value: 1, score: null };
      const b: TestRow = { name: "B", value: 2, score: null };
      expect(compare(a, b, { key: "score", direction: "desc" })).toBe(0);
    });
  });

  describe("nullPosition: first", () => {
    const compareNullFirst = createTableComparator<"score", TestRow>(
      { score: (r) => r.score },
      { nullPosition: "first" },
    );

    it("null sorts before non-null (asc)", () => {
      const rows: TestRow[] = [
        { name: "B", value: 2, score: 50 },
        { name: "A", value: 1, score: null },
      ];
      rows.sort((a, b) => compareNullFirst(a, b, { key: "score", direction: "asc" }));
      expect(rows[0].score).toBeNull();
      expect(rows[1].score).toBe(50);
    });

    it("null sorts before non-null (desc)", () => {
      const rows: TestRow[] = [
        { name: "B", value: 2, score: 50 },
        { name: "A", value: 1, score: null },
      ];
      rows.sort((a, b) => compareNullFirst(a, b, { key: "score", direction: "desc" }));
      expect(rows[0].score).toBeNull();
      expect(rows[1].score).toBe(50);
    });
  });

  describe("mixed null and non-null values", () => {
    it("sorts correctly with multiple null and non-null entries", () => {
      const rows: TestRow[] = [
        { name: "A", value: 1, score: null },
        { name: "B", value: 2, score: 80 },
        { name: "C", value: 3, score: null },
        { name: "D", value: 4, score: 30 },
        { name: "E", value: 5, score: 60 },
      ];
      rows.sort((a, b) => compare(a, b, { key: "score", direction: "desc" }));
      // Non-null values first (80, 60, 30), then nulls
      expect(rows[0].score).toBe(80);
      expect(rows[1].score).toBe(60);
      expect(rows[2].score).toBe(30);
      expect(rows[3].score).toBeNull();
      expect(rows[4].score).toBeNull();
    });

    it("sorts ascending with nulls at end", () => {
      const rows: TestRow[] = [
        { name: "A", value: 1, score: null },
        { name: "B", value: 2, score: 80 },
        { name: "C", value: 3, score: 30 },
        { name: "D", value: 4, score: null },
      ];
      rows.sort((a, b) => compare(a, b, { key: "score", direction: "asc" }));
      // Non-null values first ascending (30, 80), then nulls
      expect(rows[0].score).toBe(30);
      expect(rows[1].score).toBe(80);
      expect(rows[2].score).toBeNull();
      expect(rows[3].score).toBeNull();
    });
  });

  describe("undefined values", () => {
    it("treats undefined the same as null", () => {
      const compareUndef = createTableComparator<"val", { val: number | undefined }>({
        val: (r) => r.val,
      });
      const rows = [{ val: undefined }, { val: 5 }];
      rows.sort((a, b) => compareUndef(a, b, { key: "val", direction: "asc" }));
      expect(rows[0].val).toBe(5);
      expect(rows[1].val).toBeUndefined();
    });
  });

  describe("unknown sort key", () => {
    it("returns 0 for an unrecognized key", () => {
      const result = compare(
        { name: "A", value: 1, score: null },
        { name: "B", value: 2, score: null },
        { key: "unknown" as "name", direction: "asc" },
      );
      expect(result).toBe(0);
    });
  });
});
