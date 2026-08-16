"use client";

import { useState } from "react";
import { useStabilityIndexLight } from "@/hooks/use-stability-index-light";
import { PSI_HEX_COLORS, type ConditionBand } from "@shared/lib/psi-colors";
import { bucketUnixSecondsToUtcDay } from "@shared/lib/time-buckets";
import { getDisplayedPsi, getDisplayedPsiBasis, getPsiBandStreak } from "@shared/lib/psi-view-model";
import { cn } from "@/lib/utils";

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
  const completedOldestFirst = history
    .filter((p) => p.date < todayMidnight)
    .slice(0, BAND_STRIP_WINDOW_DAYS)
    .reverse();
  const out: Array<{ date: number; band: string } | null> = [];
  for (let i = 0; i < BAND_STRIP_WINDOW_DAYS; i++) {
    const point = completedOldestFirst[i];
    out.push(point ? { date: point.date, band: point.band } : null);
  }
  return out;
}

/** Persistent 3px bar at the top of every page, colored by current PSI band. */
export function RegimeBar() {
  const { data: psiData } = useStabilityIndexLight();
  const lightData = psiData as StabilityIndexLightData | undefined;
  const [expanded, setExpanded] = useState(false);

  const current = lightData?.current;
  if (!current) return <div className="fixed left-0 right-0 top-0 z-[60] h-[3px] max-w-[100vw]" />;

  const displayedPsi = getDisplayedPsi(current);
  const displayBasis = getDisplayedPsiBasis(current);
  const band = displayedPsi.band as ConditionBand;
  const score = displayedPsi.score;
  const color = PSI_HEX_COLORS[band];
  const isElevated = band === "FRACTURE" || band === "CRISIS" || band === "MELTDOWN";
  const components = current.components;

  // Dark text for BEDROCK/STEADY (green/teal bg + white fails WCAG contrast)
  const useDarkText = band === "BEDROCK" || band === "STEADY";

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
      aria-label={`Market regime: ${band}, PSI ${Math.round(score)}, ${displayBasis}`}
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
            <span className="font-semibold tracking-wide">{band}</span>
            {daysInBand && <span>for {daysInBand}d</span>}
            <span className={useDarkText ? "text-gray-900/70" : "text-white/80"} aria-hidden="true">·</span>
            <span>PSI {Math.round(score)} · {displayBasis}</span>
            <span className={useDarkText ? "text-gray-900/70" : "text-white/80"} aria-hidden="true">·</span>
            <span>
              sev {components?.severity.toFixed(1) ?? "n/a"} · breadth{" "}
              {components?.breadth.toFixed(1) ?? "n/a"}
              {components?.stressBreadth != null &&
                ` · stress ${components.stressBreadth.toFixed(1)}`}
              {" "}· trend {(components?.trend ?? 0) > 0 ? "+" : ""}
              {components?.trend.toFixed(1) ?? "n/a"}
            </span>
          </div>
          <div className="mx-auto mb-1 flex max-w-3xl items-center gap-2 px-4">
            <div
              className="flex h-[4px] flex-1 gap-[1px] overflow-hidden rounded-[1px]"
              role="img"
              aria-label="Last 30 days of PSI band classifications"
            >
              {bandStripCells.map((cell, i) => {
                const fill = cell ? PSI_HEX_COLORS[cell.band as ConditionBand] : null;
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
