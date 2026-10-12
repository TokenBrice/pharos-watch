import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SceneMark } from "@shared/lib/scene/marks";
import { lighthouseGeometry } from "@shared/lib/scene/objects/lighthouse";
import { SCENE_DIMETRIC } from "@shared/lib/scene/projection";
import { faceMatrixE } from "@shared/lib/scene/solids";
import { marksToSvgString } from "@shared/lib/scene/svg-string";
import { SceneDefs } from "../scene/scene-defs";
import { AtlasWindow, SceneMarks } from "../scene/scene-marks";

const p = SCENE_DIMETRIC;
const FIXTURE: SceneMark[] = [
  ...lighthouseGeometry(p, 2, 1).marks,
  { kind: "polyline", cls: "crack", points: [[0, 0], [1.25, 3]] },
  { kind: "path", cls: "relief", d: "M0,0L1,1", transform: faceMatrixE(p, 1, 2, 0.5) },
  { kind: "circle", cls: "seal-disc", cx: 0, cy: -0.62, r: 0.1, transform: faceMatrixE(p, 1, 2, 0) },
  { kind: "circle", cls: "dot", cx: 3, cy: 4, r: 1, transform: null },
  { kind: "ellipse", cls: "pool", cx: 1, cy: 2, rx: 34, ry: 17 },
  { kind: "glyph", cls: "glyph", text: "€<&>", transform: faceMatrixE(p, 0, 0, 0.1), scale: 0.26 },
];

describe("scene marks", () => {
  it("emits the same SVG from React and from the string renderer", () => {
    const react = renderToStaticMarkup(<SceneMarks marks={FIXTURE} classOf={(cls) => cls} />);
    expect(marksToSvgString(FIXTURE, (cls) => ({ class: cls }))).toBe(react);
  });

  it("inlines the paint resolver's attributes", () => {
    const svg = marksToSvgString([{ kind: "polygon", cls: "lh-e e", points: [[0, 0], [1, 0], [0, 1]] }], (cls) => ({ fill: cls.startsWith("lh-e") ? "#fff" : "none", "stroke-width": 0.5 }));
    expect(svg).toBe('<polygon fill="#fff" stroke-width="0.5" points="0,0 1,0 0,1"></polygon>');
  });

  it("maps class tokens through classOf and hands foreign marks to renderMark", () => {
    const marks: (SceneMark | { kind: "flag"; at: number })[] = [{ kind: "line", cls: "e", x1: 0, y1: 0, x2: 1, y2: 1 }, { kind: "flag", at: 3 }];
    const html = renderToStaticMarkup(<SceneMarks marks={marks} classOf={(cls) => `k-${cls}`} renderMark={(m: { kind: "flag"; at: number }, key) => <circle key={key} r={m.at} />} />);
    expect(html).toBe('<line class="k-e" x1="0" y1="0" x2="1" y2="1"></line><circle r="3"></circle>');
    expect(() => renderToStaticMarkup(<SceneMarks marks={marks} classOf={(cls) => cls} />)).toThrow(/no renderer for mark kind "flag"/);
  });

  it("windows one atlas cell", () => {
    const atlas = { href: "/a.webp?v=1", width: 100, height: 50, cellSize: 48, shift: -50, cells: {} };
    expect(renderToStaticMarkup(<AtlasWindow atlas={atlas} cell={[50, 0]} x={1} y={2} size={8} className="lg" />)).toBe(
      '<svg class="lg" x="1" y="2" width="8" height="8" viewBox="50 0 48 48"><image href="/a.webp?v=1" width="100" height="50"></image></svg>',
    );
  });
});

describe("scene defs", () => {
  it("hosts prefixed paint servers in one SVG whose class the caller sizes (never display: none)", () => {
    const html = renderToStaticMarkup(
      <SceneDefs idPrefix="hb" className="defs" hatchLineClassName="hl" gradients={[{ id: "sea", type: "linear", stops: [["0", "s0"], ["1", "s1"]] }, { id: "glow", type: "radial", stops: [["0", "g0"]] }]} />,
    );
    expect(html).toContain('<svg class="defs" aria-hidden="true" focusable="false">');
    expect(html).toContain('<pattern id="hb-hatch"');
    expect(html).toContain('<linearGradient id="hb-g-sea" x1="0" x2="1" y1="0" y2="0"><stop offset="0" class="s0"></stop><stop offset="1" class="s1"></stop></linearGradient>');
    expect(html).toContain('<radialGradient id="hb-g-glow"><stop offset="0" class="g0"></stop></radialGradient>');
    expect(html).not.toMatch(/display/);
  });
});
