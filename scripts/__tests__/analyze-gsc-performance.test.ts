import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeGscPerformanceInputs,
  renderGscPerformanceReport,
  runCli,
} from "../maintenance/analyze-gsc-performance.mjs";

function fixtureDir() {
  return mkdtempSync(join(tmpdir(), "pharos-gsc-performance-"));
}

function writeStoredZip(targetPath: string, files: Record<string, string>) {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  const entries = Object.entries(files).sort(([left], [right]) => left.localeCompare(right));

  for (const [name, content] of entries) {
    const nameBuffer = Buffer.from(name, "utf8");
    const payload = Buffer.from(content, "utf8");

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(0, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(payload.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuffer, payload);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(0, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(payload.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuffer);

    offset += localHeader.length + nameBuffer.length + payload.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  writeFileSync(targetPath, Buffer.concat([...localParts, centralDirectory, end]));
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
});
