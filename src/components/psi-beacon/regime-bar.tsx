"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown, X } from "lucide-react";
import { useStabilityIndex } from "@/hooks/api-hooks";
import { PSI_HEX_COLORS, PSI_UNKNOWN_BAND_HEX, isConditionBand } from "@shared/lib/classification/psi";
import { bucketUnixSecondsToUtcDay } from "@shared/lib/time-buckets";
import { getDisplayedPsi, getDisplayedPsiBasis, getPsiBandStreak } from "@shared/lib/psi-view-model";
import { cn } from "@/lib/utils";
import { dismissChromeOverlays, subscribeChromeDismiss } from "@/lib/chrome-popover";
import { getRouteCapabilities } from "@/lib/route-capabilities";
import { formatDataHealthTimestamp } from "@/lib/data-health";
import { usePsiBeaconState } from "@/hooks/use-psi-beacon-state";
import { PsiBeaconMicro } from "@/components/psi-beacon/psi-beacon-micro";

const BAND_STRIP_WINDOW_DAYS = 30;
type StabilityIndexLightData = {
  current?: Parameters<typeof getDisplayedPsi>[0];
  history?: Array<{ date: number; band: string; score: number }>;
};

export function buildBandStripCells(
  history: ReadonlyArray<{ date: number; band: string }> | undefined,
  computedAt: number,
): Array<{ date: number; band: string } | null> {
  if (!history?.length) return Array.from({ length: BAND_STRIP_WINDOW_DAYS }, () => null);
  const todayMidnight = bucketUnixSecondsToUtcDay(computedAt);
  const oldestDay = todayMidnight - BAND_STRIP_WINDOW_DAYS * 86_400;
  const byDay = new Map(
    history
      .filter((point) => point.date >= oldestDay && point.date < todayMidnight)
      .map((point) => [point.date, point]),
  );
  return Array.from({ length: BAND_STRIP_WINDOW_DAYS }, (_, index) => {
    const date = oldestDay + index * 86_400;
    const point = byDay.get(date);
    return point ? { date, band: point.band } : null;
  });
}

// The line and its header toggle (TopNav at lg+, Header below) live in
// different subtrees, so the disclosure state is a tiny module store.
let regimeExpanded = false;
const regimeListeners = new Set<() => void>();
function subscribeRegime(listener: () => void) {
  regimeListeners.add(listener);
  return () => {
    regimeListeners.delete(listener);
  };
}
function setRegimeExpanded(next: boolean) {
  if (regimeExpanded === next) return;
  if (next) dismissChromeOverlays("regime-bar");
  regimeExpanded = next;
  regimeListeners.forEach((listener) => listener());
}
const getRegimeExpanded = () => regimeExpanded;
const getRegimeExpandedServer = () => false;
function useRegimeExpanded() {
  return useSyncExternalStore(subscribeRegime, getRegimeExpanded, getRegimeExpandedServer);
}

const REGIME_PANEL_ID = "regime-bar-panel";

/** Collapses the panel, returning focus to the visible header toggle when it was inside. */
function closeRegimePanel() {
  const panel = document.getElementById(REGIME_PANEL_ID);
  const focusWasInside = panel?.contains(document.activeElement) ?? false;
  setRegimeExpanded(false);
  if (!focusWasInside) return;
  const toggle = Array.from(document.querySelectorAll<HTMLElement>(`[aria-controls="${REGIME_PANEL_ID}"]`))
    .find((element) => element.offsetParent !== null);
  toggle?.focus();
}

function sentenceCaseBand(band: string): string {
  return band.charAt(0) + band.slice(1).toLowerCase();
}

function formatComponent(value: number | null | undefined, signed = false): string {
  if (value == null) return "n/a";
  return `${signed && value > 0 ? "+" : ""}${value.toFixed(1)}`;
}

function useRegimeState() {
  const psiQuery = useStabilityIndex();
  const lightData = psiQuery.data as StabilityIndexLightData | undefined;
  const current = lightData?.current;
  const beacon = usePsiBeaconState({
    current,
    meta: psiQuery.meta,
    dataUpdatedAt: psiQuery.dataUpdatedAt,
    error: psiQuery.error,
  });
  if (!current || !beacon.health) {
    return { model: null, isPending: Boolean(psiQuery.isPending) };
  }

  const displayedPsi = getDisplayedPsi(current);
  const band = displayedPsi.band;
  const { isCurrent } = beacon;
  return {
    isPending: false,
    model: {
      current,
      history: lightData?.history,
      band,
      score: displayedPsi.score,
      displayBasis: getDisplayedPsiBasis(current),
      isCurrent,
      asOfLabel: formatDataHealthTimestamp(current.computedAt * 1000, "en-US", "UTC"),
      // Legacy rows and unvalidated caches can carry a band outside the closed vocabulary.
      color: isCurrent && isConditionBand(band) ? PSI_HEX_COLORS[band] : PSI_UNKNOWN_BAND_HEX,
      isElevated: isCurrent && (band === "FRACTURE" || band === "CRISIS" || band === "MELTDOWN"),
      // Dark text on the neutral fallback and green/teal bands (white fails contrast).
      useDarkText: !isCurrent || band === "BEDROCK" || band === "STEADY",
    },
  };
}

