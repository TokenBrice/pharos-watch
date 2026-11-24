/**
 * Stablecoin Cemetery plot map: mark → SVG element rendering, over the scene kit (`src/components/scene/`).
 *
 * The geometry (`@/lib/cemetery-plot-geometry`) returns shapes as plain {@link PlotMark} data whose `cls` is the
 * prototype's class-token list ("st-t e"); this module maps every token to its CSS-module class, lets the kit's
 * `SceneMarks` emit one element per mark and renders the grave medallion itself. Boundary-agnostic: no hooks, no client directive. The logo atlas arrives as data (`PlotLogoAtlas`, a
 * prop of the hero), never as a JSON import, so the manifest stays out of the client bundle.
 */
import type { CSSProperties, ReactElement } from "react";
import { CAUSE_HEX, CAUSE_HEX_DARK, CAUSE_META, CAUSE_ORDER, type CauseOfDeath } from "@shared/lib/cause-of-death";
import { fnv1a32 } from "@shared/lib/fnv1a";
import {
  bbox,
  project,
  round1,
  seededStream,
  type PlotGraveGeometry,
  type PlotMark,
  type PlotMedallionMark,
  type PlotPeakClass,
  type PlotPoint,
  type PlotProjection,
  type PlotWeather,
} from "@/lib/cemetery-plot-geometry";
import type { PlotGrave } from "@/lib/cemetery-plot-map";
import type { PlotLogoAtlas } from "@/lib/cemetery-plot-map-input";
import { SceneDefs, type SceneGradient } from "../scene/scene-defs";
import { AtlasWindow, SceneMarks } from "../scene/scene-marks";
import kit from "../scene/scene-tokens.module.css";
import styles from "./plot-map.module.css";

/** Interactive legend lens: one categorical or mark-encoding filter shared by desktop and portrait walk (E9). */
export type PlotLens =
  | { kind: "cause"; cause: CauseOfDeath }
  | { kind: "steps"; steps: PlotPeakClass }
  | { kind: "unrecorded" }
  | { kind: "fresh" }
  | { kind: "archived" }
  | { kind: "non-usd" };

/** Plinth-step range captions: one step per order of magnitude from $10M (`PLOT_STEP_THRESHOLDS_USD`). */
export const PLOT_STEP_LABELS = ["< $10M", "$10M–$100M", "$100M–$1B", "$1B–$10B", "$10B+"] as const;

export function serializePlotLens(lens: PlotLens): string {
  if (lens.kind === "cause") return `cause:${lens.cause}`;
  if (lens.kind === "steps") return `steps:${lens.steps}`;
  return lens.kind;
}

export function parsePlotLens(raw: string | null | undefined): PlotLens | null {
  if (!raw) return null;
  if (raw.startsWith("cause:")) {
    const cause = raw.slice(6) as CauseOfDeath;
    return CAUSE_ORDER.includes(cause) ? { kind: "cause", cause } : null;
  }
  if (raw.startsWith("steps:")) {
    const n = Number(raw.slice(6));
    return Number.isInteger(n) && n >= 0 && n <= 4 ? { kind: "steps", steps: n as PlotPeakClass } : null;
  }
  if (raw === "unrecorded" || raw === "fresh" || raw === "archived" || raw === "non-usd") return { kind: raw };
  return null;
}

export function samePlotLens(a: PlotLens | null, b: PlotLens | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === "cause" && b.kind === "cause") return a.cause === b.cause;
  if (a.kind === "steps" && b.kind === "steps") return a.steps === b.steps;
  return true;
}

export function matchesPlotLens(
  g: Pick<PlotGrave, "cause" | "steps" | "unrecorded" | "fresh" | "archived" | "footstone">,
  lens: PlotLens,
): boolean {
  switch (lens.kind) {
    case "cause":
      return g.cause === lens.cause;
    case "steps":
      return !g.unrecorded && g.steps === lens.steps;
    case "unrecorded":
      return g.unrecorded;
    case "fresh":
      return g.fresh;
    case "archived":
      return g.archived;
    case "non-usd":
      return g.footstone !== null;
  }
}

export function describePlotLens(lens: PlotLens): string {
  switch (lens.kind) {
    case "cause":
      return CAUSE_META[lens.cause].label;
    case "steps":
      return `peak ${PLOT_STEP_LABELS[lens.steps]}`;
    case "unrecorded":
      return "peak not recorded";
    case "fresh":
      return "fresh soil";
    case "archived":
      return "Pharos archive page";
    case "non-usd":
      return "non-USD peg";
  }
}

function pointsSubpath(pts: readonly PlotPoint[]): string {
  if (pts.length < 3) return "";
  // Normalize every subpath to consistent positive screen-space winding so overlapping subpaths inside one
  // `<path fill-rule="nonzero">` always form a solid union with zero opposite-winding holes (A4).
  let area2 = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    area2 += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  }
  const ordered = area2 < 0 ? [...pts].reverse() : pts;
  let d = `M${round1(ordered[0][0])},${round1(ordered[0][1])}`;
  for (let k = 1; k < ordered.length; k++) d += `L${round1(ordered[k][0])},${round1(ordered[k][1])}`;
  return `${d}Z`;
}

