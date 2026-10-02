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
  PLOT_LAYOUT,
  buildCemeteryPlotMap,
  fitSectionCamera,
  placeInspectorCard,
  placePlotTag,
  plotBoxToFrameRect,
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
import { PlotMapScene, desktopLayoutStyle, type PlotDesktopLayout, type PlotDim, type PlotSceneState } from "./plot-map-scene";
import { PLOT_FLOWER_MAX, plotCauseClass } from "./plot-map-shapes";
import { usePlotLayout } from "./use-plot-layout";
import styles from "./plot-map.module.css";

/** A pointer must rest this long on a grave before the beam swings to it (focus aims at once). */
export const PLOT_BEAM_DWELL_MS = 180;
/** The inspector docks beside its grave at this width and up; below it sits in flow under the plan. */
const DOCKED_QUERY = "(min-width: 1280px)";
/** Top of the visible band under the sticky chrome (CSS px). */
const CHROME_TOP = PLOT_LAYOUT.chromeTop;
/** A section-zoom pan keeps the focused grave this far inside the visible band (frame px). */
const PAN_MARGIN = 40;
/** Plan labels a docked card may cover, hidden while covered: signpost plates, colossus chips and their leaders, year stamps. */
const PLOT_COVERABLE = "[data-plot-signpost], [data-plot-chip], [data-plot-leader], [data-plot-overlay] > [data-year]";
/** The scene's only motion besides the flower bloom (plan §5.4): the beam swing and the section-zoom glide. */
const PLOT_MOTION: readonly (readonly [selector: string, transition: string])[] = [
  ["[data-plot-beam] > g", "transform 460ms var(--ease)"],
  ["[data-plot-world]", "transform 600ms var(--ease)"],
];

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
  const map = useMemo<DesktopPlotMap>(() => buildCemeteryPlotMap(toPlotMapInput(rows), { asOf, preset: "desktop" }), [rows, asOf]);
  const rowById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);
  const nav = useMemo(() => {
    const graves = new Map(map.graves.map((g) => [g.id, g]));
    const place = new Map<string, { section: number; index: number }>();
    map.keyboard.sections.forEach((s, section) => s.ids.forEach((id, index) => place.set(id, { section, index })));
    const time = new Map(map.graves.map((g) => [g.id, deathTime(g.deathDate)]));
    return { graves, place, time };
  }, [map]);
  const [vbX, vbY, vbW] = map.viewBox;

  const plotLayout = usePlotLayout();
  const docked = useMediaQuery(DOCKED_QUERY);
  const reducedMotion = usePrefersReducedMotion();
  const { registerPinGrave, revealRecord, setRecordHash } = useCemeterySelection();

  const [hot, setHot] = useState<{ id: string; focus: boolean } | null>(null);
  const [hotBeamId, setHotBeamId] = useState<string | null>(null);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [tabId, setTabId] = useState(map.keyboard.initialId);
  const [hoverDim, setHoverDim] = useState<PlotDim | null>(null);
  const [zoom, setZoom] = useState<ZoomState | null>(null);
  const [flowers, setFlowers] = useState<Readonly<Record<string, number>>>({});
  const [status, setStatus] = useState("");
  /** Bumped by every pin: the layout effect then runs the pending scroll request. */
  const [pinTick, setPinTick] = useState(0);
  /** Bumped on resize: re-measure the rest aim, the tag and the card. */
  const [viewportTick, setViewportTick] = useState(0);

  const rootRef = useRef<HTMLElement>(null);
  const tagRef = useRef<HTMLDivElement>(null);
  const inspectorRef = useRef<HTMLDivElement>(null);
  const connectorRef = useRef<HTMLSpanElement>(null);
  const dwellRef = useRef<number | undefined>(undefined);
  const keyboardRef = useRef(false);
  const beamRef = useRef<{ angle: number | null; moved: boolean }>({ angle: null, moved: false });
  /** One-shot requests the next commit carries out (set by handlers, consumed by layout effects). */
  const scrollAfterPinRef = useRef<ScrollRequest | null>(null);
  const focusAfterZoomRef = useRef<string | null>(null);

  const query = useCallback(<T extends Element>(selector: string) => rootRef.current?.querySelector<T>(selector) ?? null, []);

  /** Model box (SVG units) → frame px, through the zoom camera when zoomed. */
  const frameRectOf = useCallback(
    (box: PlotBox, scale: number): PlotRect => {
      const s = zoom ? zoom.camera.zoom : 1;
      const tx = zoom ? zoom.camera.translate[0] + zoom.pan[0] : 0;
      const ty = zoom ? zoom.camera.translate[1] + zoom.pan[1] : 0;
      return plotBoxToFrameRect({ x0: s * box.x0 + tx, y0: s * box.y0 + ty, x1: s * box.x1 + tx, y1: s * box.y1 + ty }, map.viewBox, scale);
    },
    [zoom, map.viewBox],
  );

  // ------------------------------------------------------------------ hover / focus

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
      setHot({ id, focus: via === "focus" && keyboardRef.current });
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

  // ------------------------------------------------------------------ pin

  const pin = useCallback(
    (id: string, source: CemeterySelectionSource) => {
      const grave = nav.graves.get(id);
      const row = rowById.get(id);
      if (!grave || !row) return;
      if (zoom && zoom.cause !== grave.cause) setZoom(null);
      setPinnedId(id);
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
    [nav, rowById, zoom, setRecordHash, reducedMotion, docked],
  );
  const unpin = useCallback(() => {
    // closing from inside the card (× or Esc) hands focus back to the grave instead of dropping it on the page
    if (pinnedId && inspectorRef.current?.contains(document.activeElement)) document.getElementById(`grave-${pinnedId}`)?.focus({ preventScroll: true });
    setPinnedId(null);
    setStatus("");
    setRecordHash(null);
  }, [pinnedId, setRecordHash]);

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

  // ------------------------------------------------------------------ zoom

  const zoomTo = useCallback(
    (cause: CauseOfDeath) => {
      const frame = query<HTMLElement>("[data-plot-frame]");
      if (!frame?.clientWidth) return; // the desktop stage is hidden (phone layout)
      const band = visibleBand();
      const top = frame.getBoundingClientRect().top;
      // bring the frame top under the sticky chrome so the toolbar row and the whole fit are in view
      if (Math.abs(top - band.top) > 4) window.scrollBy({ top: top - band.top, behavior: "auto" });
      // the camera measures its band from the desktop chrome offset: hand it the viewport height that leaves this band
      const camera = fitSectionCamera(map, cause, { frameWidth: frame.clientWidth, viewportHeight: band.bottom - band.top + CHROME_TOP });
      if (!camera) return;
      const bottom = Math.min(frame.clientHeight, band.bottom - band.top) - PLOT_LAYOUT.zoomBottomGap;
      setZoom({ cause, camera, pan: [0, 0], band: { width: frame.clientWidth, bottom } });
      setHoverDim(null);
      setHot(null);
      if (camera.ids.length) setTabId(camera.ids[camera.ids.length - 1]);
      // keyboard zooms move focus to the toolbar (the signpost hides); a pointer zoom leaves focus alone
      if (rootRef.current?.contains(document.activeElement)) focusAfterZoomRef.current = "[data-plot-zoom-out]";
    },
    [map, query],
  );
  const zoomReset = useCallback(() => {
    if (!zoom) return;
    if (rootRef.current?.querySelector("[data-plot-zoombar]")?.contains(document.activeElement)) {
      focusAfterZoomRef.current = `[data-plot-signpost="${zoom.cause}"]`;
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
      const dy = r.top < top ? top - r.top : r.bottom > bottom ? bottom - r.bottom : 0;
      if (dx || dy) setZoom({ ...zoom, pan: [zoom.pan[0] + dx / scale, zoom.pan[1] + dy / scale] });
    },
    [nav, zoom, vbW, frameRectOf],
  );

  // ------------------------------------------------------------------ keyboard

  const moveTo = useCallback(
    (id: string) => {
      setTabId(id);
      panTo(id);
      // zoomed, the pan (not a page scroll) brings the grave into the band; the frame stays under the chrome
      document.getElementById(`grave-${id}`)?.focus({ preventScroll: zoom !== null });
    },
    [panTo, zoom],
  );

  const graveKey = useCallback(
    (event: KeyboardEvent, id: string) => {
      const at = nav.place.get(id);
      if (!at) return;
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

  const escape = useCallback((): boolean => {
    if (pinnedId) {
      unpin();
      return true;
    }
    if (zoom) {
      zoomReset();
      return true;
    }
    return false;
  }, [pinnedId, zoom, unpin, zoomReset]);

  // Esc and F also work with focus outside the hero (page body) while a grave is pinned or hovered, on the desktop plan
  // only (the phone layer's sheet owns Esc there).
  useEffect(() => {
    if (plotLayout !== "desktop" || (!pinnedId && !zoom && !hot)) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      const target = event.target as Element | null;
      if (event.defaultPrevented || rootRef.current?.contains(target)) return;
      if (target?.closest("input, textarea, select, [contenteditable], [role=dialog]")) return;
      if (event.key === "Escape" && escape()) return;
      if ((event.key === "f" || event.key === "F") && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const id = hot?.id ?? pinnedId;
        if (id) leaveFlower(id);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [plotLayout, pinnedId, zoom, hot, escape, leaveFlower]);

  // ------------------------------------------------------------------ delegated events

  // The hero root also holds the phone layer (the portrait slot, whose graves are `walk-<id>` anchors) and, through
  // React's tree, the portalled phone sheet: the desktop plan reacts only to events from its own DOM, and only while
  // it is the live layer.
  const ownsEvent = (target: EventTarget | null) =>
    plotLayout === "desktop" && target instanceof Element && !!rootRef.current?.contains(target) && !target.closest("[data-plot-portrait-slot]");
  const graveOf = (target: EventTarget | null) => (target instanceof Element ? target.closest<SVGAElement>('a[id^="grave-"]') : null);
  const signpostOf = (target: EventTarget | null) => (target instanceof Element ? target.closest<HTMLElement>("[data-plot-signpost]") : null);
  const yearOf = (target: EventTarget | null) => (target instanceof Element ? target.closest<Element>("[data-plot-year]") : null);

  const onPointerOver = (event: PointerEvent) => {
    if (!ownsEvent(event.target)) return;
    keyboardRef.current = false;
    const grave = graveOf(event.target);
    if (grave?.dataset.graveId && grave.dataset.graveId !== hot?.id) enterGrave(grave.dataset.graveId, "pointer");
    const post = signpostOf(event.target);
    if (post && !zoom) setHoverDim({ kind: "lane", cause: post.dataset.plotSignpost as CauseOfDeath });
    const year = yearOf(event.target);
    if (year && !zoom) setHoverDim({ kind: "year", year: Number(year.getAttribute("data-plot-year")) });
  };
  const onPointerOut = (event: PointerEvent) => {
    if (!ownsEvent(event.target)) return;
    const related = event.relatedTarget as Node | null;
    const grave = graveOf(event.target);
    if (grave && !grave.contains(related) && !graveOf(related) && document.activeElement !== grave) leaveGrave("pointer");
    const post = signpostOf(event.target);
    if (post && !post.contains(related) && !zoom) setHoverDim(null);
    const year = yearOf(event.target);
    if (year && !year.contains(related) && !zoom) setHoverDim(null);
  };
  const onClick = (event: MouseEvent) => {
    if (!ownsEvent(event.target)) return;
    const grave = graveOf(event.target);
    if (grave?.dataset.graveId) {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      pin(grave.dataset.graveId, "hero");
      return;
    }
    const post = signpostOf(event.target);
    if (post) {
      zoomTo(post.dataset.plotSignpost as CauseOfDeath);
      return;
    }
    if (event.target instanceof Element && event.target.closest("[data-plot-svg]")) escape();
  };
  const onFocus = (event: FocusEvent) => {
    if (!ownsEvent(event.target)) return;
    const grave = graveOf(event.target);
    if (grave?.dataset.graveId) {
      setTabId(grave.dataset.graveId);
      enterGrave(grave.dataset.graveId, "focus");
      return;
    }
    const post = signpostOf(event.target);
    if (post && !zoom) setHoverDim({ kind: "lane", cause: post.dataset.plotSignpost as CauseOfDeath });
  };
  const onBlur = (event: FocusEvent) => {
    if (!ownsEvent(event.target)) return;
    if (graveOf(event.target) && !graveOf(event.relatedTarget)) leaveGrave("focus");
    if (signpostOf(event.target) && !zoom) setHoverDim(null);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!ownsEvent(event.target)) return;
    keyboardRef.current = true;
    const grave = graveOf(event.target);
    if (event.key === "Escape") {
      if (escape()) event.preventDefault();
      return;
    }
    if (grave?.dataset.graveId) graveKey(event, grave.dataset.graveId);
  };

  // ------------------------------------------------------------------ effects: focus, scroll, beam, tag, card

  // A zoom change moves focus where its handler asked (toolbar after a keyboard zoom, signpost after leaving it).
  useLayoutEffect(() => {
    const selector = focusAfterZoomRef.current;
    focusAfterZoomRef.current = null;
    if (selector) query<HTMLElement>(selector)?.focus();
  }, [zoom, query]);

  // A resize re-measures the rest aim, the tag and the card, and refits an open section zoom to the new frame.
  useEffect(() => {
    const onResize = () => {
      setViewportTick((n) => n + 1);
      setZoom((current) => {
        const frame = rootRef.current?.querySelector<HTMLElement>("[data-plot-frame]");
        if (!current || !frame?.clientWidth) return current;
        const band = visibleBand();
        const camera = fitSectionCamera(map, current.cause, { frameWidth: frame.clientWidth, viewportHeight: band.bottom - band.top + CHROME_TOP });
        const bottom = Math.min(frame.clientHeight, band.bottom - band.top) - PLOT_LAYOUT.zoomBottomGap;
        return camera ? { ...current, camera, pan: [0, 0], band: { width: frame.clientWidth, bottom } } : null;
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [map]);

  // A pin brings its grave into the band below the sticky chrome (docked) or its card into view (in flow).
  useLayoutEffect(() => {
    const request = scrollAfterPinRef.current;
    scrollAfterPinRef.current = null;
    const frame = query<HTMLElement>("[data-plot-frame]");
    const g = request ? nav.graves.get(request.id) : undefined;
    if (!request || !frame || !g) return;
    if (request.focus) document.getElementById(`grave-${g.id}`)?.focus({ preventScroll: true });
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

  // Motion: the beam swing and the zoom glide are transitions on SVG elements, which the app's global reset
  // `svg * { transition: none !important }` cancels from any stylesheet; only an inline `!important` outranks it.
  // Reduced motion (`usePrefersReducedMotion`, honouring the `data-motion` override) adds none: the beam jumps and
  // the zoom cuts.
  useLayoutEffect(() => {
    for (const [selector, transition] of PLOT_MOTION) {
      const el = query<SVGElement>(selector);
      if (!el) continue;
      if (reducedMotion) el.style.removeProperty("transition");
      else el.style.setProperty("transition", transition, "important");
    }
  }, [reducedMotion, query]);

  // Beam: aims at the pinned grave, else the hot one (after the dwell); rests on the `113` otherwise. The first rest
  // pose is the CSS band's (no script); once moved, the rest is measured so the beam ends 12 px right of the digits.
  const beamTargetId = pinnedId ?? hotBeamId;
  useLayoutEffect(() => {
    const rot = query<SVGGElement>("[data-plot-beam] > g");
    const frame = query<HTMLElement>("[data-plot-frame]");
    if (!rot || !frame || !frame.clientWidth) return;
    const g = beamTargetId ? nav.graves.get(beamTargetId) : undefined;
    let target: [number, number] | null = g ? [g.screen.medal.x, g.screen.medal.y] : null;
    if (!target && beamRef.current.moved) {
      const digits = query<HTMLElement>("[data-plot-figure-value]")?.getBoundingClientRect();
      const fr = frame.getBoundingClientRect();
      const scale = fr.width / vbW;
      if (digits?.width) target = [vbX + (digits.right - fr.left + 12) / scale, vbY + (digits.top + digits.height * 0.55 - fr.top) / scale];
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
    beamRef.current = { angle, moved: true };
    rot.style.setProperty("--ba", `${angle.toFixed(2)}deg`);
    rot.style.setProperty("--bs", (Math.hypot(target[0] - ox, target[1] - oy) / 1000).toFixed(4));
  }, [beamTargetId, viewportTick, query, nav, map.beamOrigin, vbX, vbY, vbW]);

  // Tag: the hot grave's "symbol · date · peak", or the highlighted year's count over its cypress. The card (docked
  // preview or pin at ≥ 1280 px, the in-flow pin below, which the pin scrolls to) says all of it for the grave it
  // shows, so that grave gets no tag.
  const cardId = pinnedId ?? (docked && hot ? hot.id : null);
  const hotRow = hot && cardId !== hot.id ? rowById.get(hot.id) : undefined;
  const cypress = hoverDim?.kind === "year" ? map.cypress.find((c) => c.year === hoverDim.year) : undefined;
  const tagText = hotRow
    ? `${hotRow.symbol} · ${formatRegisterDeathDate(hotRow.deathDate)} · ${hotRow.peak === null ? "peak not recorded" : formatCemeteryPeak(hotRow.peak)}`
    : cypress
      ? `${cypress.year} · ${cypress.count} ${cypress.count === 1 ? "death" : "deaths"}`
      : null;

  // Inspector: docked beside its grave (≥ 1280 px), clamped to the band below the chrome, clear of the Feedback
  // button, of the route head and the `113` figure (of the zoom toolbar while zoomed), and never over the colossi
  // (BUSD's mausoleum, UST's column) while an ordinary grave is read. A colossus's own card may overlap the other
  // colossus (the v2 placement the owner accepted): squeezing the most-read obituaries into the gaps left beside them
  // would cut them short. Signpost plates, colossus chips and year stamps stay uncovered where a spot holds the whole
  // card; any label the card still covers hides with its leader (`data-covered`), so no label shows cut in half.
  const placeCard = useCallback(() => {
    const insp = inspectorRef.current;
    const connector = connectorRef.current;
    const labels = [...(rootRef.current?.querySelectorAll<HTMLElement>(PLOT_COVERABLE) ?? [])];
    if (!connector) return;
    const stage = query<HTMLElement>("[data-plot-stage]");
    const frame = query<HTMLElement>("[data-plot-frame]");
    const g = cardId ? nav.graves.get(cardId) : undefined;
    if (!insp || !docked || !stage || !frame || !g || getComputedStyle(insp).position !== "absolute") {
      insp?.style.removeProperty("left");
      insp?.style.removeProperty("top");
      insp?.style.removeProperty("max-height");
      connector.hidden = true;
      for (const el of labels) el.removeAttribute("data-covered");
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
    const colossi = map.colossi.some((c) => c.id === g.id)
      ? []
      : map.colossi.flatMap((c) => {
          const box = map.obstacles.find((o) => o.key === `grave:${c.id}`);
          return box ? [toViewport(box)] : [];
        });
    const text = [...(rootRef.current?.querySelectorAll(zoom ? "[data-plot-zoombar]" : "[data-plot-head], [data-plot-figure]") ?? [])].map((el) => el.getBoundingClientRect());
    // labels hide while zoomed; chips below 1024 px have no box
    const soft = zoom ? [] : labels.filter((el) => el.getClientRects().length > 0 && !el.hasAttribute("data-plot-leader")).map((el) => el.getBoundingClientRect());
    insp.style.removeProperty("max-height");
    const p = placeInspectorCard({
      stone: toViewport(g.screen.box),
      frame: fr,
      medal: [medal.left, medal.top],
      card: { width: insp.offsetWidth, height: insp.scrollHeight },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      avoid: [...colossi, ...text],
      soft,
    });
    insp.style.left = `${p.x - sr.left}px`;
    insp.style.top = `${p.y - sr.top}px`;
    insp.style.maxHeight = `${p.maxHeight}px`;
    drawLine(connector, p.connector.x1 - sr.left, p.connector.y1 - sr.top, p.connector.x2 - sr.left, p.connector.y2 - sr.top);
    connector.hidden = false;
    const card = { left: p.x, top: p.y, right: p.x + insp.offsetWidth, bottom: p.y + p.maxHeight };
    const under = labels.map((el) => {
      const r = el.getBoundingClientRect();
      return !zoom && r.width + r.height > 0 && r.left < card.right && r.right > card.left && r.top < card.bottom && r.bottom > card.top;
    });
    const covered = new Set(labels.flatMap((el, k) => (under[k] && el.dataset.plotChip ? [el.dataset.plotChip] : [])));
    // a chip's leader goes with its chip, and also hides wherever the card would cut it
    labels.forEach((el, k) => el.toggleAttribute("data-covered", under[k] || covered.has(el.dataset.plotLeader ?? "")));
  }, [cardId, docked, zoom, query, nav, map, frameRectOf, vbW]);

  // re-place whenever the card's content can change height: preview → pinned, a flower count, a resize
  useLayoutEffect(() => {
    placeCard();
  }, [placeCard, pinnedId, flowers, viewportTick]);

  useLayoutEffect(() => {
    const tag = tagRef.current;
    const frame = query<HTMLElement>("[data-plot-frame]");
    if (!tag || !frame || !tagText) return;
    const fr = frame.getBoundingClientRect();
    const scale = fr.width / vbW;
    const size = { width: tag.offsetWidth, height: tag.offsetHeight };
    if (hot) {
      const g = nav.graves.get(hot.id);
      if (!g) return;
      const within = (el: Element): PlotRect => {
        const r = el.getBoundingClientRect();
        return { left: r.left - fr.left, top: r.top - fr.top, right: r.right - fr.left, bottom: r.bottom - fr.top };
      };
      const obstacles = [
        ...(rootRef.current?.querySelectorAll("[data-plot-signpost], [data-plot-chip], [data-plot-leader], [data-plot-figure], [data-plot-zoombar], [data-plot-inspector]") ?? []),
      ]
        .filter((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden")
        .map(within);
      // never under the sticky chrome when the frame top is scrolled beneath it; a tag with no clear spot stays out
      // (the ring, the colour logo and the beam still mark the grave) rather than cover a label
      const p = placePlotTag({ stone: frameRectOf(g.screen.box, scale), tag: size, frame: { width: fr.width, height: fr.height }, obstacles, top: CHROME_TOP - fr.top });
      tag.style.left = `${p.x}px`;
      tag.style.top = `${p.y}px`;
      tag.toggleAttribute("data-blocked", p.collisions !== 0);
    } else if (cypress) {
      tag.style.left = `${(cypress.top[0] - vbX) * scale - size.width / 2}px`;
      tag.style.top = `${(cypress.top[1] - vbY) * scale - size.height - 6}px`;
      tag.removeAttribute("data-blocked");
    }
  }, [tagText, hot, cypress, cardId, pinnedId, viewportTick, query, nav, frameRectOf, vbX, vbY, vbW]);

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

  // ------------------------------------------------------------------ render

  // What the zoom chip states: the camera's framed years and graves; after ←/→ panned a partial view, the section's
  // graves wholly inside the visible band.
  const zoomView = useMemo(() => {
    if (!zoom) return null;
    const { camera, pan, band } = zoom;
    if (pan[0] === 0 && pan[1] === 0) return { shown: camera.shown, span: camera.span };
    const scale = band.width / vbW;
    const years = map.keyboard.sections
      .flatMap((s) => (s.cause === zoom.cause ? s.ids : []))
      .flatMap((id) => {
        const g = nav.graves.get(id);
        if (!g) return [];
        const r = frameRectOf(g.screen.box, scale);
        return r.left >= 0 && r.right <= band.width && r.top >= PLOT_LAYOUT.zoomBar && r.bottom <= band.bottom ? [g.year] : [];
      });
    return years.length ? { shown: years.length, span: [Math.min(...years), Math.max(...years)] as const } : { shown: camera.shown, span: camera.span };
  }, [zoom, map, nav, frameRectOf, vbW]);

  const sceneState: PlotSceneState = {
    hotId: hot?.id ?? null,
    hotFocus: hot?.focus ?? false,
    pinnedId,
    tabId,
    dim: zoom ? { kind: "lane", cause: zoom.cause } : hoverDim,
    beamAimed: beamTargetId !== null,
    zoom: zoom
      ? {
          cause: zoom.cause,
          transform: `translate(${(zoom.camera.translate[0] + zoom.pan[0]).toFixed(1)}px, ${(zoom.camera.translate[1] + zoom.pan[1]).toFixed(1)}px) scale(${zoom.camera.zoom})`,
        }
      : null,
    flowers,
  };

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
            · showing {zoomView.span[0] === zoomView.span[1] ? zoomView.span[0] : `${zoomView.span[0]}–${zoomView.span[1]}`}, {zoomView.shown} of {zoom.camera.total} (← → keys
            reach the rest)
          </span>
        ) : null}
      </span>
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
      <PlotMapScene
        map={map}
        layout={layout}
        atlas={atlas}
        state={sceneState}
        toolbar={toolbar}
        overlay={
          <div ref={tagRef} className={styles.tag} aria-hidden="true" data-plot-tag data-on={tagText ? "true" : undefined}>
            {tagText}
          </div>
        }
      >
        {cardRow ? (
          <div ref={inspectorRef} className={styles.inspector} data-plot-inspector data-preview={pinnedId ? undefined : "true"}>
            <PlotMapRecordCard
              row={cardRow}
              editorialTitle={EDITORIAL_TITLES[cardRow.id]}
              flowers={flowers[cardRow.id] ?? 0}
              onLeaveFlower={() => leaveFlower(cardRow.id)}
              onReadRegister={() => revealRecord(cardRow.id, "hero")}
              onClose={unpin}
              variant="inspector"
              preview={!pinnedId}
            />
          </div>
        ) : null}
        <span ref={connectorRef} className={styles.cardLeader} aria-hidden="true" hidden />
      </PlotMapScene>
      <PlotMapPortraitSlot rows={rows} asOf={asOf} atlas={atlas} aspectRatio={portraitAspectRatio} flowers={flowers} onLeaveFlower={leaveFlower} />
      <p className="sr-only" role="status" aria-live="polite" data-plot-status>
        {status}
      </p>
    </section>
  );
}
