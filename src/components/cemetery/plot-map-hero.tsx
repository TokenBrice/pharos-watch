"use client";

/**
 * Stablecoin Cemetery hero island: the ONE client entry of the plot map (F5 option b3 + c2).
 *
 * It receives the same slim register rows the Autopsy Register receives, builds the desktop model in a `useMemo`
 * (the model never crosses the server/client boundary), renders the desktop scene with its interaction state, the
 * docked inspector and the phone layer (`PlotMapPortraitSlot`, which mounts its own model after hydration). The
 * server passes the route head and One Beam figure as `children`, and the rest-pose layout solved by
 * `desktopPlotLayout` (too heavy to solve during hydration).
 *
 * Interaction (plan §5.4): one roving tab stop (←/→ previous/next death in the section, ↑/↓ adjacent section at the
 * nearest date, Home/End, Enter/Space pin, F flower, Esc unpin then exit zoom); hover/focus lights a grave (ring,
 * colour logo, collision-aware tag, beam after a 180 ms dwell for the pointer, at once for focus); a pin docks the
 * record card beside the grave (≥ 1280 px; in flow below the plan from 761 px), writes `#<id>` through the selection
 * context and is announced once; signposts zoom a section; cypresses and year stamps light a year.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { CAUSE_META, type CauseOfDeath } from "@shared/lib/cause-of-death";
import { useMediaQuery } from "@/hooks/use-is-mobile";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { EDITORIAL_TITLES } from "@/lib/cemetery-editorial";
import { formatCemeteryPeak } from "@/lib/cemetery-stats";
import {
  PLOT_FRESH_DAYS,
  PLOT_LAYOUT,
  buildCemeteryPlotMap,
  fitSectionCamera,
  placeInspectorCard,
  placePlotTag,
  plotBoxToFrameRect,
  plotPeakClassOf,
  type DesktopPlotMap,
  type PlotRect,
  type PlotSectionCamera,
} from "@/lib/cemetery-plot-map";
import { toPlotMapInput, type PlotLogoAtlas } from "@/lib/cemetery-plot-map-input";
import type { CemeteryRegisterRow } from "@/lib/cemetery-register";
import type { PlotBox } from "@/lib/cemetery-plot-geometry";
import { formatRegisterDeathDate } from "./cemetery-register-model";
import { useCemeterySelection, type CemeterySelectionSource } from "./cemetery-selection-context";
import { PlotMapPortraitSlot } from "./plot-map-portrait-slot";
import { PlotMapRecordCard } from "./plot-map-record-card";
import { PlotMapScene, createPlotMapSceneHandle, desktopLayoutStyle, type PlotDesktopLayout, type PlotDim, type PlotSceneState, type PlotMapSceneHandle } from "./plot-map-scene";
import {
  PLOT_FLOWER_MAX,
  describePlotLens,
  matchesPlotLens,
  parsePlotLens,
  plotCauseClass,
  samePlotLens,
  type PlotLens,
} from "./plot-map-shapes";
import { usePlotLayout } from "./use-plot-layout";
import styles from "./plot-map.module.css";

/** A pointer must rest this long on a grave before the beam swings to it (focus aims at once). */
const PLOT_BEAM_DWELL_MS = 180;
/** The inspector docks beside its grave at this width and up; below it sits in flow under the plan. */
const DOCKED_QUERY = "(min-width: 1280px)";
/** Top of the visible band under the sticky chrome (CSS px). */
const CHROME_TOP = PLOT_LAYOUT.chromeTop;
/** A section-zoom pan keeps the focused grave this far inside the visible band (frame px). */
const PAN_MARGIN = 40;
export interface PlotMapHeroProps {
  /** The register's rows (same array object: React Flight sends it once). */
  rows: readonly CemeteryRegisterRow[];
  /** Latest recorded death (`buildCemeteryStats(…).asOf.date`). */
  asOf: string;
  atlas: PlotLogoAtlas;
  /** Rest pose solved on the server by `desktopPlotLayout`. */
  layout: PlotDesktopLayout;
  /** Portrait viewBox aspect (`getPortraitAspectRatio`, server-computed) for the phone slot's reserved box. */
  portraitAspectRatio: string;
  /** Server-rendered route head and One Beam figure (`data-plot-figure-value` marks the `113`). */
  children: ReactNode;
}

interface ZoomState {
  cause: CauseOfDeath;
  camera: PlotSectionCamera;
  /** Extra world offset (user units) after ←/→ reached a grave outside a partial view. */
  pan: [number, number];
  /** Frame width and the visible band's bottom (frame px) the camera was fitted to. */
  band: { width: number; bottom: number };
}

/** After a pin: bring the grave (or, in flow, its card) into view; `focus` moves keyboard focus to the grave. */
type ScrollRequest = { id: string; behavior: ScrollBehavior; target: "grave" | "card"; focus: boolean };

/** UTC ms of a death date; month precision stands on the 15th (the model's rule). */
function deathTime(deathDate: string): number {
  const [y, m, d] = deathDate.split("-").map(Number);
  return Date.UTC(y, (m || 1) - 1, d || 15);
}

/** Framing box for one grave inside a zoom band: tall lot-3 colossi anchor on podium + medallion. */
function zoomFocusBox(g: DesktopPlotMap["graves"][number]): PlotBox {
  if (g.lot !== 3) return g.screen.box;
  return {
    ...g.screen.box,
    y0: Math.max(g.screen.box.y0, g.screen.medal.y - g.screen.medal.r - 14),
  };
}

function formatZoomSpan(span: readonly [number, number]): string {
  return span[0] === span[1] ? String(span[0]) : `${span[0]}–${span[1]}`;
}

const DAY_MS = 864e5;

/** Evaluates a legend lens against a register row directly when the desktop model is unmounted (portrait). */
function rowMatchesLens(row: CemeteryRegisterRow, lens: PlotLens, asOfMs: number): boolean {
  switch (lens.kind) {
    case "cause":
      return row.cause === lens.cause;
    case "steps":
      return plotPeakClassOf(row.peak) === lens.steps;
    case "unrecorded":
      return plotPeakClassOf(row.peak) === null;
    case "fresh":
      return asOfMs - deathTime(row.deathDate) <= PLOT_FRESH_DAYS * DAY_MS;
    case "archived":
      return row.tracked;
    case "non-usd":
      return row.pegCurrency !== "USD";
  }
}

/** Whether two rectangles overlap with an optional outward margin `pad`. */
function rectsOverlap(a: PlotRect, b: PlotRect, pad = 0): boolean {
  return a.left < b.right + pad && a.right > b.left - pad && a.top < b.bottom + pad && a.bottom > b.top - pad;
}

/** A 1 px hairline between two points, drawn by an absolutely positioned element in its offset parent. */
function drawLine(el: HTMLElement, x1: number, y1: number, x2: number, y2: number): void {
  el.style.left = `${x1}px`;
  el.style.top = `${y1}px`;
  el.style.width = `${Math.hypot(x2 - x1, y2 - y1)}px`;
  el.style.transform = `rotate(${Math.atan2(y2 - y1, x2 - x1)}rad)`;
}

/**
 * The viewport band the plan can use, measured down the middle of the viewport: its top sits 8 px under the sticky
 * chrome (59 px of bars at 1024 px and wider, 60 px below), its bottom above any fixed bottom bar (the phone nav below
 * 1024 px). Without hit testing (jsdom) it falls back to the desktop chrome and the full viewport.
 */
function visibleBand(): { top: number; bottom: number } {
  if (typeof document.elementFromPoint !== "function") return { top: CHROME_TOP, bottom: window.innerHeight };
  const x = window.innerWidth / 2;
  const pinned = (y: number) => {
    for (let el = document.elementFromPoint(x, y); el && el !== document.body; el = el.parentElement) {
      const position = getComputedStyle(el).position;
      if (position === "fixed" || position === "sticky") return true;
    }
    return false;
  };
  let top = 0;
  while (top < 240 && pinned(top)) top += 2;
  let bottom = window.innerHeight - 1;
  while (bottom > top + 120 && pinned(bottom)) bottom -= 2;
  return { top: top + 8, bottom: bottom + 1 };
}

