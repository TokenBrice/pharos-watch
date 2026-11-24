/**
 * Stablecoin Cemetery plot map legend, in reading order: a two-line key (what a stone, a section, a row and a monument
 * mean, and that a cause sign zooms), then "encoding = field" groups with drawn examples made by the same shape
 * geometry as the plan: shape = cause, plinth steps = peak (with the hatched unrecorded peak), and the finer marks
 * (year blocks, weathering, fresh soil, plaque, footstone, cypress) in a disclosure. Order and labels are the
 * canonical `CAUSE_ORDER` / `CAUSE_META`. Server-safe (no hooks); the paint servers come from the hero's
 * `PlotMapDefs`. The disclosure renders open; the phone layer folds it once below 761 px (`data-plot-legend-more`).
 */
import type { ReactElement } from "react";
import { CAUSE_META, CAUSE_ORDER, type CauseOfDeath } from "@shared/lib/cause-of-death";
import { fnv1a32 } from "@shared/lib/fnv1a";
import {
  PLOT_ARCHETYPE_BY_CAUSE,
  PLOT_PROJECTIONS,
  bbox,
  graveGeometry,
  plotShapeOf,
  type PlotGraveShapeInput,
  type PlotPeakClass,
  type PlotWeather,
} from "@/lib/cemetery-plot-geometry";
import { PLOT_FRESH_DAYS, PLOT_PEG_GLYPHS } from "@/lib/cemetery-plot-map";
import { PLOT_STEP_LABELS, PlotGraveBody, PlotMarks, plotCauseClass, plotGraveClass, serializePlotLens } from "./plot-map-shapes";
import styles from "./plot-map.module.css";

const LEGEND_SEED = fnv1a32("legend");

/** A plain 1×1 $10M–$100M stone; each example overrides one field. */
function sample(over: Partial<PlotGraveShapeInput>): PlotGraveShapeInput {
  return {
    shape: "pillow",
    lot: 1,
    steps: 1,
    heightFactor: 0.83,
    weather: 0,
    fresh: false,
    archived: false,
    footstone: null,
    seed: LEGEND_SEED,
    lean: 0,
    cell: { i0: 0, i1: 1.1, j0: 0, j1: 0.92 },
    anchor: { i: 0.3, j: 0.46 },
    ...over,
  };
}

function StoneIcon({ g, cause = "abandoned", pad = 2, ground = true }: { g: PlotGraveShapeInput; cause?: CauseOfDeath; pad?: number; ground?: boolean }): ReactElement {
  const geometry = graveGeometry(PLOT_PROJECTIONS.dimetric, g);
  const b = bbox(geometry.pts);
  const viewBox = [b.x0 - pad, b.y0 - pad, b.x1 - b.x0 + 2 * pad, b.y1 - b.y0 + 2 * pad].map((v) => Math.round(v * 10) / 10).join(" ");
  return (
    <svg className={`${styles.icon} ${styles.map}`} viewBox={viewBox} aria-hidden="true" focusable="false">
      <g className={plotGraveClass(styles.grave, cause, g.weather)}>
        {ground ? <PlotMarks marks={geometry.ground} /> : null}
        <PlotGraveBody geometry={geometry} face={null} showContact={ground} />
      </g>
    </svg>
  );
}

const WEATHER_SAMPLES: readonly PlotWeather[] = [0, 2, 4];

