import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeGscCoverageInputs, renderGscCoverageReport } from "../analyze-gsc-coverage.mjs";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

async function analyze(counts: string[]) {
  const directory = mkdtempSync(path.join(tmpdir(), "gsc-coverage-"));
  directories.push(directory);
  writeFileSync(path.join(directory, "Critical issues.csv"),
    `Reason,Pages,Source\n${counts.map((count) => `Not found,${count},Website`).join("\n")}\n`);
  writeFileSync(path.join(directory, "Table.csv"), "URL\nhttps://pharos.watch/stablecoin/usdt-tether/?view=all\n");
  return analyzeGscCoverageInputs([directory]);
}

describe("GSC affected-page completeness", () => {
  it.each([
    ["missing", ["100", ""]],
    ["malformed", ["100", "unavailable"]],
    ["malformed numeric text", ["100", "12bad"]],
  ])("keeps known plus %s counts unknown without losing URL evidence", async (_label, counts) => {
    const report = await analyze(counts);
    const issue = report.issueCounts[0];
    expect(issue).toMatchObject({ pages: null, pagesComplete: false, knownPagesSubtotal: 100,
      pagesUnavailableReason: "missing-or-malformed-page-count", hasAffectedPages: true });
    expect(issue.rows.map((row: { raw: Record<string, string> }) => row.raw.Pages)).toEqual(counts);
    expect(issue.rows.map((row: { rowIndex: number }) => row.rowIndex)).toEqual([2, 3]);
    expect(issue.rows.every((row: { sourceLabel: string }) => row.sourceLabel.endsWith("Critical issues.csv"))).toBe(true);
    expect(report.urlGroups[0].key).toBe("/stablecoin/usdt-tether/?view");
    expect(renderGscCoverageReport(report)).toContain("pages=unknown | exportRows=2 | knownPagesSubtotal=100 (partial)");
    expect(renderGscCoverageReport(report)).not.toContain("pages=100 |");
  });

  it("renders all-missing counts as unknown rather than zero", async () => {
    const report = await analyze(["", ""]);
    expect(report.issueCounts[0]).toMatchObject({ pages: null, pagesComplete: false, knownPagesSubtotal: 0 });
    expect(renderGscCoverageReport(report)).toContain("pages=unknown");
    expect(report.missingDrilldowns).toHaveLength(1);
  });

  it("retains explicit zero alongside known counts and in an all-zero issue", async () => {
    const known = await analyze(["100", "0"]);
    expect(known.issueCounts[0]).toMatchObject({ pages: 100, pagesComplete: true, pagesUnavailableReason: null });
    expect(renderGscCoverageReport(known)).toContain("pages=100 | exportRows=2");
    const zero = await analyze(["0", "0"]);
    expect(zero.issueCounts[0]).toMatchObject({ pages: 0, pagesComplete: true, hasAffectedPages: false });
    expect(zero.missingDrilldowns).toEqual([]);
    expect(renderGscCoverageReport(zero)).toContain("pages=0 | exportRows=2");
  });

  it("does not treat a missing row beside explicit zero as unaffected", async () => {
    const report = await analyze(["0", ""]);
    expect(report.issueCounts[0]).toMatchObject({ pages: null, hasAffectedPages: true });
    expect(report.missingDrilldowns).toHaveLength(1);
  });
});
