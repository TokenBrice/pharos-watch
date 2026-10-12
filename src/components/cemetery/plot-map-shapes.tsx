/**
 * Stablecoin Cemetery plot map: mark → SVG element rendering, over the scene kit (`src/components/scene/`).
 *
 * The geometry (`@/lib/cemetery-plot-geometry`) returns shapes as plain {@link PlotMark} data whose `cls` is the
 * prototype's class-token list ("st-t e"); this module maps every token to its CSS-module class, lets the kit's
 * `SceneMarks` emit one element per mark and renders the grave medallion itself. Boundary-agnostic: no hooks, no client directive. The logo atlas arrives as data (`PlotLogoAtlas`, a
 * prop of the hero), never as a JSON import, so the manifest stays out of the client bundle.
 */
import type { CSSProperties, ReactElement } from "react";
import { CAUSE_HEX, CAUSE_HEX_DARK, CAUSE_ORDER, type CauseOfDeath } from "@shared/lib/cause-of-death";
import { fnv1a, round1, seededStream, type PlotGraveGeometry, type PlotMark, type PlotMedallionMark, type PlotWeather } from "@/lib/cemetery-plot-geometry";
import type { PlotLogoAtlas } from "@/lib/cemetery-plot-map-input";
import { SceneDefs, type SceneGradient } from "../scene/scene-defs";
import { AtlasWindow, SceneMarks } from "../scene/scene-marks";
import kit from "../scene/scene-tokens.module.css";
import styles from "./plot-map.module.css";

/** Short class token per cause: `.c-ab` sets `--cause` from the `--c-ab` custom property. */
const CAUSE_ABBR: Readonly<Record<CauseOfDeath, string>> = {
  abandoned: "ab",
  "counterparty-failure": "cp",
  "liquidity-drain": "lq",
  "algorithmic-failure": "al",
  regulatory: "rg",
};

/** CSS-module class that points `--cause` at a cause's theme colour. */
export function plotCauseClass(cause: CauseOfDeath): string {
  return styles[`c-${CAUSE_ABBR[cause]}`];
}

/** Maps prototype class tokens ("st-t e") to CSS-module classes: the cemetery's, else the scene kit's faces. */
function plotClass(tokens: string): string {
  return tokens
    .split(" ")
    .map((t) => styles[t] ?? kit[t] ?? t)
    .join(" ");
}

/** What a medallion shows: the grave's grey atlas cell, else the first letter of its symbol. */
export type PlotMedallionFace = { cell: readonly [number, number]; atlas: PlotLogoAtlas } | { initial: string } | null;

export function plotMedallionFace(atlas: PlotLogoAtlas, id: string, symbol: string): PlotMedallionFace {
  const cell = atlas.cells[id];
  if (cell) return { cell, atlas };
  const initial = symbol.replace(/[^A-Za-z0-9]/g, "").slice(0, 1).toUpperCase();
  return initial ? { initial } : null;
}

function Medallion({ mark, face }: { mark: PlotMedallionMark; face: PlotMedallionFace }): ReactElement {
  const { logo, initial } = mark;
  return (
    <>
      <circle className={styles.med} cx={mark.cx} cy={mark.cy} r={mark.r} strokeWidth={mark.ring} />
      {face && "cell" in face ? (
        <AtlasWindow atlas={face.atlas} cell={face.cell} x={logo.x} y={logo.y} size={logo.size} className={styles.lg} imageClassName={styles.lgImg} />
      ) : face ? (
        <text className={styles.lgInit} x={initial.x} y={initial.y} fontSize={initial.fontSize}>
          {face.initial}
        </text>
      ) : null}
    </>
  );
}

/** Renders marks in paint order through the kit's `SceneMarks`; `face` fills any medallion among them. */
export function PlotMarks({ marks, face = null }: { marks: readonly PlotMark[]; face?: PlotMedallionFace }): ReactElement {
  return <SceneMarks marks={marks} classOf={plotClass} renderMark={(m: PlotMedallionMark, key) => <Medallion key={key} mark={m} face={face} />} />;
}

/**
 * A grave's drawn body (plinth, stone, medallion) inside the `.stone` group the island lifts; leaning stones rotate.
 * Decorative (`aria-hidden`): the grave button carries the full name, so the logo window and glyphs stay out of the tree.
 */
