import { describe, it, expect } from "vitest";
import { buildLampLayer } from "./lamp-layer";

describe("buildLampLayer", () => {
  it("starts with zero lamps", () => {
    const layer = buildLampLayer();
    expect(layer.count()).toBe(0);
  });

  it("setLamps replaces the list", () => {
    const layer = buildLampLayer();
    layer.setLamps([
      { x: 10, y: 20, warm: true, phase: 0 },
      { x: 30, y: 40, warm: false, phase: 1 },
    ]);
    expect(layer.count()).toBe(2);
    layer.setLamps([{ x: 0, y: 0, warm: true, phase: 0 }]);
    expect(layer.count()).toBe(1);
  });
});
