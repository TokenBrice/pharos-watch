"use client";

import { useState } from "react";
import { useStabilityIndex } from "@/hooks/api-hooks";
import { PSI_HEX_COLORS, type ConditionBand } from "@shared/lib/psi-colors";
import { getDisplayedPsi, getPsiBandStreak } from "@shared/lib/psi-view-model";
import { cn } from "@/lib/utils";

/** Persistent 3px bar at the top of every page, colored by current PSI band. */
export function RegimeBar() {
  const { data: psiData } = useStabilityIndex();
  const [expanded, setExpanded] = useState(false);

  const current = psiData?.current;
  if (!current) return <div className="fixed top-0 z-[60] h-[3px] w-full" />;

  const displayedPsi = getDisplayedPsi(current);
  const band = displayedPsi.band as ConditionBand;
  const score = displayedPsi.score;
  const color = PSI_HEX_COLORS[band];
  const isElevated = band === "FRACTURE" || band === "CRISIS" || band === "MELTDOWN";

  // Dark text for BEDROCK/STEADY (green/teal bg + white fails WCAG contrast)
  const useDarkText = band === "BEDROCK" || band === "STEADY";

  // Walk history to compute days in current band
  const daysInBand = psiData?.history?.length
    ? getPsiBandStreak(psiData.history, current.computedAt, band)
    : null;

  return (
    <button
      type="button"
      className={cn(
        "fixed top-0 z-[60] w-full cursor-pointer select-none overflow-hidden text-left",
        "transition-[background-color] duration-[600ms] ease-out",
        isElevated && "animate-[pharos-regime-pulse_1.5s_ease-in-out_infinite]",
      )}
      style={{ backgroundColor: color }}
      onClick={() => setExpanded((prev) => !prev)}
      aria-expanded={expanded}
      aria-label={`Market regime: ${band}, PSI ${Math.round(score)}`}
    >
      {/* Use grid-template-rows for smooth expand/collapse (height:auto can't transition) */}
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: expanded ? "1fr" : "0fr" }}
      >
        <div className="min-h-0 overflow-hidden">
          <div className={cn(
            "flex items-center justify-center gap-3 px-4 py-1.5 text-xs font-mono tabular-nums",
            useDarkText ? "text-gray-900/90" : "text-white/90",
          )}>
            <span className="font-semibold tracking-wide">{band}</span>
            {daysInBand && <span>for {daysInBand}d</span>}
            <span className={useDarkText ? "text-gray-900/70" : "text-white/80"} aria-hidden="true">·</span>
            <span>PSI {Math.round(score)}</span>
            <span className={useDarkText ? "text-gray-900/70" : "text-white/80"} aria-hidden="true">·</span>
            <span>
              sev {current.components.severity.toFixed(1)} · breadth{" "}
              {current.components.breadth.toFixed(1)}
              {current.components.stressBreadth != null &&
                ` · stress ${current.components.stressBreadth.toFixed(1)}`}
              {" "}· trend {current.components.trend > 0 ? "+" : ""}
              {current.components.trend.toFixed(1)}
            </span>
          </div>
        </div>
      </div>
      {/* Collapsed minimum: 3px colored bar */}
      {!expanded && <div className="h-[3px]" />}
    </button>
  );
}
