// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { toPng } from "html-to-image";
import { downloadChartPng } from "../chart-export";

vi.mock("html-to-image", () => ({
  toPng: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("downloadChartPng", () => {
  it("returns true after creating a PNG download", async () => {
    vi.mocked(toPng).mockResolvedValue("data:image/png;base64,chart");
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const element = document.createElement("div");

    const result = await downloadChartPng({ current: element }, "test-chart");

    expect(result).toBe(true);
    expect(toPng).toHaveBeenCalledWith(element, { pixelRatio: 2 });
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("returns false when export fails", async () => {
    const error = new Error("canvas blocked");
    vi.mocked(toPng).mockRejectedValue(error);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await downloadChartPng({ current: document.createElement("div") }, "test-chart");

    expect(result).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith("Chart export failed:", error);
  });
});
