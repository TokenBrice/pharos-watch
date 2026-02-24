"use client";

import { useState } from "react";
import Image from "next/image";
import { CAUSE_META, CAUSE_HEX } from "@/lib/dead-stablecoins";
import { formatCurrency, formatDeathDate } from "@/lib/format";
import type { DeadStablecoin, CauseOfDeath } from "@/lib/types";

type TombSize = "lg" | "md" | "sm";

function getTombSize(peakMcap?: number): TombSize {
  if (!peakMcap) return "sm";
  if (peakMcap >= 1_000_000_000) return "lg";
  if (peakMcap >= 50_000_000) return "md";
  return "sm";
}

const SIZE = {
  lg: { w: "w-[160px]", h: "h-[240px]", arch: "rounded-t-[80px]", logo: 48 },
  md: { w: "w-[132px]", h: "h-[200px]", arch: "rounded-t-[66px]", logo: 40 },
  sm: { w: "w-[112px]", h: "h-[172px]", arch: "rounded-t-[56px]", logo: 34 },
} as const;

const CROSS_SIZE = {
  lg: { vw: 7, vh: 29, hw: 21, hh: 7, top: -26 },
  md: { vw: 6, vh: 24, hw: 18, hh: 6, top: -22 },
  sm: { vw: 5, vh: 21, hw: 16, hh: 5, top: -19 },
} as const;

// --- Shape variety ---

type TombShape = "arch" | "hammer" | "cross";

function getTombShape(cause: CauseOfDeath): TombShape {
  if (cause === "regulatory") return "hammer";
  if (cause === "abandoned") return "cross";
  return "arch";
}

// Hammer smashing the top of the tombstone — head on the arch, handle to the right
function HammerStrike({ size }: { size: TombSize }) {
  // SVG drawn horizontally: head on left, handle to right.
  // Then rotated so head points down-left onto the tombstone top.
  const scale = size === "lg" ? 1 : size === "md" ? 0.85 : 0.72;
  return (
    <div
      className="absolute z-20 pointer-events-none"
      style={{
        top: -14,
        right: -38 * scale,
        width: 90 * scale,
        height: 50 * scale,
      }}
    >
      <svg
        width="100%"
        height="100%"
        viewBox="0 0 90 50"
        fill="none"
        style={{ transform: "rotate(30deg)", transformOrigin: "18px 30px" }}
        aria-hidden="true"
      >
        {/* Handle — extends to the right */}
        <rect x="30" y="19" width="58" height="5" rx="2.5" fill="#9a7b4f" />
        <rect x="30" y="20" width="58" height="2.5" rx="1.2" fill="#b8956a" opacity="0.45" />

        {/* Head — claw hammer, vertical */}
        <path
          d="M10 6 L30 6 L30 14 L26 14 L24 10 L18 10 L16 14 L10 14Z"
          fill="#374151"
        />
        <path
          d="M10 14 L30 14 L30 34 L26 34 L24 30 L18 30 L16 34 L10 34Z"
          fill="#374151"
        />
        {/* Claw notch top */}
        <path
          d="M10 6 L14 10 L10 10Z"
          fill="#1f2937"
        />
        {/* Face bottom */}
        <rect x="12" y="30" width="16" height="3" rx="1" fill="#4b5563" opacity="0.5" />
        {/* Side bevel */}
        <rect x="28" y="8" width="3" height="24" rx="1" fill="#4b5563" opacity="0.35" />
      </svg>
    </div>
  );
}

// --- Weathering by age ---

function getDeathAgeYears(deathDate: string): number {
  const [year, month] = deathDate.split("-").map(Number);
  const deathMs = new Date(year, (month || 1) - 1).getTime();
  const nowMs = Date.now();
  return (nowMs - deathMs) / (365.25 * 24 * 60 * 60 * 1000);
}

function getWeathering(deathDate: string): { brightness: number; mossIntensity: number } {
  const age = getDeathAgeYears(deathDate);
  const brightness = Math.max(0.85, 1.0 - (age / 8) * 0.15);
  const mossIntensity = age < 3 ? 0 : Math.min(0.12, ((age - 3) / 5) * 0.12);
  return { brightness, mossIntensity };
}