/**
 * Tight hit path for one desktop grave (A4): its inset ground cell quad plus its own drawn body polygons,
 * concatenated into one SVG `<path>` so no convex-hull sky bridge can steal the pointer over a visible medallion.
 */
export function graveHitPath(p: PlotProjection, g: PlotGrave, geo: PlotGraveGeometry): string {
  const { i0, i1, j0, j1 } = g.cell;
  const cellQuad: PlotPoint[] = [
    project(p, i0 + 0.04, j0 + 0.04, 0),
    project(p, i1 - 0.04, j0 + 0.04, 0),
    project(p, i1 - 0.04, j1 - 0.04, 0),
    project(p, i0 + 0.04, j1 - 0.04, 0),
  ];
  const parts = [pointsSubpath(cellQuad)];
  for (const m of geo.body) {
    if (m.kind === "polygon") {
      const sub = pointsSubpath(m.points);
      if (sub) parts.push(sub);
    }
  }
  return parts.join("");
}

/** Enlarged selection/focus ring enclosing the grave's plinth/podium footprint plus 3.5+ SVG units (C4). */
export function graveRingGeometry(g: PlotGrave, geo: PlotGraveGeometry): { cx: number; cy: number; rx: number; ry: number } {
  const plinthPts = geo.plinth.flatMap((m) => (m.kind === "polygon" ? m.points : []));
  if (plinthPts.length < 3) return g.screen.ring;
  const pb = bbox(plinthPts);
  const cx = round1((pb.x0 + pb.x1) / 2);
  const cy = round1((pb.y0 + pb.y1) / 2);
  const rx = round1(Math.max(g.screen.ring.rx + 2, (pb.x1 - pb.x0) / 2 + 4));
  const ry = round1(Math.max(g.screen.ring.ry + 1.5, (pb.y1 - pb.y0) / 2 + 3.5));
  return { cx, cy, rx, ry };
}

/**
 * Faceted three-tier natural granite headland promontory for the Cemetery's NE lighthouse corner (Item 7).
 * Stays strictly within the lighthouse's existing `apothem` and `[rockZ0, 0.16]` envelope while keeping
 * the shared kit lighthouse (`Harbor` / `PSI`) byte-identical.
 */
export function headlandRockMarks(
  p: PlotProjection,
  lh: { i: number; j: number; apothem: number; rockZ0: number },
): PlotMark[] {
  const DEG = Math.PI / 180;
  const { i: ic, j: jc, apothem, rockZ0 } = lh;
  const Rv = apothem / Math.cos(22.5 * DEG);
  // Angles around the octagonal perimeter; an extra +45° facet splits the exposed SE bevel into natural granite planes.
  const ringDeg = [-22.5, 22.5, 45, 67.5, 112.5, 157.5, 202.5, 247.5, 292.5] as const;
  const prowFactor = (deg: number): number => {
    if (deg === 22.5 || deg === 45) return 1.0;
    if (deg === -22.5 || deg === 67.5) return 0.78;
    if (deg === 112.5) return 0.28;
    return 0; // slab-abutting NW/W/SW vertices stay flush with earth-e and north wall
  };
  const vertex = (deg: number, inset: number, z: number): PlotPoint => {
    const scale = deg === 45 ? 0.96 : 1; // +45° sits slightly proud of the 22.5°–67.5° chord, inside Rv
    const r = Math.max(0.65, Rv * scale - inset * prowFactor(deg));
    return project(p, ic + r * Math.cos(deg * DEG), jc + r * Math.sin(deg * DEG), z);
  };
  const roundPts = (pts: readonly PlotPoint[]): PlotPoint[] => pts.map(([x, y]) => [round1(x), round1(y)]);
  const zTop = 0.16;
  const span = zTop - rockZ0;
  const z1 = rockZ0 + span * 0.39; // ~ -0.49, aligned with the headland slab's -0.50 strata line
  const z2 = rockZ0 + span * 0.71; // ~ -0.15, stepping up cleanly to the lighthouse masonry plinth
  const tiers: readonly { z0: number; z1: number; insetBot: number; insetTop: number }[] = [
    { z0: rockZ0, z1, insetBot: 0, insetTop: 0.025 },
    { z0: z1, z1: z2, insetBot: 0.085, insetTop: 0.11 },
    { z0: z2, z1: zTop, insetBot: 0.145, insetTop: 0.16 },
  ];
  const visibleFaces: readonly (readonly [number, number, string])[] = [
    [-22.5, 22.5, "rock-e"],
    [22.5, 45, "rock-m"],
    [45, 67.5, "rock-m"],
    [67.5, 112.5, "rock-s"],
  ];
  const marks: PlotMark[] = [];
  for (const tier of tiers) {
    for (const [a, b, cls] of visibleFaces) {
      marks.push({
        kind: "polygon",
        cls: `${cls} e`,
        points: roundPts([vertex(a, tier.insetBot, tier.z0), vertex(b, tier.insetBot, tier.z0), vertex(b, tier.insetTop, tier.z1), vertex(a, tier.insetTop, tier.z1)]),
      });
    }
    marks.push({
      kind: "polygon",
      cls: "rock-t e",
      points: roundPts(ringDeg.map((deg) => vertex(deg, tier.insetTop, tier.z1))),
    });
  }
  // Geological granite strata hairlines across the exposed cliff faces, continuing the headland slab's strata language.
  let strataD = "";
  const strataLevels: readonly { z: number; inset: number }[] = [
    { z: rockZ0 + span * 0.19, inset: 0.012 },
    { z: z1 + (z2 - z1) * 0.52, inset: 0.098 },
  ];
  for (const level of strataLevels) {
    const pts = ([-22.5, 22.5, 45, 67.5, 112.5] as const).map((deg) => vertex(deg, level.inset, level.z));
    strataD += `M${round1(pts[0][0])},${round1(pts[0][1])}`;
    for (let k = 1; k < pts.length; k++) strataD += `L${round1(pts[k][0])},${round1(pts[k][1])}`;
  }
  marks.push({ kind: "path", cls: "rock-strata", d: strataD, transform: null });
  return marks;
}

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

