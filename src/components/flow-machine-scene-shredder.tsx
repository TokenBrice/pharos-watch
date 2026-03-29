"use client";

import { useMemo, useState } from "react";
import { Banknote } from "lucide-react";
import { cn } from "@/lib/utils";
import { buildShredderMachineModel, type FlowMachineSceneSize } from "./flow-machine-scene-model";

export function FlowMachineShredder({
  size,
  intensity,
}: {
  size: FlowMachineSceneSize;
  intensity: number;
}) {
  const [reducedMotion] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia("(prefers-reduced-motion: reduce)").matches : false,
  );

  const model = useMemo(() => {
    return buildShredderMachineModel(size, reducedMotion ? 0 : intensity);
  }, [intensity, reducedMotion, size]);

  return (
    <div className={model.dims.areaClass}>
      {model.bills.map((bill) => (
        <div key={bill.key} className="pointer-events-none absolute z-10 rounded-sm border border-red-500/50 bg-red-300/85 text-red-950 sh-bill-feed" style={bill.style}>
          <div className="flex h-full w-full items-center justify-center">
            <Banknote className={cn(model.isMini ? "h-2.5 w-2.5" : "h-3 w-3")} />
          </div>
        </div>
      ))}

      <div
        className="pointer-events-none absolute z-30 -translate-x-1/2 sh-machine-vibe"
        style={{
          left: model.machineCenterX,
          top: `${model.dims.machineTop}px`,
          width: `${model.dims.machineW}px`,
          height: `${model.dims.machineH}px`,
          animationDuration: `${model.jitterDuration.toFixed(2)}s`,
        }}
      >
        <div
          className="absolute inset-0 border border-zinc-700/85 bg-gradient-to-b from-zinc-500/88 to-zinc-700/94"
          style={{
            borderRadius: `${model.dims.machineRadius}px`,
            boxShadow: `0 0 18px rgba(248,113,113,${(0.12 + model.power * 0.24).toFixed(3)})`,
          }}
        />
        <div
          className="absolute left-1/2 -translate-x-1/2 rounded-full bg-white/16"
          style={{ top: "2px", width: `${Math.round(model.dims.machineW * 0.72)}px`, height: "4px" }}
        />
        <div
          className="absolute left-1/2 -translate-x-1/2 rounded border border-zinc-950/80 bg-black/72"
          style={{ top: `${model.dims.slotY}px`, width: `${model.dims.slotW}px`, height: `${model.dims.slotH}px` }}
        />
        <div
          className="absolute left-1/2 -translate-x-1/2 rounded-sm bg-sky-200/40"
          style={{ top: `${model.dims.slotGuideY}px`, width: `${model.dims.slotGuideW}px`, height: `${model.dims.slotGuideH}px` }}
        />
        <div
          className="absolute left-1/2 -translate-x-1/2 rounded border border-zinc-950/80 bg-zinc-900/92"
          style={{ top: `${model.dims.outputY}px`, width: `${model.dims.outputW}px`, height: `${model.dims.outputH}px` }}
        />
        <div
          className="absolute left-1/2 -translate-x-1/2"
          style={{
            top: `${model.dims.outputY + 1}px`,
            width: `${model.dims.outputW - 12}px`,
            height: "2px",
            background:
              "repeating-linear-gradient(90deg, rgba(15,23,42,0.95) 0px, rgba(15,23,42,0.95) 6px, rgba(248,113,113,0.52) 6px, rgba(248,113,113,0.52) 8px)",
          }}
        />
        <div
          className="absolute z-[2] flex items-center"
          style={{
            top: `${model.dims.indicatorY}px`,
            right: `${model.dims.indicatorRight}px`,
            gap: `${model.dims.indicatorGap}px`,
          }}
        >
          {Array.from({ length: 3 }).map((_, index) => (
            <span
              key={`ind-${index}`}
              className={cn(
                "block rounded-full border",
                index === 0 ? "border-red-300/60 bg-red-400/65 sh-light-blink" : "border-zinc-200/45 bg-zinc-100/70",
              )}
              style={{
                width: `${model.dims.indicatorSize}px`,
                height: `${model.dims.indicatorSize}px`,
                animationDuration: `${(1.45 - model.power * 0.42).toFixed(2)}s`,
              }}
            />
          ))}
        </div>
      </div>

      <div
        className="pointer-events-none absolute z-[35] -translate-x-1/2 overflow-hidden"
        style={{
          left: model.stripCenterX,
          top: `${model.stripMaskTop}px`,
          width: `${model.dims.outputW}px`,
          height: `${model.stripMaskHeight}px`,
        }}
      >
        {model.strips.map((strip) => (
          <span key={strip.key} className="pointer-events-none absolute rounded-sm border border-red-400/45 bg-red-300/80 sh-strip-fall" style={strip.style} />
        ))}
      </div>

      <style jsx>{`
        .sh-bill-feed {
          animation-name: sh-bill-feed;
          animation-timing-function: linear;
          animation-iteration-count: infinite;
        }

        .sh-strip-fall {
          animation-name: sh-strip-fall;
          animation-timing-function: ease-out;
          animation-iteration-count: infinite;
          transform-origin: top center;
        }

        .sh-machine-vibe {
          animation-name: sh-machine-vibe;
          animation-timing-function: linear;
          animation-iteration-count: infinite;
        }

        .sh-light-blink {
          animation-name: sh-light-blink;
          animation-timing-function: ease-in-out;
          animation-iteration-count: infinite;
        }

        @keyframes sh-bill-feed {
          0% {
            opacity: 0;
            transform: translate(-50%, -14px) scale(0.96) rotate(0deg);
          }
          10% {
            opacity: 1;
          }
          48% {
            opacity: 1;
            transform: translate(calc(-50% + var(--bill-dx)), var(--bill-drop)) scale(0.95) rotate(var(--bill-rot));
          }
          65% {
            opacity: 0;
            transform: translate(calc(-50% + var(--bill-dx)), calc(var(--bill-drop) + 6px)) scale(0.82) rotate(calc(var(--bill-rot) * 0.6));
          }
          100% {
            opacity: 0;
            transform: translate(calc(-50% + var(--bill-dx)), calc(var(--bill-drop) + 10px)) scale(0.7) rotate(calc(var(--bill-rot) * 0.4));
          }
        }

        @keyframes sh-strip-fall {
          0% {
            opacity: 0;
            transform: translate(-50%, 0) scaleX(0.28) scaleY(0.2);
          }
          12% {
            opacity: 1;
            transform: translate(-50%, 2px) scaleX(0.45) scaleY(0.85);
          }
          100% {
            opacity: 0;
            transform: translate(calc(-50% + var(--strip-dx)), var(--strip-drop)) scaleX(0.9) scaleY(1.32);
          }
        }

        @keyframes sh-machine-vibe {
          0%, 100% {
            transform: translateX(-50%) translateY(0);
          }
          22% {
            transform: translateX(-50%) translateY(-0.8px);
          }
          50% {
            transform: translateX(-50%) translateY(0.6px);
          }
          78% {
            transform: translateX(-50%) translateY(-0.5px);
          }
        }

        @keyframes sh-light-blink {
          0%, 100% {
            opacity: 0.4;
          }
          50% {
            opacity: 1;
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .sh-bill-feed,
          .sh-strip-fall,
          .sh-machine-vibe,
          .sh-light-blink {
            animation-duration: 6s !important;
          }
        }
      `}</style>
    </div>
  );
}
