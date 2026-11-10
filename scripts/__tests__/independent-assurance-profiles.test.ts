import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { getIndependentAssuranceManifest } from "@shared/lib/independent-assurance";
import { PROFILE as gusd } from "../lib/independent-assurance-profiles/gusd";
import { PROFILE as myrc } from "../lib/independent-assurance-profiles/myrc";
import { PROFILE as rlusd } from "../lib/independent-assurance-profiles/rlusd";
import { prepareAssuranceExtractionText } from "../lib/independent-assurance-profiles/shared";

// Extracted layout of the September 2026 examination: two examined columns,
// with footnote markers printed inline beside the row labels.
const headers = "September 9, 2026         September 30, 2026";
const table = `
${headers}
GUSD issued and in circulation1    39,271,895.43    38,378,754.40
Market value of the reserve 2:
Cash deposits held at U.S. regulated
financial institutions    $ 40,042,781.84    $ 39,246,582.59
Net cash receivable (payable) due to
timing and settlement differences 3    (770,886.41)    (867,828.19)
Total Reserve    $ 39,271,895.43    $ 38,378,754.40
`;
const monthEndTotals = ["39246582.59", "-867828.19", "38378754.40", "38378754.40"];

function extracted(pattern: RegExp, text = table): string | undefined {
  const raw = text.match(pattern)?.[1];
  return raw == null ? undefined : gusd.normalizeAmount!(raw);
}

const columnOrder = gusd.requiredText.find((check) => check.label === "examined column order")!;

describe("GUSD September examination extraction", () => {
  it("extracts every latest-column amount without subtracting the payable twice", () => {
    expect(gusd.assetRows.map((row) => extracted(row.pattern))).toEqual(["38378754.40"]);
    expect(gusd.liabilityRows.map((row) => extracted(row.pattern))).toEqual(["38378754.40"]);
    expect(gusd.adjustments!.map((row) => extracted(row.pattern))).toEqual(["-867828.19"]);
    expect(gusd.reportedTotals.map((row) => extracted(row.pattern))).toEqual(monthEndTotals);
  });

  it("does not mix the earlier examined instant into month-end accounting", () => {
    const earlierChanged = table
      .replaceAll("39,271,895.43", "1,234,567.89")
      .replace("40,042,781.84", "1,334,567.89")
      .replace("770,886.41", "100,000.00");
    expect(gusd.reportedTotals.map((row) => extracted(row.pattern, earlierChanged))).toEqual(monthEndTotals);
  });

  it("rejects reversed or missing month-end column headers", () => {
    expect(columnOrder.pattern.test(table)).toBe(true);
    expect(columnOrder.pattern.test(table.replace(
      headers,
      "September 30, 2026         September 9, 2026",
    ))).toBe(false);
    expect(columnOrder.pattern.test(table.replace("September 30, 2026", "October 31, 2026"))).toBe(false);
  });

  it.each([
    ["(770,886.41)", "770,886.41"],
    ["(867,828.19)", "867,828.19"],
    ["(770,886.41)", ""],
  ])("withholds settlement extraction when signed column %s becomes %s", (before, after) => {
    expect(extracted(gusd.adjustments![0].pattern, table.replace(before, after))).toBeUndefined();
  });
});

const text = readFileSync(new URL("../../worker/src/cron/reserve-adapters/__tests__/fixtures/myrc-report-2026-08.txt", import.meta.url), "utf8");
function amount(pattern: RegExp, source = text) {
  return source.match(pattern)?.[1]?.replaceAll(",", "");
}