export function PlotMapHero({ rows, asOf, atlas, layout, portraitAspectRatio, children }: PlotMapHeroProps): ReactElement {
  const plotLayout = usePlotLayout();
  // F1: build the desktop model on the server (first paint & no-JS) and on the client only while desktop is live;
  // phones and touch tablets drop the hidden desktop SVG and never rebuild its model during portrait interaction.
  const desktopMounted = plotLayout !== "portrait";
  const map = useMemo<DesktopPlotMap | null>(
    () => (desktopMounted ? buildCemeteryPlotMap(toPlotMapInput(rows), { asOf, preset: "desktop" }) : null),
    [desktopMounted, rows, asOf],
  );
  const rowById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);
  const nav = useMemo(() => {
    if (!map) {
      return {
        graves: new Map<string, DesktopPlotMap["graves"][number]>(),
        place: new Map<string, { section: number; index: number }>(),
        time: new Map<string, number>(),
      };
    }
    const graves = new Map(map.graves.map((g) => [g.id, g]));
    const place = new Map<string, { section: number; index: number }>();
    map.keyboard.sections.forEach((s, section) => s.ids.forEach((id, index) => place.set(id, { section, index })));
    const time = new Map(map.graves.map((g) => [g.id, deathTime(g.deathDate)]));
    return { graves, place, time };
  }, [map]);
  const [vbX, vbY, vbW] = map ? map.viewBox : [0, 0, 1];

  const docked = useMediaQuery(DOCKED_QUERY);
  const reducedMotion = usePrefersReducedMotion();
  const { heroPin, setHeroPin, registerPinGrave, revealRecord, setRecordHash } = useCemeterySelection();

  const [hot, setHot] = useState<{ id: string; focus: boolean } | null>(null);
  const [hotBeamId, setHotBeamId] = useState<string | null>(null);
  const [beamMoved, setBeamMoved] = useState(false);
  const pinnedId = heroPin?.id ?? null;
  const [tabId, setTabId] = useState(map?.keyboard.initialId ?? rows[0]?.id ?? "");
  const [hoverDim, setHoverDim] = useState<PlotDim | null>(null);
  const [activeLens, setActiveLens] = useState<PlotLens | null>(null);
  const [portraitCause, setPortraitCause] = useState<CauseOfDeath | null>(null);
  const [zoom, setZoom] = useState<ZoomState | null>(null);
  const [flowers, setFlowers] = useState<Readonly<Record<string, number>>>({});
  const [status, setStatus] = useState("");
  /** Bumped by every pin: the layout effect then runs the pending scroll request. */
  const [pinTick, setPinTick] = useState(0);
  /** Bumped on resize: re-measure the rest aim, the tag and the card. */
  const [viewportTick, setViewportTick] = useState(0);

  const rootRef = useRef<HTMLElement>(null);
  const sceneRef = useRef<PlotMapSceneHandle>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const gravesRef = useRef(new Map<string, Pick<SVGElement, "focus">>());
  const registerSceneStage = useCallback((stage: HTMLDivElement | null) => {
    stageRef.current = stage;
    sceneRef.current = stage ? createPlotMapSceneHandle(() => stageRef.current, gravesRef.current) : null;
  }, []);
  const registerSceneGrave = useCallback((id: string, element: Pick<SVGElement, "focus"> | null) => {
    if (element) gravesRef.current.set(id, element);
    else gravesRef.current.delete(id);
  }, []);
  const tagRef = useRef<HTMLDivElement>(null);
  const inspectorRef = useRef<HTMLDivElement>(null);
  const connectorRef = useRef<HTMLSpanElement>(null);
  const dwellRef = useRef<number | undefined>(undefined);
  const keyboardRef = useRef(false);
  const pointerDownRef = useRef(false);
  const beamRef = useRef<{ angle: number | null; moved: boolean }>({ angle: null, moved: false });
  /** One-shot requests the next commit carries out (set by handlers, consumed by layout effects). */
  const scrollAfterPinRef = useRef<ScrollRequest | null>(null);
  const focusAfterZoomRef = useRef<"toolbar" | CauseOfDeath | null>(null);

  const query = useCallback(<T extends Element>(selector: string) => rootRef.current?.querySelector<T>(selector) ?? null, []);

  /** Model box (SVG units) → frame px, through the zoom camera when zoomed. */
  const frameRectOf = useCallback(
    (box: PlotBox, scale: number): PlotRect => {
      if (!map) return { left: 0, top: 0, right: 0, bottom: 0 };
      const s = zoom ? zoom.camera.zoom : 1;
      const tx = zoom ? zoom.camera.translate[0] + zoom.pan[0] : 0;
      const ty = zoom ? zoom.camera.translate[1] + zoom.pan[1] : 0;
      return plotBoxToFrameRect({ x0: s * box.x0 + tx, y0: s * box.y0 + ty, x1: s * box.x1 + tx, y1: s * box.y1 + ty }, map.viewBox, scale);
    },
    [zoom, map],
  );

  const aimHot = useCallback(
    (id: string | null, immediate: boolean) => {
      window.clearTimeout(dwellRef.current);
      if (immediate || reducedMotion) setHotBeamId(id);
      else dwellRef.current = window.setTimeout(() => setHotBeamId(id), PLOT_BEAM_DWELL_MS);
    },
    [reducedMotion],
  );
  useEffect(() => () => window.clearTimeout(dwellRef.current), []);

  const enterGrave = useCallback(
    (id: string, via: "pointer" | "focus") => {
      setHot({ id, focus: via === "focus" && (keyboardRef.current || !pointerDownRef.current) });
      aimHot(id, via === "focus");
    },
    [aimHot],
  );
  const leaveGrave = useCallback(
    (via: "pointer" | "focus") => {
      setHot(null);
      aimHot(null, via === "focus");
    },
    [aimHot],
  );

  // Synchronize the roving stop during handoff without replaying scroll/focus, and drop desktop-only hover/zoom when leaving desktop.
  const [lastLayout, setLastLayout] = useState(plotLayout);
  if (lastLayout !== plotLayout) {
    setLastLayout(plotLayout);
    if (plotLayout !== "desktop") {
      setHot(null);
      setHotBeamId(null);
      setHoverDim(null);
      setZoom(null);
    }
  }
  const [lastLivePin, setLastLivePin] = useState(heroPin);
  if (plotLayout === "desktop" && lastLivePin !== heroPin) {
    setLastLivePin(heroPin);
    if (heroPin) setTabId(heroPin.id);
  }

  const pin = useCallback(
    (id: string, source: CemeterySelectionSource) => {
      const grave = nav.graves.get(id);
      const row = rowById.get(id);
      if (!grave || !row) return;
      if (zoom && zoom.cause !== grave.cause) setZoom(null);
      setHeroPin(id, source);
      setTabId(id);
      if (source === "hash") return; // the register's reveal owns scrolling; the provider already owns the hash
      setStatus(`Pinned ${row.name}`);
      setRecordHash(id);
      // "Show on the field ↑" (the register) scrolls up to the grave and hands it keyboard focus
      const fromRegister = source === "register";
      scrollAfterPinRef.current = {
        id,
        behavior: fromRegister && !reducedMotion ? "smooth" : "auto",
        target: docked || fromRegister ? "grave" : "card",
        focus: fromRegister,
      };
      setPinTick((n) => n + 1);
    },
    [nav, rowById, zoom, setHeroPin, setRecordHash, reducedMotion, docked],
  );
  const unpin = useCallback(() => {
    // closing from inside the card (× or Esc) hands focus back to the grave instead of dropping it on the page
    if (pinnedId && inspectorRef.current?.contains(document.activeElement)) sceneRef.current?.grave(pinnedId)?.focus({ preventScroll: true });
    setHeroPin(null);
    setStatus("");
    setRecordHash(null);
  }, [pinnedId, setHeroPin, setRecordHash]);

  const leaveFlower = useCallback((id: string) => {
    setFlowers((current) => ({ ...current, [id]: Math.min(PLOT_FLOWER_MAX, (current[id] ?? 0) + 1) }));
  }, []);

  // The hero owns the selection's pin handler only while the desktop plan is the live layer (the portrait slot owns
  // it at ≤ 760 px); the latest handler is read through a ref so registration does not churn.
  const pinHandlerRef = useRef(pin);
  useEffect(() => {
    pinHandlerRef.current = pin;
  }, [pin]);
  useEffect(() => {
    if (plotLayout !== "desktop") return;
    return registerPinGrave((id, source) => pinHandlerRef.current(id, source));
  }, [plotLayout, registerPinGrave]);

  const zoomTo = useCallback(
    (cause: CauseOfDeath) => {
      const frame = sceneRef.current?.frame();
      if (!map || !frame?.clientWidth) return; // the desktop stage is hidden (phone layout)
      const band = visibleBand();
      const top = frame.getBoundingClientRect().top;
      // bring the frame top under the sticky chrome so the toolbar row and the whole fit are in view
      if (Math.abs(top - band.top) > 4) window.scrollBy({ top: top - band.top, behavior: "auto" });
      // the camera measures its band from the desktop chrome offset: hand it the viewport height that leaves this band
      const camera = fitSectionCamera(map, cause, { frameWidth: frame.clientWidth, viewportHeight: band.bottom - band.top + CHROME_TOP });
      if (!camera) return;
      const bottom = Math.min(frame.clientHeight, band.bottom - band.top) - PLOT_LAYOUT.zoomBottomGap;
      setZoom({ cause, camera, pan: [0, 0], band: { width: frame.clientWidth, bottom } });
      // Entering a section zoom keeps any non-cause legend lens as an intersection; a cause lens yields to the zoom.
      setActiveLens((current) => (current?.kind === "cause" ? null : current));
      setHoverDim(null);
      setHot(null);
      if (camera.ids.length) setTabId(camera.ids[camera.ids.length - 1]);
      // keyboard zooms move focus to the toolbar (the signpost hides); a pointer zoom leaves focus alone
      if (rootRef.current?.contains(document.activeElement)) focusAfterZoomRef.current = "toolbar";
    },
    [map],
  );
  const zoomReset = useCallback(() => {
    if (!zoom) return;
    if (rootRef.current?.querySelector("[data-plot-zoombar]")?.contains(document.activeElement)) {
      focusAfterZoomRef.current = zoom.cause;
    }
    setZoom(null);
  }, [zoom]);

  /** Keeps a grave inside the zoomed band: ←/→ reach the graves a partial section view leaves out. */
  const panTo = useCallback(
    (id: string) => {
      const g = nav.graves.get(id);
      if (!zoom || !g || g.cause !== zoom.cause) return;
      const scale = zoom.band.width / vbW;
      const r = frameRectOf(g.screen.box, scale);
      const left = PAN_MARGIN;
      const right = zoom.band.width - PAN_MARGIN;
      const top = PLOT_LAYOUT.zoomBar + PAN_MARGIN / 2;
      const bottom = zoom.band.bottom - PAN_MARGIN / 2;
      const dx = r.left < left ? left - r.left : r.right > right ? right - r.right : 0;
      // Tall colossi can exceed the zoomed band height: anchor on podium + medallion rather than fighting top vs bottom.
      const focusRect = r.bottom - r.top > bottom - top ? frameRectOf(zoomFocusBox(g), scale) : r;
      const dy = focusRect.top < top ? top - focusRect.top : focusRect.bottom > bottom ? bottom - focusRect.bottom : 0;
      if (dx || dy) setZoom({ ...zoom, pan: [zoom.pan[0] + dx / scale, zoom.pan[1] + dy / scale] });
    },
    [nav, zoom, vbW, frameRectOf],
  );

  const moveTo = useCallback(
    (id: string) => {
      setTabId(id);
      panTo(id);
      // zoomed, the pan (not a page scroll) brings the grave into the band; the frame stays under the chrome
      sceneRef.current?.grave(id)?.focus({ preventScroll: zoom !== null });
    },
    [panTo, zoom],
  );

  const graveKey = useCallback(
    (event: KeyboardEvent, id: string) => {
      const at = nav.place.get(id);
      if (!map || !at) return;
      const ids = map.keyboard.sections[at.section].ids;
      /** Nearest-dated grave in the next non-empty section in `dir` (canonical order: front lane → back lane). */
      const nearestIn = (dir: 1 | -1): string | undefined => {
        const t = nav.time.get(id) ?? 0;
        for (let s = at.section + dir; s >= 0 && s < map.keyboard.sections.length; s += dir) {
          const other = map.keyboard.sections[s].ids;
          if (other.length) return other.reduce((best, o) => (Math.abs((nav.time.get(o) ?? 0) - t) < Math.abs((nav.time.get(best) ?? 0) - t) ? o : best));
        }
        return undefined;
      };
      let to: string | undefined;
      switch (event.key) {
        case "ArrowLeft":
          to = ids[at.index - 1];
          break;
        case "ArrowRight":
          to = ids[at.index + 1];
          break;
        case "ArrowUp":
          to = zoom ? undefined : nearestIn(1);
          break;
        case "ArrowDown":
          to = zoom ? undefined : nearestIn(-1);
          break;
        case "Home":
          to = ids[0];
          break;
        case "End":
          to = ids[ids.length - 1];
          break;
        case "Enter":
        case " ":
          event.preventDefault();
          pin(id, "hero");
          return;
        case "f":
        case "F":
          if (event.ctrlKey || event.metaKey || event.altKey) return;
          event.preventDefault();
          leaveFlower(id);
          return;
        default:
          return;
      }
      event.preventDefault();
      if (to) moveTo(to);
    },
    [nav, map, zoom, pin, leaveFlower, moveTo],
  );

  const clearLens = useCallback(() => {
    setActiveLens(null);
    setStatus("Showing all graves");
  }, []);

  const escape = useCallback((): boolean => {
    if (pinnedId) {
      unpin();
      return true;
    }
    if (activeLens) {
      clearLens();
      return true;
    }
    if (zoom) {
      zoomReset();
      return true;
    }
    return false;
  }, [pinnedId, activeLens, zoom, unpin, clearLens, zoomReset]);

  // Esc and F also work with focus outside the hero (page body) while a grave is pinned/hovered, zoomed, or lensed,
  // on the desktop plan only (the phone layer owns Esc there).
  useEffect(() => {
    if (plotLayout !== "desktop" || (!pinnedId && !zoom && !hot && !activeLens)) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (event.defaultPrevented || (target && rootRef.current?.contains(target))) return;
      if (target?.closest("input, textarea, select, [contenteditable], [role=dialog]")) return;
      if (event.key === "Escape" && escape()) return;
      if ((event.key === "f" || event.key === "F") && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const id = hot?.id ?? pinnedId;
        if (id) leaveFlower(id);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [plotLayout, pinnedId, zoom, hot, activeLens, escape, leaveFlower]);

  // E9: delegate legend lens toggles on the server-rendered sibling `<PlotMapLegend data-plot-legend>` so the legend
  // stays a zero-JS Server Component while driving highlighting on both desktop and portrait walk.
  const toggleLens = useCallback(
    (lens: PlotLens) => {
      if (plotLayout === "portrait" && lens.kind === "cause" && portraitCause === lens.cause && !activeLens) {
        setPortraitCause(null);
        return;
      }
      const clearing = samePlotLens(activeLens, lens);
      const next = clearing ? null : lens;
      if (next?.kind === "cause") {
        if (zoom) setZoom(null);
        if (plotLayout === "portrait") setPortraitCause(null);
      }
      setActiveLens(next);
      // F15: when the user activates a lens while the plot map is scrolled off-screen, bring the plan into view.
      if (next) {
        const planEl =
          plotLayout === "portrait"
            ? rootRef.current?.querySelector<HTMLElement>("[data-plot-portrait]")
            : sceneRef.current?.frame();
        if (planEl) {
          const rect = planEl.getBoundingClientRect();
          if (rect.height > 0) {
            const visible = Math.max(0, Math.min(window.innerHeight, rect.bottom) - Math.max(CHROME_TOP, rect.top));
            if (visible < Math.min(240, rect.height * 0.45)) {
              const targetTop =
                plotLayout === "desktop" && rect.height + 120 <= window.innerHeight - CHROME_TOP
                  ? Math.max(CHROME_TOP, window.innerHeight - 120 - rect.height)
                  : CHROME_TOP;
              window.scrollBy({ top: rect.top - targetTop, behavior: reducedMotion ? "instant" : "smooth" });
            }
          }
        }
      }
      if (plotLayout === "desktop" && map) {
        if (!next) {
          setStatus("Showing all graves");
        } else {
          const scopedCause = next.kind === "cause" ? null : (zoom?.cause ?? null);
          const matching = map.graves.filter((g) => (scopedCause ? g.cause === scopedCause : true) && matchesPlotLens(g, next)).length;
          const scopeLabel = scopedCause ? ` in ${CAUSE_META[scopedCause].label}` : "";
          setStatus(`Highlighting ${describePlotLens(next)}${scopeLabel}: ${matching} of ${map.counts.total} graves`);
        }
      }
    },
    [activeLens, plotLayout, portraitCause, zoom, map, reducedMotion],
  );

  useEffect(() => {
    const legend = rootRef.current?.parentElement?.querySelector<HTMLElement>("[data-plot-legend]");
    if (!legend) return;
    // F15: SSR renders legend lens buttons `disabled` (inert without JS); enable them once hydrated.
    legend.setAttribute("data-lenses-ready", "true");
    const buttons = [...legend.querySelectorAll<HTMLButtonElement>("[data-plot-lens]")];
    for (const button of buttons) {
      button.disabled = false;
      if (!button.hasAttribute("aria-pressed")) button.setAttribute("aria-pressed", "false");
    }
    const onLegendClick = (event: globalThis.MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-plot-lens]") : null;
      if (!target || target.disabled) return;
      const parsed = parsePlotLens(target.dataset.plotLens);
      if (parsed) toggleLens(parsed);
    };
    const onLegendKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || !activeLens) return;
      event.preventDefault();
      clearLens();
    };
    legend.addEventListener("click", onLegendClick);
    legend.addEventListener("keydown", onLegendKeyDown);
    return () => {
      legend.removeEventListener("click", onLegendClick);
      legend.removeEventListener("keydown", onLegendKeyDown);
    };
  }, [toggleLens, activeLens, clearLens]);

  useEffect(() => {
    const legend = rootRef.current?.parentElement?.querySelector<HTMLElement>("[data-plot-legend]");
    if (!legend) return;
    return () => {
      legend.removeAttribute("data-lenses-ready");
      legend.removeAttribute("data-has-lens");
      for (const button of legend.querySelectorAll<HTMLButtonElement>("[data-plot-lens]")) {
        button.disabled = true;
        button.removeAttribute("aria-pressed");
      }
    };
  }, []);

  useEffect(() => {
    const legend = rootRef.current?.parentElement?.querySelector<HTMLElement>("[data-plot-legend]");
    if (!legend) return;
    const effectivePortraitCause = plotLayout === "portrait" ? (activeLens?.kind === "cause" ? activeLens.cause : portraitCause) : null;
    const hasAny = activeLens !== null || effectivePortraitCause !== null;
    legend.toggleAttribute("data-has-lens", hasAny);
    for (const button of legend.querySelectorAll<HTMLButtonElement>("[data-plot-lens]")) {
      const parsed = parsePlotLens(button.dataset.plotLens);
      const pressed =
        (parsed !== null && samePlotLens(activeLens, parsed)) ||
        (effectivePortraitCause !== null && parsed?.kind === "cause" && parsed.cause === effectivePortraitCause);
      button.setAttribute("aria-pressed", pressed ? "true" : "false");
    }
  }, [activeLens, portraitCause, plotLayout]);

  // The hero root also holds the phone layer (the portrait slot, whose graves are `walk-<id>` anchors) and, through
  // React's tree, the portalled phone sheet: the desktop plan reacts only to events from its own DOM, and only while
  // it is the live layer.
  const ownsEvent = (target: EventTarget | null) =>
    plotLayout === "desktop" && target instanceof Element && !!rootRef.current?.contains(target) && !target.closest("[data-plot-portrait-slot]");
  const graveOf = (target: EventTarget | null) => sceneRef.current?.graveOf(target);
  const signpostOf = (target: EventTarget | null) => sceneRef.current?.signpostOf(target);
  const yearOf = (target: EventTarget | null) => sceneRef.current?.yearOf(target);

  // F17: pointer hover ignores ghosted non-members while zoomed or lensed so they never pop to full colour.
  const isGraveInActiveFilter = useCallback(
    (id: string): boolean => {
      const g = nav.graves.get(id);
      if (!g) return false;
      if (zoom) {
        if (g.cause !== zoom.cause) return false;
        return activeLens && activeLens.kind !== "cause" ? matchesPlotLens(g, activeLens) : true;
      }
      if (activeLens) return matchesPlotLens(g, activeLens);
      return true;
    },
    [nav, zoom, activeLens],
  );

  const onPointerOver = (event: PointerEvent) => {
    if (!ownsEvent(event.target)) return;
    keyboardRef.current = false;
    const grave = graveOf(event.target);
    if (grave?.id) {
      if (!isGraveInActiveFilter(grave.id)) {
        if (hot && !hot.focus) leaveGrave("pointer");
      } else if (grave.id !== hot?.id) {
        enterGrave(grave.id, "pointer");
      }
    }
    const post = signpostOf(event.target);
    if (post && !zoom) setHoverDim({ kind: "lane", cause: post.cause });
    const year = yearOf(event.target);
    if (year && !zoom) setHoverDim({ kind: "year", years: year.years });
  };
  const onPointerOut = (event: PointerEvent) => {
    if (!ownsEvent(event.target)) return;
    const related = event.relatedTarget as Node | null;
    const grave = graveOf(event.target);
    if (grave && !grave.element.contains(related) && !graveOf(related) && document.activeElement !== grave.element) leaveGrave("pointer");
    const post = signpostOf(event.target);
    if (post && !post.element.contains(related) && !zoom) setHoverDim(null);
    const year = yearOf(event.target);
    if (year && !year.element.contains(related) && !zoom) setHoverDim(null);
  };
  const onClick = (event: MouseEvent) => {
    if (!ownsEvent(event.target)) return;
    const grave = graveOf(event.target);
    if (grave?.id) {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      pin(grave.id, "hero");
      return;
    }
    const post = signpostOf(event.target);
    if (post) {
      zoomTo(post.cause);
      return;
    }
    if (sceneRef.current?.isBackground(event.target)) escape();
  };
  const onFocus = (event: FocusEvent) => {
    if (!ownsEvent(event.target)) return;
    const grave = graveOf(event.target);
    if (grave?.id) {
      setTabId(grave.id);
      enterGrave(grave.id, "focus");
      return;
    }
    const post = signpostOf(event.target);
    if (post && !zoom) setHoverDim({ kind: "lane", cause: post.cause });
  };
  const onBlur = (event: FocusEvent) => {
    if (!ownsEvent(event.target)) return;
    if (graveOf(event.target) && !graveOf(event.relatedTarget)) leaveGrave("focus");
    if (signpostOf(event.target) && !zoom) setHoverDim(null);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!ownsEvent(event.target)) return;
    keyboardRef.current = true;
    pointerDownRef.current = false;
    const grave = graveOf(event.target);
    if (event.key === "Escape") {
      if (escape()) event.preventDefault();
      return;
    }
    if (grave?.id) graveKey(event, grave.id);
  };

  // A zoom change moves focus where its handler asked (toolbar after a keyboard zoom, signpost after leaving it).
  useLayoutEffect(() => {
    const selector = focusAfterZoomRef.current;
    focusAfterZoomRef.current = null;
    if (selector) (selector === "toolbar" ? query<HTMLElement>("[data-plot-zoom-out]") : sceneRef.current?.signpost(selector))?.focus();
  }, [zoom, query]);

  // A resize or font swap re-measures the rest aim, the tag and the card, and refits an open section zoom to the new frame.
  useEffect(() => {
    if (!map) return;
    const onResize = () => {
      setViewportTick((n) => n + 1);
      setZoom((current) => {
        const frame = sceneRef.current?.frame();
        if (!current || !frame?.clientWidth) return current;
        const band = visibleBand();
        const camera = fitSectionCamera(map, current.cause, { frameWidth: frame.clientWidth, viewportHeight: band.bottom - band.top + CHROME_TOP });
        const bottom = Math.min(frame.clientHeight, band.bottom - band.top) - PLOT_LAYOUT.zoomBottomGap;
        return camera ? { ...current, camera, pan: [0, 0], band: { width: frame.clientWidth, bottom } } : null;
      });
    };
    window.addEventListener("resize", onResize);
    const frame = sceneRef.current?.frame();
    const observer = typeof ResizeObserver === "undefined" || !frame ? null : new ResizeObserver(() => setViewportTick((n) => n + 1));
    if (frame) observer?.observe(frame);
    let live = true;
    void document.fonts?.ready.then(() => {
      if (live) setViewportTick((n) => n + 1);
    });
    return () => {
      live = false;
      observer?.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, [map]);

  // A pin brings its grave into the band below the sticky chrome (docked) or its card into view (in flow).
  useLayoutEffect(() => {
    const request = scrollAfterPinRef.current;
    scrollAfterPinRef.current = null;
    const frame = sceneRef.current?.frame();
    const g = request ? nav.graves.get(request.id) : undefined;
    if (!request || !frame || !g) return;
    if (request.focus) sceneRef.current?.grave(g.id)?.focus({ preventScroll: true });
    if (request.target === "card") {
      inspectorRef.current?.scrollIntoView({ block: "nearest", behavior: request.behavior });
      return;
    }
    const fr = frame.getBoundingClientRect();
    const r = frameRectOf(g.screen.box, fr.width / vbW);
    const top = fr.top + r.top;
    const bottom = fr.top + r.bottom;
    if (top >= CHROME_TOP + 8 && bottom <= window.innerHeight - 12) return;
    window.scrollBy({ top: (top + bottom) / 2 - (CHROME_TOP + window.innerHeight) / 2, behavior: request.behavior });
  }, [pinTick, query, nav, frameRectOf, vbW]);

  // Beam: aims at the pinned grave, else the hot one (after the dwell); rests dead-centre on the `134` numerals
  // otherwise. The SSR pose uses the CSS container band; after mount, live measurement keeps the beam locked onto
  // `134` at every width and height-fit size (snapping without transition until the first hover/pin interaction).
  const beamTargetId = pinnedId ?? hotBeamId;
  if (beamTargetId !== null && !beamMoved) setBeamMoved(true);
  useLayoutEffect(() => {
    const rot = sceneRef.current?.beam();
    const frame = sceneRef.current?.frame();
    if (!map || !rot || !frame || !frame.clientWidth) return;
    const g = beamTargetId ? nav.graves.get(beamTargetId) : undefined;
    let target: [number, number] | null = g ? [g.screen.medal.x, g.screen.medal.y] : null;
    if (!target) {
      const digits = query<HTMLElement>("[data-plot-figure-value]")?.getBoundingClientRect();
      const fr = frame.getBoundingClientRect();
      const scale = fr.width / vbW;
      if (digits?.width && fr.width) {
        target = [vbX + (digits.left + digits.width * 0.5 - fr.left) / scale, vbY + (digits.top + digits.height * 0.46 - fr.top) / scale];
      }
    }
    if (!target) return;
    const [ox, oy] = map.beamOrigin;
    let angle = (Math.atan2(target[1] - oy, target[0] - ox) * 180) / Math.PI;
    const from = beamRef.current.angle ?? Number.parseFloat(getComputedStyle(rot).getPropertyValue("--ba"));
    // swing the short way round (the rest pose points up-left, graves lie down-left)
    if (Number.isFinite(from)) {
      while (angle - from > 180) angle -= 360;
      while (angle - from < -180) angle += 360;
    }
    beamRef.current = { angle, moved: beamRef.current.moved || beamTargetId !== null };
    rot.style.setProperty("--ba", `${angle.toFixed(2)}deg`);
    rot.style.setProperty("--bs", (Math.hypot(target[0] - ox, target[1] - oy) / 1000).toFixed(4));
  }, [beamTargetId, viewportTick, query, nav, map, vbX, vbY, vbW]);

  // Hover/focus always shows the compact tag ("name · peak · date", mono figures); the full record card opens only on
  // pin (click / Enter / Space), so keyboard walks and pointer sweeps never open or jump the card.
  const cardId = pinnedId;
  const hotAllowed = hot !== null && (hot.focus || isGraveInActiveFilter(hot.id));
  const hotRow = hotAllowed && cardId !== hot.id ? rowById.get(hot.id) : undefined;
  const cypress = map && hoverDim?.kind === "year" && hoverDim.years.length === 1 ? map.cypress.find((c) => c.year === hoverDim.years[0]) : undefined;
  const mergedBlock =
    map && hoverDim?.kind === "year" && hoverDim.years.length > 1
      ? map.blocks.find((b) => !b.empty && b.years.length === hoverDim.years.length && b.years[0] === hoverDim.years[0])
      : undefined;
  const tagContent = hotRow ? (
    <>
      <span className={styles.tagName}>{hotRow.name}</span>
      {" · "}
      <span className={styles.mono}>{hotRow.peak === null ? "not recorded" : formatCemeteryPeak(hotRow.peak)}</span>
      {" · "}
      <span className={styles.mono}>{formatRegisterDeathDate(hotRow.deathDate)}</span>
    </>
  ) : cypress ? (
    <span className={styles.mono}>{cypress.label}</span>
  ) : mergedBlock ? (
    <span className={styles.mono}>
      {mergedBlock.text}
      {mergedBlock.sub ? ` · ${mergedBlock.sub}` : ""}
    </span>
  ) : null;
  const hasTag = tagContent !== null;

  // Inspector (pinned only): docked beside its grave (≥ 1280 px), clamped to the band below the chrome, clear of the
  // Feedback button, of the route head and the `134` figure (of the zoom toolbar while zoomed), and NEVER covering a
  // colossus (BUSD/UST) or its chip. Signpost plates and year stamps stay uncovered where a spot holds the whole card;
  // any non-colossus label still covered hides whole (`data-covered`), never cut in half.
  const placeCard = useCallback(() => {
    const insp = inspectorRef.current;
    const connector = connectorRef.current;
    const labels = sceneRef.current?.coverableLabels() ?? [];
    if (!connector) return;
    const stage = sceneRef.current?.stage();
    const frame = sceneRef.current?.frame();
    const g = cardId ? nav.graves.get(cardId) : undefined;
    if (!map || !insp || !docked || !stage || !frame || !g || getComputedStyle(insp).position !== "absolute") {
      insp?.style.removeProperty("left");
      insp?.style.removeProperty("top");
      insp?.style.removeProperty("max-height");
      connector.hidden = true;
      for (const { element } of labels) element.removeAttribute("data-covered");
      return;
    }
    const fr = frame.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    const scale = fr.width / vbW;
    const toViewport = (box: PlotBox): PlotRect => {
      const r = frameRectOf(box, scale);
      return { left: fr.left + r.left, top: fr.top + r.top, right: fr.left + r.right, bottom: fr.top + r.bottom };
    };
    const medal = toViewport({ x0: g.screen.medal.x, y0: g.screen.medal.y, x1: g.screen.medal.x, y1: g.screen.medal.y });
    const colossi = map.colossi.flatMap((c) => {
      const box = map.obstacles.find((o) => o.key === `grave:${c.id}`);
      const gCol = nav.graves.get(c.id);
      const modelRect = box ? toViewport(box) : gCol ? toViewport(gCol.screen.box) : null;
      const domRect = stage.querySelector<Element>(`a[data-grave-id="${c.id}"]`)?.getBoundingClientRect();
      const liveRect = domRect && domRect.width > 0 && domRect.height > 0 ? domRect : null;
      if (modelRect && liveRect) {
        return [{ left: Math.min(modelRect.left, liveRect.left), top: Math.min(modelRect.top, liveRect.top), right: Math.max(modelRect.right, liveRect.right), bottom: Math.max(modelRect.bottom, liveRect.bottom) }];
      }
      return liveRect ? [liveRect] : modelRect ? [modelRect] : [];
    });
    const colossusChips = zoom
      ? []
      : labels
          .filter(({ element, chipId }) => chipId !== undefined && chipId !== cardId && element.getClientRects().length > 0)
          .map(({ element }) => element.getBoundingClientRect());
    const hardColossi: PlotRect[] = [...colossi, ...colossusChips];
    const text = [...(rootRef.current?.querySelectorAll(zoom ? "[data-plot-zoombar]" : "[data-plot-head], [data-plot-figure]") ?? [])].map((el) => el.getBoundingClientRect());
    // labels hide while zoomed; colossus chips are already hard-avoided
    const soft = zoom ? [] : labels.filter(({ element, leaderId, chipId }) => element.getClientRects().length > 0 && leaderId === undefined && chipId === undefined).map(({ element }) => element.getBoundingClientRect());
    insp.style.removeProperty("max-height");
    const cardW = insp.offsetWidth;
    const cardH = insp.scrollHeight;
    const stoneRect = toViewport(g.screen.box);
    const avoid = [...hardColossi, ...text];
    let p = placeInspectorCard({
      stone: stoneRect,
      frame: fr,
      medal: [medal.left, medal.top],
      card: { width: cardW, height: cardH },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      avoid,
      soft,
    });
    // If the default slot hit a colossus/chip or was vertically pinched below the card's full height, relocate to the
    // nearest colossus-free column inside the frame so colossi stay uncovered and the full card fits without scrolling.
    const hitsColossus = (rect: PlotRect) => hardColossi.some((c) => rectsOverlap(rect, c, 4));
    const currentHits = hardColossi.length > 0 && hitsColossus({ left: p.x, top: p.y, right: p.x + cardW, bottom: p.y + p.maxHeight });
    if (hardColossi.length && (currentHits || p.maxHeight < cardH)) {
      const minColLeft = Math.min(...hardColossi.map((c) => c.left));
      const maxColRight = Math.max(...hardColossi.map((c) => c.right));
      const minH = Math.min(cardH, 220);
      const visTop = Math.max(CHROME_TOP, fr.top);
      const visBot = Math.min(window.innerHeight - 8, fr.bottom);
      const onScreen = visBot - visTop >= minH;
      const topMin = onScreen ? visTop : fr.top;
      const midY = (stoneRect.top + stoneRect.bottom) / 2;
      const xs = [maxColRight + 10, minColLeft - 10 - cardW, fr.right - 4 - cardW, fr.left + 4].filter(
        (x) => x >= fr.left + 4 - 1 && x + cardW <= fr.right - 4 + 1,
      );
      let best: { x: number; y: number; maxHeight: number; score: number } | null = null;
      for (const x of xs) {
        const bot = onScreen ? Math.min(x + cardW > window.innerWidth - 132 ? window.innerHeight - 54 : window.innerHeight - 8, fr.bottom) : fr.bottom;
        let runs: [number, number][] = [[topMin, bot]];
        for (const r of avoid) {
          if (r.left >= x + cardW + 6 || r.right <= x - 6) continue;
          runs = runs.flatMap(([a, b]): [number, number][] => {
            const cut0 = r.top - 6;
            const cut1 = r.bottom + 6;
            if (cut1 <= a || cut0 >= b) return [[a, b]];
            return [...(cut0 > a ? [[a, cut0] as [number, number]] : []), ...(cut1 < b ? [[cut1, b] as [number, number]] : [])];
          });
        }
        for (const [a, b] of runs) {
          if (b - a < minH) continue;
          const h = Math.min(cardH, b - a);
          const y = Math.min(Math.max(midY - h / 2, a), b - h);
          const rect = { left: x, top: y, right: x + cardW, bottom: y + h };
          if (hitsColossus(rect)) continue;
          const dist = Math.abs(x + cardW / 2 - (stoneRect.left + stoneRect.right) / 2);
          if (!best || h > best.maxHeight || (h === best.maxHeight && dist < best.score)) best = { x, y, maxHeight: h, score: dist };
        }
      }
      if (best && (currentHits || best.maxHeight > p.maxHeight)) {
        const ex = best.x > medal.left ? best.x : best.x + cardW;
        const ey = Math.min(Math.max(medal.top, best.y + 14), best.y + best.maxHeight - 14);
        p = { x: best.x, y: best.y, maxHeight: best.maxHeight, connector: { x1: medal.left, y1: medal.top, x2: ex, y2: ey } };
      }
    }
    insp.style.left = `${p.x - sr.left}px`;
    insp.style.top = `${p.y - sr.top}px`;
    insp.style.maxHeight = `${p.maxHeight}px`;
    drawLine(connector, p.connector.x1 - sr.left, p.connector.y1 - sr.top, p.connector.x2 - sr.left, p.connector.y2 - sr.top);
    connector.hidden = false;
    const card = { left: p.x, top: p.y, right: p.x + cardW, bottom: p.y + p.maxHeight };
    const under = labels.map(({ element }) => {
      const r = element.getBoundingClientRect();
      return !zoom && r.width + r.height > 0 && rectsOverlap(r, card, 0);
    });
    const covered = new Set(labels.flatMap(({ chipId }, k) => (under[k] && chipId ? [chipId] : [])));
    labels.forEach(({ element, leaderId }, k) => element.toggleAttribute("data-covered", under[k] || covered.has(leaderId ?? "")));
  }, [cardId, docked, zoom, nav, map, frameRectOf, vbW]);

  // re-place whenever the card's content can change height: pin change, flower count, resize
  useLayoutEffect(() => {
    placeCard();
  }, [placeCard, pinnedId, flowers, viewportTick]);

  useLayoutEffect(() => {
    const tag = tagRef.current;
    const frame = sceneRef.current?.frame();
    if (!map || !tag || !frame || !hasTag) return;
    const fr = frame.getBoundingClientRect();
    const scale = fr.width / vbW;
    const size = { width: tag.offsetWidth, height: tag.offsetHeight };
    if (hot && hotRow) {
      const g = nav.graves.get(hot.id);
      if (!g) return;
      const within = (el: Element): PlotRect => {
        const r = el.getBoundingClientRect();
        return { left: r.left - fr.left, top: r.top - fr.top, right: r.right - fr.left, bottom: r.bottom - fr.top };
      };
      const domObstacles = (rootRef.current ? sceneRef.current?.tagObstacles(rootRef.current) ?? [] : [])
        .filter((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden")
        .map(within);
      // Never cover a colossus (BUSD/UST) with the hover/focus tag.
      const colossusObstacles = map.colossi.flatMap((c) => {
        const box = map.obstacles.find((o) => o.key === `grave:${c.id}`);
        const gCol = nav.graves.get(c.id);
        const modelRect = box ? frameRectOf(box, scale) : gCol ? frameRectOf(gCol.screen.box, scale) : null;
        const domEl = frame.querySelector(`a[data-grave-id="${c.id}"]`);
        const domRect = domEl?.getBoundingClientRect();
        const liveRect = domRect && domRect.width > 0 && domRect.height > 0
          ? { left: domRect.left - fr.left, top: domRect.top - fr.top, right: domRect.right - fr.left, bottom: domRect.bottom - fr.top }
          : null;
        if (modelRect && liveRect) {
          return [{ left: Math.min(modelRect.left, liveRect.left), top: Math.min(modelRect.top, liveRect.top), right: Math.max(modelRect.right, liveRect.right), bottom: Math.max(modelRect.bottom, liveRect.bottom) }];
        }
        return liveRect ? [liveRect] : modelRect ? [modelRect] : [];
      });
      const obstacles = [...domObstacles, ...colossusObstacles];
      const stoneModel = frameRectOf(g.screen.box, scale);
      const stoneDom = frame.querySelector(`a[data-grave-id="${g.id}"]`)?.getBoundingClientRect();
      const stone =
        stoneDom && stoneDom.width > 0 && stoneDom.height > 0
          ? {
              left: Math.min(stoneModel.left, stoneDom.left - fr.left),
              top: Math.min(stoneModel.top, stoneDom.top - fr.top),
              right: Math.max(stoneModel.right, stoneDom.right - fr.left),
              bottom: Math.max(stoneModel.bottom, stoneDom.bottom - fr.top),
            }
          : stoneModel;
      const topLimit = Math.max(0, CHROME_TOP - fr.top);
      let p = placePlotTag({ stone, tag: size, frame: { width: fr.width, height: fr.height }, obstacles, top: topLimit });
      if (p.collisions !== 0) {
        // Try a slightly wider ring around stones nestled beside colossi before hiding the tag.
        const cx = (stone.left + stone.right) / 2;
        const midY = (stone.top + stone.bottom) / 2;
        const extras: [number, number][] = [
          [cx - size.width / 2, stone.top - size.height - 16],
          [cx - size.width / 2, stone.bottom + 14],
          [stone.right + 12, stone.bottom + 6],
          [stone.left - size.width - 12, stone.bottom + 6],
          [stone.right + 14, midY - size.height / 2],
          [stone.left - size.width - 14, midY - size.height / 2],
        ];
        for (const [x, y] of extras) {
          if (x < 0 || y < topLimit || x + size.width > fr.width || y + size.height > fr.height) continue;
          const rect = { left: x, top: y, right: x + size.width, bottom: y + size.height };
          if (!obstacles.some((o) => rectsOverlap(rect, o, 3))) {
            p = { x, y, collisions: 0 };
            break;
          }
        }
      }
      tag.style.left = `${p.x}px`;
      tag.style.top = `${p.y}px`;
      tag.toggleAttribute("data-blocked", p.collisions !== 0);
    } else if (cypress) {
      tag.style.left = `${(cypress.top[0] - vbX) * scale - size.width / 2}px`;
      tag.style.top = `${(cypress.top[1] - vbY) * scale - size.height - 6}px`;
      tag.removeAttribute("data-blocked");
    } else if (mergedBlock) {
      const left = Math.max(4, Math.min(fr.width - size.width - 4, (mergedBlock.stamp[0] - vbX) * scale - size.width / 2));
      const top = Math.max(4, (mergedBlock.stamp[1] - vbY) * scale - size.height - 14);
      tag.style.left = `${left}px`;
      tag.style.top = `${top}px`;
      tag.removeAttribute("data-blocked");
    }
  }, [hasTag, hot, hotRow, cypress, mergedBlock, cardId, pinnedId, viewportTick, query, nav, map, frameRectOf, vbX, vbY, vbW]);

  useEffect(() => {
    if (!cardId || !docked) return;
    let frame = 0;
    const onScroll = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(placeCard);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
    };
  }, [cardId, docked, placeCard]);

  // What the zoom chip states: the camera's framed years and graves; after ←/→ or ‹/› panned a partial view,
  // the section's graves whose focus box lies inside the visible band.
  const zoomView = useMemo(() => {
    if (!zoom || !map) return null;
    const { camera, pan, band } = zoom;
    if (pan[0] === 0 && pan[1] === 0) return { shown: camera.shown, span: camera.span };
    const scale = band.width / vbW;
    const years = map.keyboard.sections
      .flatMap((s) => (s.cause === zoom.cause ? s.ids : []))
      .flatMap((id) => {
        const g = nav.graves.get(id);
        if (!g) return [];
        const r = frameRectOf(zoomFocusBox(g), scale);
        return r.left >= -4 && r.right <= band.width + 4 && r.top >= PLOT_LAYOUT.zoomBar - 4 && r.bottom <= band.bottom + 4 ? [g.year] : [];
      });
    return years.length ? { shown: years.length, span: [Math.min(...years), Math.max(...years)] as const } : { shown: camera.shown, span: camera.span };
  }, [zoom, map, nav, frameRectOf, vbW]);

  // C7 / C-12: prev (‹ left / newer) and next (› right / older) year-run pan targets for partial section zooms.
  interface ZoomPanTarget {
    span: readonly [number, number];
    label: string;
    ids: string[];
    pan: [number, number];
  }
  const zoomPanTargets = useMemo<{ prev: ZoomPanTarget | null; next: ZoomPanTarget | null }>(() => {
    if (!zoom || !map || !zoomView || !zoom.camera.partial) return { prev: null, next: null };
    const sectionGraves = map.graves.filter((g) => g.cause === zoom.cause);
    const yearsAsc = [...new Set(sectionGraves.map((g) => g.year))].sort((a, b) => a - b);
    const [spanLo, spanHi] = zoomView.span;
    const s = zoom.camera.zoom;
    const scale = zoom.band.width / vbW;
    const availW = zoom.band.width - PLOT_LAYOUT.zoomSideInset;
    const availH = zoom.band.bottom - PLOT_LAYOUT.zoomBar;
    const maxUserW = availW / (s * scale);
    const maxUserH = availH / (s * scale);

    const buildTarget = (dir: -1 | 1): ZoomPanTarget | null => {
      // Desktop runs newest (left / west) → oldest (right / east): ‹ pans left to newer years, › pans right to older years.
      const remaining = dir === -1 ? yearsAsc.filter((y) => y > spanHi) : yearsAsc.filter((y) => y < spanLo).reverse();
      if (!remaining.length) return null;
      // If every remaining year sits inside the initial camera span, return straight to the initial camera window.
      const fitsInitial =
        remaining.every((y) => y >= zoom.camera.span[0] && y <= zoom.camera.span[1]) &&
        !(spanLo === zoom.camera.span[0] && spanHi === zoom.camera.span[1]);
      let lo: number;
      let hi: number;
      if (fitsInitial) {
        [lo, hi] = zoom.camera.span;
      } else {
        const picked: number[] = [remaining[0]];
        let box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
        const extendBox = (year: number) => {
          let next = { ...box };
          for (const g of sectionGraves) {
            if (g.year !== year) continue;
            const b = zoomFocusBox(g);
            next = {
              x0: Math.min(next.x0, b.x0),
              y0: Math.min(next.y0, b.y0),
              x1: Math.max(next.x1, b.x1),
              y1: Math.max(next.y1, b.y1),
            };
          }
          return next;
        };
        box = extendBox(remaining[0]);
        for (let k = 1; k < remaining.length; k++) {
          const cand = extendBox(remaining[k]);
          if (cand.x1 - cand.x0 <= maxUserW && cand.y1 - cand.y0 <= maxUserH) {
            picked.push(remaining[k]);
            box = cand;
          } else break;
        }
        lo = Math.min(...picked);
        hi = Math.max(...picked);
      }
      const runGraves = sectionGraves.filter((g) => g.year >= lo && g.year <= hi).sort((a, b) => a.laneIndex - b.laneIndex);
      if (!runGraves.length) return null;
      const isInitial = lo === zoom.camera.span[0] && hi === zoom.camera.span[1];
      let pan: [number, number] = [0, 0];
      if (!isInitial) {
        const boxes = runGraves.map(zoomFocusBox);
        const x0 = Math.min(...boxes.map((b) => b.x0));
        const x1 = Math.max(...boxes.map((b) => b.x1));
        const y0 = Math.min(...boxes.map((b) => b.y0));
        const y1 = Math.max(...boxes.map((b) => b.y1));
        const cx = (x0 + x1) / 2;
        const cy = (y0 + y1) / 2;
        const desiredTx = vbX + zoom.band.width / 2 / scale - s * cx;
        const desiredTy = vbY + (PLOT_LAYOUT.zoomBar + availH / 2 + PLOT_LAYOUT.zoomCentreOffset) / scale - s * cy;
        pan = [desiredTx - zoom.camera.translate[0], desiredTy - zoom.camera.translate[1]];
      }
      const span = [lo, hi] as const;
      // Name only the years the move brings into view, not the ones already on screen.
      const shownNext = fitsInitial ? ([Math.min(...remaining), Math.max(...remaining)] as const) : span;
      return { span, label: formatZoomSpan(shownNext), ids: runGraves.map((g) => g.id), pan };
    };

    return { prev: buildTarget(-1), next: buildTarget(1) };
  }, [zoom, map, zoomView, vbX, vbY, vbW]);

  const panZoom = useCallback(
    (dir: -1 | 1) => {
      if (!zoom) return;
      const target = dir === -1 ? zoomPanTargets.prev : zoomPanTargets.next;
      if (!target) return;
      setZoom({ ...zoom, pan: target.pan });
      if (target.ids.length) setTabId(target.ids[target.ids.length - 1]);
      setStatus(`Showing ${CAUSE_META[zoom.cause].label} ${target.label}, ${target.ids.length} of ${zoom.camera.total} graves`);
    },
    [zoom, zoomPanTargets],
  );

  // F4: plain pointer hover keeps the ring, compact tag, top focus redraw and beam dwell without plan-wide dimming
  // (preventing hover strobing across dense stones). Spotlight dimming activates only on pin or keyboard focus.
  const spotlightActive = pinnedId !== null || Boolean(hot?.focus);
  const spotlightIds = spotlightActive
    ? [pinnedId, hot?.id].filter((id): id is string => id !== null && id !== undefined)
    : [];
  const resolvedDim: PlotDim | null = zoom
    ? activeLens && activeLens.kind !== "cause"
      ? { kind: "lens", lens: activeLens, cause: zoom.cause }
      : { kind: "lane", cause: zoom.cause }
    : activeLens
      ? activeLens.kind === "cause"
        ? { kind: "lane", cause: activeLens.cause }
        : { kind: "lens", lens: activeLens }
      : hoverDim
        ? hoverDim
        : spotlightIds.length > 0
          ? { kind: "spotlight", ids: spotlightIds }
          : null;

  const sceneState: PlotSceneState = {
    hotId: hot?.id ?? null,
    hotFocus: hot?.focus ?? false,
    pinnedId,
    tabId: map && nav.graves.has(tabId) ? tabId : (map?.keyboard.initialId ?? tabId),
    dim: resolvedDim,
    beamAimed: beamTargetId !== null,
    beamMoved,
    zoom: zoom
      ? {
          cause: zoom.cause,
          transform: `translate(${(zoom.camera.translate[0] + zoom.pan[0]).toFixed(1)}px, ${(zoom.camera.translate[1] + zoom.pan[1]).toFixed(1)}px) scale(${zoom.camera.zoom})`,
        }
      : null,
    flowers,
  };

  const zoomLensCount =
    zoom && activeLens && activeLens.kind !== "cause" && map
      ? map.graves.filter((g) => g.cause === zoom.cause && matchesPlotLens(g, activeLens)).length
      : null;

  const activeLensMatchCount = useMemo(() => {
    if (!activeLens) return 0;
    if (map) {
      const scopedCause = activeLens.kind === "cause" ? null : (zoom?.cause ?? null);
      return map.graves.filter((g) => (scopedCause ? g.cause === scopedCause : true) && matchesPlotLens(g, activeLens)).length;
    }
    const asOfMs = deathTime(asOf);
    const scopedCause = activeLens.kind === "cause" ? null : portraitCause;
    return rows.filter((r) => (scopedCause ? r.cause === scopedCause : true) && rowMatchesLens(r, activeLens, asOfMs)).length;
  }, [activeLens, map, zoom, asOf, portraitCause, rows]);

  const toolbar = zoom ? (
    <div className={styles.zoomBar} data-plot-zoombar>
      <button type="button" className={styles.zoomOut} onClick={zoomReset} data-plot-zoom-out>
        <span aria-hidden="true">←</span> Whole cemetery
      </button>
      <span className={`${styles.zoomChip} ${plotCauseClass(zoom.cause)}`} data-plot-zoom-chip>
        <span className={styles.sw} />
        {CAUSE_META[zoom.cause].label} <span className={styles.n}>{zoom.camera.total}</span>
        {zoomView && zoomView.shown < zoom.camera.total ? (
          <span className={styles.part}>
            {" "}
            · showing {formatZoomSpan(zoomView.span)}, {zoomView.shown} of {zoom.camera.total}
          </span>
        ) : null}
      </span>
      {zoom.camera.partial ? (
        <span className={styles.zoomNav} role="group" aria-label="Pan zoomed section" data-plot-zoom-nav>
          <button
            type="button"
            className={styles.zoomStep}
            disabled={!zoomPanTargets.prev}
            onClick={() => panZoom(-1)}
            aria-label={zoomPanTargets.prev ? `Show ${zoomPanTargets.prev.label}` : "At newest years"}
            data-plot-zoom-prev
          >
            <span aria-hidden="true">‹</span>
            {zoomPanTargets.prev ? <span className={styles.mono}>{zoomPanTargets.prev.label}</span> : null}
          </button>
          <button
            type="button"
            className={styles.zoomStep}
            disabled={!zoomPanTargets.next}
            onClick={() => panZoom(1)}
            aria-label={zoomPanTargets.next ? `Show ${zoomPanTargets.next.label}` : "At oldest years"}
            data-plot-zoom-next
          >
            {zoomPanTargets.next ? <span className={styles.mono}>{zoomPanTargets.next.label}</span> : null}
            <span aria-hidden="true">›</span>
          </button>
        </span>
      ) : null}
      {activeLens && activeLens.kind !== "cause" && zoomLensCount !== null ? (
        <button type="button" className={styles.zoomLensClear} onClick={clearLens} data-plot-lens-clear>
          {describePlotLens(activeLens)} <span className={styles.n}>{zoomLensCount}</span>
          <span aria-hidden="true">×</span>
        </button>
      ) : null}
    </div>
  ) : null;

  const cardRow = cardId ? rowById.get(cardId) : undefined;

  return (
    <section
      ref={rootRef}
      className={styles.hero}
      id="cemetery"
      aria-labelledby="cemetery-title"
      style={desktopLayoutStyle(layout)}
      data-plot-root
      data-ready={plotLayout ? "true" : undefined}
      data-zooming={zoom ? "true" : undefined}
      onPointerOver={onPointerOver}
      onPointerOut={onPointerOut}
      onPointerDown={() => {
        keyboardRef.current = false;
        pointerDownRef.current = true;
      }}
      onPointerUp={() => {
        pointerDownRef.current = false;
      }}
      onPointerCancel={() => {
        pointerDownRef.current = false;
      }}
      onClick={onClick}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
    >
      {children}
      <a className={styles.skip} href="#register">
        Skip the cemetery map
      </a>
      <div className={styles.stageWrap} data-plot-stage-wrap>
        {map ? (
          <PlotMapScene
            stageRef={registerSceneStage}
            registerGrave={registerSceneGrave}
            map={map}
            layout={layout}
            atlas={atlas}
            state={sceneState}
            interactive={plotLayout === "desktop"}
            toolbar={toolbar}
            overlay={
              <div ref={tagRef} className={styles.tag} aria-hidden="true" data-plot-tag data-on={hasTag ? "true" : undefined}>
                {tagContent}
              </div>
            }
          >
            {cardRow ? (
              <div ref={inspectorRef} className={styles.inspector} data-plot-inspector>
                <PlotMapRecordCard
                  row={cardRow}
                  editorialTitle={EDITORIAL_TITLES[cardRow.id]}
                  flowers={flowers[cardRow.id] ?? 0}
                  onLeaveFlower={() => leaveFlower(cardRow.id)}
                  onReadRegister={() => revealRecord(cardRow.id, "hero")}
                  onClose={unpin}
                  variant="inspector"
                />
              </div>
            ) : null}
            <span ref={connectorRef} className={styles.cardLeader} aria-hidden="true" hidden />
          </PlotMapScene>
        ) : null}
      </div>
      <PlotMapPortraitSlot
        rows={rows}
        asOf={asOf}
        atlas={atlas}
        aspectRatio={portraitAspectRatio}
        flowers={flowers}
        onLeaveFlower={leaveFlower}
        activeLens={activeLens}
        onClearLens={clearLens}
        controlledCause={portraitCause}
        onCauseChange={setPortraitCause}
      />
      {activeLens && !zoom ? (
        <div className={styles.lensBar} data-plot-lens-bar>
          <span className={`${styles.lensBarLabel} ${activeLens.kind === "cause" ? plotCauseClass(activeLens.cause) : ""}`}>
            {activeLens.kind === "cause" ? <span className={styles.sw} /> : null}
            Highlighting <b>{describePlotLens(activeLens)}</b>
            {plotLayout === "portrait" && portraitCause && activeLens.kind !== "cause" ? ` in ${CAUSE_META[portraitCause].label}` : ""}
            {" · "}
            <span className={styles.mono}>
              {activeLensMatchCount} of {rows.length}
            </span>
          </span>
          <button type="button" className={styles.lensBarClear} onClick={clearLens} data-plot-lens-bar-clear>
            Clear <span aria-hidden="true">×</span>
          </button>
        </div>
      ) : null}
      <p className="sr-only" role="status" aria-live="polite" data-plot-status>
        {status}
      </p>
    </section>
  );
}
