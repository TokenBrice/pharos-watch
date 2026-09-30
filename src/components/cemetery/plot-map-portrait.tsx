/**
 * Stablecoin Cemetery plot map: the portrait plan (≤ 760 px). Lanes become columns (canonical order left → right),
 * years run down the page newest first, the same grave shapes through the `portrait` projection. One header row
 * (each cell exactly its column's width), year labels in a solid left margin, the drawn grid, and a 44 × 44 hit
 * target per grave (`walk-<id>`, one roving tab stop) for the mobile slot's nearest-centre resolution.
 *
 * Boundary-agnostic: no hooks, no client directive. State (tab stop, pinned grave, flowers) and the delegated
 * hit-layer handlers come from `PlotMapPortraitSlot`.
 */
import { memo, type KeyboardEventHandler, type MouseEventHandler, type ReactElement } from "react";
import type { CauseOfDeath } from "@shared/lib/cause-of-death";
import { PLOT_PROJECTIONS, graveGeometry, portraitSiteMarks } from "@/lib/cemetery-plot-geometry";
import type { PortraitPlotMap } from "@/lib/cemetery-plot-map";
import type { PlotLogoAtlas } from "@/lib/cemetery-plot-map-input";
import { PlotFlowers, PlotGraveBody, PlotMarks, plotCauseClass, plotGraveClass, plotMedallionFace } from "./plot-map-shapes";
import { plotGraveLabel } from "./plot-map-scene";
import styles from "./plot-map.module.css";

/** Column-head labels that fit a phone column; the full CAUSE_META label stays available to assistive tech. */
const SHORT_LABEL: Readonly<Record<CauseOfDeath, string>> = {
  abandoned: "Abandoned",
  "counterparty-failure": "Counter\u00adparty",
  "liquidity-drain": "Liq.",
  "algorithmic-failure": "Algo.",
  regulatory: "Reg.",
};

/** Narrowest phone plan (360 px viewport − 32 px padding − 36 px year margin): margin labels never overlap there. */
const NARROW_PLAN_PX = 292;
const LABEL_H = { year: 26, empty: 34, gap: 3 } as const;
/** Header row height (CSS px); the slot's reserved box adds it to the plan's aspect-ratio height. */
export const PORTRAIT_HEAD_PX = 44;

const NO_FLOWERS: Readonly<Record<string, number>> = {};

export interface PlotMapPortraitProps {
  map: PortraitPlotMap;
  atlas: PlotLogoAtlas;
  /** The one grave with `tabIndex=0` (roving stop); defaults to the model's first landing. */
  tabStopId?: string;
  /** Pinned grave: `aria-pressed` on its button, `data-hot` on its drawn grave. */
  pinnedId?: string | null;
  flowers?: Readonly<Record<string, number>>;
  onHitsClick?: MouseEventHandler<HTMLDivElement>;
  onHitsKeyDown?: KeyboardEventHandler<HTMLDivElement>;
}

/** Margin year labels, pushed down where thin blocks (the empty strip, a one-row year) would make them overlap. */
function yearLabelPushes(map: PortraitPlotMap): number[] {
  const vbY = map.viewBox[1];
  const scale = NARROW_PLAN_PX / map.viewBox[2];
  const pushes: number[] = [];
  let prevBottom = -Infinity;
  for (const b of map.blocks) {
    const h = b.empty ? LABEL_H.empty : LABEL_H.year;
    const top = ((b.span.y0 + b.span.y1) / 2 - vbY) * scale - h / 2;
    const push = Math.max(0, prevBottom + LABEL_H.gap - top);
    prevBottom = top + push + h;
    pushes.push(Math.ceil(push));
  }
  return pushes;
}

