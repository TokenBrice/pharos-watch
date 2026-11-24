/**
 * Stablecoin Cemetery plot map: the portrait walk (phones ≤ 760 px and touch tablets ≤ 1024 px). Lanes become
 * vertical columns (canonical order left → right), years run down the page newest first, the same grave shapes through
 * the vertical `portrait` projection. Sticky equal-height cause-head toggle buttons highlight a cause lane via the
 * shared `data-dim` vocabulary; sticky year bands ride along each block so the plan runs full-bleed without a left
 * year gutter; and a 44 × 44 hit target per grave (`walk-<id>`, one roving tab stop) feeds nearest-centre tap
 * resolution.
 *
 * Pure and SSR-safe: `PlotMapPortraitSkeleton` renders the lightweight chrome + site beds during SSR (~6 KB raw,
 * exact viewBox aspect for 0 CLS) while `PlotMapPortrait` mounts client-side under `PLOT_PORTRAIT_QUERY`.
 */
import { memo, useImperativeHandle, useRef, type KeyboardEventHandler, type MouseEventHandler, type ReactElement, type Ref } from "react";
import type { CauseOfDeath } from "@shared/lib/cause-of-death";
import { PLOT_PROJECTIONS, bbox, graveGeometry, lotPadCell, portraitSiteMarks, project, round1 } from "@/lib/cemetery-plot-geometry";
import type { PortraitPlotMap } from "@/lib/cemetery-plot-map";
import type { PlotLogoAtlas } from "@/lib/cemetery-plot-map-input";
import { PlotFlowers, PlotGraveBody, PlotMarks, matchesPlotLens, plotCauseClass, plotGraveClass, plotMedallionFace, type PlotLens } from "./plot-map-shapes";
import { plotGraveLabel } from "./plot-map-scene";
import styles from "./plot-map.module.css";
import mobileStyles from "./plot-map-mobile.module.css";

/** Compact column-head labels for narrow phone columns; assistive tech always receives the full `CAUSE_META` label. */
const SHORT_LABEL: Readonly<Record<CauseOfDeath, string>> = {
  abandoned: "Abandoned",
  "counterparty-failure": "Counter\u00adparty",
  "liquidity-drain": "Liq.",
  "algorithmic-failure": "Algo.",
  regulatory: "Reg.",
};

/** Full one-word column-head labels shown once columns widen on tablet touch viewports. */
const FULL_PORTRAIT_LABEL: Readonly<Record<CauseOfDeath, string>> = {
  abandoned: "Abandoned",
  "counterparty-failure": "Counterparty",
  "liquidity-drain": "Liquidity",
  "algorithmic-failure": "Algorithmic",
  regulatory: "Regulatory",
};

/** Keyboard model of the walk, announced as the group's description (F for flowers stays undocumented here). */
const KEYS_HINT =
  "Arrow keys move between graves: up and down through the years in a cause column, left and right between columns; Home and End jump to a column's newest and oldest. Enter or Space opens the record; cause buttons above highlight one column; Escape closes the record or clears the highlight.";
/** Sticky cause-head bar height (CSS px): 45 px border-box (1 px bottom border) yields exact 44 px tall buttons. */
export const PORTRAIT_HEAD_PX = 45;

const NO_FLOWERS: Readonly<Record<string, number>> = {};
/** SVG clearance below a block's front bed curb + contact shadow before the next sticky year track starts. */
const PORTRAIT_CURB_CLEARANCE = 5.5;

/**
 * Sticky year-track bounds in SVG y: each non-empty block extends to the exact `y0` of the next track so incoming
 * year bands push outgoing bands edge-to-edge behind the opaque `.portraitHeads` bar with zero gap or text leak.
 */
function portraitYearTrackBounds(
  blocks: PortraitPlotMap["blocks"],
  index: number,
  vbY: number,
  vbH: number,
): { y0: number; y1: number } {
  const b = blocks[index];
  if (b.empty) return { y0: b.span.y0, y1: b.span.y1 };
  const y0 = index === 0 ? vbY : blocks[index - 1].span.y1 + PORTRAIT_CURB_CLEARANCE;
  const next = blocks[index + 1];
  const y1 = next ? (next.empty ? next.span.y0 : b.span.y1 + PORTRAIT_CURB_CLEARANCE) : vbY + vbH;
  return { y0, y1 };
}

