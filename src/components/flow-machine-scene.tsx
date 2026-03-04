"use client";

import { type CSSProperties } from "react";
import { Banknote, Printer, Scissors } from "lucide-react";
import { cn } from "@/lib/utils";

type CssVarStyle = CSSProperties & Record<`--${string}`, string | number>;

export type FlowMachineSceneMode = "printer" | "shredder";
export type FlowMachineSceneSize = "mini" | "full";

export interface FlowMachineSceneProps {
  size: FlowMachineSceneSize;
  mode: FlowMachineSceneMode;
  intensity: number;
  statusText: string;
  title?: string;
  subText?: string;
  accentHex?: string;
  stress?: number;
  className?: string;
}

interface PrinterDims {
  containerClass: string;
  areaClass: string;
  topShellTop: number;
  topShellW: number;
  topShellH: number;
  bodyTop: number;
  bodyW: number;
  bodyH: number;
  slotTop: number;
  slotW: number;
  slotH: number;
  rollerTop: number;
  rollerW: number;
  rollerH: number;
  rollerLeftOffset: number;
  rollerRightOffset: number;
  crankTop: number;
  crankLeftOffset: number;
  crankBox: number;
  crankBarW: number;
  crankKnob: number;
  sheetTop: number;
  sheetW: number;
  sheetH: number;
  outputTop: number;
  noteW: number;
  noteH: number;
  emissionOffset: number;
  hasStatusLight: boolean;
  statusLightTop: number;
  statusLightLeftOffset: number;
  statusLightSize: number;
}