/** The drawn plan; re-renders only when the pinned grave or the flowers change, never on tab-stop moves. */
const PortraitSvg = memo(function PortraitSvg({
  map,
  atlas,
  hotId,
  flowers,
}: {
  map: PortraitPlotMap;
  atlas: PlotLogoAtlas;
  hotId: string | null;
  flowers: Readonly<Record<string, number>>;
}): ReactElement {
  const p = PLOT_PROJECTIONS[map.projection];
  const site = portraitSiteMarks(map);
  const byKey = new Map(map.graves.map((g) => [`grave:${g.id}`, g]));
  const drawn = map.drawOrder.flatMap((key) => {
    const g = byKey.get(key);
    return g ? [{ g, geometry: graveGeometry(p, g) }] : [];
  });
  return (
    <svg className={styles.map} viewBox={map.viewBox.join(" ")} aria-hidden="true" focusable="false" data-plot-portrait-svg>
      <g>
        <PlotMarks marks={site.ground} />
        {site.beds.map((bed) => (
          <g key={bed.cause} className={`${styles.bedG} ${plotCauseClass(bed.cause)}`} data-cause={bed.cause}>
            <PlotMarks marks={bed.marks} />
          </g>
        ))}
        {drawn.map(({ g, geometry }) => (
          <g key={g.id} className={plotGraveClass(styles.gm, g.cause, g.weather)} data-grave-id={g.id}>
            <PlotMarks marks={geometry.ground} />
          </g>
        ))}
      </g>
      <g data-plot-layer="objects">
        {drawn.map(({ g, geometry }) => (
          <g
            key={g.id}
            className={plotGraveClass(styles.grave, g.cause, g.weather)}
            data-grave-id={g.id}
            data-cause={g.cause}
            data-year={g.year}
            data-hot={g.id === hotId || undefined}
          >
            <PlotGraveBody geometry={geometry} face={plotMedallionFace(atlas, g.id, g.symbol)} />
            {flowers[g.id] ? <PlotFlowers id={g.id} count={flowers[g.id]} x={geometry.medal.x} y={geometry.medal.y} /> : null}
          </g>
        ))}
      </g>
    </svg>
  );
});

export function PlotMapPortrait({
  map,
  atlas,
  tabStopId = map.keyboard.initialId,
  pinnedId = null,
  flowers = NO_FLOWERS,
  onHitsClick,
  onHitsKeyDown,
}: PlotMapPortraitProps): ReactElement {
  const [vbX, vbY, vbW, vbH] = map.viewBox;
  const x = (v: number) => `${((v - vbX) / vbW) * 100}%`;
  const y = (v: number) => `${((v - vbY) / vbH) * 100}%`;
  const pushes = yearLabelPushes(map);

  return (
    <div className={styles.portrait} data-plot-portrait>
      <div className={styles.portraitHeads} style={{ height: PORTRAIT_HEAD_PX }}>
        {map.columns.map((c) => (
          <span key={c.cause} className={`${styles.colHead} ${plotCauseClass(c.cause)}`} style={{ left: x(c.x0), width: `${((c.x1 - c.x0) / vbW) * 100}%` }} title={c.label}>
            <span className={styles.top}>
              <span className={styles.sw} />
              <span className={styles.n}>{c.count}</span>
            </span>
            <span className={styles.lb} aria-hidden="true">
              {SHORT_LABEL[c.cause]}
            </span>
            <span className="sr-only">{c.label}</span>
          </span>
        ))}
      </div>
      <div
        className={styles.portraitPlan}
        role="group"
        aria-label="Stablecoin Cemetery plot map, newest year first. Each button opens one grave; the Autopsy Register below lists every record."
      >
        <PortraitSvg map={map} atlas={atlas} hotId={pinnedId} flowers={flowers} />
        {map.blocks.map((b, k) => (
          <span
            key={b.key}
            className={styles.yr}
            style={{ top: y((b.span.y0 + b.span.y1) / 2), marginTop: pushes[k] || undefined }}
            data-empty={b.empty || undefined}
            aria-hidden="true"
          >
            <span className={styles.mono}>{b.label}</span>
            {b.empty ? <small>{b.sub}</small> : <small className={styles.mono}>{b.count}</small>}
          </span>
        ))}
        <div className={styles.hits} onClick={onHitsClick} onKeyDown={onHitsKeyDown} data-plot-hits>
          {map.graves.map((g) => (
            <a
              key={g.id}
              className={styles.hit44}
              id={`walk-${g.id}`}
              href={`#${g.id}`}
              role="button"
              aria-pressed={g.id === pinnedId}
              aria-label={plotGraveLabel(g)}
              tabIndex={g.id === tabStopId ? 0 : -1}
              style={{ left: x(g.screen.centre[0]), top: y(g.screen.centre[1]) }}
              data-grave-id={g.id}
              data-cause={g.cause}
              data-year={g.year}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
