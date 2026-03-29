import type { CSSProperties } from "react";
import { clamp } from "@shared/lib/math";

export type CssVarStyle = CSSProperties & Record<`--${string}`, string | number>;

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
  centerOffset: number;
  billCenterOffset: number;
  stripCenterOffset: number;
  machineTop: number;
  machineW: number;
  machineH: number;
  machineRadius: number;
  slotY: number;
  slotW: number;
  slotH: number;
  slotGuideY: number;
  slotGuideW: number;
  slotGuideH: number;
  outputY: number;
  outputW: number;
  outputH: number;
  indicatorY: number;
  indicatorRight: number;
  indicatorSize: number;
  indicatorGap: number;
  billSpawnTop: number;
  billW: number;
  billH: number;
  billEmitOffset: number;
  billEnterDrop: number;
  stripW: number;
  stripH: number;
  stripDropBase: number;
  stripSpread: number;
}

function calcOffset(offset: number): string {
  return `calc(50% ${offset >= 0 ? "+" : "-"} ${Math.abs(offset)}px)`;
}

const BILL_PATTERN = [-0.2, -0.12, -0.06, 0, 0.06, 0.12, 0.2] as const;
const STRIP_PATTERN = [-0.72, -0.56, -0.4, -0.26, -0.14, -0.06, 0, 0.06, 0.14, 0.26, 0.4, 0.56, 0.72] as const;

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
  centerOffset: 96,
  billCenterOffset: 12,
  stripCenterOffset: 12,
  machineTop: 54,
  machineW: 190,
  machineH: 72,
  machineRadius: 14,
  slotY: 8,
  slotW: 94,
  slotH: 7,
  slotGuideY: 19,
  slotGuideW: 148,
  slotGuideH: 5,
  outputY: 49,
  outputW: 114,
  outputH: 8,
  indicatorY: 28,
  indicatorRight: 14,
  indicatorSize: 6,
  indicatorGap: 7,
  billSpawnTop: 4,
  billW: 34,
  billH: 20,
  billEmitOffset: 0,
  billEnterDrop: 63,
  stripW: 5,
  stripH: 18,
  stripDropBase: 42,
  stripSpread: 24,
};

const FULL_SHREDDER_DIMS: ShredderDims = {
  containerClass: "relative overflow-hidden rounded-xl border border-border/60 bg-background/40 p-4",
  areaClass: "relative mt-4 h-[178px]",
  centerOffset: 108,
  billCenterOffset: 14,
  stripCenterOffset: 14,
  machineTop: 58,
  machineW: 218,
  machineH: 78,
  machineRadius: 16,
  slotY: 9,
  slotW: 116,
  slotH: 8,
  slotGuideY: 21,
  slotGuideW: 170,
  slotGuideH: 5,
  outputY: 54,
  outputW: 132,
  outputH: 8,
  indicatorY: 30,
  indicatorRight: 16,
  indicatorSize: 7,
  indicatorGap: 8,
  billSpawnTop: 6,
  billW: 38,
  billH: 22,
  billEmitOffset: 0,
  billEnterDrop: 66,
  stripW: 6,
  stripH: 20,
  stripDropBase: 50,
  stripSpread: 30,
};

export function getFlowMachineContainerClass(size: FlowMachineSceneSize) {
  return size === "mini" ? MINI_PRINTER_DIMS.containerClass : FULL_PRINTER_DIMS.containerClass;
}

export function resolveFlowMachineTitle(
  size: FlowMachineSceneSize,
  mode: FlowMachineSceneMode,
  title?: string,
) {
  if (title) return title;
  if (mode === "shredder") {
    return size === "mini" ? "Shredder" : "Shredder Desk";
  }
  return size === "mini" ? "Printer" : "Printer Desk";
}

