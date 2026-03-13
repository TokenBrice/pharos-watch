import { describe, it, expect } from "vitest";
import { createTableComparator } from "../table-comparator";

interface TestRow { name: string; value: number; label: string; }

describe("createTableComparator", () => {
  const compare = createTableComparator<TestRow, "name" | "value">({
    name: (r) => r.name,
    value: (r) => r.value,
  });

  it("sorts by numeric field ascending", () => {
    const rows: TestRow[] = [
      { name: "B", value: 20, label: "" },
      { name: "A", value: 10, label: "" },
    ];
    rows.sort((a, b) => compare(a, b, { key: "value", direction: "asc" }));
    expect(rows[0].value).toBe(10);
  });

  it("sorts by string field descending", () => {
    const rows: TestRow[] = [
      { name: "A", value: 10, label: "" },
      { name: "B", value: 20, label: "" },
    ];
    rows.sort((a, b) => compare(a, b, { key: "name", direction: "desc" }));
    expect(rows[0].name).toBe("B");
  });

  it("handles null/undefined values", () => {
    const nullCompare = createTableComparator<{ v: number | null }, "v">({
      v: (r) => r.v ?? 0,
    });
    const rows = [{ v: null }, { v: 5 }];
    rows.sort((a, b) => nullCompare(a, b, { key: "v", direction: "asc" }));
    expect(rows[0].v).toBeNull();
  });
});
