"use client";

import { Printer, Scissors } from "lucide-react";
import { cn } from "@/lib/utils";
import { clamp } from "@shared/lib/math";
import { FlowMachinePrinter } from "./flow-machine-scene-printer";
import { FlowMachineShredder } from "./flow-machine-scene-shredder";
import {
  getFlowMachineContainerClass,
  resolveFlowMachineTitle,
  type FlowMachineSceneProps,
} from "./flow-machine-scene-model";

/**
 * Visual note: This component uses hardcoded dark-palette colors (slate, rgba shadows)
 * for artistic effect. It renders on dark surfaces only and does not adapt to light mode.
 * See design audit 2026-03-07 for rationale.
 */

export function FlowMachineScene({
  size,
  mode,
  intensity,
  statusText,
  title,
  subText,
  accentHex,
  stress = 0,
  className,
}: FlowMachineSceneProps) {
  const isShredder = mode === "shredder";
  const modeTitle = resolveFlowMachineTitle(size, mode, title);

  return (
    <div className={cn(getFlowMachineContainerClass(size), className)}>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          {isShredder ? <Scissors className="h-3.5 w-3.5" /> : <Printer className="h-3.5 w-3.5" />}
          {modeTitle}
        </span>
        <span className="font-mono tabular-nums">{statusText}</span>
      </div>

      {subText ? (
        <p className="mt-1 text-[11px] text-muted-foreground/85">{subText}</p>
      ) : null}

      {isShredder ? (
        <FlowMachineShredder size={size} intensity={clamp(intensity, 0.08, 1)} />
      ) : (
        <FlowMachinePrinter
          size={size}
          intensity={clamp(intensity, 0.08, 1)}
          stress={stress}
          accentHex={accentHex ?? "rgba(16,185,129,0.6)"}
        />
      )}
    </div>
  );
}