export function buildPrinterMachineModel(
  size: FlowMachineSceneSize,
  intensity: number,
  stress: number,
) {
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
  const durationStep = clamp((isMini ? 0.16 : 0.22) - power * 0.1, isMini ? 0.06 : 0.05, isMini ? 0.16 : 0.22);
  const delayStep = clamp((isMini ? 0.16 : 0.18) - power * 0.1, isMini ? 0.06 : 0.04, isMini ? 0.16 : 0.18);

  const glowOpacity = 0.2 + power * 0.55 + surgeBoost * 0.2;
  const coneIntensity = Math.pow(power, 1.6);
  const spreadX = (isMini ? 42 : 52) + Math.round(coneIntensity * (isMini ? 78 : 100) + surgeBoost * 32);
  const riseBase = (isMini ? 34 : 26) + Math.round(coneIntensity * (isMini ? 56 : 58) + surgeBoost * 20);
  const riseStep = isMini ? 7 : 6 + Math.round(coneIntensity * 14);

  const crankKick = `${((1 - power) * 8.5).toFixed(2)}deg`;
  const crankWobble = `${((1 - power) * 2.8).toFixed(2)}px`;
  const spreadPattern = power < 0.45
    ? [-0.45, -0.28, -0.12, 0, 0.12, 0.28, 0.45]
    : [-1, -0.82, -0.64, -0.46, -0.28, -0.1, 0, 0.1, 0.28, 0.46, 0.64, 0.82, 1];

  const sheets = Array.from({ length: sheetCount }).map((_, index) => {
    const seed = Math.abs(Math.sin((index + 1) * 12.9898) * 43758.5453);
    const chaos = seed - Math.floor(seed);
    const dxJitter = Math.round((chaos - 0.5) * (6 + power * 28 + surgeBoost * 18));
    const dyJitter = Math.round((chaos - 0.5) * (8 + power * 16));
    const rot = -28 + (index % 8) * 8 + Math.round((chaos - 0.5) * (12 + surgeBoost * 14));
    const dx = Math.round(spreadPattern[index % spreadPattern.length] * spreadX) + dxJitter;
    const dy = riseBase + (index % 8) * riseStep + dyJitter;
    const misfeed = !isMini && stressFactor > 0.02 && index % (stressFactor > 0.33 ? 4 : 6) === 0;

    return {
      key: index,
      className: misfeed ? "fm-paper-misfeed" : "fm-paper-fly",
      style: {
        left: calcOffset(dims.emissionOffset),
        top: `${dims.outputTop}px`,
        width: `${dims.noteW}px`,
        height: `${dims.noteH}px`,
        animationDuration: `${(baseDuration + (index % 6) * durationStep).toFixed(2)}s`,
        animationDelay: `${(-index * delayStep).toFixed(2)}s`,
        "--paper-dx": `${dx}px`,
        "--paper-dy": `${dy}px`,
        "--note-rot": `${rot}deg`,
        "--misfeed-drop": `${(22 + stressFactor * 56 + (index % 3) * 12).toFixed(0)}px`,
        "--misfeed-dx": `${Math.round((chaos - 0.5) * 44)}px`,
        "--misfeed-rot": `${Math.round(rot * 0.45)}deg`,
      } satisfies CssVarStyle,
    };
  });

  return {
    dims,
    isMini,
    power,
    glowOpacity,
    rollerDuration,
    crankStyle: {
      animationDuration: `${crankDuration.toFixed(2)}s`,
      "--crank-kick": crankKick,
      "--crank-wobble": crankWobble,
    } satisfies CssVarStyle,
    isCrankChoppy: power < 0.58,
    sheets,
  };
}

