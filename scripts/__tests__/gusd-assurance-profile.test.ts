import { describe, expect, it } from "vitest";
import { PROFILE } from "../lib/independent-assurance-profiles/gusd";

// Poppler layout preserves the report's two examined columns and places the
// settlement footnote marker on a separate line before the row continuation.
const table = `
    August 11, 2026           August 31, 2026
1
    GUSD issued and in circulation       39,754,933.34       39,573,881.00
    Market value of the reserve:
    Cash deposits held at U.S. regulated
    financial institutions              $ 40,445,937.02     $ 40,344,765.86
    Net cash receivable (payable) due to
3
    timing and settlement differences      (691,003.68)        (770,884.86)
    Total Reserve                       $ 39,754,933.34     $ 39,573,881.00
`;

function extracted(pattern: RegExp, text = table): string | undefined {
  const raw = text.match(pattern)?.[1];
  return raw == null ? undefined : PROFILE.normalizeAmount!(raw);
}

const columnOrder = PROFILE.requiredText.find((check) => check.pattern.test(table))!;

describe("GUSD August examination extraction", () => {
  it("extracts every latest-column amount without subtracting the payable twice", () => {
    expect(PROFILE.assetRows.map((row) => extracted(row.pattern))).toEqual(["39573881.00"]);
    expect(PROFILE.liabilityRows.map((row) => extracted(row.pattern))).toEqual(["39573881.00"]);
    expect(PROFILE.adjustments!.map((row) => extracted(row.pattern))).toEqual(["-770884.86"]);
    expect(PROFILE.reportedTotals.map((row) => extracted(row.pattern))).toEqual([
      "40344765.86", "-770884.86", "39573881.00", "39573881.00",
    ]);
  });

  it("does not mix the earlier examined instant into month-end accounting", () => {
    const earlierChanged = table
      .replaceAll("39,754,933.34", "1,234,567.89")
      .replace("40,445,937.02", "1,334,567.89")
      .replace("691,003.68", "100,000.00");
    expect(PROFILE.reportedTotals.map((row) => extracted(row.pattern, earlierChanged))).toEqual([
      "40344765.86", "-770884.86", "39573881.00", "39573881.00",
    ]);
  });

  it("rejects reversed or missing month-end column headers", () => {
    expect(columnOrder.pattern.test(table)).toBe(true);
    expect(columnOrder.pattern.test(table.replace(
      "August 11, 2026           August 31, 2026",
      "August 31, 2026           August 11, 2026",
    ))).toBe(false);
    expect(columnOrder.pattern.test(table.replace("August 31, 2026", "September 30, 2026"))).toBe(false);
  });

  it("withholds settlement extraction when a signed examined column is missing", () => {
    const pattern = PROFILE.adjustments![0].pattern;
    expect(extracted(pattern, table.replace("(691,003.68)", "691,003.68"))).toBeUndefined();
    expect(extracted(pattern, table.replace("(770,884.86)", "770,884.86"))).toBeUndefined();
    expect(extracted(pattern, table.replace("(691,003.68)", ""))).toBeUndefined();
  });
});
