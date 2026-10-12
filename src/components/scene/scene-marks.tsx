/**
 * Scene kit: marks → SVG elements. One element per {@link SceneMark}, in paint order; `classOf` maps a mark's class
 * tokens ("lh-e e") to CSS classes, so colour stays in the theme's custom properties. A scene that extends the mark
 * union with its own kinds renders those through `renderMark`.
 *
 * Boundary-agnostic: no hooks, no client directive. `marksToSvgString` (`@shared/lib/scene/svg-string`) emits the
 * same geometry as a string for server-rendered cards.
 */
import type { ReactElement } from "react";
import type { SceneAtlas } from "@shared/lib/scene/atlas";
import { isSceneMark, type SceneMark } from "@shared/lib/scene/marks";
import { formatMatrix, formatPoints } from "@shared/lib/scene/projection";

/** Class tokens → `className` (a CSS-module lookup that falls back to the token itself is typical). */
export type SceneClassOf = (tokens: string) => string;

/** One kit mark as one SVG element. */
function sceneMarkElement(mark: SceneMark, key: number, classOf: SceneClassOf): ReactElement {
  switch (mark.kind) {
    case "polygon":
      return <polygon key={key} className={classOf(mark.cls)} points={formatPoints(mark.points)} />;
    case "polyline":
      return <polyline key={key} className={classOf(mark.cls)} points={formatPoints(mark.points)} />;
    case "path":
      return <path key={key} className={classOf(mark.cls)} d={mark.d} transform={mark.transform ? formatMatrix(mark.transform) : undefined} />;
    case "circle":
      return <circle key={key} className={classOf(mark.cls)} cx={mark.cx} cy={mark.cy} r={mark.r} transform={mark.transform ? formatMatrix(mark.transform) : undefined} />;
    case "ellipse":
      return <ellipse key={key} className={classOf(mark.cls)} cx={mark.cx} cy={mark.cy} rx={mark.rx} ry={mark.ry} />;
    case "line":
      return <line key={key} className={classOf(mark.cls)} x1={mark.x1} y1={mark.y1} x2={mark.x2} y2={mark.y2} />;
    case "glyph":
      return (
        <text key={key} className={classOf(mark.cls)} transform={`${formatMatrix(mark.transform)} scale(${mark.scale})`} fontSize={1}>
          {mark.text}
        </text>
      );
  }
}

/** Renders marks in paint order; marks outside the kit union go to `renderMark` (required if any are present). */
export function SceneMarks<M extends { kind: string } = never>({
  marks,
  classOf,
  renderMark,
}: {
  marks: readonly (SceneMark | M)[];
  classOf: SceneClassOf;
  renderMark?: (mark: M, key: number) => ReactElement | null;
}): ReactElement {
  return (
    <>
      {marks.map((m, k) => {
        if (isSceneMark(m)) return sceneMarkElement(m, k, classOf);
        if (!renderMark) throw new Error(`SceneMarks: no renderer for mark kind "${m.kind}"`);
        return renderMark(m as M, k);
      })}
    </>
  );
}

/**
 * One atlas cell drawn into the square (`x`, `y`, `size`): a nested `<svg>` whose viewBox windows the atlas image.
 * The image is the whole atlas, so a class can slide it by `atlas.shift` to show the colour cell instead of the grey.
 */
export function AtlasWindow({
  atlas,
  cell,
  x,
  y,
  size,
  className,
  imageClassName,
}: {
  atlas: SceneAtlas;
  cell: readonly [number, number];
  x: number;
  y: number;
  size: number;
  className?: string;
  imageClassName?: string;
}): ReactElement {
  return (
    <svg className={className} x={x} y={y} width={size} height={size} viewBox={`${cell[0]} ${cell[1]} ${atlas.cellSize} ${atlas.cellSize}`}>
      <image className={imageClassName} href={atlas.href} width={atlas.width} height={atlas.height} />
    </svg>
  );
}
