import { describe, expect, it } from "vitest";

import {
  appendGscReportPreamble,
  appendGscReportSection,
  parsePositiveNumber,
  runAsyncDirect,
  runGscCli,
} from "../lib/gsc-report.mts";

describe("GSC report helpers", () => {
  it("renders a shared report preamble with optional detail lines and empty sections", () => {
    const lines: string[] = [];
    appendGscReportPreamble(lines, {
      title: "Example GSC report",
      detailLines: ["Target: 5%"],
      inputs: [],
      notes: ["ignored.xlsx: unsupported"],
      parsedFileCounts: [["CSV files", 2]],
    });

    expect(lines.join("\n")).toBe(
      [
        "Example GSC report",
        "No live network checks were performed.",
        "Target: 5%",
        "",
        "Inputs:",
        "- none",
        "",
        "Unsupported or skipped files:",
        "- ignored.xlsx: unsupported",
        "",
        "Parsed files:",
        "- CSV files: 2",
        "",
      ].join("\n"),
    );
  });

  it("only starts async CLI handling for direct entrypoint runs", () => {
    expect(runAsyncDirect("file:///example.mjs", "/not-example.mjs", async () => 0)).toBe(false);
  });

  it("shares section rendering and positive-number validation", () => {
    const lines: string[] = [];
    appendGscReportSection(lines, "Rows", [1, 2], (value) => String(value * 2));
    appendGscReportSection(lines, "Empty", []);

    expect(lines).toEqual(["Rows:", "- 2", "- 4", "", "Empty:", "- none", ""]);
    expect(parsePositiveNumber("5", "--top", { integer: true })).toBe(5);
    expect(() => parsePositiveNumber("0", "--top", { integer: true })).toThrow("Invalid --top: 0");
  });

  it("maps shared analyzer failures to status one", async () => {
    let stderr = "";
    await expect(runGscCli(() => { throw new Error("malformed export"); }, { write: (text) => { stderr += text; } }))
      .resolves.toBe(1);
    expect(stderr).toBe("malformed export\n");
  });
});
