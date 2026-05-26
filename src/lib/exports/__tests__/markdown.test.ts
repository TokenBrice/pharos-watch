// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMarkdownWithPreamble, copyMarkdownWithPreamble } from "@/lib/exports/markdown";
import type { ExportPreamble } from "@/lib/exports/preamble";

const PREAMBLE: ExportPreamble = {
  endpoint: "stablecoins",
  asOfISO: "2026-05-16T12:00:00.000Z",
  sourceUrl: "https://pharos.watch/",
  methodologyLabel: "safety-score v7.25",
};

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

describe("copyMarkdownWithPreamble", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("writes the rendered markdown to the clipboard and returns true on success", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const result = await copyMarkdownWithPreamble(
      [{ name: "USDC" }],
      [{ header: "Name", accessor: (row) => row.name }],
      PREAMBLE,
    );

    expect(result).toBe(true);
    expect(writeText).toHaveBeenCalledTimes(1);
    const arg = writeText.mock.calls[0]?.[0] as string;
    expect(arg.startsWith("> Pharos pharos.watch")).toBe(true);
    expect(arg).toContain("| USDC |");
  });

  it("returns false when the clipboard API rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const result = await copyMarkdownWithPreamble(
      [{ name: "USDC" }],
      [{ header: "Name", accessor: (row) => row.name }],
      PREAMBLE,
    );

    expect(result).toBe(false);
  });

  it("returns false when the clipboard API is unavailable", async () => {
    vi.stubGlobal("navigator", {});

    const result = await copyMarkdownWithPreamble(
      [{ name: "USDC" }],
      [{ header: "Name", accessor: (row) => row.name }],
      PREAMBLE,
    );

    expect(result).toBe(false);
  });
});
