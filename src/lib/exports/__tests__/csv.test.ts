// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCsvWithPreamble, downloadCsvWithPreamble } from "@/lib/exports/csv";
import type { ExportPreamble } from "@/lib/exports/preamble";

const PREAMBLE: ExportPreamble = {
  endpoint: "stablecoins",
  asOfISO: "2026-05-16T12:00:00.000Z",
  sourceUrl: "https://pharos.watch/",
  methodologyLabel: "safety-score v7.25",
};

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
});

describe("downloadCsvWithPreamble", () => {
  const createObjectURL = vi.fn(() => "blob:pharos-csv");
  const revokeObjectURL = vi.fn();
  let clickSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-16T12:00:00.000Z"));
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL,
      revokeObjectURL,
    });
    clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  afterEach(() => {
    clickSpy.mockRestore();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
  });

  it("creates a BOM-prefixed CSV blob, dated filename, and defers revoke", async () => {
    downloadCsvWithPreamble(
      [{ name: "USDC" }],
      [{ header: "Name", accessor: (row) => row.name }],
      "stablecoins",
      PREAMBLE,
    );

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0]?.[0];
    expect(blob).toBeInstanceOf(Blob);
    expect((blob as Blob).type).toBe("text/csv;charset=utf-8;");
    const bytes = new Uint8Array(await (blob as Blob).arrayBuffer());
    expect(Array.from(bytes.slice(0, 3))).toEqual([239, 187, 191]); // UTF-8 BOM
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();

    await vi.runOnlyPendingTimersAsync();

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:pharos-csv");
  });

  it("still revokes the object URL when the anchor click throws", async () => {
    clickSpy.mockImplementation(() => {
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
