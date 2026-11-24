/**
 * Cemetery cause gravestone marker drawn read-only from `graveGeometry` — the
 * exact five stone shapes shown in the hero legend. Boundary-agnostic: no hooks,
 * no client directive; cause colours come solely from `causeColorVars`
 * (`CAUSE_HEX` / `CAUSE_HEX_DARK` via `shared/lib/classification.ts`).
 *
 * Low-count surfaces (causes band, chart legends/lanes) use `CemeteryCauseGlyph`
 * directly. High-count repeated rows (the Autopsy Register) mount one
 * `CemeteryCauseGlyphDefs` symbol host and reference it with `CemeteryCauseGlyphUse`
 * so per-row markup stays tiny and works without JS.
 */
import type { ReactElement } from "react";
import { CAUSE_ORDER, type CauseOfDeath } from "@shared/lib/cause-of-death";
import { fnv1a32 } from "@shared/lib/fnv1a";
import {
  PLOT_ARCHETYPE_BY_CAUSE,
  PLOT_PROJECTIONS,
  bbox,
  graveGeometry,
  plotShapeOf,
  type PlotGraveGeometry,
  type PlotGraveShapeInput,
  type PlotMedallionMark,
} from "@/lib/cemetery-plot-geometry";
import { causeColorVars } from "@/lib/cemetery-cause-style";
import { cn } from "@/lib/utils";
import { SceneMarks } from "../scene/scene-marks";
import styles from "./cemetery-below-fold.module.css";

export type CemeteryCauseGlyphSize = "xs" | "sm" | "md";

const GLYPH_SEED = fnv1a32("legend");
const GLYPH_PAD = 1.5;

const SIZE_CLASS: Readonly<Record<CemeteryCauseGlyphSize, string>> = {
  xs: styles.glyphXs,
  sm: styles.glyphSm,
  md: styles.glyphMd,
};

const MARK_CLASS: Readonly<Record<string, string>> = {
  e: styles.gE,
  "st-e": styles.gStE,
  "st-t": styles.gStT,
  "st-s": styles.gStS,
  col: styles.gCol,
  brk: styles.gBrk,
  "pl-e": styles.gPlE,
  "pl-t": styles.gPlT,
  "pl-s": styles.gPlS,
  crack: styles.gCrack,
  mouth: styles.gMouth,
  seal: styles.gSeal,
};

function glyphClassOf(tokens: string): string {
  return tokens
    .split(" ")
    .map((token) => MARK_CLASS[token] ?? token)
    .join(" ");
}

function sampleShapeInput(cause: CauseOfDeath): PlotGraveShapeInput {
  return {
    shape: plotShapeOf(PLOT_ARCHETYPE_BY_CAUSE[cause], 1),
    lot: 1,
    steps: 1,
    heightFactor: 0.83,
    weather: 0,
    fresh: false,
    archived: false,
    footstone: null,
    seed: GLYPH_SEED,
    lean: 0,
    cell: { i0: 0, i1: 1.1, j0: 0, j1: 0.92 },
    anchor: { i: 0.3, j: 0.46 },
  };
}

interface BuiltCauseGlyph {
  geometry: PlotGraveGeometry;
  viewBox: string;
}

const GLYPHS: Readonly<Record<CauseOfDeath, BuiltCauseGlyph>> = Object.fromEntries(
  CAUSE_ORDER.map((cause) => {
    const geometry = graveGeometry(PLOT_PROJECTIONS.dimetric, sampleShapeInput(cause));
    const b = bbox(geometry.pts);
    const viewBox = [
      b.x0 - GLYPH_PAD,
      b.y0 - GLYPH_PAD,
      b.x1 - b.x0 + 2 * GLYPH_PAD,
      b.y1 - b.y0 + 2 * GLYPH_PAD,
    ]
      .map((value) => Math.round(value * 10) / 10)
      .join(" ");
    return [cause, { geometry, viewBox }];
  }),
) as Record<CauseOfDeath, BuiltCauseGlyph>;

function CauseGlyphMarks({ geometry }: { geometry: PlotGraveGeometry }): ReactElement {
  return (
    <SceneMarks
      marks={geometry.body}
      classOf={glyphClassOf}
      renderMark={(mark: PlotMedallionMark, key) => (
        <circle key={key} className={styles.gMed} cx={mark.cx} cy={mark.cy} r={mark.r} />
      )}
    />
  );
}

/** Inline decorative gravestone marker for one cause of death (`aria-hidden`; pair with visible text). */
export function CemeteryCauseGlyph({
  cause,
  size = "sm",
  className,
}: {
  cause: CauseOfDeath;
  size?: CemeteryCauseGlyphSize;
  className?: string;
}): ReactElement {
  const { geometry, viewBox } = GLYPHS[cause];
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      data-cause-glyph={cause}
      data-cause-archetype={PLOT_ARCHETYPE_BY_CAUSE[cause]}
      viewBox={viewBox}
      preserveAspectRatio="xMidYMax meet"
      className={cn(styles.glyph, styles.glyphRoot, SIZE_CLASS[size], className)}
      style={causeColorVars(cause)}
    >
      <CauseGlyphMarks geometry={geometry} />
    </svg>
  );
}

/** 0×0 symbol host mounted once for repeated register rows (never `display: none`). */
export function CemeteryCauseGlyphDefs({ idPrefix }: { idPrefix: string }): ReactElement {
  return (
    <svg aria-hidden="true" focusable="false" className={styles.glyphDefs}>
      <defs>
        {CAUSE_ORDER.map((cause) => {
          const { geometry, viewBox } = GLYPHS[cause];
          return (
            <symbol
              key={cause}
              id={`${idPrefix}-${cause}`}
              viewBox={viewBox}
              preserveAspectRatio="xMidYMax meet"
              className={styles.glyphRoot}
              style={causeColorVars(cause)}
            >
              <CauseGlyphMarks geometry={geometry} />
            </symbol>
          );
        })}
      </defs>
    </svg>
  );
}

/** Lightweight `<use>` reference to `CemeteryCauseGlyphDefs` (falls back to inline if no prefix is supplied). */
export function CemeteryCauseGlyphUse({
  cause,
  idPrefix,
  size = "sm",
  className,
}: {
  cause: CauseOfDeath;
  idPrefix?: string;
  size?: CemeteryCauseGlyphSize;
  className?: string;
}): ReactElement {
  if (!idPrefix) return <CemeteryCauseGlyph cause={cause} size={size} className={className} />;
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      data-cause-glyph={cause}
      data-cause-archetype={PLOT_ARCHETYPE_BY_CAUSE[cause]}
      className={cn(styles.glyph, styles.glyphRoot, SIZE_CLASS[size], className)}
      style={causeColorVars(cause)}
    >
      <use href={`#${idPrefix}-${cause}`} />
    </svg>
  );
}
