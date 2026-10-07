import { Fragment } from "react";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import { cn } from "@/lib/utils";

/**
 * Collateral coverage band of a ratio in percent, on the collateralization
 * chip's cutoffs: within ±0.5 pp of par reads as par.
 */
export type CollateralCoverageTone = "over" | "par" | "under";

export function getCollateralCoverageTone(valuePct: number): CollateralCoverageTone {
  if (valuePct >= 100.5) return "over";
  if (valuePct >= 99.5) return "par";
  return "under";
}

// Under-collateralized takes the rail's rose "structurally short" slot, the
// same tone as the collateralization chip, never the red `alert` step.
const COVERAGE_FILL_CLASS: Record<CollateralCoverageTone, string> = {
  over: SEVERITY_TONE_CLASS.ok.bar,
  par: SEVERITY_TONE_CLASS.ok.bar,
  under: SEVERITY_TONE_CLASS.rose.bar,
};

const COVERAGE_TEXT_CLASS: Record<CollateralCoverageTone, string> = {
  over: "text-foreground",
  par: "text-foreground",
  under: SEVERITY_TONE_CLASS.rose.text,
};

const CLAMP_HIGH_ARROW_CLASS: Record<CollateralCoverageTone, string> = {
  over: "border-y-4 border-l-[5px] border-y-transparent border-l-emerald-500",
  par: "border-y-4 border-l-[5px] border-y-transparent border-l-emerald-500",
  under: "border-y-4 border-l-[5px] border-y-transparent border-l-rose-500",
};

const CLAMP_LOW_ARROW_CLASS = "border-y-4 border-r-[5px] border-y-transparent border-r-rose-500";

/**
 * The empty track. `bg-muted` sits within a few luminance steps of the dark
 * card and vanished there; a foreground tint reads in both themes.
 */
const TRACK_CLASS = "bg-foreground/10";

/** Default figure format, matching the collateralization headline (`1,234%`, `279.2%`, `110%`). */
function formatGaugePct(pct: number): string {
  if (Math.abs(pct) >= 1000) return `${Math.round(pct).toLocaleString("en-US")}%`;
  const fixed = pct.toFixed(1);
  return `${fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed}%`;
}

export interface ThresholdGaugeDomain {
  /** Left end of the track, in percent; must be > 0 and below par. */
  minPct: number;
  /** Right end of the track, in percent; values beyond it clamp with an overflow arrow. */
  maxPct: number;
}

/**
 * 50 % → 1,000 % on a log axis puts par at ~23 % of the track and keeps
 * 100–1,000 % legible: MCR 110 % ≈ 26 %, BOLD 279 % ≈ 57 %, ZSD 420 % ≈ 71 %,
 * LUSD 745 % ≈ 90 %.
 */
const THRESHOLD_GAUGE_DEFAULT_DOMAIN: ThresholdGaugeDomain = { minPct: 50, maxPct: 1000 };

/**
 * Tighter tracks for ratios that sit near par, tried in order before the
 * default. On the 50–1,000 % track 100 % and 103 % land 0.9 pp apart and
 * read as the same knob; on 90–125 % they sit ~9 pp apart (par ≈ 32 %,
 * 103 % ≈ 41 %). 75–200 % carries a 110 % MCR and a 150 % shutdown beside
 * a ratio up to ~190 % (par ≈ 29 %).
 */
const THRESHOLD_GAUGE_DOMAIN_LADDER: readonly ThresholdGaugeDomain[] = [
  { minPct: 90, maxPct: 125 },
  { minPct: 75, maxPct: 200 },
];

/** A mark nearer a track end than this (in % of the track) widens the domain. */
const DOMAIN_EDGE_CLEARANCE = 5;

function resolveDomain(domain: ThresholdGaugeDomain | undefined): ThresholdGaugeDomain {
  if (
    domain
    && Number.isFinite(domain.minPct)
    && Number.isFinite(domain.maxPct)
    && domain.minPct > 0
    && domain.maxPct > domain.minPct
  ) {
    return domain;
  }
  return THRESHOLD_GAUGE_DEFAULT_DOMAIN;
}

export interface ThresholdGaugePosition {
  /** Offset along the track, 0–100. */
  left: number;
  /** Which end the value was clamped to, when it falls outside the domain. */
  clamped: "low" | "high" | null;
}