export interface PlotMapPortraitHandle {
  grave(id: string): HTMLAnchorElement | null;
  graves(): { id: string; element: HTMLAnchorElement }[];
  graveOf(target: EventTarget | null): { id: string; element: HTMLElement } | null;
  causeHead(cause: CauseOfDeath): HTMLButtonElement | null;
}

export interface PlotMapPortraitProps {
  controllerRef?: Ref<PlotMapPortraitHandle>;
  map: PortraitPlotMap;
  atlas: PlotLogoAtlas;
  /** The one grave with `tabIndex=0` (roving stop); defaults to the model's first landing. */
  tabStopId?: string;
  /** Pinned grave: `aria-pressed` on its button, `data-hot` + full-grave selection ring on its drawn grave. */
  pinnedId?: string | null;
  /** Highlighted cause column toggled from the sticky cause heads (`data-dim="lane"`). */
  activeCause?: CauseOfDeath | null;
  /** Optional non-cause legend lens (composes with `activeCause` as an intersection, E9). */
  activeLens?: PlotLens | null;
  flowers?: Readonly<Record<string, number>>;
  /** The plan box (drawn grid + sticky year bands + hit layer). */
  planRef?: Ref<HTMLDivElement>;
  onToggleCause?: (cause: CauseOfDeath) => void;
  onHitsClick?: MouseEventHandler<HTMLDivElement>;
  onHitsKeyDown?: KeyboardEventHandler<HTMLDivElement>;
}

