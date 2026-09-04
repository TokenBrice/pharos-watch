"use client";

import { cn } from "@/lib/utils";
import { formatBps, formatElapsedSeconds } from "@shared/lib/format";
import type { DdrDuration } from "@shared/types/depeg-resolver";
import {
  formatDurationSec,
  FORWARD_STOPS,
  getAgeSec,
  getCurrentDeviationBps,
  getDuration,
  getLockMetadata,
  getPeakDeviationBps,
  getPredictionState,
  getResolution,
  NOW_DOT_TONE,
  TIER_META,
  timeToForwardX,
  type DdrDisplayRow,
} from "@/components/depeg-resolver-row-card-model";

function PastDeviationSpark({ row }: { row: DdrDisplayRow }) {
  const peak = Math.abs(getPeakDeviationBps(row));
  const currentDeviationBps = getCurrentDeviationBps(row);
  const now = currentDeviationBps != null ? Math.abs(currentDeviationBps) : peak;
  const max = Math.max(peak, now, 1);
  const below = row.direction === "below";

  const pegY = 20;
  const depthY = (frac: number) => (below ? pegY + frac * 16 : pegY - frac * 16);
  const peakY = depthY(peak / max);
  const nowY = depthY(now / max);
  const line = `0,${pegY} 48,${peakY} 100,${nowY}`;
  const area = `0,${pegY} 48,${peakY} 100,${nowY} 100,${pegY}`;

  return (
    <svg
      viewBox="0 0 100 40"
      preserveAspectRatio="none"
      className="absolute inset-0 h-full w-full text-red-500"
      aria-hidden="true"
    >
      <line
        x1="0"
        y1={pegY}
        x2="100"
        y2={pegY}
        stroke="currentColor"
        className="text-border"
        strokeWidth={0.75}
        strokeDasharray="2 3"
        vectorEffect="non-scaling-stroke"
      />
      <polygon points={area} fill="currentColor" fillOpacity={0.1} />
      <polyline
        points={line}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.75}
        strokeWidth={1.5}
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function ForwardProjection({ duration }: { duration: DdrDuration }) {
  const medianX = duration.medianSec != null ? timeToForwardX(duration.medianSec) : null;
  const iqrLeft = duration.iqrSec ? timeToForwardX(duration.iqrSec[0]) : null;
  const iqrRight = duration.iqrSec ? timeToForwardX(duration.iqrSec[1]) : null;
  const displayHorizons = duration.horizons.filter((cell) =>
    FORWARD_STOPS.some((stop) => stop.horizon === cell.horizon),
  );

  return (
    <div className="absolute inset-0">
      <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-gradient-to-r from-sky-500/60 via-sky-500/30 to-transparent" />
      <span
        className="absolute right-0 top-1/2 -translate-y-1/2 border-y-[3px] border-l-[5px] border-y-transparent border-l-sky-500/40"
        aria-hidden="true"
      />

      {iqrLeft != null && iqrRight != null ? (
        <span
          className="absolute top-1/2 h-2 -translate-y-1/2 rounded-full bg-sky-500/20"
          style={{ left: `${iqrLeft}%`, width: `${Math.max(2, iqrRight - iqrLeft)}%` }}
        />
      ) : null}

      {displayHorizons.map((cell) => {
        const stop = FORWARD_STOPS.find((s) => s.horizon === cell.horizon)!;
        const hasProb = cell.probability != null;
        return (
          <div
            key={cell.horizon}
            className="absolute bottom-0 flex -translate-x-1/2 flex-col items-center gap-0.5"
            style={{ left: `${stop.x}%` }}
          >
            <span className="pharos-meta font-medium uppercase tracking-wide">{cell.horizon}</span>
            {hasProb ? (
              <span className="pharos-numeric text-xs leading-none text-sky-700 dark:text-sky-400">
                {Math.round((cell.probability ?? 0) * 100)}%
              </span>
            ) : (
              <span aria-hidden="true" className="pharos-numeric text-xs leading-none text-muted-foreground">·</span>
            )}
          </div>
        );
      })}

      {displayHorizons.map((cell) => {
        const stop = FORWARD_STOPS.find((s) => s.horizon === cell.horizon)!;
        return (
          <span
            key={`tick-${cell.horizon}`}
            className="absolute top-1/2 h-1.5 w-px -translate-x-1/2 -translate-y-1/2 bg-border"
            style={{ left: `${stop.x}%` }}
            aria-hidden="true"
          />
        );
      })}

      {medianX != null && duration.medianSec != null ? (
        <div className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2" style={{ left: `${medianX}%` }}>
          <span className="absolute bottom-full left-1/2 mb-1.5 -translate-x-1/2 whitespace-nowrap font-mono text-xs font-semibold leading-none text-foreground">
            ~{formatDurationSec(duration.medianSec)}
          </span>
          <span className="block h-2.5 w-2.5 rotate-45 bg-sky-500" aria-hidden="true" />
        </div>
      ) : null}
    </div>
  );
}

function ForwardCap({ tone, label }: { tone: "terminal" | "muted"; label: string }) {
  const lineTone = tone === "terminal" ? "bg-red-500/30" : "bg-border";
  const textTone = tone === "terminal" ? "text-red-700 dark:text-red-400" : "text-muted-foreground/80";
  return (
    <div className="absolute inset-0 flex items-center">
      <span className={cn("h-px flex-1", lineTone)} aria-hidden="true" />
      <span className={cn("px-2 text-center text-xs font-medium leading-tight", textTone)}>{label}</span>
      <span className={cn("h-px flex-1", lineTone)} aria-hidden="true" />
    </div>
  );
}

export function ForecastTimeline({ row }: { row: DdrDisplayRow }) {
  const resolution = getResolution(row);
  const tier = resolution.tier;
  const duration = getDuration(row);
  const predictionState = getPredictionState(row);
  const lockAnchored = predictionState === "frozen";
  const lockMetadata = getLockMetadata(row);
  const terminal = tier === "recovery_unlikely";
  const insufficient = tier === "insufficient_signal";
  const hasBand =
    !terminal && !insufficient && !duration.suppressed && (duration.medianSec != null || duration.horizons.length > 0);

  const forwardLabel = terminal
    ? "no recovery expected"
    : insufficient
      ? "awaiting signal"
      : "duration not benchmarked";

  const ageSec = lockAnchored ? (lockMetadata.predictedAgeSec ?? getAgeSec(row)) : getAgeSec(row);
  const peakDeviationBps = getPeakDeviationBps(row);
  const currentDeviationBps = getCurrentDeviationBps(row);
  const ariaLabel = lockAnchored
    ? `Forecast timeline frozen at public lock: depeg age at lock ${formatElapsedSeconds(ageSec)}, peak ${formatBps(
        peakDeviationBps,
      )}${currentDeviationBps != null ? `, lock deviation ${formatBps(currentDeviationBps)}` : ""}; verdict ${
        TIER_META[tier].label
      }${hasBand && duration.medianSec != null ? `; expected to resolve in about ${formatDurationSec(duration.medianSec)} after lock` : `; ${forwardLabel}`}.`
    : `Forecast timeline: depeg open ${formatElapsedSeconds(ageSec)}, peak ${formatBps(peakDeviationBps)}${
        currentDeviationBps != null ? `, now ${formatBps(currentDeviationBps)}` : ""
      }; verdict ${TIER_META[tier].label}${
        hasBand && duration.medianSec != null
          ? `; expected to resolve in about ${formatDurationSec(duration.medianSec)}`
          : `; ${forwardLabel}`
      }.`;

  return (
    <div
      className="pharos-chart-stage px-3.5 py-3 sm:px-4"
      role="img"
      aria-label={ariaLabel}
    >
      <div className="pharos-kicker grid grid-cols-[1.05fr_auto_1.85fr] items-center gap-2">
        <span className="truncate">
          {lockAnchored ? "At lock" : "So far"}{" "}
          <span className="font-mono normal-case text-muted-foreground/90">· {formatElapsedSeconds(ageSec)}</span>
        </span>
        <span className="px-1 text-foreground/70">{lockAnchored ? "Lock" : "Now"}</span>
        <span className="text-right">
          {terminal || insufficient ? "Outlook" : lockAnchored ? "From lock" : "Projected"}
        </span>
      </div>

      <div className="mt-1.5 flex h-[76px] items-stretch gap-2 sm:h-[84px]">
        <div className="relative flex-[1.05]">
          <PastDeviationSpark row={row} />
        </div>

        <div className="relative flex w-3 items-center justify-center">
          <span className="absolute inset-y-1 left-1/2 w-px -translate-x-1/2 bg-border" aria-hidden="true" />
          <span className="relative flex h-3.5 w-3.5 items-center justify-center">
            {!terminal && !insufficient ? (
              <span
                className={cn(
                  "absolute inline-flex h-full w-full rounded-full opacity-60 motion-safe:animate-ping",
                  NOW_DOT_TONE[tier],
                )}
                aria-hidden="true"
              />
            ) : null}
            <span
              className={cn("relative inline-flex h-3 w-3 rounded-full ring-4 ring-background", NOW_DOT_TONE[tier])}
            />
          </span>
        </div>

        <div className="relative flex-[1.85]">
          {hasBand ? (
            <ForwardProjection duration={duration} />
          ) : (
            <ForwardCap tone={terminal ? "terminal" : "muted"} label={forwardLabel} />
          )}
        </div>
      </div>
    </div>
  );
}