describe("MYRC examined schedule extraction", () => {
  it("extracts actual cash/fund and net-circulation amounts without deducting authorized tokens twice", () => {
    expect(myrc.assetRows.map((row) => amount(row.pattern))).toEqual(["1200903.77", "600000.00"]);
    expect(myrc.liabilityRows.map((row) => amount(row.pattern))).toEqual(["1800903.74"]);
    expect(myrc.adjustments?.map((row) => amount(row.pattern))).toEqual(["4564394.91"]);
    expect(myrc.reportedTotals.map((row) => amount(row.pattern))).toEqual(myrc.reportedTotals.map((row) => row.expected));
    expect(myrc.requiredText.every((check) => check.pattern.test(text))).toBe(true);
    expect(myrc.rejectedText.some((check) => check.pattern.test(text))).toBe(false);
    expect(myrc).not.toHaveProperty("reportIssuedAt");
  });

  it.each([
    ["31 August 2026 at 11:59 PM GMT+8", "30 September 2026 at 11:59 PM GMT+8"],
    ["Malaysian Ringgit Coin (“MYRC”)", "Malaysian Ringgit Coin (“OTHER”)"],
    ["is fairly stated", "is not fairly stated"],
    ["AF 002378", "AF 999999"],
    ["6,365,298.65", "6,365,299.65"],
  ])("rejects changed examined identity, period or criterion: %s", (before, after) => {
    const changed = text.replaceAll(before, after);
    expect(myrc.requiredText.every((check) => check.pattern.test(changed))).toBe(false);
  });

  it("detects changed accounting totals instead of flattening the reported/breakdown difference", () => {
    const changed = text.replaceAll("1,800,903.77", "1,800,903.78");
    expect(myrc.reportedTotals.some((row) => amount(row.pattern, changed) !== row.expected)).toBe(true);
    expect(myrc.reportedAssetTotal).toBe("1800903.74");
    expect(myrc.computedAssetTotal).toBe("1800903.77");
  });

  it("withholds a renamed fund category and an absent examination extraction", () => {
    expect(amount(myrc.assetRows[1].pattern, text.replace("Halogen Shariah MYR Liquid", "Unreviewed Asset"))).toBeUndefined();
    expect(myrc.requiredText.every((check) => check.pattern.test(""))).toBe(false);
  });
});

const popplerAvailable = spawnSync("pdftotext", ["-v"]).status === 0 && spawnSync("pdfinfo", ["-v"]).status === 0;

describe("RLUSD reviewed offline compiler", () => {
  it("rejects a reversed examined-column header rather than blending periods", () => {
    const check = rlusd.requiredText.find((entry) => entry.label === "month-end column order")!;
    expect(check.pattern.test("September 30, 2026 September 21, 2026")).toBe(false);
  });

  describe.skipIf(!popplerAvailable)("PDF extraction (requires optional Poppler pdftotext and pdfinfo)", () => {
    let artifact: Parameters<typeof prepareAssuranceExtractionText>[1];

    beforeAll(() => {
      const pdf = fileURLToPath(new URL("./fixtures/rlusd-september-2026.pdf", import.meta.url));
      const bytes = readFileSync(pdf);
      const text = execFileSync("pdftotext", ["-layout", pdf, "-"], { encoding: "utf8" });
      const pageCount = Number(execFileSync("pdfinfo", [pdf], { encoding: "utf8" }).match(/^Pages:\s+(\d+)/m)?.[1]);
      artifact = {
        reportSha256: createHash("sha256").update(bytes).digest("hex"), reportByteLength: bytes.length,
        normalizedTextSha256: createHash("sha256").update(text).digest("hex"), pageCount, text,
      };
    });

    it("extracts only the reviewed month-end book from exact PDF bytes", () => {
      const manifest = getIndependentAssuranceManifest("RLUSD");
      const prepared = prepareAssuranceExtractionText(rlusd, artifact);
      for (const check of rlusd.requiredText) expect(check.pattern.test(prepared), check.label).toBe(true);
      for (const check of rlusd.rejectedText) expect(check.pattern.test(prepared), check.label).toBe(false);
      for (const [rows, amounts] of [[rlusd.assetRows, manifest.assets], [rlusd.liabilityRows, manifest.liabilities]] as const) {
        expect(rows.map((row) => prepared.match(row.pattern)?.[1]?.replaceAll(",", "")))
          .toEqual(amounts.map((row) => row.amount));
        expect(rows.map(({ code, label }) => ({ code, label }))).toEqual(amounts.map(({ code, label }) => ({ code, label })));
      }
      for (const total of rlusd.reportedTotals) expect(prepared.match(total.pattern)?.[1]?.replaceAll(",", ""), total.label).toBe(total.expected);
      for (const field of ["product", "profile", "officialIndexUrl", "reportUrl", "reportDate", "reportAsOf", "reportTimeZone", "reportIssuedAt", "attestor", "engagement", "conclusion", "unit", "reportedAssetTotal", "computedAssetTotal", "reportedLiabilityTotal"] as const) {
        expect(rlusd[field], field).toBe(manifest[field]);
      }
      expect(artifact.reportSha256).toBe(manifest.reportSha256);
      expect(artifact.normalizedTextSha256).toBe(manifest.extraction.normalizedTextSha256);
    });
    it.each(["reportSha256", "reportByteLength", "normalizedTextSha256", "pageCount"] as const)("refuses image transcription when %s changes", (key) => {
      const changed = { ...artifact, [key]: typeof artifact[key] === "number" ? artifact[key] + 1 : "changed" };
      expect(() => prepareAssuranceExtractionText(rlusd, changed)).toThrow(/re-review the report/);
    });
  });
});
