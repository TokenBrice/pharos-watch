import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeGscPerformanceInputs,
  renderGscPerformanceReport,
  runCli,
} from "../maintenance/analyze-gsc-performance.mjs";
import { writeStoredZip } from "./helpers/gsc-zip";

function fixtureDir() {
  return mkdtempSync(join(tmpdir(), "pharos-gsc-performance-"));
}

describe("analyze-gsc-performance", () => {
  it("aggregates page-family CTR gaps and query opportunities from GSC exports", async () => {
    const root = fixtureDir();
    writeFileSync(
      join(root, "Pages.csv"),
      [
        "Exported from Google Search Console",
        "Top pages,Clicks,Impressions,CTR,Position",
        'https://pharos.watch/,230,"5,000",4.60%,2.4',
        'https://pharos.watch/stablecoin/usdc-circle/?utm_source=search,20,"1,000",2.00%,6.2',
        "https://pharos.watch/chains/ethereum/,10,200,5.00%,3.4",
        "https://pharos.watch/coverage/,1,80,1.25%,6.0",
        "https://pharos.watch/compare/,0,120,0%,11.0",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "Queries.csv"),
      ["Top queries,Clicks,Impressions,CTR,Position", '"usdc stablecoin",10,"1,000",1.00%,7.2'].join("\n"),
    );

    const report = await analyzeGscPerformanceInputs([root], {
      targetCtr: 0.045,
      minImpressions: 100,
      topCount: 10,
    });
    const rendered = renderGscPerformanceReport(report);

    expect(report.parsedFileCounts).toMatchObject({
      performance: 2,
      pageRows: 5,
      queryOnlyRows: 1,
    });
    expect(report.families).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          family: "stablecoin-detail",
          pageCount: 1,
          clicks: 20,
          impressions: 1000,
          targetClickGap: 25,
        }),
      ]),
    );
    expect(report.priorityPages[0]).toMatchObject({
      path: "/stablecoin/usdc-circle/",
      family: "stablecoin-detail",
      targetClickGap: 25,
      queryKeys: ["utm_source"],
    });
    expect(report.lowSamplePages[0]).toMatchObject({
      path: "/coverage/",
      family: "dashboard",
      targetClickGap: 3,
    });
    expect(report.priorityPages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/compare/",
          family: "non-indexable-or-retired",
          targetClickGap: 6,
        }),
      ]),
    );
    expect(report.queryOpportunities[0]).toMatchObject({
      query: "usdc stablecoin",
      targetClickGap: 35,
    });
    expect(rendered).toContain("GSC Performance CTR Inventory");
    expect(rendered).toContain("Target CTR: 4.50%");
    expect(rendered).toContain("/stablecoin/usdc-circle/");
    expect(rendered).toContain("queryKeys=utm_source");
    expect(rendered).toContain("labels=noncanonical-query,quick-win");
    expect(rendered).toContain("possible-noindex/retired");
    expect(rendered).toContain("Low-sample pages below target");
    expect(rendered).toContain("usdc stablecoin");
  });

  it("accepts ZIP exports and reports unsupported spreadsheet files without live checks", async () => {
    const root = fixtureDir();
    const zipPath = join(root, "performance.zip");
    writeStoredZip(zipPath, {
      "Performance/Pages.csv": [
        "Page,Clicks,Impressions,CTR,Position",
        "https://pharos.watch/stablecoins/usd/,1,500,0.20%,9.5",
      ].join("\n"),
    });
    writeFileSync(join(root, "performance.xlsx"), "not parsed");

    const report = await analyzeGscPerformanceInputs([root], {
      targetCtr: 0.05,
      minImpressions: 100,
      topCount: 5,
    });

    expect(report.notes).toEqual(
      expect.arrayContaining([expect.stringContaining("XLSX/XLS parsing is unsupported without adding a dependency")]),
    );
    expect(report.priorityPages).toEqual([
      expect.objectContaining({
        path: "/stablecoins/usd/",
        family: "peg-taxonomy-detail",
        targetClickGap: 24,
      }),
    ]);
  });

  it("truncates decimal counts and clamps negative performance values", async () => {
    const root = fixtureDir();
    writeFileSync(
      join(root, "Pages.csv"),
      [
        "Page,Clicks,Impressions,CTR,Position",
        "https://pharos.watch/stablecoin/euro-fixture/,-2.9,100.9,1%,8",
      ].join("\n"),
    );

    const report = await analyzeGscPerformanceInputs([root], {
      targetCtr: 0.05,
      minImpressions: 1,
      topCount: 5,
    });

    expect(report.priorityPages[0]).toMatchObject({ clicks: 0, impressions: 100, targetClickGap: 5 });
  });

  it("parses CLI CTR options as percentages", async () => {
    const root = fixtureDir();
    writeFileSync(
      join(root, "Pages.csv"),
      ["Top pages,Clicks,Impressions,CTR,Position", "https://pharos.watch/stablecoin/tether-usdt/,1,100,1%,8"].join(
        "\n",
      ),
    );
    let stdout = "";
    let stderr = "";

    const code = await runCli(
      ["--target-ctr=5%", "--min-impressions=50", "--top=1", root],
      { write: (chunk: string) => (stdout += chunk) },
      { write: (chunk: string) => (stderr += chunk) },
    );

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Target CTR: 5.00%");
    expect(stdout).toContain("targetClickGap=4");
  });

  it("rejects zero for positive integer CLI options", async () => {
    for (const option of ["--top=0", "--min-impressions=0"]) {
      await expect(runCli(
        [option, "/tmp/missing-gsc-export"],
        { write: () => undefined },
        { write: () => undefined },
      )).rejects.toThrow(`Invalid ${option.split("=")[0]}: 0`);
    }
  });

  it.each([
    { argv: ["--help"], expectedCode: 0, stream: "stdout", text: "Usage: npm run analyze:gsc-performance" },
    { argv: ["--unknown"], expectedCode: 1, stream: "stderr", text: "Unknown option: --unknown" },
    { argv: [], expectedCode: 1, stream: "stderr", text: "Usage: npm run analyze:gsc-performance" },
  ])("handles $stream CLI diagnostics", async ({ argv, expectedCode, stream, text }) => {
    let stdout = "";
    let stderr = "";
    const code = await runCli(
      argv,
      { write: (chunk: string) => (stdout += chunk) },
      { write: (chunk: string) => (stderr += chunk) },
    );

    expect(code).toBe(expectedCode);
    expect(stream === "stdout" ? stdout : stderr).toContain(text);
  });
});