/** Position of a percent value on the clamped log track. */
export function thresholdGaugePosition(
  pct: number,
  domain: ThresholdGaugeDomain = THRESHOLD_GAUGE_DEFAULT_DOMAIN,
): ThresholdGaugePosition {
  const { minPct, maxPct } = resolveDomain(domain);
  if (pct <= minPct) return { left: 0, clamped: pct < minPct ? "low" : null };
  if (pct >= maxPct) return { left: 100, clamped: pct > maxPct ? "high" : null };
  const left = ((Math.log(pct) - Math.log(minPct)) / (Math.log(maxPct) - Math.log(minPct))) * 100;
  return { left: Math.round(left * 100) / 100, clamped: null };
}

/**
 * The tightest track that keeps every mark (the ratio, par and any reviewed
 * marker) unclamped and clear of both ends; the 50–1,000 % default otherwise.
 * The scale ends are always labelled, so a zoomed track never passes for the
 * default one.
 */
export function resolveThresholdGaugeDomain(marksPct: readonly number[]): ThresholdGaugeDomain {
  const marks = marksPct.filter((pct) => Number.isFinite(pct));
  const fits = (domain: ThresholdGaugeDomain) =>
    marks.every((pct) => {
      const { left, clamped } = thresholdGaugePosition(pct, domain);
      return clamped === null && left >= DOMAIN_EDGE_CLEARANCE && left <= 100 - DOMAIN_EDGE_CLEARANCE;
    });
  return THRESHOLD_GAUGE_DOMAIN_LADDER.find(fits) ?? THRESHOLD_GAUGE_DEFAULT_DOMAIN;
}

export interface ThresholdGaugeMarker {
  /** Marker position in percent (110 = 110 %). */
  pct: number;
  /** Short name drawn before the figure ("MCR", "Shutdown"). */
  label: string;
}

export interface ThresholdGaugeProps {
  /** Collateral ratio in percent (279.2 = 279.2 %); `null` when unavailable. */
  valuePct: number | null;
  /** Names the measure and its basis ("Collateral ratio vs supply"); the gauge appends what it draws. */
  ariaLabel: string;
  /** Minimum collateral ratio (liquidation line); draw only when reviewed. */
  threshold?: ThresholdGaugeMarker | null;
  /** Shutdown / critical collateral ratio; draw only when reviewed. */
  shutdown?: ThresholdGaugeMarker | null;
  formatValue?: (pct: number) => string;
  /** Fixed track; omitted, the gauge picks the tightest fitting one (`resolveThresholdGaugeDomain`). */
  domain?: ThresholdGaugeDomain;
  /** Repeat the value under its knob; switch off when a headline sits directly above. */
  showValueLabel?: boolean;
  unavailableLabel?: string;
  className?: string;
}

type GaugeMarkerKind = "par" | "threshold" | "shutdown";
type GaugeLabelKind = "value" | "unavailable" | "scale-min" | "scale-max" | "markers";

interface GaugeLabelMarker {
  kind: GaugeMarkerKind;
  pct: number;
  label: string;
}

interface GaugeLabelItem {
  kind: GaugeLabelKind;
  /** Where the label hangs from, in % of the track. */
  left: number;
  /** Roughly the label's visual centre, which lane spacing measures from. */
  spacingLeft: number;
  /** Minimum centre distance to any other label sharing its lane. */
  gap: number;
  anchorClass: string;
  /** The marker cluster a `markers` label names, in track order. */
  markers: readonly GaugeLabelMarker[];
}

interface GaugeLabel extends GaugeLabelItem {
  lane: number;
}

const PAR_PCT = 100;
/** Minimum horizontal distance, in % of the track, between label centres sharing a lane. */
const LABEL_GAP = 20;
/**
 * Markers closer than this (in % of the track, ~24 px on the ~300 px rail
 * track) share one label ("Par 100% · MCR 110%"): two labels stacked under
 * ticks a few pixels apart read as one tangle, and neither names its tick.
 */
const MARKER_MERGE_GAP = 8;
/** A merged label is about three single labels wide; it hangs from its outer tick. */
const MERGED_LABEL_HALF_WIDTH = 15;
const MERGED_LABEL_GAP = 32;
/**
 * Scale-end labels hang inward from the track ends rather than centring on
 * them, so lane spacing measures from roughly their centres instead.
 */
