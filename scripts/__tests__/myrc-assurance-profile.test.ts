import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROFILE } from "../lib/independent-assurance-profiles/myrc";

const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../worker/src/cron/reserve-adapters/__tests__/fixtures/myrc-report-2026-08.txt"), "utf8");
function amount(pattern: RegExp, source = text) {
  return source.match(pattern)?.[1]?.replaceAll(",", "");
}

describe("MYRC examined schedule extraction", () => {
  it("extracts actual cash/fund and net-circulation amounts without deducting authorized tokens twice", () => {
    expect(PROFILE.assetRows.map((row) => amount(row.pattern))).toEqual(["1200903.77", "600000.00"]);
    expect(PROFILE.liabilityRows.map((row) => amount(row.pattern))).toEqual(["1800903.74"]);
    expect(PROFILE.adjustments?.map((row) => amount(row.pattern))).toEqual(["4564394.91"]);
    expect(PROFILE.reportedTotals.map((row) => amount(row.pattern))).toEqual(PROFILE.reportedTotals.map((row) => row.expected));
    expect(PROFILE.requiredText.every((check) => check.pattern.test(text))).toBe(true);
    expect(PROFILE.rejectedText.some((check) => check.pattern.test(text))).toBe(false);
    expect(PROFILE).not.toHaveProperty("reportIssuedAt");
  });

  it.each([
    ["31 August 2026 at 11:59 PM GMT+8", "30 September 2026 at 11:59 PM GMT+8"],
    ["Malaysian Ringgit Coin (“MYRC”)", "Malaysian Ringgit Coin (“OTHER”)"],
    ["is fairly stated", "is not fairly stated"],
    ["AF 002378", "AF 999999"],
    ["6,365,298.65", "6,365,299.65"],
  ])("rejects changed examined identity, period or criterion: %s", (before, after) => {
    const changed = text.replaceAll(before, after);
    expect(PROFILE.requiredText.every((check) => check.pattern.test(changed))).toBe(false);
  });

  it("detects changed accounting totals instead of flattening the reported/breakdown difference", () => {
    const changed = text.replaceAll("1,800,903.77", "1,800,903.78");
    expect(PROFILE.reportedTotals.some((row) => amount(row.pattern, changed) !== row.expected)).toBe(true);
    expect(PROFILE.reportedAssetTotal).toBe("1800903.74");
    expect(PROFILE.computedAssetTotal).toBe("1800903.77");
  });

  it("withholds a renamed fund category and an absent examination extraction", () => {
    expect(amount(PROFILE.assetRows[1].pattern, text.replace("Halogen Shariah MYR Liquid", "Unreviewed Asset"))).toBeUndefined();
    expect(PROFILE.requiredText.every((check) => check.pattern.test(""))).toBe(false);
  });
});
