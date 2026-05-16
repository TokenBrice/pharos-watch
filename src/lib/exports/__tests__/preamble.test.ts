import { describe, expect, it } from "vitest";
import {
  formatPreambleCsv,
  formatPreambleMarkdown,
  formatPreambleNdjson,
  getMethodologyLabel,
  type ExportPreamble,
} from "@/lib/exports/preamble";

const FIXTURE: ExportPreamble = {
  endpoint: "stablecoins",
  asOfISO: "2026-05-16T12:00:00.000Z",
  sourceUrl: "https://pharos.watch/",
  methodologyLabel: "safety-score v7.25",
};

describe("ExportPreamble formatters", () => {
  it("renders the CSV preamble as a single `# `-prefixed comment line", () => {
    expect(formatPreambleCsv(FIXTURE)).toBe(
      "# Pharos pharos.watch | Endpoint: stablecoins | As of: 2026-05-16T12:00:00.000Z | URL: https://pharos.watch/ | Methodology: safety-score v7.25",
    );
  });

  it("renders the NDJSON preamble as a single `_meta` JSON line", () => {
    const ndjson = formatPreambleNdjson(FIXTURE);
    expect(JSON.parse(ndjson)).toEqual({
      _meta: {
        endpoint: "stablecoins",
        asOfISO: "2026-05-16T12:00:00.000Z",
        sourceUrl: "https://pharos.watch/",
        methodologyLabel: "safety-score v7.25",
      },
    });
    expect(ndjson.includes("\n")).toBe(false);
  });

  it("renders the Markdown preamble as a `> `-prefixed blockquote line", () => {
    expect(formatPreambleMarkdown(FIXTURE)).toBe(
      "> Pharos pharos.watch | Endpoint: stablecoins | As of: 2026-05-16T12:00:00.000Z | URL: https://pharos.watch/ | Methodology: safety-score v7.25",
    );
  });
});

describe("getMethodologyLabel", () => {
  it("returns a label for known endpoints", () => {
    const label = getMethodologyLabel("stablecoins");
    expect(label).not.toBeNull();
    expect(label).toMatch(/^safety-score v/);
  });

  it("returns the depeg-dews label for peg-summary", () => {
    const label = getMethodologyLabel("peg-summary");
    expect(label).not.toBeNull();
    expect(label).toMatch(/^depeg-dews v/);
  });

  it("returns null for unknown endpoints", () => {
    expect(getMethodologyLabel("not-a-real-endpoint")).toBeNull();
  });
});