const SCALE_LABEL_INSET = 5;
const MAX_LABEL_LANES = 3;
const LANE_HEIGHT_PX = 14;
const LANE_HEIGHT_CLASS = ["h-[14px]", "h-[28px]", "h-[42px]"] as const;

const TICK_CLASS: Record<GaugeMarkerKind, string> = {
  par: "w-px bg-foreground/60",
  threshold: "w-0.5 rounded-full bg-foreground/85",
  shutdown: "w-0 border-l border-dashed border-foreground/85",
};

/** Greedy lanes: the first lane with room, else the least-crowded one. */
function assignLanes(items: readonly GaugeLabelItem[]): GaugeLabel[] {
  const lanes: { spacingLeft: number; gap: number }[][] = [];
  return items.map((item) => {
    let lane = lanes.findIndex((occupied) =>
      occupied.every((other) => Math.abs(other.spacingLeft - item.spacingLeft) >= Math.max(other.gap, item.gap)),
    );
    if (lane === -1) {
      if (lanes.length < MAX_LABEL_LANES) {
        lane = lanes.length;
        lanes.push([]);
      } else {
        const distances = lanes.map((occupied) =>
          Math.min(...occupied.map((other) => Math.abs(other.spacingLeft - item.spacingLeft))),
        );
        lane = distances.indexOf(Math.max(...distances));
      }
    }
    lanes[lane]!.push({ spacingLeft: item.spacingLeft, gap: item.gap });
    return { ...item, lane };
  });
}

/** Keeps a centred label inside the track instead of centring it past an end. */
function centredAnchorClass(left: number): string {
  if (left < 9) return "";
  if (left > 91) return "-translate-x-full";
  return "-translate-x-1/2";
}

/**
 * One label per marker, except that markers within `MARKER_MERGE_GAP` of each
 * other share one. A merged label hangs from its outer tick, toward the
 * middle of the track, so it never runs past either end.
 */
function markerLabelItems(markers: readonly (GaugeLabelMarker & { left: number })[]): GaugeLabelItem[] {
  const clusters: (GaugeLabelMarker & { left: number })[][] = [];
  for (const marker of markers) {
    const current = clusters.at(-1);
    if (current && marker.left - current.at(-1)!.left < MARKER_MERGE_GAP) current.push(marker);
    else clusters.push([marker]);
  }
  return clusters.map((cluster) => {
    const first = cluster[0]!;
    const last = cluster.at(-1)!;
    if (cluster.length === 1) {
      return {
        kind: "markers" as const,
        left: first.left,
        spacingLeft: first.left,
        gap: LABEL_GAP,
        anchorClass: centredAnchorClass(first.left),
        markers: cluster,
      };
    }
    const leftHalf = (first.left + last.left) / 2 <= 50;
    return {
      kind: "markers" as const,
      left: leftHalf ? first.left : last.left,
      spacingLeft: leftHalf ? first.left + MERGED_LABEL_HALF_WIDTH : last.left - MERGED_LABEL_HALF_WIDTH,
      gap: MERGED_LABEL_GAP,
      anchorClass: leftHalf ? "" : "-translate-x-full",
      markers: cluster,
    };
  });
}

/**
 * A collateral (or hedge coverage) ratio on a clamped log track. Par (100 %)
 * is always marked; a reviewed MCR and shutdown ratio add labelled ticks
 * (solid and dashed). Without a fixed `domain`, a ratio near par draws on a
 * tighter track so 100 % and 103 % no longer read alike; both scale ends are
 * labelled so the zoom is stated, and par keeps its true position on it.
 * Values beyond the domain pin to the end with an overflow arrow, while every
 * label keeps the true figure. A missing ratio draws a dashed, empty track
 * labelled as unavailable — never a zero-width fill.
 *
 * The caller caps the width (`className`): a ratio stretched across a
 * 1,000 px row reads as a 750 px empty track.
 *
 * Pure CSS/HTML: inline offsets on a handful of spans, no SVG.
 */