/** The drawn walk; re-renders only when the pinned grave, active cause/lens or flowers change, never on tab-stop moves. */
const PortraitSvg = memo(function PortraitSvg({
  map,
  atlas,
  hotId,
  activeCause,
  activeLens,
  flowers,
}: {
  map: PortraitPlotMap;
  atlas: PlotLogoAtlas;
  hotId: string | null;
  activeCause: CauseOfDeath | null;
  activeLens: PlotLens | null;
  flowers: Readonly<Record<string, number>>;
}): ReactElement {
  const p = PLOT_PROJECTIONS[map.projection];
  const site = portraitSiteMarks(map);
  const byKey = new Map(map.graves.map((g) => [`grave:${g.id}`, g]));
  const drawn = map.drawOrder.flatMap((key) => {
    const g = byKey.get(key);
    return g ? [{ g, geometry: graveGeometry(p, g) }] : [];
  });
  const effectiveCause = activeLens?.kind === "cause" ? activeLens.cause : activeCause;
  const nonCauseLens = activeLens && activeLens.kind !== "cause" ? activeLens : null;
  const dimKind: "lane" | "lens" | "spotlight" | undefined = nonCauseLens
    ? "lens"
    : effectiveCause
      ? "lane"
      : hotId
        ? "spotlight"
        : undefined;
  const isLit = (g: PortraitPlotMap["graves"][number]): "true" | undefined => {
    if (!dimKind) return undefined;
    if (dimKind === "spotlight") return g.id === hotId ? "true" : undefined;
    if (dimKind === "lane") return g.cause === effectiveCause ? "true" : undefined;
    return (effectiveCause ? g.cause === effectiveCause : true) && matchesPlotLens(g, nonCauseLens!) ? "true" : undefined;
  };
  const hotDrawn = hotId ? (drawn.find(({ g }) => g.id === hotId) ?? null) : null;
  const ringBox = hotDrawn
    ? bbox(
        hotDrawn.g.lot > 1
          ? (() => {
              const pad = lotPadCell(hotDrawn.g.cell);
              return [
                ...hotDrawn.geometry.pts,
                project(p, pad.i0, pad.j0, 0),
                project(p, pad.i1, pad.j0, 0),
                project(p, pad.i1, pad.j1, 0),
                project(p, pad.i0, pad.j1, 0),
                project(p, pad.i0, pad.j0, 0.16),
                project(p, pad.i1, pad.j1, 0.16),
              ];
            })()
          : hotDrawn.geometry.pts,
      )
    : null;
  const ringPadX = hotDrawn && hotDrawn.g.lot > 1 ? 2.5 : 3.5;
  const ringPadBot = hotDrawn && hotDrawn.g.lot > 1 ? 2.5 : 3.5;
  return (
    <svg
      className={styles.map}
      viewBox={map.viewBox.join(" ")}
      aria-hidden="true"
      focusable="false"
      data-plot-portrait-svg
      data-dim={dimKind}
    >
      <g>
        <PlotMarks marks={site.ground} />
        {site.beds.map((bed) => (
          <g
            key={bed.cause}
            className={`${styles.bedG} ${plotCauseClass(bed.cause)}`}
            data-cause={bed.cause}
            data-lit={effectiveCause && bed.cause === effectiveCause ? "true" : undefined}
          >
            <PlotMarks marks={bed.marks} />
          </g>
        ))}
        {drawn.map(({ g, geometry }) => (
          <g
            key={g.id}
            className={plotGraveClass(styles.gm, g.cause, g.weather)}
            data-grave-id={g.id}
            data-lit={isLit(g)}
          >
            <PlotMarks marks={geometry.ground} />
          </g>
        ))}
        <g className={mobileStyles.walkTrees} data-plot-portrait-trees>
          {site.trees.map((tree, idx) => (
            <g key={`${tree.year}-${idx}`} className={styles.tree}>
              <PlotMarks marks={tree.marks} />
            </g>
          ))}
        </g>
      </g>
      <g data-plot-layer="objects">
        {drawn.map(({ g, geometry }) => (
          <g
            key={g.id}
            className={plotGraveClass(styles.grave, g.cause, g.weather)}
            data-grave-id={g.id}
            data-cause={g.cause}
            data-year={g.year}
            data-hot={g.id === hotId ? "true" : undefined}
            data-lit={isLit(g)}
          >
            <PlotGraveBody geometry={geometry} face={plotMedallionFace(atlas, g.id, g.symbol)} />
            {flowers[g.id] ? <PlotFlowers id={g.id} count={flowers[g.id]} x={geometry.medal.x} y={geometry.medal.y} /> : null}
          </g>
        ))}
      </g>
      <g data-plot-layer="focus" aria-hidden="true" className={styles.focusLayer}>
        {hotDrawn && ringBox ? (
          <>
            <rect
              className={`${styles.portraitRing} ${plotCauseClass(hotDrawn.g.cause)}`}
              x={round1(ringBox.x0 - ringPadX)}
              y={round1(ringBox.y0 - 4)}
              width={round1(ringBox.x1 - ringBox.x0 + ringPadX * 2)}
              height={round1(ringBox.y1 - ringBox.y0 + 4 + ringPadBot)}
              rx={4.5}
              ry={4.5}
              data-plot-portrait-ring={hotDrawn.g.id}
            />
            <g
              className={plotGraveClass(styles.grave, hotDrawn.g.cause, hotDrawn.g.weather)}
              data-focus-copy={hotDrawn.g.id}
              data-hot="true"
              data-lit="true"
            >
              <PlotGraveBody geometry={hotDrawn.geometry} face={plotMedallionFace(atlas, hotDrawn.g.id, hotDrawn.g.symbol)} />
              {flowers[hotDrawn.g.id] ? (
                <PlotFlowers id={hotDrawn.g.id} count={flowers[hotDrawn.g.id]} x={hotDrawn.geometry.medal.x} y={hotDrawn.geometry.medal.y} />
              ) : null}
            </g>
          </>
        ) : null}
      </g>
    </svg>
  );
});

/**
 * Lightweight SSR placeholder for the portrait walk: exact column heads, ground/bed SVG at the final viewBox aspect,
 * and sticky year bands — zero stones, medallions, or hit anchors (~6 KB raw, 0 CLS on client swap).
 */