export function PlotMapLegend({ firstYear, lastYear }: { firstYear: number; lastYear: number }): ReactElement {
  return (
    <section className={styles.legend} id="legend" aria-label="How to read the plot map" data-plot-legend>
      <p className={styles.legendKey}>
        Each stone is one coin. Sections show why; rows show when; bigger monuments mean bigger recorded peaks.
        <span className={styles.zoomHint}> Select a cause sign to look closer, or toggle any legend mark below to highlight matching stones.</span>
      </p>
      <div>
        <h2>Shape = cause of death</h2>
        <ul>
          {CAUSE_ORDER.map((cause) => (
            <li key={cause}>
              <button
                type="button"
                className={`${styles.lensBtn} ${plotCauseClass(cause)}`}
                data-plot-lens={serializePlotLens({ kind: "cause", cause })}
                disabled
              >
                <StoneIcon g={sample({ shape: plotShapeOf(PLOT_ARCHETYPE_BY_CAUSE[cause], 1) })} cause={cause} />
                <span>
                  <b>{CAUSE_META[cause].label}</b>
                </span>
              </button>
            </li>
          ))}
        </ul>
        <p className={styles.note}>
          Stone shape is cause of death, not what holders recovered.{" "}
          <span className={styles.onWide}>Sections run from Abandoned at the front to Regulatory under the sea wall.</span>
          <span className={styles.onPhone}>Columns run from Abandoned on the left to Regulatory on the right.</span>
        </p>
      </div>
      <div>
        <h2>Plinth steps = peak market cap</h2>
        <div className={styles.steps}>
          {PLOT_STEP_LABELS.map((label, n) => (
            <button
              key={label}
              type="button"
              className={styles.lensStepBtn}
              data-plot-lens={serializePlotLens({ kind: "steps", steps: n as PlotPeakClass })}
              aria-label={`Highlight stones with peak market cap ${label}`}
              disabled
            >
              <figure>
                <StoneIcon g={sample({ steps: n as PlotPeakClass, heightFactor: 0.7 + n * 0.1 })} pad={3} ground={false} />
                <figcaption>{label}</figcaption>
              </figure>
            </button>
          ))}
        </div>
        <ul className={styles.afterSteps}>
          <li>
            <button
              type="button"
              className={styles.lensBtn}
              data-plot-lens={serializePlotLens({ kind: "unrecorded" })}
              disabled
            >
              <StoneIcon g={sample({ steps: null })} />
              <span>
                <b>Peak not recorded</b> <span className={styles.eq}>= hatched face and plinth, neutral height</span>
              </span>
            </button>
          </li>
        </ul>
        <p className={styles.note}>
          Each step is ×10. At $10B and above the architecture carries the class: TerraUSD&apos;s snapped column is the tallest monument, Binance USD&apos;s sealed
          mausoleum the largest. Peak market cap is not what holders lost.
        </p>
      </div>
      <details className={styles.legendMore} open data-plot-legend-more>
        <summary>Year blocks, weathering and other marks</summary>
        <h2>Position and marks</h2>
        <ul>
          <li>
            <svg className={styles.icon} viewBox="0 0 58 36" aria-hidden="true" focusable="false">
              <path className={styles.yearAxisLine} d="M4 30 L54 30" />
              <text className={styles.yearAxis} x="4" y="24">
                {lastYear}
              </text>
              <text className={styles.yearAxis} x="54" y="24" textAnchor="end">
                {firstYear}
              </text>
            </svg>
            <span>
              <b>Year blocks</b>{" "}
              <span className={styles.eq}>
                = year of death, <span className={styles.onWide}>newest at the gate, oldest under the lighthouse</span>
                <span className={styles.onPhone}>newest at the top, sticky year bands as you scroll</span>
              </span>
            </span>
          </li>
          <li>
            <span className={styles.icons}>
              {WEATHER_SAMPLES.map((w) => (
                <StoneIcon key={w} g={sample({ weather: w, seed: fnv1a32(`w${w}`) })} ground={false} />
              ))}
            </span>
            <span>
              <b>Weathering</b> <span className={styles.eq}>= years since death</span>
            </span>
          </li>
          <li>
            <button
              type="button"
              className={styles.lensBtn}
              data-plot-lens={serializePlotLens({ kind: "fresh" })}
              disabled
            >
              <StoneIcon g={sample({ fresh: true })} />
              <span>
                <b>Fresh soil</b> <span className={styles.eq}>= died within {PLOT_FRESH_DAYS} days of the latest recorded death</span>
              </span>
            </button>
          </li>
          <li>
            <button
              type="button"
              className={styles.lensBtn}
              data-plot-lens={serializePlotLens({ kind: "archived" })}
              disabled
            >
              <StoneIcon g={sample({ archived: true })} />
              <span>
                <b>Bronze plaque</b> <span className={styles.eq}>= Pharos holds a frozen data page</span>
              </span>
            </button>
          </li>
          <li>
            <button
              type="button"
              className={styles.lensBtn}
              data-plot-lens={serializePlotLens({ kind: "non-usd" })}
              disabled
            >
              <StoneIcon g={sample({ footstone: PLOT_PEG_GLYPHS.EUR })} />
              <span>
                <b>Footstone glyph</b> <span className={styles.eq}>= peg other than USD</span>
              </span>
            </button>
          </li>
        </ul>
        <p className={styles.note}>
          <span className={styles.onWide}>
            Cypress height is deaths that year. Hover a stone to read it; select it to pin its record; toggle a legend mark to highlight matching stones. Keyboard:
            Tab into the map, then the arrow keys move from stone to stone; Enter pins, Esc closes.
          </span>
          <span className={styles.onPhone}>
            Tap a stone to open its record; tap a cause head or legend mark to highlight matching stones. Keyboard: the arrow keys move from stone to stone; Enter
            opens, Esc closes.
          </span>
        </p>
      </details>
    </section>
  );
}
