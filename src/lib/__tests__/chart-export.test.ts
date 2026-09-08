// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { toPng } from "html-to-image";
import { downloadChartPng } from "../chart-export";

vi.mock("html-to-image", () => ({
  toPng: vi.fn(),
}));

const clickedAnchors: HTMLAnchorElement[] = [];

function spyOnAnchorClicks(): void {
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    clickedAnchors.push(this);
  });
}

afterEach(() => {
  vi.mocked(toPng).mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
  clickedAnchors.length = 0;
});

describe("downloadChartPng", () => {
  it("downloads the encoded image under the caller's name and the UTC date", async () => {
    vi.useFakeTimers();
    // 23:30Z: a local-date substitution would name the file for the next day
    // in any zone east of UTC.
    vi.setSystemTime(new Date("2026-03-08T23:30:00Z"));
    vi.mocked(toPng).mockResolvedValue("data:image/png;base64,chart");
    spyOnAnchorClicks();
    const element = document.createElement("div");

    const result = await downloadChartPng({ current: element }, "test-chart");

    expect(result).toBe(true);
    expect(toPng).toHaveBeenCalledWith(element, { pixelRatio: 2 });
    expect(clickedAnchors).toHaveLength(1);
    expect(clickedAnchors[0]?.href).toBe("data:image/png;base64,chart");
    expect(clickedAnchors[0]?.download).toBe("test-chart-2026-03-08.png");
  });

  it("returns false without encoding or downloading when the ref is empty", async () => {
    spyOnAnchorClicks();

    const result = await downloadChartPng({ current: null }, "test-chart");

    expect(result).toBe(false);
    expect(toPng).not.toHaveBeenCalled();
    expect(clickedAnchors).toHaveLength(0);
  });

  it("returns false and downloads nothing when export fails", async () => {
    vi.mocked(toPng).mockRejectedValue(new Error("canvas blocked"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    spyOnAnchorClicks();

    const result = await downloadChartPng({ current: document.createElement("div") }, "test-chart");

    expect(result).toBe(false);
    expect(clickedAnchors).toHaveLength(0);
  });
});
