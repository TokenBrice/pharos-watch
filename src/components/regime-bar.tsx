"use client";

import { useState } from "react";
import { useStabilityIndex } from "@/hooks/api-hooks";
import { PSI_HEX_COLORS, PSI_UNKNOWN_BAND_HEX, isConditionBand } from "@shared/lib/psi-colors";
import { bucketUnixSecondsToUtcDay } from "@shared/lib/time-buckets";
import { getDisplayedPsi, getDisplayedPsiBasis, getPsiBandStreak } from "@shared/lib/psi-view-model";
import { cn } from "@/lib/utils";
import { deriveDataHealth, formatDataHealthTimestamp } from "@/lib/data-health";
import { DATA_HEALTH_PRESETS } from "@/lib/data-health-config";
import { useHydrated } from "@/hooks/use-hydrated";
import type { ApiMeta } from "@/lib/api";

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

/** Persistent 3px bar at the top of every page, colored by current PSI band. */
export function RegimeBar() {
  const psiQuery = useStabilityIndex();
  const psiData = psiQuery.data;
  const lightData = psiData as StabilityIndexLightData | undefined;
  const [expanded, setExpanded] = useState(false);
  const hydrated = useHydrated();

  const current = lightData?.current;
  if (!current) return <div className="fixed left-0 right-0 top-0 z-[60] h-[3px] max-w-[100vw]" />;

  const displayedPsi = getDisplayedPsi(current);
  const displayBasis = getDisplayedPsiBasis(current);
  const band = displayedPsi.band;
  const score = displayedPsi.score;
  const meta = psiQuery.meta;
  const generationUpdatedAt = Math.min(meta?.updatedAt ?? current.computedAt, current.computedAt);
  const generationMeta: ApiMeta = meta?.updatedAt === null ? meta : {
    ...meta,
    updatedAt: generationUpdatedAt,
    ageSeconds: meta?.ageSeconds ?? Math.max(0, psiQuery.dataUpdatedAt / 1000 - generationUpdatedAt),
    status: meta?.status ?? "fresh",
  };
  const health = deriveDataHealth({
    ...DATA_HEALTH_PRESETS.stabilityIndex,
    dataUpdatedAt: psiQuery.dataUpdatedAt,
    error: psiQuery.error,
    hasData: true,
    meta: generationMeta,
  }, hydrated ? undefined : psiQuery.dataUpdatedAt);
  const isCurrent = health.state === "fresh";
  const retainedLabel = `Retained observation as of ${formatDataHealthTimestamp(current.computedAt * 1000, "en-US", "UTC")}`;
  // Legacy rows and unvalidated caches can carry a band outside the closed vocabulary.
  const color = isCurrent && isConditionBand(band) ? PSI_HEX_COLORS[band] : PSI_UNKNOWN_BAND_HEX;
  const isElevated = isCurrent && (band === "FRACTURE" || band === "CRISIS" || band === "MELTDOWN");
  const components = current.components;

  // Dark text on the neutral fallback and green/teal bands (white fails contrast).
  const useDarkText = !isCurrent || band === "BEDROCK" || band === "STEADY";

  // Walk history to compute days in current band
  const daysInBand = lightData?.history?.length
    ? getPsiBandStreak(lightData.history, current.computedAt, band)
    : null;

  // 30-day band history strip (oldest → newest). Empty cells until history hydrates.
  const bandStripCells = buildBandStripCells(lightData?.history, current.computedAt);

  return (
    <button
      type="button"
      className={cn(
        "fixed left-0 right-0 top-0 z-[60] max-w-[100vw] cursor-pointer select-none overflow-hidden text-left",
        "transition-[background-color] duration-[600ms] ease-out",
        isElevated && "animate-[pharos-regime-pulse_1.5s_ease-in-out_infinite]",
      )}
      style={{ backgroundColor: color }}
      onClick={() => setExpanded((prev) => !prev)}
      aria-expanded={expanded}
      aria-label={isCurrent
        ? `Market regime: ${band}, PSI ${Math.round(score)}, ${displayBasis}`
        : `Current market regime unavailable. ${health.message} ${retainedLabel}: ${band}, PSI ${Math.round(score)}, ${displayBasis}`}
    >
      {/* Use grid-template-rows for smooth expand/collapse (height:auto can't transition) */}
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: expanded ? "1fr" : "0fr" }}
      >
        <div className="min-h-0 overflow-hidden">
          <div className={cn(
            "flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4 py-1 text-[11px] leading-none font-mono tabular-nums",
            useDarkText ? "text-gray-900/90" : "text-white/90",
          )}>
            {!isCurrent && <span>Current regime unavailable · {retainedLabel}</span>}
            <span className="font-semibold tracking-wide">{band}</span>
            {isCurrent && daysInBand && <span>for {daysInBand}d</span>}
            <span className={useDarkText ? "text-gray-900/70" : "text-white/80"} aria-hidden="true">·</span>
            <span>PSI {Math.round(score)} · {displayBasis}</span>
            <span className={useDarkText ? "text-gray-900/70" : "text-white/80"} aria-hidden="true">·</span>
            <span>
              sev {components?.severity?.toFixed(1) ?? "n/a"} · breadth{" "}
              {components?.breadth?.toFixed(1) ?? "n/a"}
              {" · stress "}{components?.stressBreadth?.toFixed(1) ?? "n/a"}
              {" "}· trend {components?.trend != null && components.trend > 0 ? "+" : ""}
              {components?.trend?.toFixed(1) ?? "n/a"}
            </span>
          </div>
          <div className="mx-auto mb-1 flex max-w-3xl items-center gap-2 px-4">
            <div
              className="flex h-[4px] flex-1 gap-[1px] overflow-hidden rounded-[1px]"
              role="img"
              aria-label="Last 30 days of PSI band classifications"
            >
              {bandStripCells.map((cell, i) => {
                const fill = cell
                  ? (isConditionBand(cell.band) ? PSI_HEX_COLORS[cell.band] : PSI_UNKNOWN_BAND_HEX)
                  : null;
                const title = cell
                  ? `${new Date(cell.date * 1000).toISOString().slice(0, 10)} · ${cell.band}`
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
      {/* Collapsed minimum: 3px colored bar */}
      {!expanded && <div className="h-[3px]" />}
    </button>
  );
}
