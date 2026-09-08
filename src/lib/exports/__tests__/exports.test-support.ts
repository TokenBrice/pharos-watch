import { afterEach, beforeEach, expect, vi, type MockInstance } from "vitest";
import type { ExportPreamble } from "@/lib/exports/preamble";

export const PREAMBLE: ExportPreamble = {
  endpoint: "stablecoins",
  asOfISO: "2026-05-16T12:00:00.000Z",
  sourceUrl: "https://pharos.watch/",
  methodologyLabel: "safety-score v7.25",
};

export function expectBlob(value: Blob | MediaSource | undefined): asserts value is Blob {
  expect(value).toBeInstanceOf(Blob);
}

export function useDownloadHarness(objectUrl: string) {
  const createObjectURL = vi.fn<(object: Blob | MediaSource) => string>(() => objectUrl);
  const revokeObjectURL = vi.fn();
  let clickSpy: MockInstance<() => void>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(PREAMBLE.asOfISO));
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
  });

  return { createObjectURL, revokeObjectURL, get clickSpy() { return clickSpy; } };
}
