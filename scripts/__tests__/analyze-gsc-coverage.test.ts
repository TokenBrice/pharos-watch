import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeGscCoverageInputs, renderGscCoverageReport, runCli } from "../maintenance/analyze-gsc-coverage.mjs";
import { writeStoredZip } from "./helpers/gsc-zip";

function fixtureDir() {
  return mkdtempSync(join(tmpdir(), "pharos-gsc-coverage-"));
}

describe("analyze-gsc-coverage", () => {
  it("maps drilldown zips to issue rows and groups URLs by path/query key", async () => {
    const root = fixtureDir();
    const coverageDir = join(root, "coverage-export");
    mkdirSync(coverageDir);
    writeFileSync(
      join(coverageDir, "Non-critical issues.csv"),
      ["Reason,Source,Validation,Trend,Pages", '"Crawled - currently not indexed",Website,Not Started,Flat,3'].join(
        "\n",
      ),
    );
    writeStoredZip(join(root, "Crawled - currently not indexed.zip"), {
      "Metadata.csv": "Field,Value\nReason,Crawled - currently not indexed\n",
      "Table.csv": [
        "URL,Last crawled",
        "https://pharos.watch/stablecoins/usdc?utm_source=alpha,2026-05-30",
        "https://pharos.watch/stablecoins/usdc?utm_source=beta,2026-05-30",
        "https://pharos.watch/stablecoins/dai?ref=nav&utm_source=alpha,2026-05-30",
      ].join("\n"),
    });

    const report = await analyzeGscCoverageInputs([coverageDir, join(root, "Crawled - currently not indexed.zip")]);
    const rendered = renderGscCoverageReport(report);

    expect(report.drilldowns).toHaveLength(1);
    expect(report.drilldowns[0]).toMatchObject({
      issueName: "Crawled - currently not indexed",
      urlCount: 3,
    });
    expect(report.missingDrilldowns).toEqual([]);
    expect(report.urlGroups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "/stablecoins/usdc?utm_source",
          urls: [
            "https://pharos.watch/stablecoins/usdc?utm_source=alpha",
            "https://pharos.watch/stablecoins/usdc?utm_source=beta",
          ],
        }),
        expect.objectContaining({
          key: "/stablecoins/dai?ref&utm_source",
          urls: ["https://pharos.watch/stablecoins/dai?ref=nav&utm_source=alpha"],
        }),
      ]),
    );
    expect(rendered).toContain("Crawled - currently not indexed | urls=3 | pathQueryGroups=2 | matchedIssue=yes");
    expect(rendered).toContain("No live network checks were performed.");
  });

  it("reports missing drilldowns for affected issue rows without URL tables", async () => {
    const root = fixtureDir();
    writeFileSync(
      join(root, "Critical issues.csv"),
      [
        "Reason,Source,Validation,Trend,Pages",
        '"Blocked due to access forbidden (403)",Website,Not Started,Rising,2',
        '"Server error (5xx)",Website,Passed,Flat,-2.9',
      ].join("\n"),
    );
    writeStoredZip(join(root, "Page with redirect.zip"), {
      "Metadata.csv": "Field,Value\nReason,Page with redirect\n",
      "Table.csv": "URL\nhttps://pharos.watch/old-page\n",
    });
    writeFileSync(join(root, "coverage.xlsx"), "not parsed");

    const report = await analyzeGscCoverageInputs([root]);
    const rendered = renderGscCoverageReport(report);

    expect(report.missingDrilldowns).toEqual([
      expect.objectContaining({
        issueName: "Blocked due to access forbidden (403)",
        pages: 2,
      }),
    ]);
    expect(report.missingDrilldowns).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ issueName: "Server error (5xx)" })]),
    );
    expect(report.issueCounts).toContainEqual(expect.objectContaining({ issueName: "Server error (5xx)", pages: -2 }));
    expect(report.notes).toEqual(
      expect.arrayContaining([expect.stringContaining("XLSX/XLS parsing is unsupported without adding a dependency")]),
    );
    expect(rendered).toContain(
      "[critical] Blocked due to access forbidden (403) | pages=2 | expected=export matching Table.csv drilldown",
    );
  });

  it("uses standalone CSV filenames as drilldown issue names inside directories", async () => {
    const root = fixtureDir();
    writeFileSync(
      join(root, "Critical issues.csv"),
      ["Reason,Source,Validation,Trend,Pages", '"Crawled - currently not indexed",Google systems,Not Started,Flat,1'].join(
        "\n",
      ),
    );
    writeFileSync(
      join(root, "Crawled - currently not indexed.csv"),
      ["URL,Last crawled", "https://pharos.watch/stablecoin/usdc-circle/,2026-05-30"].join("\n"),
    );

    const report = await analyzeGscCoverageInputs([root]);
    const rendered = renderGscCoverageReport(report);

    expect(report.drilldowns).toEqual([
      expect.objectContaining({
        issueName: "Crawled - currently not indexed",
        urlCount: 1,
      }),
    ]);
    expect(report.missingDrilldowns).toEqual([]);
    expect(rendered).toContain("Crawled - currently not indexed | urls=1 | pathQueryGroups=1 | matchedIssue=yes");
  });

  it.each([
    { argv: ["--help"], expectedCode: 0, stream: "stdout", text: "Usage: npm run analyze:gsc-coverage" },
    { argv: ["--unknown"], expectedCode: 1, stream: "stderr", text: "Unknown option: --unknown" },
    { argv: [], expectedCode: 1, stream: "stderr", text: "Usage: npm run analyze:gsc-coverage" },
  ])("handles $stream CLI diagnostics", async ({ argv, expectedCode, stream, text }) => {
    let stdout = "";
    let stderr = "";
    const code = await runCli(
      argv,
      { write: (chunk: string) => { stdout += chunk; return true; } } as typeof process.stdout,
      { write: (chunk: string) => { stderr += chunk; return true; } } as typeof process.stderr,
    );

    expect(code).toBe(expectedCode);
    expect(stream === "stdout" ? stdout : stderr).toContain(text);
  });
});
