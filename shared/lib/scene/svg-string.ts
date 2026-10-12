/**
 * Scene kit marks as an SVG string, for server-rendered cards (the Worker's OG renderer, build scripts) where there is
 * no React or no stylesheet. `paint(cls)` resolves a mark's class tokens to the attributes to inline (`fill`,
 * `stroke`, … or just `class`); the geometry attributes are exactly those `SceneMarks` renders, in the same order, so
 * `paint = (cls) => ({ class: cls })` reproduces `renderToStaticMarkup(<SceneMarks classOf={(c) => c} … />)` byte for
 * byte.
 */
import type { SceneMark } from "./marks";
import { formatMatrix, formatPoints } from "./projection";

export type ScenePaint = (cls: string) => Readonly<Record<string, string | number>>;

const ESCAPES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" };
const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ESCAPES[c]);

function element(tag: string, attrs: readonly (readonly [string, string | number | undefined])[], text = ""): string {
  let out = `<${tag}`;
  for (const [name, value] of attrs) if (value !== undefined) out += ` ${name}="${escape(String(value))}"`;
  return `${out}>${escape(text)}</${tag}>`;
}

/** One element per mark, in paint order, concatenated (wrap in your own `<svg viewBox>`). */
export function marksToSvgString(marks: readonly SceneMark[], paint: ScenePaint): string {
  return marks
    .map((m) => {
      const p = Object.entries(paint(m.cls));
      switch (m.kind) {
        case "polygon":
        case "polyline":
          return element(m.kind, [...p, ["points", formatPoints(m.points)]]);
        case "path":
          return element("path", [...p, ["d", m.d], ["transform", m.transform ? formatMatrix(m.transform) : undefined]]);
        case "circle":
          return element("circle", [...p, ["cx", m.cx], ["cy", m.cy], ["r", m.r], ["transform", m.transform ? formatMatrix(m.transform) : undefined]]);
        case "ellipse":
          return element("ellipse", [...p, ["cx", m.cx], ["cy", m.cy], ["rx", m.rx], ["ry", m.ry]]);
        case "line":
          return element("line", [...p, ["x1", m.x1], ["y1", m.y1], ["x2", m.x2], ["y2", m.y2]]);
        case "glyph":
          return element("text", [...p, ["transform", `${formatMatrix(m.transform)} scale(${m.scale})`], ["font-size", 1]], m.text);
      }
    })
    .join("");
}
