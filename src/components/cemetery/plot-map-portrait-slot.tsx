"use client";

/**
 * Stablecoin Cemetery plot map: the phone and touch-tablet walk layer (`PLOT_PORTRAIT_QUERY`).
 *
 * Keeps SSR HTML within budget (Item 2): during SSR and the initial hydration pass (`layout === null`) this slot
 * renders the lightweight `PlotMapPortraitSkeleton` (exact column heads, ground/bed SVG at the final viewBox aspect,
 * and sticky year bands — ~6 KB raw, 0 CLS). Without JS, `<noscript>` hides this slot and reveals the server-rendered
 * desktop plan with native `#<id>` anchors. Once hydrated under `PLOT_PORTRAIT_QUERY` (`layout === "portrait"`), the
 * full interactive `PortraitLayer` mounts and owns the hero's `pinGrave` handler, roving tab stop, nearest-centre tap
 * resolution, sticky cause-head highlight toggles, Escape order and bottom sheet; on desktop (`layout === "desktop"`),
 * the slot unmounts to zero DOM nodes.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
} from "react";
import { CAUSE_META, type CauseOfDeath } from "@shared/lib/cause-of-death";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { buildCemeteryPlotMap, type PortraitPlotMap } from "@/lib/cemetery-plot-map";
import { toPlotMapInput, type PlotLogoAtlas } from "@/lib/cemetery-plot-map-input";
import type { CemeteryRegisterRow } from "@/lib/cemetery-register";
import { useCemeterySelection, type CemeterySelectionSource } from "./cemetery-selection-context";
import { PORTRAIT_HEAD_PX, PlotMapPortrait, PlotMapPortraitSkeleton, type PlotMapPortraitHandle } from "./plot-map-portrait";
import { describePlotLens, matchesPlotLens, type PlotLens } from "./plot-map-shapes";
import { PlotMapSheet } from "./plot-map-sheet";
import { usePlotLayout } from "./use-plot-layout";
import plotStyles from "./plot-map.module.css";
import styles from "./plot-map-mobile.module.css";

export interface PlotMapPortraitSlotProps {
  rows: readonly CemeteryRegisterRow[];
  asOf: string;
  atlas: PlotLogoAtlas;
  /** Portrait viewBox aspect, `"w / h"` (`getPortraitAspectRatio`, computed on the server). */
  aspectRatio: string;
  /** Session flowers by grave id (count hidden until ≥ 1). */
  flowers: Readonly<Record<string, number>>;
  onLeaveFlower: (id: string) => void;
  /** Optional interactive legend lens owned by `PlotMapHero` (E9). */
  activeLens?: PlotLens | null;
  onClearLens?: () => void;
  /** Optional controlled cause highlight synced with the hero's legend. */
  controlledCause?: CauseOfDeath | null;
  onCauseChange?: (cause: CauseOfDeath | null) => void;
}

/**
 * No JS: hide the portrait skeleton and reveal the server-rendered desktop plan (whose `<a href="#<id>">` graves work
 * natively without script) on phones and touch tablets; drop desktop-only overlays on narrow phones so the stones read.
 */
