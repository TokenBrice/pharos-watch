import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeGscPerformanceInputs, renderGscPerformanceReport, runCli } from "../analyze-gsc-performance.mjs";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));
const pageCsv = "Page,Clicks,Impressions,Position\n/stablecoin/usdt-tether,100,1000,4\n";
const combinedCsv = "Page,Query,Clicks,Impressions,Position\n/stablecoin/usdt-tether?view=all,stablecoin research,10,100,20\n";

function capture(files: Record<string, string>) {
  const directory = mkdtempSync(path.join(tmpdir(), "gsc-performance-"));
  directories.push(directory);
  for (const [name, content] of Object.entries(files)) {
    const destination = path.join(directory, name);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }
  return directory;
}

function expectMetrics(report: Awaited<ReturnType<typeof analyzeGscPerformanceInputs>>, clicks: number, impressions: number) {
  expect(report.site).toMatchObject({ clicks, impressions });
  expect(report.pages[0]).toMatchObject({ path: "/stablecoin/usdt-tether/", clicks, impressions });
  expect(report.families[0]).toMatchObject({ family: "stablecoin-detail", pageCount: 1, clicks, impressions });
}

describe("GSC performance metric authority", () => {
  it("uses page-only metrics across site, page and family", async () => {
    const report = await analyzeGscPerformanceInputs([capture({ "Pages.csv": pageCsv })]);
    expectMetrics(report, 100, 1000);
    expect(report.pages[0].queryCount).toBe(0);
    expect(report.rows[0]).toMatchObject({ grain: "page" });
    expect(renderGscPerformanceReport(report)).toContain("impressions=1,000 | clicks=100");
  });

  it("aggregates combined-only captures without dropping query opportunities", async () => {
    const report = await analyzeGscPerformanceInputs([capture({ "Combined.csv": combinedCsv +
      "/stablecoin/usdt-tether,stablecoin research,20,200,5\n" })], { targetCtr: 0.2 });
    expectMetrics(report, 30, 300);
    expect(report.site.averagePosition).toBe(10);
    expect(report.pages[0]).toMatchObject({ queryCount: 1, queryKeys: ["view"] });
    expect(report.queryOpportunities[0]).toMatchObject({ query: "stablecoin research", clicks: 30, impressions: 300 });
    expect(report.rows[0].grain).toBe("page-query");
  });

  it("uses same-capture page totals once while retaining detail queries, keys and sources", async () => {
    const directory = capture({ "Pages.csv": pageCsv, "Table.csv": combinedCsv });
    const report = await analyzeGscPerformanceInputs([directory], { targetCtr: 0.2 });
    expectMetrics(report, 100, 1000);
    expect(report.site.averagePosition).toBe(4);
    expect(report.pages[0]).toMatchObject({ queryCount: 1, queryKeys: ["view"] });
    expect(report.pages[0].sources).toHaveLength(2);
    expect(report.queryOpportunities[0]).toMatchObject({ query: "stablecoin research", clicks: 10, impressions: 100 });
    expect(new Set(report.rows.map((row) => row.captureKey)).size).toBe(1);
    expect(renderGscPerformanceReport(report)).toContain("impressions=1,000 | clicks=100");
    expect(renderGscPerformanceReport(report)).not.toContain("impressions=1,100 | clicks=110");
    const explicitFiles = await analyzeGscPerformanceInputs([path.join(directory, "Pages.csv"), path.join(directory, "Table.csv")]);
    expectMetrics(explicitFiles, 100, 1000);
  });

  it("retains metrics for combined pages lacking their own page total", async () => {
    const report = await analyzeGscPerformanceInputs([capture({ "Pages.csv": pageCsv,
      "Combined.csv": combinedCsv + "/stablecoin/usdc-circle,usdc,5,500,8\n" })]);
    expect(report.site).toMatchObject({ clicks: 105, impressions: 1500 });
    expect(report.families[0]).toMatchObject({ pageCount: 2, clicks: 105, impressions: 1500 });
    expect(report.pages.find((page) => page.path === "/stablecoin/usdc-circle/")).toMatchObject({ clicks: 5, impressions: 500 });
  });

  it("keeps separate query totals authoritative over combined query metrics", async () => {
    const report = await analyzeGscPerformanceInputs([capture({ "Pages.csv": pageCsv, "Combined.csv": combinedCsv,
      "Queries.csv": "Query,Clicks,Impressions,Position\nstablecoin research,12,200,7\n" })], { targetCtr: 0.2 });
    expectMetrics(report, 100, 1000);
    expect(report.queries[0]).toMatchObject({ clicks: 12, impressions: 200, averagePosition: 7 });
    expect(report.pages[0].queryCount).toBe(1);
  });

  it("rejects ambiguous multi-capture inputs before rendering numeric output", async () => {
    const first = capture({ "Pages.csv": pageCsv });
    const second = capture({ "Combined.csv": combinedCsv });
    await expect(analyzeGscPerformanceInputs([first, second])).rejects.toThrow("Ambiguous GSC performance captures");
    let stdout = "";
    let stderr = "";
    expect(await runCli([first, second], { write: (text: string) => { stdout += text; } },
      { write: (text: string) => { stderr += text; } })).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("Analyze each export separately");
  });

  it("requires separate analysis even for named disjoint periods rather than discarding combined rows", async () => {
    const directory = capture({ "2026-09/Pages.csv": pageCsv, "2026-10/Combined.csv": combinedCsv });
    await expect(analyzeGscPerformanceInputs([directory])).rejects.toThrow("date-window overlap is not proven");
    expectMetrics(await analyzeGscPerformanceInputs([path.join(directory, "2026-09")]), 100, 1000);
    expectMetrics(await analyzeGscPerformanceInputs([path.join(directory, "2026-10")]), 10, 100);
  });

  it("rejects duplicate page totals instead of double-counting an unproven second observation", async () => {
    await expect(analyzeGscPerformanceInputs([capture({ "Pages.csv": pageCsv, "Pages-copy.csv": pageCsv })]))
      .rejects.toThrow("Ambiguous duplicate page totals");
  });
});
