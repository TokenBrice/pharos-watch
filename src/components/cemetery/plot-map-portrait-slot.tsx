"use client";

/**
 * Stablecoin Cemetery plot map: the phone layer (≤ 760 px). Server HTML carries only a reserved box sized by CSS to
 * the portrait plan (`aspectRatio` from `getPortraitAspectRatio`, plus the header row), so the plan mounts after
 * hydration without layout shift. On phones the slot builds the portrait model from the same register rows the
 * register receives, renders `PlotMapPortrait`, and owns its interaction: one roving tab stop, nearest-centre tap
 * resolution, the bottom sheet (`PlotMapSheet`), and the hero's `pinGrave` handler while the portrait is active.
 * Without JavaScript a `<noscript>` rule hides the empty slot and shows the desktop plan instead.
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
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { buildCemeteryPlotMap, type PortraitPlotMap } from "@/lib/cemetery-plot-map";
import { toPlotMapInput, type PlotLogoAtlas } from "@/lib/cemetery-plot-map-input";
import type { CemeteryRegisterRow } from "@/lib/cemetery-register";
import { useCemeterySelection, type CemeterySelectionSource } from "./cemetery-selection-context";
import { PORTRAIT_HEAD_PX, PlotMapPortrait } from "./plot-map-portrait";
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
}

/** No JS: the portrait never mounts, so phones get the desktop plan (scaled to the column) instead of an empty box. */
const NOSCRIPT_CSS = `<style>@media (max-width: 760px){[data-plot-portrait-slot]{display:none!important}.${plotStyles.stage}{display:block!important}}</style>`;

export function PlotMapPortraitSlot({ rows, asOf, atlas, aspectRatio, flowers, onLeaveFlower }: PlotMapPortraitSlotProps): ReactElement {
  const layout = usePlotLayout();
  useLegendFold(layout);
  const style = { "--portrait-ar": aspectRatio, "--portrait-head": `${PORTRAIT_HEAD_PX}px` } as CSSProperties;
  return (
    <div className={styles.slot} style={style} data-plot-portrait-slot>
      <noscript dangerouslySetInnerHTML={{ __html: NOSCRIPT_CSS }} />
      {layout === "portrait" ? (
        <PortraitLayer rows={rows} asOf={asOf} atlas={atlas} flowers={flowers} onLeaveFlower={onLeaveFlower} />
      ) : (
        <div className={styles.reserve} aria-hidden="true" />
      )}
    </div>
  );
}

/**
 * The legend's disclosure folds once on phones (hero budget) and is always open on the desktop. Folding shrinks the
 * page below the legend by several hundred px, so it never happens under the reader: not when the page opened on a
 * fragment (the browser's fragment scroll would land at the pre-fold offset) and not once the legend's top has
 * scrolled above the viewport.
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
// Portrait layer (client only, ≤ 760 px)
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

/** Space kept between neighbouring margin year labels (px). */
const YEAR_LABEL_GAP = 3;

/**
 * Vertical shift (px, + down / − up) per margin year label (DOM order = `map.blocks` order) so no two labels overlap
 * and the last stays inside the plan. Each label is centred on its block (`top` in %); thin blocks (a one-row year,
 * the empty strip) sit closer than two labels are tall, so labels first push down, then the stack is pulled back up
 * from the plan's bottom edge. Measured, so it holds at every plan width and label height.
 */
function measureYearPushes(plan: HTMLElement): number[] {
  const height = plan.clientHeight;
  const labels = Array.from(plan.querySelectorAll<HTMLElement>("[data-plot-year-label]"));
  const heights = labels.map((label) => label.offsetHeight);
  const natural = labels.map((label, k) => (parseFloat(label.style.top) / 100) * height - heights[k] / 2);
  const tops = [...natural];
  for (let k = 1; k < tops.length; k++) tops[k] = Math.max(tops[k], tops[k - 1] + heights[k - 1] + YEAR_LABEL_GAP);
  let limit = height;
  for (let k = tops.length - 1; k >= 0; k--) {
    tops[k] = Math.min(tops[k], limit - heights[k]);
    limit = tops[k] - YEAR_LABEL_GAP;
  }
  return tops.map((top, k) => Math.round(top - natural[k]));
}

/**
 * Scrolls the page so the grave's hit box sits in the band between the sticky chrome and the open sheet (upper
 * third where possible). The sheet's resting top is computed from its size, not its rect: it may still be sliding.
 */
function scrollGraveAboveSheet(grave: HTMLElement, sheet: HTMLElement, reducedMotion: boolean): void {
  const r = grave.getBoundingClientRect();
  const chromeBottom = cssPx("--table-header-top", 56) + 8;
  const sheetTop = window.innerHeight - (parseFloat(getComputedStyle(sheet).bottom) || 0) - sheet.offsetHeight;
  const lowest = sheetTop - r.height - 12;
  if (r.top >= chromeBottom && r.top <= lowest) return;
  const target = Math.max(chromeBottom, Math.min(window.innerHeight * 0.3, lowest));
  window.scrollBy({ top: r.top - target, behavior: reducedMotion ? "instant" : "smooth" });
}

type SheetClose = "dismiss" | "register" | "silent";

