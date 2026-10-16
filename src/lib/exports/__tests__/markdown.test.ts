// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { buildMarkdownWithPreamble } from "@/lib/exports/markdown";
import { PREAMBLE } from "./exports.test-support";

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

