// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { buildNdjsonWithPreamble } from "@/lib/exports/ndjson";
import { PREAMBLE } from "./exports.test-support";

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