type RegimeModel = NonNullable<ReturnType<typeof useRegimeState>["model"]>;

function regimeLabel(model: RegimeModel): string {
  // One PSI precision everywhere: the same one-decimal reading the pages print.
  const reading = `${sentenceCaseBand(model.band)}, PSI ${model.score.toFixed(1)}, ${model.displayBasis}`;
  return model.isCurrent
    ? `Market regime: ${reading}`
    // Global chrome carries no data-health state words (docs/homepage.md#data-health): a neutral date only.
    : `Market regime as of ${model.asOfLabel}: ${reading}`;
}

/**
 * Persistent 3px line at the top of every page, colored by the current PSI
 * band. The line is decorative: as a 3px full-width button it failed target
 * size and took the first tab stop, so the details disclosure is
 * `RegimeBarToggle` in the header. Line and panel sit on the `z-regime`
 * layer, below dialogs and sheets (`z-modal`).
 */
export function RegimeBar() {
  const { model } = useRegimeState();
  const expanded = useRegimeExpanded();
  const pathname = usePathname();

  const closeRef = useRef<HTMLButtonElement>(null);

  // Close the regime panel on navigation, cross-overlay dismissal, outside click, Escape, or its close button.
  useEffect(() => {
    setRegimeExpanded(false);
  }, [pathname]);

  useEffect(() => subscribeChromeDismiss("regime-bar", () => setRegimeExpanded(false)), []);

  useEffect(() => {
    if (!expanded) return;
    // Opened from the keyboard: move focus into the panel so Escape and Tab work predictably.
    if (document.activeElement?.getAttribute("aria-controls") === REGIME_PANEL_ID) closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      closeRegimePanel();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(`#${REGIME_PANEL_ID}`)) return;
      if (target.closest(`[aria-controls="${REGIME_PANEL_ID}"]`)) return;
      setRegimeExpanded(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [expanded]);

  if (!model) {
    return (
      <div
        className="fixed left-0 right-0 top-0 z-regime h-[3px] max-w-[100vw] bg-border/60"
        aria-hidden="true"
      />
    );
  }

  const { current, band, score, displayBasis, isCurrent, asOfLabel, color, isElevated, useDarkText } = model;
  const components = current.components;
  const daysInBand = model.history?.length
    ? getPsiBandStreak(model.history, current.computedAt, band)
    : null;
  // 30-day band history strip (oldest -> newest). Empty cells until history hydrates.
  const bandStripCells = buildBandStripCells(model.history, current.computedAt);
  const separator = <span className={useDarkText ? "text-black/60" : "text-white/70"} aria-hidden="true">·</span>;
  const lineTitle = `Market regime: the line's color tracks the Pharos Stability Index (PSI) band, ${
    isCurrent ? `currently ${sentenceCaseBand(band)}` : `as of ${asOfLabel}`
  }.`;

  return (
    <>
      <div
        className={cn(
          "fixed left-0 right-0 top-0 z-regime h-[3px] max-w-[100vw]",
          "transition-[background-color] duration-[600ms] ease-out",
          isElevated && "animate-[pharos-regime-pulse_1.5s_ease-in-out_infinite]",
        )}
        style={{ backgroundColor: color }}
        title={lineTitle}
        aria-hidden="true"
      />
      <div
        className={cn(
          "fixed left-0 right-0 top-[var(--sticky-header-bottom,3.75rem)] z-regime max-w-[100vw] overflow-hidden",
          "transition-[background-color] duration-[600ms] ease-out",
          !expanded && "pointer-events-none",
          expanded && "border-b border-black/15 shadow-sm",
        )}
        style={{ backgroundColor: color }}
      >
        {/* grid-template-rows animates the expand/collapse (height:auto can't transition). */}
        <div
          id={REGIME_PANEL_ID}
          role="region"
          aria-label={regimeLabel(model)}
          inert={!expanded}
          className={cn(
            "grid motion-reduce:transition-none",
            expanded
              ? "visible [transition:grid-template-rows_200ms_ease-out,visibility_0ms_linear_0ms]"
              : "invisible [transition:grid-template-rows_200ms_ease-out,visibility_0ms_linear_200ms]",
          )}
          style={{ gridTemplateRows: expanded ? "1fr" : "0fr" }}
        >
          <div className="min-h-0 overflow-hidden">
            <div className={cn(
              "flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4 pt-2 pb-1.5 text-xs leading-snug",
              useDarkText ? "text-black/90" : "text-white/90",
            )}>
              {!isCurrent && <span>As of {asOfLabel}</span>}
              <span className="inline-flex items-center gap-1.5">
                <PsiBeaconMicro score={score} retained={!isCurrent} />
                <span className="font-semibold">{sentenceCaseBand(band)}</span>
                {isCurrent && daysInBand ? <span>for {daysInBand} {daysInBand === 1 ? "day" : "days"}</span> : null}
              </span>
              {separator}
              <span>PSI <span className="font-mono tabular-nums">{score.toFixed(1)}</span> ({displayBasis})</span>
              {separator}
              <span>
                Severity <span className="font-mono tabular-nums">{formatComponent(components?.severity)}</span>
                {" · "}Breadth <span className="font-mono tabular-nums">{formatComponent(components?.breadth)}</span>
                {" · "}Stress breadth <span className="font-mono tabular-nums">{formatComponent(components?.stressBreadth)}</span>
                {" · "}Trend <span className="font-mono tabular-nums">{formatComponent(components?.trend, true)}</span>
              </span>
              {separator}
              <Link
                href="/stability-index/"
                prefetch={false}
                onClick={() => setRegimeExpanded(false)}
                className={cn(
                  "pharos-focus-ring inline-flex min-h-11 cursor-pointer items-center gap-1 rounded-md px-2 font-medium whitespace-nowrap underline-offset-2 hover:underline lg:min-h-0 lg:px-1.5 lg:py-0.5",
                  useDarkText ? "text-black hover:bg-black/10" : "text-white hover:bg-white/15",
                )}
              >
                Open Stability Index{"\u00a0\u2192"}
              </Link>
              <button
                ref={closeRef}
                type="button"
                onClick={closeRegimePanel}
                aria-label="Close market regime details"
                className={cn(
                  "pharos-focus-ring inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors lg:size-9",
                  useDarkText ? "hover:bg-black/10" : "hover:bg-white/15",
                )}
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>
            <div className="mx-auto mb-2 flex max-w-3xl items-center gap-2 px-4">
              <div
                className="flex h-[4px] flex-1 gap-[1px] overflow-hidden rounded-xs"
                role="img"
                aria-label="Last 30 days of PSI band classifications"
              >
                {bandStripCells.map((cell, i) => {
                  const fill = cell
                    ? (isConditionBand(cell.band) ? PSI_HEX_COLORS[cell.band] : PSI_UNKNOWN_BAND_HEX)
                    : null;
                  const title = cell
                    ? `${new Date(cell.date * 1000).toISOString().slice(0, 10)} · ${sentenceCaseBand(cell.band)}`
                    : "no data";
                  return (
                    <span
                      key={i}
                      className="flex-1"
                      style={{
                        backgroundColor: fill ?? "rgba(255,255,255,0.18)",
                        opacity: fill ? 1 : 0.6,
                      }}
                      title={title}
                    />
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * Labelled disclosure for the regime details, placed in the header because
 * the line itself is decorative. Renders nothing on home; holds a matching
 * width reserve while PSI loads so the navbar never jitters horizontally.
 */
export function RegimeBarToggle({ className }: { className?: string }) {
  const { model, isPending } = useRegimeState();
  const expanded = useRegimeExpanded();
  const pathname = usePathname();
  if (getRouteCapabilities(pathname).home) return null;

  if (!model) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex h-9 min-w-[6rem] shrink-0 items-center justify-center gap-1.5 rounded-full border border-border/50 bg-muted/15 px-2",
          className,
        )}
      >
        <span
          className={cn(
            "size-2 shrink-0 rounded-full bg-border/80",
            isPending && "animate-pulse motion-reduce:animate-none",
          )}
        />
        <span
          className={cn(
            "h-2.5 w-11 rounded-sm bg-border/60",
            isPending && "animate-pulse motion-reduce:animate-none",
          )}
        />
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setRegimeExpanded(!expanded)}
      aria-expanded={expanded}
      aria-controls={REGIME_PANEL_ID}
      aria-label={`${regimeLabel(model)}. Market regime details`}
      title="Market regime: Pharos Stability Index"
      className={cn(
        "pharos-focus-ring inline-flex h-9 min-w-[6rem] shrink-0 cursor-pointer items-center justify-center gap-1 rounded-full border border-border/70 bg-muted/20 px-2 text-xs text-muted-foreground transition-colors hover:border-border hover:bg-muted/40 hover:text-foreground",
        expanded && "border-border bg-muted/50 text-foreground",
        className,
      )}
    >
      <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: model.color }} aria-hidden="true" />
      <span aria-hidden="true" className="whitespace-nowrap">
        PSI <span className="font-mono tabular-nums text-foreground">{model.score.toFixed(1)}</span>
      </span>
      <ChevronDown
        className={cn("size-3 shrink-0 opacity-60 transition-transform duration-200", expanded && "rotate-180")}
        aria-hidden="true"
      />
    </button>
  );
}