export function buildShredderMachineModel(size: FlowMachineSceneSize, intensity: number) {
  const isMini = size === "mini";
  const dims = isMini ? MINI_SHREDDER_DIMS : FULL_SHREDDER_DIMS;
  const power = clamp(intensity, 0.08, 1);

  const billCount = clamp(Math.round((isMini ? 4 : 6) + power * (isMini ? 10 : 16)), isMini ? 4 : 6, isMini ? 12 : 22);
  const stripCount = clamp(Math.round((isMini ? 14 : 18) + power * (isMini ? 18 : 24)), isMini ? 14 : 18, isMini ? 32 : 42);

  const billDuration = clamp((isMini ? 2.0 : 1.85) - power * 0.95, 0.45, isMini ? 2.0 : 1.85);
  const stripDuration = clamp((isMini ? 2.2 : 2.0) - power * 0.9, 0.5, isMini ? 2.2 : 2.0);
  const billDelayStep = clamp((isMini ? 0.14 : 0.12) - power * 0.05, 0.03, isMini ? 0.14 : 0.12);
  const stripDelayStep = clamp((isMini ? 0.06 : 0.05) - power * 0.02, 0.015, isMini ? 0.06 : 0.05);
  const jitterDuration = clamp(0.9 - power * 0.35, 0.35, 0.9);

  const billSpread = (isMini ? 6 : 8) + Math.round(power * (isMini ? 4 : 6));
  const stripSpread = dims.stripSpread + Math.round(power * (isMini ? 10 : 14));
  const stripDrop = dims.stripDropBase + Math.round(power * (isMini ? 24 : 30));

  return {
    dims,
    isMini,
    power,
    jitterDuration,
    machineCenterX: calcOffset(dims.centerOffset),
    billCenterX: calcOffset(dims.billCenterOffset + dims.billEmitOffset),
    stripCenterX: calcOffset(dims.stripCenterOffset),
    stripMaskTop: dims.machineTop + dims.outputY + dims.outputH - 1,
    stripMaskHeight: stripDrop + dims.stripH + (isMini ? 14 : 18),
    bills: Array.from({ length: billCount }).map((_, index) => {
      const seed = Math.abs(Math.sin((index + 1) * 17.113) * 43758.5453);
      const chaos = seed - Math.floor(seed);
      const dx = Math.round(BILL_PATTERN[index % BILL_PATTERN.length] * billSpread) + Math.round((chaos - 0.5) * 2);
      const drop = dims.machineTop + dims.slotY - dims.billSpawnTop + 1 + (index % 3) * (isMini ? 1 : 2) + Math.round((chaos - 0.5) * 2);
      const rot = -3 + (chaos - 0.5) * 8;
      return {
        key: `bill-${index}`,
        style: {
          left: calcOffset(dims.billCenterOffset + dims.billEmitOffset),
          top: `${dims.billSpawnTop}px`,
          width: `${dims.billW}px`,
          height: `${dims.billH}px`,
          animationDuration: `${(billDuration + (index % 4) * 0.05).toFixed(2)}s`,
          animationDelay: `${(-index * billDelayStep).toFixed(2)}s`,
          "--bill-dx": `${dx}px`,
          "--bill-drop": `${drop}px`,
          "--bill-rot": `${rot.toFixed(2)}deg`,
        } satisfies CssVarStyle,
      };
    }),
    strips: Array.from({ length: stripCount }).map((_, index) => {
      const seed = Math.abs(Math.sin((index + 1) * 29.477) * 43758.5453);
      const chaos = seed - Math.floor(seed);
      const dx = Math.round(STRIP_PATTERN[index % STRIP_PATTERN.length] * stripSpread) + Math.round((chaos - 0.5) * 4);
      const drop = stripDrop + (index % 4) * (isMini ? 5 : 6) + Math.round((chaos - 0.5) * 10);
      return {
        key: `strip-${index}`,
        style: {
          left: "50%",
          top: "0px",
          width: `${dims.stripW}px`,
          height: `${dims.stripH}px`,
          animationDuration: `${(stripDuration + (index % 5) * 0.04).toFixed(2)}s`,
          animationDelay: `${(-index * stripDelayStep).toFixed(2)}s`,
          "--strip-dx": `${dx}px`,
          "--strip-drop": `${drop}px`,
        } satisfies CssVarStyle,
      };
    }),
  };
}
