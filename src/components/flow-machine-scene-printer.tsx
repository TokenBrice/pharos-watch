"use client";

import { useMemo } from "react";
import { Banknote } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { buildPrinterMachineModel, type FlowMachineSceneSize } from "./flow-machine-scene-model";
import styles from "./flow-machine-scene-printer.module.css";

export function FlowMachinePrinter({
  size,
  intensity,
  stress,
  accentHex,
}: {
  size: FlowMachineSceneSize;
  intensity: number;
  stress: number;
  accentHex: string;
}) {
  // Shared store (matches the shredder scene): honours the explicit
  // system/reduced/full override, stays SSR-safe, and re-renders when the OS
  // preference changes — the local `useState(matchMedia)` read did none of the
  // three and froze at mount.
  const reducedMotion = usePrefersReducedMotion();

  const model = useMemo(() => {
    return buildPrinterMachineModel(size, reducedMotion ? 0 : intensity, stress);
  }, [intensity, reducedMotion, size, stress]);

  return (
    <div className={model.dims.areaClass}>
      <div
        className="pointer-events-none absolute left-1/2 -translate-x-1/2 rounded-t-xl border border-slate-600/70 bg-slate-700/70"
        style={{
          top: `${model.dims.topShellTop}px`,
          width: `${model.dims.topShellW}px`,
          height: `${model.dims.topShellH}px`,
          boxShadow: `0 0 20px ${accentHex}55`,
        }}
      />
      <div
        className="pointer-events-none absolute left-1/2 -translate-x-1/2 rounded-xl border border-slate-600/80 bg-slate-900/85"
        style={{ top: `${model.dims.bodyTop}px`, width: `${model.dims.bodyW}px`, height: `${model.dims.bodyH}px` }}
      />
      <div
        className="pointer-events-none absolute left-1/2 -translate-x-1/2 rounded border border-slate-700/80 bg-black/55"
        style={{ top: `${model.dims.slotTop}px`, width: `${model.dims.slotW}px`, height: `${model.dims.slotH}px` }}
      />
      <div
        className={cn("pointer-events-none absolute rounded-full border border-slate-500/70 bg-slate-500/45", styles.roller)}
        style={{
          top: `${model.dims.rollerTop}px`,
          left: `calc(50% - ${Math.abs(model.dims.rollerLeftOffset)}px)`,
          width: `${model.dims.rollerW}px`,
          height: `${model.dims.rollerH}px`,
          animationDuration: `${model.rollerDuration.toFixed(2)}s`,
        }}
      />
      <div
        className={cn("pointer-events-none absolute rounded-full border border-slate-500/70 bg-slate-500/45", styles.roller)}
        style={{
          top: `${model.dims.rollerTop}px`,
          left: `calc(50% + ${model.dims.rollerRightOffset}px)`,
          width: `${model.dims.rollerW}px`,
          height: `${model.dims.rollerH}px`,
          animationDuration: `${(model.rollerDuration * 0.92).toFixed(2)}s`,
        }}
      />

      {model.dims.hasStatusLight ? (
        <div
          className={cn("pointer-events-none absolute rounded-full border border-emerald-300/45 bg-emerald-400/25", styles.light)}
          style={{
            top: `${model.dims.statusLightTop}px`,
            left: `calc(50% + ${model.dims.statusLightLeftOffset}px)`,
            width: `${model.dims.statusLightSize}px`,
            height: `${model.dims.statusLightSize}px`,
            animationDuration: `${(1.8 - model.power).toFixed(2)}s`,
            boxShadow: `0 0 12px rgba(52,211,153,${model.glowOpacity})`,
          }}
        />
      ) : null}

      <div
        className={cn("pointer-events-none absolute origin-[2px_50%]", model.isCrankChoppy ? styles.crankStutter : styles.crank)}
        style={{
          ...model.crankStyle,
          top: `${model.dims.crankTop}px`,
          left: `calc(50% + ${model.dims.crankLeftOffset}px)`,
          width: `${model.dims.crankBox}px`,
          height: `${model.dims.crankBox}px`,
        }}
      >
        <div
          className="absolute left-0 top-1/2 -translate-y-1/2 rounded bg-slate-300/85"
          style={{ width: `${model.dims.crankBarW}px`, height: "3px" }}
        />
        <div
          className="absolute right-0 top-1/2 -translate-y-1/2 rounded-full border border-slate-500/80 bg-slate-200/90"
          style={{ width: `${model.dims.crankKnob}px`, height: `${model.dims.crankKnob}px` }}
        />
      </div>

      <div
        className="pointer-events-none absolute left-1/2 -translate-x-1/2 rounded border border-slate-500/70 bg-gradient-to-b from-slate-300/70 to-slate-200/25"
        style={{ top: `${model.dims.sheetTop}px`, width: `${model.dims.sheetW}px`, height: `${model.dims.sheetH}px` }}
      />

      {model.sheets.map((sheet) => (
        <div
          key={sheet.key}
          className={cn(
            "pointer-events-none absolute flex -translate-x-1/2 items-center justify-center rounded-sm border border-emerald-500/45 bg-emerald-300/75 text-emerald-950",
            sheet.misfeed ? styles.paperMisfeed : styles.paperFly,
          )}
          style={sheet.style}
        >
          <Banknote className={cn(model.isMini ? "h-2.5 w-2.5" : "h-3 w-3")} />
        </div>
      ))}
    </div>
  );
}
