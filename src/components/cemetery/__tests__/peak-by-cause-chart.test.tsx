// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import * as hash from "@shared/lib/fnv1a";
import { PeakByCauseChart, type PeakLaneDatum } from "../peak-by-cause-chart";

vi.mock("@/components/cemetery/cemetery-selection-context", () => ({
  useCemeterySelection: () => ({ revealRecord: vi.fn() }),
}));

function legacyHash(id: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < id.length; index++) value = Math.imul(value ^ id.charCodeAt(index), 0x01000193);
  return value >>> 0;
}

const lanes: PeakLaneDatum[] = [{
  cause: "abandoned", medianPeak: null, medianLabel: null, n: 4, unrecordedCount: 0,
  dots: ["fixture", "coin-😀"].flatMap((id) => [false, true].map((labelled) => ({
    id: `${id}-${labelled}`, name: id, symbol: labelled ? "TOP" : "COIN", peak: 20_000_000,
    peakLabel: "$20M", dateLabel: "January 2024", labelled,
  }))),
}];

function renderChart() {
  return renderToStaticMarkup(<PeakByCauseChart lanes={lanes} titleId="peak-title" header={<h3 id="peak-title">Peaks</h3>} footnote={null} />);
}

describe("PeakByCauseChart jitter parity", () => {
  it("preserves legacy SVG coordinates and labels for ASCII and surrogate-pair ids", () => {
    const actual = renderChart();
    const legacy = vi.spyOn(hash, "fnv1a32").mockImplementation(legacyHash);
    try {
      expect(actual).toBe(renderChart());
    } finally {
      legacy.mockRestore();
    }
    const container = document.createElement("div");
    container.innerHTML = actual;
    for (const dot of lanes[0].dots) {
      const unit = (legacyHash(dot.id) / 0xffffffff) * 2 - 1;
      expect(hash.fnv1a32(dot.id)).toBe(legacyHash(dot.id));
      const y = 40 + (dot.labelled ? Math.abs(unit) * 5 : unit * 14);
      const group = Array.from(container.querySelectorAll("[data-dot-id]")).find((node) => node.getAttribute("data-dot-id") === dot.id)!;
      expect(group.getAttribute("aria-label")).toBe(`${dot.name} (${dot.symbol}), $20M, January 2024`);
      for (const circle of group.querySelectorAll("circle")) {
        expect(circle.getAttribute("cy")).toBe(String(y));
        expect(circle.getAttribute("cx")).toBe("36.165%");
      }
      if (dot.labelled) {
        const labels = Array.from(container.querySelectorAll("text")).filter((node) => node.textContent === dot.symbol);
        expect(labels.some((node) => node.getAttribute("y") === String(y))).toBe(true);
        expect(labels.some((node) => node.getAttribute("y") === String(y - 11.5))).toBe(true);
      }
    }
  });
});