interface ShredderDims {
  containerClass: string;
  areaClass: string;
  hopperTop: number;
  hopperW: number;
  hopperH: number;
  feedSlotTop: number;
  feedSlotW: number;
  feedSlotH: number;
  bodyTop: number;
  bodyW: number;
  bodyH: number;
  cutterTop: number;
  cutterW: number;
  cutterH: number;
  cutterTeethTop: number;
  cutterTeethW: number;
  cutterTeethCount: number;
  outputTop: number;
  outputW: number;
  outputH: number;
  lightTop: number;
  lightLeftOffset: number;
  lightSize: number;
  billSpawnTop: number;
  billW: number;
  billH: number;
  billEmitOffset: number;
  billEnterDrop: number;
  stripSpawnTop: number;
  stripW: number;
  stripH: number;
  stripDropBase: number;
  stripSpread: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function calcOffset(offset: number): string {
  return `calc(50% ${offset >= 0 ? "+" : "-"} ${Math.abs(offset)}px)`;
}

const MINI_PRINTER_DIMS: PrinterDims = {
  containerClass: "relative h-[210px] overflow-hidden rounded-xl border border-border/60 bg-background/40 p-3",
  areaClass: "relative mt-2 h-[160px]",
  topShellTop: 12,
  topShellW: 96,
  topShellH: 48,
  bodyTop: 48,
  bodyW: 192,
  bodyH: 80,
  slotTop: 84,
  slotW: 144,
  slotH: 12,
  rollerTop: 96,
  rollerW: 36,
  rollerH: 16,
  rollerLeftOffset: -66,
  rollerRightOffset: 32,
  crankTop: 89,
  crankLeftOffset: 82,
  crankBox: 32,
  crankBarW: 28,
  crankKnob: 14,
  sheetTop: 22,
  sheetW: 64,
  sheetH: 40,
  outputTop: 86,
  noteW: 32,
  noteH: 18,
  emissionOffset: 12,
  hasStatusLight: false,
  statusLightTop: 0,
  statusLightLeftOffset: 0,
  statusLightSize: 0,
};

const FULL_PRINTER_DIMS: PrinterDims = {
  containerClass: "relative overflow-hidden rounded-xl border border-border/60 bg-background/40 p-4",
  areaClass: "relative mt-4 h-[178px]",
  topShellTop: 8,
  topShellW: 128,
  topShellH: 64,
  bodyTop: 56,
  bodyW: 224,
  bodyH: 96,
  slotTop: 88,
  slotW: 176,
  slotH: 12,
  rollerTop: 104,
  rollerW: 40,
  rollerH: 16,
  rollerLeftOffset: -84,
  rollerRightOffset: 44,
  crankTop: 89,
  crankLeftOffset: 97,
  crankBox: 40,
  crankBarW: 36,
  crankKnob: 16,
  sheetTop: 18,
  sheetW: 96,
  sheetH: 56,
  outputTop: 92,
  noteW: 36,
  noteH: 20,
  emissionOffset: 16,
  hasStatusLight: true,
  statusLightTop: 72,
  statusLightLeftOffset: 86,
  statusLightSize: 16,
};

const MINI_SHREDDER_DIMS: ShredderDims = {
  containerClass: "relative h-[210px] overflow-hidden rounded-xl border border-border/60 bg-background/40 p-3",
  areaClass: "relative mt-2 h-[160px]",
  hopperTop: 8,
  hopperW: 114,
  hopperH: 40,
  feedSlotTop: 36,
  feedSlotW: 62,
  feedSlotH: 6,
  bodyTop: 46,
  bodyW: 186,
  bodyH: 96,
  cutterTop: 80,
  cutterW: 138,
  cutterH: 18,
  cutterTeethTop: 82,
  cutterTeethW: 122,
  cutterTeethCount: 11,
  outputTop: 121,
  outputW: 104,
  outputH: 8,
  lightTop: 70,
  lightLeftOffset: 62,
  lightSize: 12,
  billSpawnTop: 18,
  billW: 34,
  billH: 20,
  billEmitOffset: 0,
  billEnterDrop: 54,
  stripSpawnTop: 124,
  stripW: 6,
  stripH: 18,
  stripDropBase: 46,
  stripSpread: 52,
};

const FULL_SHREDDER_DIMS: ShredderDims = {
  containerClass: "relative overflow-hidden rounded-xl border border-border/60 bg-background/40 p-4",
  areaClass: "relative mt-4 h-[178px]",
  hopperTop: 8,
  hopperW: 132,
  hopperH: 46,
  feedSlotTop: 38,
  feedSlotW: 74,
  feedSlotH: 7,
  bodyTop: 50,
  bodyW: 214,
  bodyH: 106,
  cutterTop: 88,
  cutterW: 162,
  cutterH: 20,
  cutterTeethTop: 90,
  cutterTeethW: 146,
  cutterTeethCount: 13,
  outputTop: 138,
  outputW: 126,
  outputH: 9,
  lightTop: 73,
  lightLeftOffset: 86,
  lightSize: 16,
  billSpawnTop: 20,
  billW: 38,
  billH: 22,
  billEmitOffset: 0,
  billEnterDrop: 60,
  stripSpawnTop: 141,
  stripW: 7,
  stripH: 20,
  stripDropBase: 54,
  stripSpread: 70,
};

interface PrinterMachineProps {
  size: FlowMachineSceneSize;
  intensity: number;
  stress: number;
  accentHex: string;
}

function PrinterMachine({ size, intensity, stress, accentHex }: PrinterMachineProps) {
  const isMini = size === "mini";
  const dims = isMini ? MINI_PRINTER_DIMS : FULL_PRINTER_DIMS;

  const power = clamp(intensity, 0.08, 1);
  const stressFactor = clamp(stress, 0, 1);
  const easedPower = Math.pow(power, isMini ? 1.35 : 1.45);
  const surgeBoost = !isMini && power > 0.72 ? Math.pow((power - 0.72) / 0.28, 1.15) : 0;

  const sheetCount = clamp(
    Math.round(4 + easedPower * (isMini ? 14 : 9) + surgeBoost * 24 - stressFactor * 2),
    isMini ? 4 : 3,
    isMini ? 18 : 38,
  );
  const baseDuration = clamp(
    (isMini ? 2.2 : 2.35) - easedPower * (isMini ? 1.4 : 1.25) - surgeBoost * 0.48 + stressFactor * 0.24,
    isMini ? 0.55 : 0.36,
    isMini ? 2.2 : 2.45,
  );
  const rollerDuration = clamp(
    (isMini ? 1.8 : 1.85) - easedPower * 1.2 - surgeBoost * 0.34 + stressFactor * 0.2,
    isMini ? 0.5 : 0.32,
    isMini ? 1.8 : 1.95,
  );
  const crankDuration = clamp(
    (isMini ? 2.5 : 2.8) - Math.pow(power, 1.9) * (isMini ? 1.8 : 2.3),
    isMini ? 0.45 : 0.34,
    isMini ? 2.5 : 2.8,
  );
  const durationStep = clamp(
    (isMini ? 0.16 : 0.22) - power * 0.1,
    isMini ? 0.06 : 0.05,
    isMini ? 0.16 : 0.22,
  );
  const delayStep = clamp(
    (isMini ? 0.16 : 0.18) - power * 0.1,
    isMini ? 0.06 : 0.04,
    isMini ? 0.16 : 0.18,
  );

  const glowOpacity = 0.2 + power * 0.55 + surgeBoost * 0.2;
  const coneIntensity = Math.pow(power, 1.6);
  const spreadX = (isMini ? 42 : 52) + Math.round(coneIntensity * (isMini ? 78 : 100) + surgeBoost * 32);
  const riseBase = (isMini ? 34 : 26) + Math.round(coneIntensity * (isMini ? 56 : 58) + surgeBoost * 20);
  const riseStep = isMini ? 7 : 6 + Math.round(coneIntensity * 14);

  const crankKick = `${((1 - power) * 8.5).toFixed(2)}deg`;
  const crankWobble = `${((1 - power) * 2.8).toFixed(2)}px`;
  const isCrankChoppy = power < 0.58;
  const crankStyle: CssVarStyle = {
    animationDuration: `${crankDuration.toFixed(2)}s`,
    "--crank-kick": crankKick,
    "--crank-wobble": crankWobble,
  };

  const spreadPattern = power < 0.45
    ? [-0.45, -0.28, -0.12, 0, 0.12, 0.28, 0.45]
    : [-1, -0.82, -0.64, -0.46, -0.28, -0.1, 0, 0.1, 0.28, 0.46, 0.64, 0.82, 1];

  return (
    <div className={dims.areaClass}>
      <div
        className="pointer-events-none absolute left-1/2 -translate-x-1/2 rounded-t-xl border border-slate-600/70 bg-slate-700/70"
        style={{
          top: `${dims.topShellTop}px`,
          width: `${dims.topShellW}px`,
          height: `${dims.topShellH}px`,
          boxShadow: `0 0 20px ${accentHex}55`,
        }}
      />
      <div
        className="pointer-events-none absolute left-1/2 -translate-x-1/2 rounded-2xl border border-slate-600/80 bg-slate-900/85 shadow-[inset_0_-14px_24px_rgba(0,0,0,0.35)]"
        style={{ top: `${dims.bodyTop}px`, width: `${dims.bodyW}px`, height: `${dims.bodyH}px` }}
      />
      <div
        className="pointer-events-none absolute left-1/2 -translate-x-1/2 rounded border border-slate-700/80 bg-black/55"
        style={{ top: `${dims.slotTop}px`, width: `${dims.slotW}px`, height: `${dims.slotH}px` }}
      />

      <div
        className="pointer-events-none absolute rounded-full border border-slate-500/70 bg-slate-500/45 fm-roller"
        style={{
          top: `${dims.rollerTop}px`,
          left: calcOffset(dims.rollerLeftOffset),
          width: `${dims.rollerW}px`,
          height: `${dims.rollerH}px`,
          animationDuration: `${rollerDuration.toFixed(2)}s`,
        }}
      />
      <div
        className="pointer-events-none absolute rounded-full border border-slate-500/70 bg-slate-500/45 fm-roller"
        style={{
          top: `${dims.rollerTop}px`,
          left: calcOffset(dims.rollerRightOffset),
          width: `${dims.rollerW}px`,
          height: `${dims.rollerH}px`,
          animationDuration: `${(rollerDuration * 0.92).toFixed(2)}s`,
        }}
      />

      {dims.hasStatusLight ? (
        <div
          className="pointer-events-none absolute rounded-full border border-emerald-300/45 bg-emerald-400/25 fm-light"
          style={{
            top: `${dims.statusLightTop}px`,
            left: calcOffset(dims.statusLightLeftOffset),
            width: `${dims.statusLightSize}px`,
            height: `${dims.statusLightSize}px`,
            animationDuration: `${(1.8 - power).toFixed(2)}s`,
            boxShadow: `0 0 12px rgba(52,211,153,${glowOpacity})`,
          }}
        />
      ) : null}

      <div
        className={cn(
          "pointer-events-none absolute origin-[2px_50%]",
          isCrankChoppy ? "fm-crank-stutter" : "fm-crank",
        )}
        style={{
          ...crankStyle,
          top: `${dims.crankTop}px`,
          left: calcOffset(dims.crankLeftOffset),
          width: `${dims.crankBox}px`,
          height: `${dims.crankBox}px`,
        }}
      >
        <div
          className="absolute left-0 top-1/2 -translate-y-1/2 rounded bg-slate-300/85"
          style={{ width: `${dims.crankBarW}px`, height: "3px" }}
        />
        <div
          className="absolute right-0 top-1/2 -translate-y-1/2 rounded-full border border-slate-500/80 bg-slate-200/90"
          style={{ width: `${dims.crankKnob}px`, height: `${dims.crankKnob}px` }}
        />
      </div>

      <div
        className="pointer-events-none absolute left-1/2 -translate-x-1/2 rounded border border-slate-500/70 bg-gradient-to-b from-slate-300/70 to-slate-200/25"
        style={{ top: `${dims.sheetTop}px`, width: `${dims.sheetW}px`, height: `${dims.sheetH}px` }}
      />

      {Array.from({ length: sheetCount }).map((_, i) => {
        const seed = Math.abs(Math.sin((i + 1) * 12.9898) * 43758.5453);
        const chaos = seed - Math.floor(seed);
        const dxJitter = Math.round((chaos - 0.5) * (6 + power * 28 + surgeBoost * 18));
        const dyJitter = Math.round((chaos - 0.5) * (8 + power * 16));
        const rot = -28 + (i % 8) * 8 + Math.round((chaos - 0.5) * (12 + surgeBoost * 14));
        const dx = Math.round(spreadPattern[i % spreadPattern.length] * spreadX) + dxJitter;
        const dy = riseBase + (i % 8) * riseStep + dyJitter;
        const misfeed = !isMini && stressFactor > 0.02 && i % (stressFactor > 0.33 ? 4 : 6) === 0;
        const misfeedDrop = `${(22 + stressFactor * 56 + (i % 3) * 12).toFixed(0)}px`;
        const misfeedDx = `${Math.round((chaos - 0.5) * 44)}px`;
        const style: CssVarStyle = {
          left: calcOffset(dims.emissionOffset),
          top: `${dims.outputTop}px`,
          width: `${dims.noteW}px`,
          height: `${dims.noteH}px`,
          animationDuration: `${(baseDuration + (i % 6) * durationStep).toFixed(2)}s`,
          animationDelay: `${(-i * delayStep).toFixed(2)}s`,
          "--paper-dx": `${dx}px`,
          "--paper-dy": `${dy}px`,
          "--note-rot": `${rot}deg`,
          "--misfeed-drop": misfeedDrop,
          "--misfeed-dx": misfeedDx,
          "--misfeed-rot": `${Math.round(rot * 0.45)}deg`,
        };

        return (
          <div
            key={i}
            className={cn(
              "pointer-events-none absolute flex -translate-x-1/2 items-center justify-center rounded-sm border border-emerald-500/45 bg-emerald-300/75 text-emerald-950",
              misfeed ? "fm-paper-misfeed" : "fm-paper-fly",
            )}
            style={style}
          >
            <Banknote className={cn(isMini ? "h-2.5 w-2.5" : "h-3 w-3")} />
          </div>
        );
      })}

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

interface ShredderMachineProps {
  size: FlowMachineSceneSize;
  intensity: number;
}

function ShredderMachine({ size, intensity }: ShredderMachineProps) {
  const isMini = size === "mini";
  const dims = isMini ? MINI_SHREDDER_DIMS : FULL_SHREDDER_DIMS;
  const power = clamp(intensity, 0.08, 1);

  const billCount = clamp(
    Math.round((isMini ? 4 : 6) + power * (isMini ? 12 : 20)),
    isMini ? 4 : 6,
    isMini ? 14 : 26,
  );
  const stripCount = clamp(
    Math.round((isMini ? 18 : 24) + power * (isMini ? 24 : 40)),
    isMini ? 18 : 24,
    isMini ? 42 : 64,
  );

  const billDuration = clamp((isMini ? 2.0 : 1.85) - power * 0.95, 0.45, isMini ? 2.0 : 1.85);
  const stripDuration = clamp((isMini ? 2.2 : 2.0) - power * 0.9, 0.5, isMini ? 2.2 : 2.0);
  const billDelayStep = clamp((isMini ? 0.14 : 0.12) - power * 0.05, 0.03, isMini ? 0.14 : 0.12);
  const stripDelayStep = clamp((isMini ? 0.06 : 0.05) - power * 0.02, 0.015, isMini ? 0.06 : 0.05);
  const jitterDuration = clamp(0.9 - power * 0.35, 0.35, 0.9);

  const billSpread = (isMini ? 20 : 28) + Math.round(power * (isMini ? 14 : 22));
  const stripSpread = dims.stripSpread + Math.round(power * (isMini ? 20 : 26));
  const stripDrop = dims.stripDropBase + Math.round(power * (isMini ? 28 : 34));

  const billPattern = [-0.42, -0.3, -0.18, -0.08, 0, 0.08, 0.18, 0.3, 0.42];
  const stripPattern = [
    -1,
    -0.88,
    -0.76,
    -0.64,
    -0.52,
    -0.4,
    -0.28,
    -0.16,
    -0.08,
    0,
    0.08,
    0.16,
    0.28,
    0.4,
    0.52,
    0.64,
    0.76,
    0.88,
    1,
  ];

  return (
    <div className={dims.areaClass}>
      {Array.from({ length: billCount }).map((_, i) => {
        const seed = Math.abs(Math.sin((i + 1) * 17.113) * 43758.5453);
        const chaos = seed - Math.floor(seed);
        const dx = Math.round(billPattern[i % billPattern.length] * billSpread) + Math.round((chaos - 0.5) * 8);
        const drop = dims.billEnterDrop + (i % 3) * (isMini ? 4 : 5) + Math.round((chaos - 0.5) * 6);
        const rot = -8 + (chaos - 0.5) * 20;
        const style: CssVarStyle = {
          left: calcOffset(dims.billEmitOffset),
          top: `${dims.billSpawnTop}px`,
          width: `${dims.billW}px`,
          height: `${dims.billH}px`,
          animationDuration: `${(billDuration + (i % 4) * 0.05).toFixed(2)}s`,
          animationDelay: `${(-i * billDelayStep).toFixed(2)}s`,
          "--bill-dx": `${dx}px`,
          "--bill-drop": `${drop}px`,
          "--bill-rot": `${rot.toFixed(2)}deg`,
        };
        return (
          <div key={`bill-${i}`} className="pointer-events-none absolute z-10 rounded-sm border border-red-500/50 bg-red-300/85 text-red-950 sh-bill-feed" style={style}>
            <div className="flex h-full w-full items-center justify-center">
              <Banknote className={cn(isMini ? "h-2.5 w-2.5" : "h-3 w-3")} />
            </div>
          </div>
        );
      })}

      <div
        className="pointer-events-none absolute left-1/2 z-20 -translate-x-1/2 rounded-[14px] border border-zinc-500/70 bg-gradient-to-b from-zinc-500/80 to-zinc-700/90"
        style={{
          top: `${dims.hopperTop}px`,
          width: `${dims.hopperW}px`,
          height: `${dims.hopperH}px`,
          clipPath: "polygon(12% 0%, 88% 0%, 100% 100%, 0% 100%)",
          boxShadow: `0 0 16px rgba(248,113,113,${(0.2 + power * 0.35).toFixed(3)})`,
        }}
      />

      <div
        className="pointer-events-none absolute left-1/2 z-[25] -translate-x-1/2 rounded border border-zinc-900/80 bg-black/70"
        style={{ top: `${dims.feedSlotTop}px`, width: `${dims.feedSlotW}px`, height: `${dims.feedSlotH}px` }}
      />

      <div
        className="pointer-events-none absolute left-1/2 z-30 -translate-x-1/2 rounded-2xl border border-zinc-700/80 bg-zinc-900/95 sh-machine-vibe"
        style={{
          top: `${dims.bodyTop}px`,
          width: `${dims.bodyW}px`,
          height: `${dims.bodyH}px`,
          animationDuration: `${jitterDuration.toFixed(2)}s`,
        }}
      />

      <div
        className="pointer-events-none absolute left-1/2 z-[35] -translate-x-1/2 rounded border border-red-700/80"
        style={{
          top: `${dims.cutterTop}px`,
          width: `${dims.cutterW}px`,
          height: `${dims.cutterH}px`,
          background:
            "repeating-linear-gradient(135deg, rgba(239,68,68,0.6) 0px, rgba(239,68,68,0.6) 8px, rgba(15,23,42,0.55) 8px, rgba(15,23,42,0.55) 14px)",
        }}
      />

      <div
        className="pointer-events-none absolute left-1/2 z-40 flex -translate-x-1/2 justify-between"
        style={{ top: `${dims.cutterTeethTop}px`, width: `${dims.cutterTeethW}px`, paddingLeft: "6px", paddingRight: "6px" }}
      >
        {Array.from({ length: dims.cutterTeethCount }).map((_, i) => (
          <span key={`tooth-${i}`} className="h-2 w-2 rounded-b-sm bg-red-300/80" />
        ))}
      </div>

      <div
        className="pointer-events-none absolute left-1/2 z-[45] -translate-x-1/2 rounded border border-red-700/90 bg-red-950/75"
        style={{ top: `${dims.outputTop}px`, width: `${dims.outputW}px`, height: `${dims.outputH}px` }}
      />

      <div
        className="pointer-events-none absolute z-[45] rounded-full border border-red-300/45 bg-red-400/25 sh-light-blink"
        style={{
          top: `${dims.lightTop}px`,
          left: calcOffset(dims.lightLeftOffset),
          width: `${dims.lightSize}px`,
          height: `${dims.lightSize}px`,
          animationDuration: `${(1.35 - power * 0.42).toFixed(2)}s`,
          boxShadow: `0 0 12px rgba(248,113,113,${(0.45 + power * 0.35).toFixed(3)})`,
        }}
      />

      {Array.from({ length: stripCount }).map((_, i) => {
        const seed = Math.abs(Math.sin((i + 1) * 29.477) * 43758.5453);
        const chaos = seed - Math.floor(seed);
        const dx = Math.round(stripPattern[i % stripPattern.length] * stripSpread) + Math.round((chaos - 0.5) * 8);
        const drop = stripDrop + (i % 4) * (isMini ? 6 : 7) + Math.round((chaos - 0.5) * 12);
        const style: CssVarStyle = {
          left: "50%",
          top: `${dims.stripSpawnTop}px`,
          width: `${dims.stripW}px`,
          height: `${dims.stripH}px`,
          animationDuration: `${(stripDuration + (i % 5) * 0.04).toFixed(2)}s`,
          animationDelay: `${(-i * stripDelayStep).toFixed(2)}s`,
          "--strip-dx": `${dx}px`,
          "--strip-drop": `${drop}px`,
        };
        return <span key={`strip-${i}`} className="pointer-events-none absolute z-[15] rounded-sm border border-red-400/45 bg-red-300/80 sh-strip-fall" style={style} />;
      })}

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
            transform: translate(calc(-50% + var(--strip-dx)), var(--strip-drop)) scaleX(0.92) scaleY(1.38);
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
  const isMini = size === "mini";
  const isShredder = mode === "shredder";
  const modeTitle = title ?? (isShredder ? (isMini ? "Shredder" : "Shredder Desk") : (isMini ? "Printer" : "Printer Desk"));
  const containerClass = isMini ? MINI_PRINTER_DIMS.containerClass : FULL_PRINTER_DIMS.containerClass;

  const power = clamp(intensity, 0.08, 1);

  return (
    <div className={cn(containerClass, className)}>
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

      {/* Invariant: printer branch is intentionally preserved. Shredder is a fully separate implementation. */}
      {isShredder ? (
        <ShredderMachine size={size} intensity={power} />
      ) : (
        <PrinterMachine
          size={size}
          intensity={power}
          stress={stress}
          accentHex={accentHex ?? "rgba(16,185,129,0.6)"}
        />
      )}
    </div>
  );
}
