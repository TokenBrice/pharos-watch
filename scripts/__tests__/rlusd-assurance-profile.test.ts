import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { getIndependentAssuranceManifest } from "@shared/lib/independent-assurance";
import { MANIFEST_SOURCES } from "../../shared/data/live-reserves/independent-assurance";
import { COMPILER_PROFILES } from "../lib/independent-assurance-profiles/registry";
import { PROFILE } from "../lib/independent-assurance-profiles/rlusd";
import { prepareAssuranceExtractionText } from "../lib/independent-assurance-profiles/shared";

const popplerAvailable = spawnSync("pdftotext", ["-v"]).status === 0 && spawnSync("pdfinfo", ["-v"]).status === 0;

describe("RLUSD reviewed offline compiler", () => {
  it("keeps runtime manifests and offline compiler key sets in exact parity", () => {
    expect(Object.keys(COMPILER_PROFILES).sort()).toEqual(Object.keys(MANIFEST_SOURCES).sort());
  });
  it("rejects a reversed examined-column header rather than blending periods", () => {
    const check = PROFILE.requiredText.find((entry) => entry.label === "month-end column order")!;
    expect(check.pattern.test("August 31, 2026 August 17, 2026")).toBe(false);
  });

  describe.skipIf(!popplerAvailable)("PDF extraction (requires optional Poppler pdftotext and pdfinfo)", () => {
    let artifact: Parameters<typeof prepareAssuranceExtractionText>[1];

    beforeAll(() => {
      const pdf = fileURLToPath(new URL("./fixtures/rlusd-august-2026.pdf", import.meta.url));
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
      const prepared = prepareAssuranceExtractionText(PROFILE, artifact);
      for (const check of PROFILE.requiredText) expect(check.pattern.test(prepared), check.label).toBe(true);
      for (const check of PROFILE.rejectedText) expect(check.pattern.test(prepared), check.label).toBe(false);
      for (const [rows, amounts] of [[PROFILE.assetRows, manifest.assets], [PROFILE.liabilityRows, manifest.liabilities]] as const) {
        expect(rows.map((row) => prepared.match(row.pattern)?.[1]?.replaceAll(",", "")))
          .toEqual(amounts.map((row) => row.amount));
        expect(rows.map(({ code, label }) => ({ code, label }))).toEqual(amounts.map(({ code, label }) => ({ code, label })));
      }
      for (const total of PROFILE.reportedTotals) expect(prepared.match(total.pattern)?.[1]?.replaceAll(",", ""), total.label).toBe(total.expected);
      for (const field of ["product", "profile", "officialIndexUrl", "reportUrl", "reportDate", "reportAsOf", "reportTimeZone", "reportIssuedAt", "attestor", "engagement", "conclusion", "unit", "reportedAssetTotal", "computedAssetTotal", "reportedLiabilityTotal"] as const) {
        expect(PROFILE[field], field).toBe(manifest[field]);
      }
      expect(artifact.reportSha256).toBe(manifest.reportSha256);
      expect(artifact.normalizedTextSha256).toBe(manifest.extraction.normalizedTextSha256);
    });
    it.each(["reportSha256", "reportByteLength", "normalizedTextSha256", "pageCount"] as const)("refuses image transcription when %s changes", (key) => {
      const changed = { ...artifact, [key]: typeof artifact[key] === "number" ? artifact[key] + 1 : "changed" };
      expect(() => prepareAssuranceExtractionText(PROFILE, changed)).toThrow(/re-review the report/);
    });
  });
});
