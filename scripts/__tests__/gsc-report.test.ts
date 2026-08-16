import { describe, expect, it } from "vitest";

import { appendGscReportPreamble, runAsyncDirect } from "../lib/gsc-report.mts";

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
});