/**
 * The kit's hairline edge (`e`) under a two-letter alias scoped to `.map` (restated as the first rule of
 * `plot-map.module.css`). About 1,300 faces carry it, so the kit's module class alone cost ~28 KB of route HTML.
 */
const EDGE_CLASS = "ce";

/** Maps prototype class tokens ("st-t e") to CSS-module classes: the cemetery's, else the scene kit's faces. */
function plotClass(tokens: string): string {
  return tokens
    .split(" ")
    .map((t) => (t === "e" ? EDGE_CLASS : styles[t] ?? kit[t] ?? t))
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
 * A grave's drawn body: grounded contact-shadow band first (outside the hover lift so it stays seated on the bed/pad),
 * then the `.stone` group containing the level plinth and the stone + medallion (only the stone rotates on `lean`,
 * pivoting on the plinth top). Decorative (`aria-hidden`): the grave button carries the full name.
 */
export function PlotGraveBody({
  geometry,
  face,
  showContact = true,
}: {
  geometry: PlotGraveGeometry;
  face: PlotMedallionFace;
  showContact?: boolean;
}): ReactElement {
  const { lean } = geometry;
  return (
    <>
      {showContact && geometry.contact.length > 0 ? <PlotMarks marks={geometry.contact} /> : null}
      <g className={styles.stone} aria-hidden="true">
        {geometry.plinth.length > 0 ? <PlotMarks marks={geometry.plinth} /> : null}
        {lean ? (
          <g transform={`rotate(${lean.deg} ${lean.x} ${lean.y})`}>
            <PlotMarks marks={geometry.stone} face={face} />
          </g>
        ) : (
          <PlotMarks marks={geometry.stone} face={face} />
        )}
      </g>
    </>
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
        const rnd = seededStream(fnv1a32(`${id}:${k + 1}`));
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
  return (
    <>
      <SceneDefs idPrefix="cem" className={kit.defs} hatchLineClassName={kit.hatchLine} gradients={PLOT_GRADIENTS} />
      <svg className={kit.defs} aria-hidden="true" focusable="false">
        <defs>
          <pattern id="cem-hatch-coarse" patternUnits="userSpaceOnUse" width="2.2" height="2.2" patternTransform="rotate(42)">
            <line className={styles.hatchPlinthLine} x1="0" y1="0" x2="0" y2="2.2" />
          </pattern>
        </defs>
      </svg>
    </>
  );
}

/** `cem-g-col` (column shading), `cem-g-col-dim` (solid dimmed column), `cem-g-sea` (moonlit sea), `cem-g-beam`, `cem-g-pool`, `cem-g-spot`. */
const PLOT_GRADIENTS: readonly SceneGradient[] = [
  { id: "col", type: "linear", stops: [["0", styles.gsShade], [".45", styles.gsMid], [".82", styles.gsLit], ["1", styles.gsMid]] },
  { id: "col-dim", type: "linear", stops: [["0", styles.gsDimShade], [".45", styles.gsDimMid], [".82", styles.gsDimLit], ["1", styles.gsDimMid]] },
  { id: "sea", type: "linear", stops: [["0", styles.gsea0], [".68", styles.gsea1], ["1", styles.gsea2]] },
  { id: "beam", type: "linear", stops: [["0", styles.gb0], [".5", styles.gb1], [".8", styles.gb2], ["1", styles.gb3]] },
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
