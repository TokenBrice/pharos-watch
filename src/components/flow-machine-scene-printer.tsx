"use client";

import { useMemo, useState } from "react";
import { Banknote } from "lucide-react";
import { cn } from "@/lib/utils";
import { buildPrinterMachineModel, type FlowMachineSceneSize } from "./flow-machine-scene-model";

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
  const [reducedMotion] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia("(prefers-reduced-motion: reduce)").matches : false,
  );

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
        className="pointer-events-none absolute left-1/2 -translate-x-1/2 rounded-2xl border border-slate-600/80 bg-slate-900/85 shadow-[inset_0_-14px_24px_rgba(0,0,0,0.35)]"
        style={{ top: `${model.dims.bodyTop}px`, width: `${model.dims.bodyW}px`, height: `${model.dims.bodyH}px` }}
      />
      <div
        className="pointer-events-none absolute left-1/2 -translate-x-1/2 rounded border border-slate-700/80 bg-black/55"
        style={{ top: `${model.dims.slotTop}px`, width: `${model.dims.slotW}px`, height: `${model.dims.slotH}px` }}
      />
      <div
        className="pointer-events-none absolute rounded-full border border-slate-500/70 bg-slate-500/45 fm-roller"
        style={{
          top: `${model.dims.rollerTop}px`,
          left: `calc(50% - ${Math.abs(model.dims.rollerLeftOffset)}px)`,
          width: `${model.dims.rollerW}px`,
          height: `${model.dims.rollerH}px`,
          animationDuration: `${model.rollerDuration.toFixed(2)}s`,
        }}
      />
      <div
        className="pointer-events-none absolute rounded-full border border-slate-500/70 bg-slate-500/45 fm-roller"
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
          className="pointer-events-none absolute rounded-full border border-emerald-300/45 bg-emerald-400/25 fm-light"
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
        className={cn("pointer-events-none absolute origin-[2px_50%]", model.isCrankChoppy ? "fm-crank-stutter" : "fm-crank")}
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
            sheet.className,
          )}
          style={sheet.style}
        >
          <Banknote className={cn(model.isMini ? "h-2.5 w-2.5" : "h-3 w-3")} />
        </div>
      ))}

      <style jsx>{`
        .fm-paper-fly {
          animation-name: fm-paper-fly;
          animation-timing-function: linear;
          animation-iteration-count: infinite;
        }
        .fm-paper-misfeed {
          animation-name: fm-paper-misfeed;
          animation-timing-function: ease-in-out;
          animation-iteration-count: infinite;
        }
        .fm-roller {
          animation-name: fm-roller-spin;
          animation-timing-function: linear;
          animation-iteration-count: infinite;
        }
        .fm-light {
          animation-name: fm-status-blink;
          animation-timing-function: ease-in-out;
          animation-iteration-count: infinite;
        }
        .fm-crank {
          animation-name: fm-crank-spin;
          animation-timing-function: linear;
          animation-iteration-count: infinite;
        }
        .fm-crank-stutter {
          animation-name: fm-crank-stutter;
          animation-timing-function: cubic-bezier(0.55, 0.02, 0.64, 0.96);
          animation-iteration-count: infinite;
        }

        @keyframes fm-paper-fly {
          0% {
            opacity: 0;
            transform: translate(-50%, 0) scale(0.72) rotate(0deg);
          }
          10% {
            opacity: 1;
          }
          64% {
            opacity: 1;
          }
          100% {
            opacity: 0;
            transform: translate(calc(-50% + var(--paper-dx)), calc(-1 * var(--paper-dy))) scale(1.02) rotate(var(--note-rot));
          }
        }

        @keyframes fm-paper-misfeed {
          0% {
            opacity: 0;
            transform: translate(-50%, 0) scale(0.68) rotate(0deg);
          }
          14% {
            opacity: 1;
          }
          46% {
            opacity: 1;
            transform: translate(calc(-50% + var(--misfeed-dx)), 16px) scale(0.86) rotate(var(--misfeed-rot));
          }
          100% {
            opacity: 0;
            transform: translate(calc(-50% + var(--misfeed-dx)), var(--misfeed-drop)) scale(0.8) rotate(var(--misfeed-rot));
          }
        }

        @keyframes fm-roller-spin {
          0% {
            transform: rotate(0deg);
          }
          100% {
            transform: rotate(360deg);
          }
        }

        @keyframes fm-status-blink {
          0%, 100% {
            opacity: 0.45;
          }
          50% {
            opacity: 1;
          }
        }

        @keyframes fm-crank-spin {
          0% {
            transform: rotate(0deg);
          }
          100% {
            transform: rotate(360deg);
          }
        }

        @keyframes fm-crank-stutter {
          0% {
            transform: translateY(0) rotate(0deg);
          }
          10% {
            transform: translateY(calc(var(--crank-wobble) * -1)) rotate(calc(34deg + var(--crank-kick)));
          }
          16% {
            transform: translateY(0) rotate(calc(22deg - var(--crank-kick)));
          }
          30% {
            transform: translateY(calc(var(--crank-wobble) * -1)) rotate(calc(112deg + var(--crank-kick)));
          }
          36% {
            transform: translateY(0) rotate(calc(98deg - var(--crank-kick)));
          }
          52% {
            transform: translateY(calc(var(--crank-wobble) * -1)) rotate(calc(204deg + var(--crank-kick)));
          }
          58% {
            transform: translateY(0) rotate(calc(188deg - var(--crank-kick)));
          }
          74% {
            transform: translateY(calc(var(--crank-wobble) * -1)) rotate(calc(294deg + var(--crank-kick)));
          }
          80% {
            transform: translateY(0) rotate(calc(280deg - var(--crank-kick)));
          }
          100% {
            transform: translateY(0) rotate(360deg);
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .fm-paper-fly,
          .fm-paper-misfeed,
          .fm-roller,
          .fm-light,
          .fm-crank,
          .fm-crank-stutter {
            animation-duration: 6s !important;
          }
        }
      `}</style>
    </div>
  );
}
