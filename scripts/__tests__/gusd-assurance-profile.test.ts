import { describe, expect, it } from "vitest";
import { PROFILE } from "../lib/independent-assurance-profiles/gusd";

// Extracted layout of the September 2026 examination: two examined columns,
// with footnote markers printed inline beside the row labels.
const table = `
                                      September 9, 2026         September 30, 2026
    GUSD issued and in circulation1       39,271,895.43              38,378,754.40

    Market value of the reserve 2:
    Cash deposits held at U.S. regulated
    financial institutions              $   40,042,781.84         $      39,246,582.59
    Net cash receivable (payable) due to
    timing and settlement differences 3        (770,886.41)                 (867,828.19)

    Total Reserve                       $   39,271,895.43         $      38,378,754.40
`;

function extracted(pattern: RegExp, text = table): string | undefined {
  const raw = text.match(pattern)?.[1];
  return raw == null ? undefined : PROFILE.normalizeAmount!(raw);
}

const columnOrder = PROFILE.requiredText.find((check) => check.label === "examined column order")!;

describe("GUSD September examination extraction", () => {
  it("extracts every latest-column amount without subtracting the payable twice", () => {
    expect(PROFILE.assetRows.map((row) => extracted(row.pattern))).toEqual(["38378754.40"]);
    expect(PROFILE.liabilityRows.map((row) => extracted(row.pattern))).toEqual(["38378754.40"]);
    expect(PROFILE.adjustments!.map((row) => extracted(row.pattern))).toEqual(["-867828.19"]);
    expect(PROFILE.reportedTotals.map((row) => extracted(row.pattern))).toEqual([
      "39246582.59", "-867828.19", "38378754.40", "38378754.40",
    ]);
  });

  it("does not mix the earlier examined instant into month-end accounting", () => {
    const earlierChanged = table
      .replaceAll("39,271,895.43", "1,234,567.89")
      .replace("40,042,781.84", "1,334,567.89")
      .replace("770,886.41", "100,000.00");
    expect(PROFILE.reportedTotals.map((row) => extracted(row.pattern, earlierChanged))).toEqual([
      "39246582.59", "-867828.19", "38378754.40", "38378754.40",
    ]);
  });

  it("rejects reversed or missing month-end column headers", () => {
    expect(columnOrder.pattern.test(table)).toBe(true);
    expect(columnOrder.pattern.test(table.replace(
      "September 9, 2026         September 30, 2026",
      "September 30, 2026         September 9, 2026",
    ))).toBe(false);
    expect(columnOrder.pattern.test(table.replace("September 30, 2026", "October 31, 2026"))).toBe(false);
  });

  it("withholds settlement extraction when a signed examined column is missing", () => {
    const pattern = PROFILE.adjustments![0].pattern;
    expect(extracted(pattern, table.replace("(770,886.41)", "770,886.41"))).toBeUndefined();
    expect(extracted(pattern, table.replace("(867,828.19)", "867,828.19"))).toBeUndefined();
    expect(extracted(pattern, table.replace("(770,886.41)", ""))).toBeUndefined();
  });
});