function PortraitLayer({
  rows,
  asOf,
  atlas,
  flowers,
  onLeaveFlower,
}: Omit<PlotMapPortraitSlotProps, "aspectRatio">): ReactElement {
  const { revealRecord, registerPinGrave, setRecordHash } = useCemeterySelection();
  const reducedMotion = usePrefersReducedMotion();
  const map = useMemo(() => buildCemeteryPlotMap(toPlotMapInput(rows), { asOf, preset: "portrait" }), [rows, asOf]);
  const rowById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const dates = useMemo(() => new Map(map.graves.map((g) => [g.id, dateOrdinal(g.deathDate)])), [map]);

  const [tabStopId, setTabStopId] = useState(map.keyboard.initialId);
  const [openId, setOpenId] = useState<string | null>(null);
  /** Last opened record: stays in the sheet while it slides out. */
  const [shownId, setShownId] = useState<string | null>(null);
  /** Bumped on every open so re-opening the same grave re-runs the scroll/focus effect. */
  const [openSeq, setOpenSeq] = useState(0);
  const sheetRef = useRef<HTMLDivElement>(null);
  const planRef = useRef<HTMLDivElement>(null);
  const [yearPushes, setYearPushes] = useState<readonly number[]>([]);

  // Margin year labels: measured before the first paint and again whenever the plan (hence every block) resizes.
  useLayoutEffect(() => {
    const plan = planRef.current;
    if (!plan) return;
    let live = true;
    const update = () => {
      if (!live) return;
      const next = measureYearPushes(plan);
      setYearPushes((prev) => (prev.length === next.length && prev.every((v, i) => v === next[i]) ? prev : next));
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(plan);
    void document.fonts?.ready.then(update);
    return () => {
      live = false;
      observer?.disconnect();
    };
  }, [map]);

  const openSheet = useCallback(
    (id: string) => {
      if (!rowById.has(id)) return;
      setTabStopId(id);
      setOpenId(id);
      setShownId(id);
      setOpenSeq((n) => n + 1);
      setRecordHash(id);
    },
    [rowById, setRecordHash],
  );

  const closeSheet = useCallback(
    (how: SheetClose) => {
      const id = openId;
      if (!id) return;
      setOpenId(null);
      if (how === "register") {
        revealRecord(id, "hero");
        return;
      }
      setRecordHash(null);
      if (how === "dismiss") document.getElementById(`walk-${id}`)?.focus();
    },
    [openId, revealRecord, setRecordHash],
  );

  // After an open (openSeq: also a re-open of the same grave): bring the grave above the sheet, focus the sheet.
  useLayoutEffect(() => {
    const sheet = sheetRef.current;
    if (!openId || !sheet) return;
    const grave = document.getElementById(`walk-${openId}`);
    if (grave) scrollGraveAboveSheet(grave, sheet, reducedMotion);
    sheet.focus({ preventScroll: true });
  }, [openId, openSeq, reducedMotion]);

  // Esc closes the sheet from anywhere on the page while it is open.
  useEffect(() => {
    if (!openId) return;
    const onKey = (ev: globalThis.KeyboardEvent) => {
      if (ev.key !== "Escape" || ev.defaultPrevented) return;
      ev.preventDefault();
      closeSheet("dismiss");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openId, closeSheet]);

  // The hero's pin handler while the portrait is the active layout (this layer only mounts then). A deep link only
  // moves the tab stop: the register reveal owns scrolling, and a sheet would cover the revealed row.
  const pinRef = useRef<(id: string, source: CemeterySelectionSource) => void>(() => {});
  useEffect(() => {
    pinRef.current = (id, source) => {
      if (!rowById.has(id)) return;
      if (source === "hash") setTabStopId(id);
      else openSheet(id);
    };
  }, [rowById, openSheet]);
  useEffect(() => registerPinGrave((id, source) => pinRef.current(id, source)), [registerPinGrave]);

  const toggle = useCallback((id: string) => (id === openId ? closeSheet("silent") : openSheet(id)), [openId, closeSheet, openSheet]);

  const onHitsClick = useCallback(
    (ev: MouseEvent<HTMLDivElement>) => {
      const hit = (ev.target as Element).closest<HTMLElement>("[data-grave-id]");
      if (!hit) {
        // a tap on empty ground unpins
        if (openId) closeSheet("silent");
        return;
      }
      ev.preventDefault();
      let id = hit.dataset.graveId ?? "";
      // pointer taps: overlapping 44 px boxes resolve to the nearest grave centre (keyboard clicks keep the target)
      if (ev.detail > 0) {
        let best = Infinity;
        for (const el of ev.currentTarget.querySelectorAll<HTMLElement>("[data-grave-id]")) {
          const r = el.getBoundingClientRect();
          const d = Math.hypot(r.left + r.width / 2 - ev.clientX, r.top + r.height / 2 - ev.clientY);
          if (d < best) {
            best = d;
            id = el.dataset.graveId ?? id;
          }
        }
      }
      toggle(id);
    },
    [openId, closeSheet, toggle],
  );

  const onHitsKeyDown = useCallback(
    (ev: KeyboardEvent<HTMLDivElement>) => {
      const id = (ev.target as HTMLElement).dataset?.graveId;
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
      document.getElementById(`walk-${next}`)?.focus();
    },
    [map, dates, toggle, onLeaveFlower],
  );

  const shownRow = shownId ? (rowById.get(shownId) ?? null) : null;
  return (
    <>
      <PlotMapPortrait
        map={map}
        atlas={atlas}
        tabStopId={tabStopId}
        pinnedId={openId}
        flowers={flowers}
        onHitsClick={onHitsClick}
        onHitsKeyDown={onHitsKeyDown}
        yearPushes={yearPushes}
        planRef={planRef}
      />
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
