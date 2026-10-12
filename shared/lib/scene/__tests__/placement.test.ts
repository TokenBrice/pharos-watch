import { describe, expect, it } from "vitest";
import { faceFloorPx, footprintOverlaps } from "../capacity";
import { boxToFrameRect, placeInspectorCard, placeTag, rectsHit } from "../placement";

const frame = { left: 0, top: 0, right: 1400, bottom: 900 };
const stone = { left: 600, top: 400, right: 640, bottom: 450 };
const card = { width: 300, height: 360 };
const viewport = { width: 1440, height: 900 };

describe("scene placement", () => {
  it("maps SVG boxes to frame px and detects padded hits", () => {
    expect(boxToFrameRect({ x0: 10, y0: 20, x1: 30, y1: 40 }, [0, 10, 100, 100], 2)).toEqual({ left: 20, top: 20, right: 60, bottom: 60 });
    expect(rectsHit({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 14, top: 0, right: 20, bottom: 10 }, 5)).toBe(true);
    expect(rectsHit({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 14, top: 0, right: 20, bottom: 10 }, 3)).toBe(false);
  });

  it("puts a tag above its target, else the first clear candidate", () => {
    const tag = { width: 80, height: 20 };
    const f = { width: 1400, height: 900 };
    expect(placeTag({ stone, tag, frame: f, obstacles: [] })).toEqual({ x: 580, y: 374, collisions: 0 });
    const above = { left: 570, top: 360, right: 670, bottom: 398 };
    const placed = placeTag({ stone, tag, frame: f, obstacles: [above] });
    expect(placed.collisions).toBe(0);
    expect(placed.x).toBe(646);
    expect(placeTag({ stone, tag, frame: f, obstacles: [], top: 380 })).toEqual({ x: 644, y: 384, collisions: 0 });
    expect(placeTag({ stone, tag, frame: f, obstacles: [], top: 600 }).collisions).toBe(-1);
  });

  it("docks the inspector below the given chrome edge", () => {
    const low = placeInspectorCard({ stone, frame, medal: [620, 420], card, viewport, chromeTop: 67 });
    const high = placeInspectorCard({ stone, frame, medal: [620, 420], card, viewport, chromeTop: 300 });
    expect(low.x).toBe(stone.right + 28);
    expect(high.y).toBeGreaterThanOrEqual(300);
    expect(low.connector).toMatchObject({ x1: 620, y1: 420, x2: low.x });
  });

  it("stops above a bottom-right corner control only when it reaches it", () => {
    const narrow = { width: 600, height: 900 };
    const narrowFrame = { left: 0, top: 0, right: 600, bottom: 900 };
    const target = { left: 100, top: 760, right: 140, bottom: 800 };
    const tall = { width: 300, height: 900 };
    const free = placeInspectorCard({ stone: target, frame: narrowFrame, medal: [120, 780], card: tall, viewport: narrow, chromeTop: 67 });
    const cornered = placeInspectorCard({ stone: target, frame: narrowFrame, medal: [120, 780], card: tall, viewport: narrow, chromeTop: 67, corner: { width: 170, height: 84 } });
    const clear = placeInspectorCard({ stone: target, frame: narrowFrame, medal: [120, 780], card: tall, viewport: narrow, chromeTop: 67, corner: { width: 100, height: 84 } });
    expect(free.y + free.maxHeight).toBe(narrow.height - 8);
    expect(cornered.y + cornered.maxHeight).toBe(narrow.height - 84);
    expect(clear.y + clear.maxHeight).toBe(narrow.height - 8);
  });
});

describe("scene capacity", () => {
  it("lists overlapping footprints pairwise and ignores touching ones", () => {
    const cells = [
      { id: "a", cell: { i0: 0, i1: 1, j0: 0, j1: 1 } },
      { id: "b", cell: { i0: 1, i1: 2, j0: 0, j1: 1 } },
      { id: "c", cell: { i0: 0.5, i1: 1.5, j0: 0.5, j1: 1.5 } },
    ];
    expect(footprintOverlaps(cells, (c) => c.cell).map(([x, y]) => `${x.id}${y.id}`)).toEqual(["ac", "bc"]);
  });

  it("measures a face in CSS px at a reference frame", () => {
    expect(faceFloorPx(0.6, 1440, 960)).toBe(18);
    expect(faceFloorPx(0.6, 1440, 960, 10)).toBe(9);
  });
});
