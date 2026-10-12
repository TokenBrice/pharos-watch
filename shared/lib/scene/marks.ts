/**
 * Scene kit marks: shapes as plain data, one SVG element per mark.
 *
 * Geometry never carries colour. Every mark has `cls`, a space-separated list of class tokens (`"lh-e e"`: lighthouse
 * east face + hairline edge); the renderer maps each token to a CSS class (`SceneMarks`' `classOf`, or the paint
 * resolver of `marksToSvgString`), and the colour lives in theme custom properties behind that class.
 */
import { project, roundPoint, type SceneMatrix, type ScenePoint, type SceneProjection } from "./projection";

export type SceneMark =
  | { kind: "polygon"; cls: string; points: ScenePoint[] }
  | { kind: "polyline"; cls: string; points: ScenePoint[] }
  /** `d` is in screen units, or in face-local world units when `transform` is set. */
  | { kind: "path"; cls: string; d: string; transform: SceneMatrix | null }
  | { kind: "circle"; cls: string; cx: number; cy: number; r: number; transform: SceneMatrix | null }
  | { kind: "ellipse"; cls: string; cx: number; cy: number; rx: number; ry: number }
  | { kind: "line"; cls: string; x1: number; y1: number; x2: number; y2: number }
  /** One glyph (or short text): one em at `font-size: 1`, placed by `transform` then scaled by `scale`. */
  | { kind: "glyph"; cls: string; text: string; transform: SceneMatrix; scale: number };

export type SceneMarkKind = SceneMark["kind"];

/** A drawn object: its marks in paint order and its extent points (unrounded; depth sorting, hulls, cameras). */
export interface SceneObjectGeometry {
  marks: SceneMark[];
  pts: ScenePoint[];
}

const SCENE_MARK_KINDS: ReadonlySet<string> = new Set<SceneMarkKind>(["polygon", "polyline", "path", "circle", "ellipse", "line", "glyph"]);

/** True for the kit's own mark kinds; a scene may extend the union with marks it renders itself. */
export function isSceneMark(mark: { kind: string }): mark is SceneMark {
  return SCENE_MARK_KINDS.has(mark.kind);
}

/** Polygon from screen points (0.1-rounded). */
export function screenPolygon(cls: string, pts: readonly ScenePoint[]): SceneMark {
  return { kind: "polygon", cls, points: pts.map(roundPoint) };
}

/** Polygon from world points. */
export function worldPolygon(p: SceneProjection, cls: string, world: readonly (readonly number[])[]): SceneMark {
  return screenPolygon(
    cls,
    world.map((w) => project(p, w[0], w[1], w[2] || 0)),
  );
}