export function PlotGraveBody({ geometry, face }: { geometry: PlotGraveGeometry; face: PlotMedallionFace }): ReactElement {
  const { lean } = geometry;
  return (
    <g className={styles.stone} transform={lean ? `rotate(${lean.deg} ${lean.x} ${lean.y})` : undefined} aria-hidden="true">
      <PlotMarks marks={geometry.body} face={face} />
    </g>
  );
}

/** Class list of a grave (or its ground group): base, cause colour, weathering class. */
export function plotGraveClass(base: string, cause: CauseOfDeath, weather: PlotWeather): string {
  return weather ? `${base} ${plotCauseClass(cause)} ${styles[`w${weather}`]}` : `${base} ${plotCauseClass(cause)}`;
}

/** Session flowers are capped per grave (the easter egg, not a counter). */
export const PLOT_FLOWER_MAX = 24;
/** Flower tones (`.flower0`…`.flower3` in the CSS module). */
const FLOWER_TONES = 4;

/**
 * Flowers left at a grave this session, scattered at the grave's base below its medallion (`x`, `y`: the medallion
 * centre in the SVG's user units; `spread` scales the 14 × 8-unit scatter for other projections). Deterministic: the
 * n-th flower of a grave always lands in the same place. A new flower blooms once (CSS; not under reduced motion).
 */
export function PlotFlowers({ id, count, x, y, spread = 1 }: { id: string; count: number; x: number; y: number; spread?: number }): ReactElement | null {
  if (count < 1) return null;
  return (
    <g aria-hidden="true" data-plot-flowers>
      {Array.from({ length: Math.min(count, PLOT_FLOWER_MAX) }, (_, k) => {
        const rnd = seededStream(fnv1a(`${id}:${k + 1}`));
        const fx = round1(x + (rnd() - 0.2) * 14 * spread);
        const fy = round1(y + (10 + rnd() * 8) * spread);
        return (
          <g key={k} className={styles[`flower${Math.floor(rnd() * FLOWER_TONES)}`]} transform={`translate(${fx} ${fy})`}>
            <line className={styles.flowerStem} x1={0} y1={0} x2={0} y2={round1(3 * spread)} />
            <circle className={styles.flowerHead} r={round1(1.5 * spread)} />
          </g>
        );
      })}
    </g>
  );
}

/**
 * Paint servers shared by every plot-map SVG on the page (desktop plan, portrait plan, legend icons). Rendered once
 * in a 0×0 host SVG that is never `display: none`, so references keep working while a scene is hidden. It must sit
 * inside the tokens element: the stops read theme custom properties.
 */
export function PlotMapDefs(): ReactElement {
  return <SceneDefs idPrefix="cem" className={kit.defs} hatchLineClassName={kit.hatchLine} gradients={PLOT_GRADIENTS} />;
}

/** `cem-g-col` (column shading), `cem-g-beam`, `cem-g-pool` (lamp light), `cem-g-spot` (zoom spotlight). */
const PLOT_GRADIENTS: readonly SceneGradient[] = [
  { id: "col", type: "linear", stops: [["0", styles.gsShade], [".45", styles.gsMid], [".82", styles.gsLit], ["1", styles.gsMid]] },
  { id: "beam", type: "linear", stops: [["0", styles.gb0], [".55", styles.gb1], ["1", styles.gb2]] },
  { id: "pool", type: "radial", stops: [["0", styles.gp0], ["1", kit.stopClear]] },
  { id: "spot", type: "radial", stops: [["0", styles.gsp0], ["1", kit.stopClear]] },
];

/** Custom properties for the tokens element: both cause hexes (theme picked in CSS) and the atlas colour shift. */
export function plotTokenStyle(atlas: PlotLogoAtlas): CSSProperties {
  const vars: Record<string, string> = { "--atlas-shift": `${atlas.shift}px` };
  for (const cause of CAUSE_ORDER) {
    vars[`--c-${CAUSE_ABBR[cause]}-l`] = CAUSE_HEX[cause];
    vars[`--c-${CAUSE_ABBR[cause]}-d`] = CAUSE_HEX_DARK[cause];
  }
  return vars as CSSProperties;
}