function Tombstone({
  coin,
  index,
  onSelect,
}: {
  coin: DeadStablecoin;
  index: number;
  onSelect: (symbol: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const size = getTombSize(coin.peakMcap);
  const cfg = SIZE[size];
  const color = CAUSE_HEX[coin.causeOfDeath];
  const logoUrl = coin.logo ? `/logos/cemetery/${coin.logo}` : undefined;
  const staggerLevel = index % 3;
  const staggerClass = staggerLevel === 0 ? "mt-0" : staggerLevel === 1 ? "mt-3" : "mt-6";
  const rotation = (index % 3 - 1) * 0.5;

  const shape = getTombShape(coin.causeOfDeath);
  const topRounding = cfg.arch;

  // Weathering
  const { brightness, mossIntensity } = getWeathering(coin.deathDate);
  const mossShadow = mossIntensity > 0
    ? `inset 0 -6px 12px rgba(34,120,60,${mossIntensity})`
    : "";

  const buildBoxShadow = () => {
    const parts = ["inset 0 2px 4px rgba(0,0,0,0.15)"];
    if (mossShadow) parts.push(mossShadow);
    if (hovered) parts.push(`0 0 16px ${color}33`);
    return parts.join(", ");
  };

  // Cross dimensions
  const cross = CROSS_SIZE[size];

  return (
    <div
      className={`relative flex flex-col items-center ${staggerClass}`}
      tabIndex={0}
      role="button"
      aria-label={`${coin.symbol} — ${coin.name}, ${CAUSE_META[coin.causeOfDeath].label}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      onClick={() => onSelect(coin.symbol)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(coin.symbol);
        }
      }}
    >
      {/* Cross top for abandoned tombstones */}
      {shape === "cross" && (
        <div
          className="absolute z-0 pointer-events-none"
          style={{ top: cross.top }}
        >
          {/* Vertical bar */}
          <div
            className="absolute left-1/2 -translate-x-1/2 bg-stone-100 dark:bg-card border border-border"
            style={{ width: cross.vw, height: cross.vh, filter: `brightness(${brightness})` }}
          />
          {/* Horizontal bar */}
          <div
            className="absolute left-1/2 -translate-x-1/2 bg-stone-100 dark:bg-card border border-border"
            style={{
              width: cross.hw,
              height: cross.hh,
              top: 2,
              filter: `brightness(${brightness})`,
            }}
          />
        </div>
      )}

      <div
        className={`
          relative
          ${cfg.w} ${cfg.h} ${topRounding}
          bg-stone-100 dark:bg-card
          border border-border
          flex flex-col items-center justify-center gap-1.5
          cursor-pointer transition-all duration-200
          hover:-translate-y-1
        `}
        style={{
          borderTopWidth: "3px",
          borderTopColor: color,
          boxShadow: buildBoxShadow(),
          filter: `brightness(${brightness})`,
          transform: hovered
            ? "translateY(-4px) rotate(0deg)"
            : `rotate(${rotation}deg)`,
        }}
      >
        {/* Hammer smashing into tombstone for regulatory kills */}
        {shape === "hammer" && <HammerStrike size={size} />}

        <span className="text-[9px] text-muted-foreground/30 tracking-widest">
          R.I.P.
        </span>

        <div
          className="rounded-full overflow-hidden bg-muted flex items-center justify-center shrink-0"
          style={{ width: cfg.logo, height: cfg.logo }}
        >
          {logoUrl ? (
            <Image
              src={logoUrl}
              alt={coin.symbol}
              width={cfg.logo}
              height={cfg.logo}
              className={`rounded-full transition-all duration-300 ${hovered ? "" : "grayscale"}`}
              unoptimized
            />
          ) : (
            <span className="text-xs font-bold text-muted-foreground">
              {coin.symbol.charAt(0)}
            </span>
          )}
        </div>

        <span className="text-sm font-semibold line-through decoration-muted-foreground/50 text-center leading-tight">
          {coin.symbol}
        </span>

        <span className="text-[11px] font-mono tabular-nums text-muted-foreground">
          {formatDeathDate(coin.deathDate)}
        </span>

        {coin.epitaph && (
          <span className="text-[10px] italic text-muted-foreground/70 text-center leading-tight px-1.5">
            {coin.epitaph}
          </span>
        )}
      </div>

      {/* Tooltip */}
      {hovered && (
        <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 z-30 w-56 rounded-lg border bg-popover p-3 text-xs shadow-lg pointer-events-none">
          <p className="font-semibold">{coin.name}</p>
          <p className="text-muted-foreground mt-1 leading-relaxed">
            {coin.obituary.split(". ")[0]}.
          </p>
          <div className="mt-1.5 flex items-center justify-between">
            <span className={CAUSE_META[coin.causeOfDeath].textColor}>
              {CAUSE_META[coin.causeOfDeath].label}
            </span>
            {coin.peakMcap && (
              <span className="font-mono tabular-nums text-muted-foreground">
                {formatCurrency(coin.peakMcap, 1)}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface CemeteryTombstonesProps {
  coins: DeadStablecoin[];
  onSelect: (symbol: string) => void;
}

export function CemeteryTombstones({ coins, onSelect }: CemeteryTombstonesProps) {
  return (
    <div>
      <div className="relative pb-8">
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-x-5 gap-y-8 justify-items-center pt-6 pb-4">
          {coins.map((coin, i) => (
            <Tombstone
              key={coin.symbol}
              coin={coin}
              index={i}
              onSelect={onSelect}
            />
          ))}
        </div>

        {/* Ground gradient */}
        <div className="absolute bottom-0 left-0 right-0 h-10 bg-gradient-to-t from-emerald-950/15 dark:from-emerald-950/25 to-transparent pointer-events-none" />
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-3 pt-3 border-t mt-2">
        {Object.entries(CAUSE_META).map(([key, meta]) => (
          <div key={key} className="flex items-center gap-1.5">
            <div
              className="h-2.5 w-2.5 rounded-sm"
              style={{ backgroundColor: CAUSE_HEX[key as CauseOfDeath] }}
            />
            <span className="text-xs text-muted-foreground">
              {meta.label}
            </span>
          </div>
        ))}
        <span className="ml-auto text-[10px] text-muted-foreground/50 italic">
          Tombstone size reflects peak market cap
        </span>
      </div>
    </div>
  );
}
