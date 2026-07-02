// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildNdjsonWithPreamble, downloadNdjsonWithPreamble } from "@/lib/exports/ndjson";
import type { ExportPreamble } from "@/lib/exports/preamble";

const PREAMBLE: ExportPreamble = {
  endpoint: "stablecoins",
  asOfISO: "2026-05-16T12:00:00.000Z",
  sourceUrl: "https://pharos.watch/",
  methodologyLabel: "safety-score v7.25",
};

function expectBlob(value: Blob | MediaSource | undefined): asserts value is Blob {
  expect(value).toBeInstanceOf(Blob);
}

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

describe("downloadNdjsonWithPreamble", () => {
  const createObjectURL = vi.fn<(object: Blob | MediaSource) => string>(() => "blob:pharos-ndjson");
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

  it("triggers a download with the expected MIME type and dated filename", async () => {
    downloadNdjsonWithPreamble(
      [{ name: "USDC" }],
      [{ header: "Name", accessor: (row) => row.name }],
      "stablecoins",
      PREAMBLE,
    );

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0]?.[0];
    expectBlob(blob);
    expect(blob.type).toBe("application/x-ndjson;charset=utf-8;");
    await expect(blob.text()).resolves.toBe(
      [
        '{"_meta":{"endpoint":"stablecoins","asOfISO":"2026-05-16T12:00:00.000Z","sourceUrl":"https://pharos.watch/","methodologyLabel":"safety-score v7.25"}}',
        '{"Name":"USDC"}',
      ].join("\n"),
    );
    expect(clickSpy).toHaveBeenCalledTimes(1);
    const anchor = clickSpy.mock.instances[0] as HTMLAnchorElement | undefined;
    expect(anchor?.download).toBe("stablecoins-2026-05-16.ndjson");
    expect(revokeObjectURL).not.toHaveBeenCalled();

    await vi.runOnlyPendingTimersAsync();

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:pharos-ndjson");
  });

  it("still revokes the object URL when the anchor click throws", async () => {
    clickSpy.mockImplementation(() => {
      throw new Error("click blocked by browser policy");
    });

    expect(() =>
      downloadNdjsonWithPreamble(
        [{ name: "USDC" }],
        [{ header: "Name", accessor: (row) => row.name }],
        "stablecoins",
        PREAMBLE,
      ),
    ).toThrow("click blocked by browser policy");

    await vi.runOnlyPendingTimersAsync();

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:pharos-ndjson");
  });
});