const NOSCRIPT_CSS =
  `<style>` +
  `[data-plot-lens]{cursor:default!important}` +
  `@media (max-width:760px),(max-width:1024px) and (pointer:coarse){` +
  `[data-plot-portrait-slot]{display:none!important}` +
  `.${plotStyles.stage}{display:block!important;margin-top:8px!important}` +
  `}` +
  `@media (min-width:761px) and (max-width:1024px) and (pointer:coarse){` +
  `.${plotStyles.head}{display:block!important;min-height:124px!important;margin-bottom:0!important}` +
  `.${plotStyles.routeHead}{display:block!important;max-width:min(360px,36%)!important}` +
  `.${plotStyles.title}{font-size:1.85rem!important;height:1.05em!important}` +
  `.${plotStyles.lead},.${plotStyles.whisper},.${plotStyles.beamPlaque},.${plotStyles.beamSub},.${plotStyles.beamRest}{display:block!important}` +
  `.${plotStyles.links}{display:block!important;margin-top:5px!important}` +
  `.${plotStyles.links} a{display:inline!important;min-height:0!important;padding-inline:0!important}` +
  `.${plotStyles.onWide}{display:inline!important}` +
  `.${plotStyles.onPhone}{display:none!important}` +
  `.${plotStyles.figure}{position:absolute!important;top:0!important;right:calc((100% - var(--stage-w, 100%)) / 2 + var(--stage-w, 100%) * var(--lantern-right-ratio, 0.0384) + 22px)!important;display:grid!important;grid-template-columns:auto auto!important;column-gap:10px!important;align-items:end!important;text-align:right!important}` +
  `.${plotStyles.figure}>div{padding-right:10px!important;border-right:1px solid var(--border)!important}` +
  `.${plotStyles.beamLabel}{display:block!important;order:0!important;margin:0 0 2px!important;font-size:0.75rem!important}` +
  `.${plotStyles.figure} .${plotStyles.figureValue}{font-size:2.45rem!important;line-height:1!important}` +
  `.${plotStyles.stage}{margin-top:var(--sky)!important}` +
  `}` +
  `@media (max-width:760px){` +
  `.${plotStyles.signpost},.${plotStyles.yearStamp},.${plotStyles.chip},.${plotStyles.leader}{display:none!important}` +
  `}` +
  `</style>`;

export function PlotMapPortraitSlot({
  rows,
  asOf,
  atlas,
  aspectRatio,
  flowers,
  onLeaveFlower,
  activeLens = null,
  onClearLens,
  controlledCause,
  onCauseChange,
}: PlotMapPortraitSlotProps): ReactElement {
  const layout = usePlotLayout();
  useLegendFold(layout);
  const portraitMap = useMemo(
    () => (layout === "desktop" ? null : buildCemeteryPlotMap(toPlotMapInput(rows), { asOf, preset: "portrait" })),
    [layout, rows, asOf],
  );
  const style = { "--portrait-ar": aspectRatio, "--portrait-head": `${PORTRAIT_HEAD_PX}px` } as CSSProperties;
  return (
    <div className={styles.slot} style={style} data-plot-portrait-slot>
      <noscript dangerouslySetInnerHTML={{ __html: NOSCRIPT_CSS }} />
      {layout === "portrait" && portraitMap ? (
        <PortraitLayer
          map={portraitMap}
          rows={rows}
          atlas={atlas}
          flowers={flowers}
          onLeaveFlower={onLeaveFlower}
          activeLens={activeLens}
          onClearLens={onClearLens}
          controlledCause={controlledCause}
          onCauseChange={onCauseChange}
        />
      ) : layout === null && portraitMap ? (
        <PlotMapPortraitSkeleton map={portraitMap} />
      ) : null}
    </div>
  );
}

/**
 * The legend's disclosure folds once on phones/touch tablets (hero budget) and is always open on desktop. Folding
 * shrinks the page below the legend by several hundred px, so it never happens under the reader: not when the page
 * opened on a fragment (the browser's fragment scroll would land at the pre-fold offset) and not once the legend's
 * top has scrolled above the viewport.
 */
function useLegendFold(layout: "desktop" | "portrait" | null): void {
  const folded = useRef(false);
  useEffect(() => {
    if (layout === null) return;
    const details = document.querySelector<HTMLDetailsElement>("details[data-plot-legend-more]");
    if (!details) return;
    if (layout === "desktop") details.open = true;
    else if (!folded.current) {
      folded.current = true;
      if (window.location.hash.length > 1 || details.getBoundingClientRect().top < 0) return;
      details.open = false;
    }
  }, [layout]);
}

// ---------------------------------------------------------------------------
// Portrait layer (SSR + live under PLOT_PORTRAIT_QUERY)
// ---------------------------------------------------------------------------

/** Ordinal for "nearest date" across columns (`YYYY-MM` or `YYYY-MM-DD`). */
function dateOrdinal(date: string): number {
  const [y, m = "1", d = "15"] = date.split("-");
  return Number(y) * 372 + (Number(m) - 1) * 31 + Number(d);
}