export function ThresholdGauge({
  valuePct,
  ariaLabel,
  threshold = null,
  shutdown = null,
  formatValue = formatGaugePct,
  domain,
  showValueLabel = true,
  unavailableLabel = "Unavailable",
  className,
}: ThresholdGaugeProps) {
  const value = typeof valuePct === "number" && Number.isFinite(valuePct) && valuePct >= 0 ? valuePct : null;
  const reviewedMarkers = [
    ...(threshold && Number.isFinite(threshold.pct) ? [{ kind: "threshold" as const, ...threshold }] : []),
    ...(shutdown && Number.isFinite(shutdown.pct) ? [{ kind: "shutdown" as const, ...shutdown }] : []),
  ];
  // No reading means nothing to zoom on: the unavailable track keeps the default scale.
  const resolvedDomain = domain
    ? resolveDomain(domain)
    : value != null
      ? resolveThresholdGaugeDomain([value, PAR_PCT, ...reviewedMarkers.map((marker) => marker.pct)])
      : THRESHOLD_GAUGE_DEFAULT_DOMAIN;
  const tone = value != null ? getCollateralCoverageTone(value) : null;
  const position = value != null ? thresholdGaugePosition(value, resolvedDomain) : null;

  const markers = [{ kind: "par" as const, pct: PAR_PCT, label: "Par" }, ...reviewedMarkers]
    .map((marker) => ({ ...marker, left: thresholdGaugePosition(marker.pct, resolvedDomain).left }))
    .sort((a, b) => a.left - b.left || a.pct - b.pct);

  const scaleItem = (kind: "scale-min" | "scale-max" | "unavailable"): GaugeLabelItem => ({
    kind,
    left: kind === "scale-max" ? 100 : 0,
    spacingLeft: kind === "scale-max" ? 100 - SCALE_LABEL_INSET : SCALE_LABEL_INSET,
    gap: LABEL_GAP,
    anchorClass: kind === "scale-max" ? "-translate-x-full" : "",
    markers: [],
  });
  const labelItems: GaugeLabelItem[] = value != null
    ? [scaleItem("scale-min"), scaleItem("scale-max")]
    : [scaleItem("unavailable")];
  labelItems.push(...markerLabelItems(markers));
  if (position != null && showValueLabel) {
    labelItems.push({
      kind: "value",
      left: position.left,
      spacingLeft: position.left,
      gap: LABEL_GAP,
      anchorClass: centredAnchorClass(position.left),
      markers: [],
    });
  }
  const labels = assignLanes(labelItems);
  const laneCount = Math.max(1, ...labels.map((label) => label.lane + 1));

  const description = [
    ariaLabel,
    value != null ? formatValue(value) : unavailableLabel.toLowerCase(),
    ...markers.map((marker) => `${marker.label} ${formatValue(marker.pct)}`),
    position?.clamped === "high"
      ? `beyond the ${formatValue(resolvedDomain.maxPct)} scale end`
      : position?.clamped === "low"
        ? `below the ${formatValue(resolvedDomain.minPct)} scale start`
        : null,
    value != null
      ? `log scale from ${formatValue(resolvedDomain.minPct)} to ${formatValue(resolvedDomain.maxPct)}`
      : "log scale",
  ]
    .filter((part): part is string => part != null)
    .join("; ");

  return (
    <div
      role="img"
      aria-label={`${description}.`}
      data-state={value != null ? "available" : "unavailable"}
      data-tone={tone ?? undefined}
      data-clamped={position?.clamped ?? undefined}
      className={cn("min-w-0 px-1.5", className)}
    >
      <div className="relative h-3">
        {value != null && position != null && tone != null ? (
          <>
            <div className={cn("absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full", TRACK_CLASS)}>
              <div
                data-gauge-fill=""
                className={cn("h-full rounded-full", COVERAGE_FILL_CLASS[tone])}
                style={{ width: `${Math.max(position.left, 1.5)}%` }}
              />
            </div>
            {position.clamped === "high" ? (
              <span aria-hidden="true" className={cn("absolute left-full top-1/2 ml-px -translate-y-1/2", CLAMP_HIGH_ARROW_CLASS[tone])} />
            ) : null}
            {position.clamped === "low" ? (
              <span aria-hidden="true" className={cn("absolute right-full top-1/2 mr-px -translate-y-1/2", CLAMP_LOW_ARROW_CLASS)} />
            ) : null}
          </>
        ) : (
          <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full border border-dashed border-muted-foreground/50" />
        )}
        {markers.map((marker) => (
          <span
            key={marker.kind}
            data-gauge-marker={marker.kind}
            className={cn("absolute inset-y-0 -translate-x-1/2", TICK_CLASS[marker.kind])}
            style={{ left: `${marker.left}%` }}
          />
        ))}
        {position != null ? (
          <span
            data-gauge-marker="value"
            className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card bg-foreground"
            style={{ left: `${position.left}%` }}
          />
        ) : null}
      </div>
      <div aria-hidden="true" className={cn("relative mt-1", LANE_HEIGHT_CLASS[laneCount - 1])}>
        {labels.map((label) => {
          // A marker label is keyed by the kinds it names: "par", or "par threshold" when merged.
          const labelKey = label.kind === "markers" ? label.markers.map((marker) => marker.kind).join(" ") : label.kind;
          return (
            <span
              key={labelKey}
              data-gauge-label={labelKey}
              className={cn("absolute whitespace-nowrap text-[11px] leading-[14px]", label.anchorClass)}
              style={{ left: `${label.left}%`, top: `${label.lane * LANE_HEIGHT_PX}px` }}
            >
              {label.kind === "value" && value != null && tone != null ? (
                <span className={cn("font-mono font-semibold tabular-nums", COVERAGE_TEXT_CLASS[tone])}>
                  {formatValue(value)}
                </span>
              ) : label.kind === "unavailable" ? (
                <span className="text-muted-foreground">{unavailableLabel}</span>
              ) : label.kind === "scale-min" || label.kind === "scale-max" ? (
                <span className="font-mono tabular-nums text-muted-foreground">
                  {formatValue(label.kind === "scale-min" ? resolvedDomain.minPct : resolvedDomain.maxPct)}
                </span>
              ) : (
                <span className="text-muted-foreground">
                  {label.markers.map((marker, index) => (
                    <Fragment key={marker.kind}>
                      {index > 0 ? " · " : null}
                      {marker.label}{" "}
                      <span className="font-mono tabular-nums">{formatValue(marker.pct)}</span>
                    </Fragment>
                  ))}
                </span>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export interface ShareMeterProps {
  /** Share in percent, 0–100 (57.5 = 57.5 % of supply); `null` when unavailable. */
  valuePct: number | null;
  /** Names the share and its denominator ("Liquidation backstop, share of supply"). */
  ariaLabel: string;
  formatValue?: (pct: number) => string;
  /**
   * Fill for the measured share. Neutral by default: a share of a whole is a
   * composition, not a graded level, unless the caller has published cutoffs.
   */
  fillClass?: string;
  unavailableLabel?: string;
  className?: string;
}

/**
 * Compact 0–100 % meter for a share of a whole ("liquidation backstop 57.5 %
 * of supply"). A real zero draws an empty solid track; a missing share draws
 * a dashed track with an "Unavailable" note, so the two never read alike.
 * (`LinearGauge` is not reused: it draws a missing value as an empty bar.)
 *
 * Only for shares whose 0–100 range is meaningful: a 0.1 % buffer on this
 * track reads as an empty bar, so callers print such figures without one.
 */
export function ShareMeter({
  valuePct,
  ariaLabel,
  formatValue = formatGaugePct,
  fillClass = "bg-foreground/60",
  unavailableLabel = "Unavailable",
  className,
}: ShareMeterProps) {
  if (typeof valuePct !== "number" || !Number.isFinite(valuePct)) {
    return (
      <div
        role="img"
        aria-label={`${ariaLabel}: ${unavailableLabel.toLowerCase()}.`}
        data-state="unavailable"
        className={cn("flex min-w-0 items-center gap-2", className)}
      >
        <div className="h-1.5 min-w-0 flex-1 rounded-full border border-dashed border-muted-foreground/50" />
        <span aria-hidden="true" className="shrink-0 text-[11px] text-muted-foreground">{unavailableLabel}</span>
      </div>
    );
  }

  const width = Math.min(Math.max(valuePct, 0), 100);
  return (
    <div
      role="img"
      aria-label={`${ariaLabel}: ${formatValue(valuePct)}.`}
      data-state="available"
      className={cn("h-1.5 min-w-0 overflow-hidden rounded-full", TRACK_CLASS, className)}
    >
      {width > 0 ? (
        <div
          data-gauge-fill=""
          className={cn("h-full rounded-full", fillClass)}
          style={{ width: `${Math.max(width, 1.5)}%` }}
        />
      ) : null}
    </div>
  );
}
