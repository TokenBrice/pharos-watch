import { describe, expect, it } from "vitest";
import { COLUMN_FIT_DROP_ORDER, fitColumnsToWidth } from "@/lib/stablecoin-table-fit";
import { ALL_COLUMNS, DEFAULT_VISIBLE_COLUMNS, type ColumnId } from "@/lib/column-visibility";

// Mirrors the default-variant COLUMN_MIN_WIDTH_PX map in stablecoin-table.tsx.
const WIDTHS: Record<ColumnId, number> = {
  rank: 40,
  name: 168,
  price: 116,
  peg: 92,
  mcap: 144,
  change24h: 92,
  change7d: 144,
  grade: 124,
  stability: 156,
  liquidity: 104,
  blacklistable: 124,
  mintAuthority: 160,
  backing: 92,
  type: 92,
  flags: 72,
};
const getColumnWidth = (id: ColumnId) => WIDTHS[id];

function fit(containerWidth: number, intent: readonly ColumnId[] = DEFAULT_VISIBLE_COLUMNS, fixedWidth = 0) {
  return fitColumnsToWidth({ intent, containerWidth, getColumnWidth, fixedWidth });
}

describe("fitColumnsToWidth", () => {
  it("passes intent through untouched when unmeasured (width 0)", () => {
    const result = fit(0);
    expect(result.rendered).toEqual([...DEFAULT_VISIBLE_COLUMNS]);
    expect(result.hiddenByFit).toEqual([]);
  });

  it("renders everything when the container is wide enough", () => {
    const total = DEFAULT_VISIBLE_COLUMNS.reduce((sum, id) => sum + WIDTHS[id], 0);
    const result = fit(total);
    expect(result.hiddenByFit).toEqual([]);
  });

  it("drops columns in priority order, least essential first", () => {
    const total = DEFAULT_VISIBLE_COLUMNS.reduce((sum, id) => sum + WIDTHS[id], 0);
    // Just too narrow for the full set: exactly one drop needed. flags is not in
    // the default set, so "type" is the first eligible drop.
    const result = fit(total - 1);
    expect(result.hiddenByFit).toEqual(["type"]);
    expect(result.rendered).not.toContain("type");
    expect(result.rendered).toContain("backing");
  });

  it("keeps the essential identity/market floor at tablet widths", () => {
    // 1024 viewport minus page gutters ≈ 976.
    const result = fit(976);
    for (const id of ["rank", "name", "price", "peg", "mcap"] as const) {
      expect(result.rendered).toContain(id);
    }
    const renderedWidth = result.rendered.reduce((sum, id) => sum + WIDTHS[id], 0);
    expect(renderedWidth).toBeLessThanOrEqual(976);
  });

  it("never drops columns outside the drop order, even at absurdly narrow widths", () => {
    const result = fit(100);
    expect(result.rendered).toEqual(
      DEFAULT_VISIBLE_COLUMNS.filter((id) => !COLUMN_FIT_DROP_ORDER.includes(id)),
    );
  });

  it("accounts for fixed chrome width (pinned star column)", () => {
    const total = DEFAULT_VISIBLE_COLUMNS.reduce((sum, id) => sum + WIDTHS[id], 0);
    const withoutChrome = fit(total);
    const withChrome = fit(total, DEFAULT_VISIBLE_COLUMNS, 56);
    expect(withoutChrome.hiddenByFit).toEqual([]);
    expect(withChrome.hiddenByFit.length).toBeGreaterThan(0);
  });

  it("preserves the intent's column order in the rendered set", () => {
    const result = fit(976);
    const canonical = ALL_COLUMNS.map((column) => column.id).filter((id) => result.rendered.includes(id));
    expect(result.rendered).toEqual(canonical);
  });

  it("respects a user-narrowed intent without re-adding columns", () => {
    const intent: ColumnId[] = ["rank", "name", "price", "mcap", "grade"];
    const result = fit(2000, intent);
    expect(result.rendered).toEqual(intent);
  });
});