/**
 * Roving-stop target for a key, or null. Columns are sections (canonical order left → right) and time runs down the
 * page newest first: ↑/↓ step to the newer/older death in the column, ←/→ jump to the adjacent column's nearest
 * date, Home/End to the column's newest/oldest.
 */
function portraitKeyTarget(map: PortraitPlotMap, dates: ReadonlyMap<string, number>, id: string, key: string): string | null {
  const sections = map.keyboard.sections;
  const k = sections.findIndex((s) => s.ids.includes(id));
  if (k < 0) return null;
  const ids = sections[k].ids; // oldest first
  const at = ids.indexOf(id);
  switch (key) {
    case "ArrowUp":
      return ids[at + 1] ?? null;
    case "ArrowDown":
      return ids[at - 1] ?? null;
    case "Home":
      return ids[ids.length - 1];
    case "End":
      return ids[0];
    case "ArrowLeft":
    case "ArrowRight": {
      const step = key === "ArrowRight" ? 1 : -1;
      const here = dates.get(id) ?? 0;
      for (let n = k + step; n >= 0 && n < sections.length; n += step) {
        let best: string | null = null;
        let bestD = Infinity;
        for (const other of sections[n].ids) {
          const d = Math.abs((dates.get(other) ?? 0) - here);
          if (d < bestD) {
            bestD = d;
            best = other;
          }
        }
        if (best) return best;
      }
      return null;
    }
    default:
      return null;
  }
}

function cssPx(name: string, fallback: number): number {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(v) ? v : fallback;
}

/**
 * Scrolls the page so the grave's hit box sits in the band between the sticky chrome (top bar + sticky cause heads +
 * sticky year band) and the open sheet. The sheet's resting top is computed from its size, not its rect: it may still
 * be sliding.
 */
function scrollGraveAboveSheet(grave: HTMLElement, sheet: HTMLElement, reducedMotion: boolean): void {
  const r = grave.getBoundingClientRect();
  const chromeBottom = cssPx("--table-header-top", 59) + PORTRAIT_HEAD_PX + 28;
  const sheetTop = window.innerHeight - (parseFloat(getComputedStyle(sheet).bottom) || 0) - sheet.offsetHeight;
  const lowest = sheetTop - r.height - 12;
  if (r.top >= chromeBottom && r.top <= lowest) return;
  const target = Math.max(chromeBottom, Math.min(window.innerHeight * 0.34, lowest));
  window.scrollBy({ top: r.top - target, behavior: reducedMotion ? "instant" : "smooth" });
}

type SheetClose = "dismiss" | "register" | "silent";