export function PlotMapPortraitSkeleton({ map }: { map: PortraitPlotMap }): ReactElement {
  const site = portraitSiteMarks(map, { detail: false });
  const [vbX, vbY, vbW, vbH] = map.viewBox;
  const x = (v: number) => `${((v - vbX) / vbW) * 100}%`;
  const y = (v: number) => `${((v - vbY) / vbH) * 100}%`;
  const h = (span: number) => `${(span / vbH) * 100}%`;

  return (
    <div className={`${styles.portrait} ${mobileStyles.walk}`} data-plot-portrait data-plot-portrait-skeleton aria-hidden="true">
      <div className={styles.portraitHeads} style={{ height: PORTRAIT_HEAD_PX }} data-plot-portrait-heads>
        {map.columns.map((c) => (
          <span key={c.cause} className={styles.colSlot} style={{ left: x(c.x0), width: `${((c.x1 - c.x0) / vbW) * 100}%` }}>
            <span className={`${styles.colHead} ${plotCauseClass(c.cause)}`} data-cause={c.cause}>
              <span className={styles.top}>
                <span className={styles.sw} />
                <span className={styles.n}>{c.count}</span>
              </span>
              <span className={styles.lb}>
                <span className={styles.lbShort}>{SHORT_LABEL[c.cause]}</span>
                <span className={styles.lbFull}>{FULL_PORTRAIT_LABEL[c.cause]}</span>
              </span>
            </span>
          </span>
        ))}
      </div>
      <div className={`${styles.portraitPlan} ${mobileStyles.walkPlan}`}>
        <svg className={styles.map} viewBox={map.viewBox.join(" ")} focusable="false" data-plot-portrait-svg>
          <g>
            <PlotMarks marks={site.ground} />
            {site.beds.map((bed) => (
              <g key={bed.cause} className={`${styles.bedG} ${plotCauseClass(bed.cause)}`} data-cause={bed.cause}>
                <PlotMarks marks={bed.marks} />
              </g>
            ))}
          </g>
        </svg>
        <div className={styles.yearTracks}>
          {map.blocks.map((b, k) => {
            const { y0, y1 } = portraitYearTrackBounds(map.blocks, k, vbY, vbH);
            if (b.empty) {
              return (
                <div
                  key={b.key}
                  className={styles.yearTrack}
                  style={{ top: y(y0), height: h(Math.max(1, y1 - y0)) }}
                  data-empty="true"
                  data-plot-year-band={b.key}
                >
                  <div className={styles.yearEmpty}>
                    <span className={styles.yearLabel}>
                      <span className={styles.mono}>{b.label}</span>
                      <span className={styles.yearSep}>·</span>
                      <span>{b.sub ?? "none recorded"}</span>
                    </span>
                    <span className={styles.yearRule} />
                  </div>
                </div>
              );
            }
            return (
              <div
                key={b.key}
                className={styles.yearTrack}
                style={{ top: y(y0), height: h(Math.max(1, y1 - y0)) }}
                data-plot-year-band={b.key}
              >
                <div className={styles.yearBand} data-merged={b.sub ? "true" : undefined}>
                  <span className={styles.yearLabel}>
                    <span className={styles.mono}>{b.label}</span>
                    <span className={styles.yearSep}>·</span>
                    <small className={styles.mono}>{b.count}</small>
                    {b.sub ? <small className={styles.yearSub}>{b.sub}</small> : null}
                  </span>
                  <span className={styles.yearRule} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function PlotMapPortrait({
  map,
  atlas,
  tabStopId = map.keyboard.initialId,
  pinnedId = null,
  activeCause = null,
  activeLens = null,
  flowers = NO_FLOWERS,
  planRef,
  controllerRef,
  onToggleCause,
  onHitsClick,
  onHitsKeyDown,
}: PlotMapPortraitProps): ReactElement {
  const gravesRef = useRef(new Map<string, HTMLAnchorElement>());
  const causeHeadsRef = useRef(new Map<CauseOfDeath, HTMLButtonElement>());
  useImperativeHandle(
    controllerRef,
    () => ({
      grave: (id) => gravesRef.current.get(id) ?? null,
      graves: () =>
        map.graves.flatMap(({ id }) => {
          const element = gravesRef.current.get(id);
          return element ? [{ id, element }] : [];
        }),
      graveOf: (target) => {
        const element = target instanceof Element ? target.closest<HTMLElement>("[data-grave-id]") : null;
        return element?.dataset.graveId ? { id: element.dataset.graveId, element } : null;
      },
      causeHead: (cause) => causeHeadsRef.current.get(cause) ?? null,
    }),
    [map],
  );
  const [vbX, vbY, vbW, vbH] = map.viewBox;
  const x = (v: number) => `${((v - vbX) / vbW) * 100}%`;
  const y = (v: number) => `${((v - vbY) / vbH) * 100}%`;
  const h = (span: number) => `${(span / vbH) * 100}%`;

  const effectiveCause = activeLens?.kind === "cause" ? activeLens.cause : activeCause;
  return (
    <div className={`${styles.portrait} ${mobileStyles.walk}`} data-plot-portrait>
      <div
        className={styles.portraitHeads}
        style={{ height: PORTRAIT_HEAD_PX }}
        role="group"
        aria-label="Highlight a cause of death column"
        data-has-active={effectiveCause ? "true" : undefined}
        data-plot-portrait-heads
      >
        {map.columns.map((c) => {
          const pressed = effectiveCause === c.cause;
          return (
            <span key={c.cause} className={styles.colSlot} style={{ left: x(c.x0), width: `${((c.x1 - c.x0) / vbW) * 100}%` }}>
              <button
                type="button"
                ref={(element) => {
                  if (element) causeHeadsRef.current.set(c.cause, element);
                  else causeHeadsRef.current.delete(c.cause);
                }}
                className={`${styles.colHead} ${plotCauseClass(c.cause)}`}
                aria-pressed={pressed}
                aria-label={`${c.label}: ${c.count} ${c.count === 1 ? "grave" : "graves"}`}
                data-cause={c.cause}
                data-plot-cause-head
                onClick={() => onToggleCause?.(c.cause)}
              >
                <span className={styles.top} aria-hidden="true">
                  <span className={styles.sw} />
                  <span className={styles.n}>{c.count}</span>
                </span>
                <span className={styles.lb} aria-hidden="true">
                  <span className={styles.lbShort}>{SHORT_LABEL[c.cause]}</span>
                  <span className={styles.lbFull}>{FULL_PORTRAIT_LABEL[c.cause]}</span>
                </span>
              </button>
            </span>
          );
        })}
      </div>
      <div
        ref={planRef}
        className={`${styles.portraitPlan} ${mobileStyles.walkPlan}`}
        role="group"
        aria-label="Stablecoin Cemetery plot map, newest year first. Each button opens one grave; the Autopsy Register below lists every record."
        aria-describedby="cem-portrait-keys"
      >
        <p id="cem-portrait-keys" className="sr-only">
          {KEYS_HINT}
        </p>
        <PortraitSvg map={map} atlas={atlas} hotId={pinnedId} activeCause={activeCause} activeLens={activeLens} flowers={flowers} />
        <div className={styles.yearTracks} aria-hidden="true">
          {map.blocks.map((b, k) => {
            const { y0, y1 } = portraitYearTrackBounds(map.blocks, k, vbY, vbH);
            if (b.empty) {
              return (
                <div
                  key={b.key}
                  className={styles.yearTrack}
                  style={{ top: y(y0), height: h(Math.max(1, y1 - y0)) }}
                  data-empty="true"
                  data-plot-year-band={b.key}
                >
                  <div className={styles.yearEmpty}>
                    <span className={styles.yearLabel}>
                      <span className={styles.mono}>{b.label}</span>
                      <span className={styles.yearSep}>·</span>
                      <span>{b.sub ?? "none recorded"}</span>
                    </span>
                    <span className={styles.yearRule} />
                  </div>
                </div>
              );
            }
            return (
              <div
                key={b.key}
                className={styles.yearTrack}
                style={{ top: y(y0), height: h(Math.max(1, y1 - y0)) }}
                data-plot-year-band={b.key}
              >
                <div className={styles.yearBand} data-merged={b.sub ? "true" : undefined}>
                  <span className={styles.yearLabel}>
                    <span className={styles.mono}>{b.label}</span>
                    <span className={styles.yearSep}>·</span>
                    <small className={styles.mono}>{b.count}</small>
                    {b.sub ? <small className={styles.yearSub}>{b.sub}</small> : null}
                  </span>
                  <span className={styles.yearRule} />
                </div>
              </div>
            );
          })}
        </div>
        <div className={styles.hits} onClick={onHitsClick} onKeyDown={onHitsKeyDown} data-plot-hits>
          {map.graves.map((g) => (
            <a
              key={g.id}
              ref={(element) => {
                if (element) gravesRef.current.set(g.id, element);
                else gravesRef.current.delete(g.id);
              }}
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
