import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Independent pre-cutover scene loop: UTF-16 code units, not Unicode code points.
function legacyHash(id: string): number {
  let value = 2166136261;
  for (let index = 0; index < id.length; index++) value = Math.imul(value ^ id.charCodeAt(index), 16777619);
  return value >>> 0;
}

// Static imports cannot exercise the legend's module-initialized seed after resetting its hash dependency.
async function renderConsumers() {
  const { PlotFlowers } = await import("../plot-map-shapes");
  const { PlotMapLegend } = await import("../plot-map-legend");
  return renderToStaticMarkup(<>
    <svg>{["fixture", "coin-😀"].map((id) => <PlotFlowers key={id} id={id} count={3} x={12} y={24} />)}</svg>
    <PlotMapLegend firstYear={2014} lastYear={2026} />
  </>);
}

describe("plot map hash consumers", () => {
  it("preserves complete flower and legend SVG bytes from the legacy scene seeds", async () => {
    const actual = await renderConsumers();
    // Reload the legend too: its base seed is computed at module initialization.
    vi.doMock("@shared/lib/fnv1a", () => ({ fnv1a32: legacyHash }));
    vi.resetModules();
    try {
      expect(actual).toBe(await renderConsumers());
    } finally {
      vi.doUnmock("@shared/lib/fnv1a");
      vi.resetModules();
    }
  });
});