function PortraitLayer({
  map,
  rows,
  atlas,
  flowers,
  onLeaveFlower,
  activeLens = null,
  onClearLens,
  controlledCause,
  onCauseChange,
}: Omit<PlotMapPortraitSlotProps, "aspectRatio" | "asOf"> & { map: PortraitPlotMap }): ReactElement {
  const { heroPin, setHeroPin, revealRecord, registerPinGrave, setRecordHash } = useCemeterySelection();
  const reducedMotion = usePrefersReducedMotion();
  const rowById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const dates = useMemo(() => new Map(map.graves.map((g) => [g.id, dateOrdinal(g.deathDate)])), [map]);

  const [tabStopId, setTabStopId] = useState(heroPin?.id ?? map.keyboard.initialId);
  const [openId, setOpenId] = useState<string | null>(heroPin && heroPin.source !== "hash" ? heroPin.id : null);
  /** Last opened record: stays in the sheet while it slides out. */
  const [shownId, setShownId] = useState<string | null>(openId);
  /** Highlighted cause column toggled via the sticky cause-head buttons (synced with hero legend when controlled). */
  const [uncontrolledCause, setUncontrolledCause] = useState<CauseOfDeath | null>(null);
  const activeCause = controlledCause !== undefined ? controlledCause : uncontrolledCause;
  const setActiveCause = useCallback(
    (next: CauseOfDeath | null) => {
      if (onCauseChange) onCauseChange(next);
      else setUncontrolledCause(next);
    },
    [onCauseChange],
  );
  const [status, setStatus] = useState("");
  /** Bumped on every open so re-opening the same grave re-runs the scroll/focus effect. */
  const [openSeq, setOpenSeq] = useState(0);
  const sheetRef = useRef<HTMLDivElement>(null);
  const planRef = useRef<HTMLDivElement>(null);
  const portraitRef = useRef<PlotMapPortraitHandle>(null);

  const openSheet = useCallback(
    (id: string) => {
      const row = rowById.get(id);
      if (!row) return;
      if (activeCause && activeCause !== row.cause) setActiveCause(null);
      setTabStopId(id);
      setOpenId(id);
      setHeroPin(id);
      setShownId(id);
      setOpenSeq((n) => n + 1);
      setRecordHash(id);
    },
    [rowById, activeCause, setActiveCause, setHeroPin, setRecordHash],
  );

  const closeSheet = useCallback(
    (how: SheetClose) => {
      const id = openId;
      if (!id) return;
      setOpenId(null);
      setHeroPin(null);
      if (how === "register") {
        revealRecord(id, "hero");
        return;
      }
      setRecordHash(null);
      if (how === "dismiss") portraitRef.current?.grave(id)?.focus();
    },
    [openId, setHeroPin, revealRecord, setRecordHash],
  );

  const effectiveCause = activeLens?.kind === "cause" ? activeLens.cause : activeCause;

  const toggleCause = useCallback(
    (cause: CauseOfDeath) => {
      if (activeLens?.kind === "cause") {
        onClearLens?.();
        if (activeLens.cause === cause) {
          setActiveCause(null);
          setStatus("Showing all causes");
          return;
        }
      }
      const next = effectiveCause === cause ? null : cause;
      setActiveCause(next);
      if (next) {
        const count =
          activeLens && activeLens.kind !== "cause"
            ? map.graves.filter((g) => g.cause === next && matchesPlotLens(g, activeLens)).length
            : (map.columns.find((c) => c.cause === next)?.count ?? 0);
        const lensSuffix = activeLens && activeLens.kind !== "cause" ? ` · ${describePlotLens(activeLens)}` : "";
        setStatus(`Highlighting ${CAUSE_META[next].label}${lensSuffix}: ${count} ${count === 1 ? "grave" : "graves"}`);
      } else {
        setStatus(activeLens && activeLens.kind !== "cause" ? `Highlighting ${describePlotLens(activeLens)}` : "Showing all causes");
      }
    },
    [activeLens, effectiveCause, onClearLens, setActiveCause, map.columns, map.graves],
  );

  // Announce legend lens changes while the portrait walk is the active layer (React render-time state sync).
  const [lastLens, setLastLens] = useState<PlotLens | null>(activeLens);
  if (lastLens !== activeLens) {
    setLastLens(activeLens);
    if (!activeLens) {
      setStatus(activeCause ? `Highlighting ${CAUSE_META[activeCause].label}` : "Showing all graves");
    } else {
      const scopedCause = activeLens.kind === "cause" ? null : activeCause;
      const count = map.graves.filter((g) => (scopedCause ? g.cause === scopedCause : true) && matchesPlotLens(g, activeLens)).length;
      const scope = scopedCause ? ` in ${CAUSE_META[scopedCause].label}` : "";
      setStatus(`Highlighting ${describePlotLens(activeLens)}${scope}: ${count} of ${map.counts.total} graves`);
    }
  }

  // After an open (openSeq: also a re-open of the same grave): bring the grave above the sheet, focus the sheet.
  useLayoutEffect(() => {
    const sheet = sheetRef.current;
    if (!openSeq || !openId || !sheet) return;
    const grave = portraitRef.current?.grave(openId);
    if (grave) scrollGraveAboveSheet(grave, sheet, reducedMotion);
    sheet.focus({ preventScroll: true });
  }, [openId, openSeq, reducedMotion]);

  useEffect(() => {
    if (!openId && !activeCause && !activeLens) return;
    const onKey = (ev: globalThis.KeyboardEvent) => {
      if (ev.key !== "Escape" || ev.defaultPrevented) return;
      ev.preventDefault();
      if (openId) {
        closeSheet("dismiss");
        return;
      }
      if (activeLens) {
        onClearLens?.();
        return;
      }
      if (activeCause) {
        const prevCause = activeCause;
        setActiveCause(null);
        setStatus("Showing all causes");
        if (planRef.current?.contains(document.activeElement)) {
          portraitRef.current?.causeHead(prevCause)?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openId, activeCause, activeLens, closeSheet, onClearLens, setActiveCause]);

  // The hero's pin handler while the portrait is the active layout. A deep link only moves the tab stop:
  // the register reveal owns scrolling, and a sheet would cover the revealed row.
  const pinRef = useRef<(id: string, source: CemeterySelectionSource) => void>(() => {});
  useEffect(() => {
    pinRef.current = (id, source) => {
      if (!rowById.has(id)) return;
      if (source === "hash") {
        setTabStopId(id);
        setOpenId(null);
      } else openSheet(id);
    };
  }, [rowById, openSheet]);
  useEffect(() => registerPinGrave((id, source) => pinRef.current(id, source)), [registerPinGrave]);

  const toggle = useCallback((id: string) => (id === openId ? closeSheet("silent") : openSheet(id)), [openId, closeSheet, openSheet]);

  const onHitsClick = useCallback(
    (ev: MouseEvent<HTMLDivElement>) => {
      const hit = portraitRef.current?.graveOf(ev.target);
      if (!hit) {
        if (openId) closeSheet("silent");
        else if (activeCause) {
          setActiveCause(null);
          setStatus("Showing all causes");
        }
        return;
      }
      ev.preventDefault();
      let id = hit.id;
      // pointer taps: overlapping 44 px boxes resolve to the nearest grave centre (keyboard clicks keep the target)
      if (ev.detail > 0) {
        let best = Infinity;
        for (const { id: candidateId, element } of portraitRef.current?.graves() ?? []) {
          const r = element.getBoundingClientRect();
          const d = Math.hypot(r.left + r.width / 2 - ev.clientX, r.top + r.height / 2 - ev.clientY);
          if (d < best) {
            best = d;
            id = candidateId;
          }
        }
      }
      toggle(id);
    },
    [openId, activeCause, setActiveCause, closeSheet, toggle],
  );

  const onHitsKeyDown = useCallback(
    (ev: KeyboardEvent<HTMLDivElement>) => {
      const id = portraitRef.current?.graveOf(ev.target)?.id;
      if (!id || ev.altKey || ev.ctrlKey || ev.metaKey) return;
      if (ev.key === " ") {
        ev.preventDefault();
        toggle(id);
        return;
      }
      if (ev.key === "f" || ev.key === "F") {
        ev.preventDefault();
        onLeaveFlower(id);
        return;
      }
      if (ev.key.startsWith("Arrow") || ev.key === "Home" || ev.key === "End") ev.preventDefault();
      const next = portraitKeyTarget(map, dates, id, ev.key);
      if (!next || next === id) return;
      setTabStopId(next);
      portraitRef.current?.grave(next)?.focus();
    },
    [map, dates, toggle, onLeaveFlower],
  );

  const shownRow = shownId ? (rowById.get(shownId) ?? null) : null;
  return (
    <>
      <PlotMapPortrait
        controllerRef={portraitRef}
        map={map}
        atlas={atlas}
        tabStopId={tabStopId}
        pinnedId={openId}
        activeCause={activeCause}
        activeLens={activeLens}
        flowers={flowers}
        onToggleCause={toggleCause}
        onHitsClick={onHitsClick}
        onHitsKeyDown={onHitsKeyDown}
        planRef={planRef}
      />
      <p className="sr-only" role="status" aria-live="polite" data-plot-portrait-status>
        {status}
      </p>
      <PlotMapSheet
        row={shownRow}
        open={openId !== null}
        atlas={atlas}
        flowers={shownId ? (flowers[shownId] ?? 0) : 0}
        onLeaveFlower={() => {
          if (shownId) onLeaveFlower(shownId);
        }}
        onReadRegister={() => closeSheet("register")}
        onClose={() => closeSheet("dismiss")}
        sheetRef={sheetRef}
      />
    </>
  );
}
