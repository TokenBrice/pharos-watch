import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeGscCoverageInputs, renderGscCoverageReport } from "../maintenance/analyze-gsc-coverage.mjs";

function fixtureDir() {
  return mkdtempSync(join(tmpdir(), "pharos-gsc-coverage-"));
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
        '"Server error (5xx)",Website,Passed,Flat,0',
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
});
