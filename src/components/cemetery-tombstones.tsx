"use client";

import { memo, useState, useEffect, useCallback, useMemo, useRef, type CSSProperties } from "react";
import Image from "next/image";
import { CAUSE_META, CAUSE_HEX } from "@shared/lib/dead-stablecoins";
import type { CemeteryEntry } from "@shared/lib/cemetery-merged";
import { formatCurrency, formatDeathDate, formatYearMonth } from "@shared/lib/format";
import type { CauseOfDeath } from "@shared/types";
import { buildCemeteryYearSections } from "@/lib/cemetery";
import { YEAR_MS } from "@/lib/constants";
import { EDITORIAL_BODY_STYLE } from "@/lib/digest";
import { digestDisplay } from "@/lib/fonts/digest";
import { cn } from "@/lib/utils";
import styles from "./cemetery-tombstones.module.css";

/**
 * Visual note: SVG illustrations (hammer, flowers) use semantic CSS variables with
 * hex fallbacks so they adapt to both light and dark themes. The cemetery scene uses
 * local CSS modules because its atmosphere is a one-off memorial treatment.
 *
 * Editorial treatment: cemetery entries with a Newsreader display title in
 * `EDITORIAL_TITLES` are promoted to authored obituaries — kicker + serif
 * headline + Courier-italic body + cause-of-death byline chip. The map is
 * hand-curated to entries with strong factual grounding; the long tail of
 * decommissioned coins keeps the structural plaque treatment so the cemetery
 * never asserts more than the historical record supports.
 */

const EDITORIAL_TITLES: Record<string, string> = {
  "ust-terrausd-2022-05":
    "How TerraUSD lost its peg and $40 billion in 72 hours",
  "busd-binance-usd-2023-02":
    "How a regulator quietly ended the third-largest stablecoin",
  "iron-iron-2021-06":
    "How crypto's first bank run ate Iron Finance in eight hours",
  "esd-empty-set-dollar-2021-01":
    "How seigniorage coupons promised stability and delivered ruin",
  "bac-basis-cash-2021-01":
    "How Do Kwon's first stablecoin failed before he built the second",
  "usdn-neutrino-usd-2022-04":
    "How WAVES collateral dragged Neutrino USD into its own gravity well",
  "fei-fei-usd-2022-08":
    "How a $1.3B launch ended in a 1:1 DAI redemption vote",
  "husd-husd-2022-10":
    "How Justin Sun's Huobi acquisition unwound HUSD overnight",
  "dsd-dynamic-set-dollar-2021-01":
    "How Dynamic Set Dollar discovered faster reflexivity cuts both ways",
  "vai-vai-2021-09":
    "How Venus's $77M bad-debt crisis broke its native stablecoin",
  "tor-tor-2023-07":
    "How the Multichain exploit ended Hector Network's stablecoin",
};

type TombSize = "lg" | "md" | "sm";

function getTombSize(peakMcap?: number): TombSize {
  if (!peakMcap) return "sm";
  if (peakMcap >= 1_000_000_000) return "lg";
  if (peakMcap >= 50_000_000) return "md";
  return "sm";
}

const SIZE = {
  lg: { w: "w-[160px]", h: "h-[240px]", arch: "rounded-t-[80px]", logo: 48, px: 160, heightPx: 240 },
  md: { w: "w-[132px]", h: "h-[200px]", arch: "rounded-t-[66px]", logo: 40, px: 132, heightPx: 200 },
  sm: { w: "w-[112px]", h: "h-[172px]", arch: "rounded-t-[56px]", logo: 34, px: 112, heightPx: 172 },
} as const;

const CROSS_SIZE = {
  lg: { vw: 7, vh: 29, hw: 21, hh: 7, top: -26 },
  md: { vw: 6, vh: 24, hw: 18, hh: 6, top: -22 },
  sm: { vw: 5, vh: 21, hw: 16, hh: 5, top: -19 },
} as const;

// --- Flower for "Press F to pay respects" ---

const FLOWER_COLORS = ["#f9a8d4", "#fde68a", "#c4b5fd", "#e5e7eb"] as const;

function Flower({ index, tombWidth }: { index: number; tombWidth: number }) {
  const color = FLOWER_COLORS[index % FLOWER_COLORS.length];
  // Scatter flowers within the tombstone width, wrapping into rows
  const perRow = Math.max(3, Math.floor(tombWidth / 16));
  const row = Math.floor(index / perRow);
  const col = index % perRow;
  // Deterministic jitter from index
  const jx = ((index * 7 + 3) % 11) - 5;
  const jy = ((index * 13 + 5) % 9) - 4;
  const x = (col - (perRow - 1) / 2) * 14 + jx;
  const y = row * 14 + jy;
  return (
    <svg
      width="14"
      height="16"
      viewBox="0 0 14 16"
      fill="none"
      aria-hidden="true"
      className="animate-in fade-in duration-300"
      style={{
        position: "absolute",
        bottom: y,
        left: `calc(50% + ${x}px - 7px)`,
      }}
    >
      {/* Stem */}
      <line x1="7" y1="16" x2="7" y2="7" stroke="var(--severity-healthy-hex, #4ade80)" strokeWidth="1.5" />
      {/* Petals */}
      <circle cx="7" cy="5" r="2.5" fill={color} opacity="0.85" />
      <circle cx="4.5" cy="6.5" r="2.5" fill={color} opacity="0.75" />
      <circle cx="9.5" cy="6.5" r="2.5" fill={color} opacity="0.75" />
      <circle cx="5.2" cy="3.8" r="2.5" fill={color} opacity="0.7" />
      <circle cx="8.8" cy="3.8" r="2.5" fill={color} opacity="0.7" />
      {/* Center */}
      <circle cx="7" cy="5.5" r="1.5" fill="#facc15" />
    </svg>
  );
}

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
        <rect x="30" y="19" width="58" height="5" rx="2.5" fill="var(--text-secondary, #9a7b4f)" />
        <rect x="30" y="20" width="58" height="2.5" rx="1.2" fill="var(--border-default, #b8956a)" opacity="0.45" />

        {/* Head — claw hammer, vertical */}
        <path
          d="M10 6 L30 6 L30 14 L26 14 L24 10 L18 10 L16 14 L10 14Z"
          fill="var(--text-secondary, #374151)"
        />
        <path
          d="M10 14 L30 14 L30 34 L26 34 L24 30 L18 30 L16 34 L10 34Z"
          fill="var(--text-secondary, #374151)"
        />
        {/* Claw notch top */}
        <path
          d="M10 6 L14 10 L10 10Z"
          fill="var(--text-primary, #1f2937)"
        />
        {/* Face bottom */}
        <rect x="12" y="30" width="16" height="3" rx="1" fill="var(--border-strong, #4b5563)" opacity="0.5" />
        {/* Side bevel */}
        <rect x="28" y="8" width="3" height="24" rx="1" fill="var(--border-strong, #4b5563)" opacity="0.35" />
      </svg>
    </div>
  );
}

// --- Weathering by age ---

function getDeathAgeYears(deathDate: string): number {
  const [year, month] = deathDate.split("-").map(Number);
  const deathMs = new Date(year, (month || 1) - 1).getTime();
  const nowMs = Date.now();
  return (nowMs - deathMs) / YEAR_MS;
}

function getWeathering(deathDate: string): { brightness: number; mossIntensity: number } {
  const age = getDeathAgeYears(deathDate);
  const brightness = Math.max(0.85, 1.0 - (age / 8) * 0.15);
  const mossIntensity = age < 3 ? 0 : Math.min(0.12, ((age - 3) / 5) * 0.12);
  return { brightness, mossIntensity };
}

function getObituaryLead(obituary: string): string {
  const [lead] = obituary.split(". ");
  return lead.endsWith(".") ? lead : `${lead}.`;
}

function getObituaryPreview(obituary: string, isEditorial: boolean): string {
  if (!isEditorial) return getObituaryLead(obituary);

  const sentences = obituary.match(/[^.!?]+[.!?]+(?:\s|$)/g) ?? [obituary];
  const preview = sentences.slice(0, 2).join(" ").trim();
  const bounded = preview.length > 380 ? `${preview.slice(0, 377).trimEnd()}...` : preview;
  return bounded || getObituaryLead(obituary);
}

function getCemeteryLogoUrl(logo?: string): string | undefined {
  if (!logo) return undefined;
  return logo.startsWith("/") ? logo : `/logos/cemetery/${logo}`;
}

function Tombstone({
  coin,
  index,
  onSelect,
  flowerCount,
  onPayRespects,
  isEditorial,
}: {
  coin: CemeteryEntry;
  index: number;
  onSelect: (coinId: string) => void;
  flowerCount: number;
  onPayRespects: (coinId: string) => void;
  isEditorial: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const tombRef = useRef<HTMLDivElement>(null);
  const [tooltipShift, setTooltipShift] = useState(0);

  const updateTooltipShift = useCallback(() => {
    if (!tombRef.current) {
      setTooltipShift(0);
      return;
    }
    const rect = tombRef.current.getBoundingClientRect();
    const tooltipW = 320;
    const center = rect.left + rect.width / 2;
    const leftOverflow = 8 - (center - tooltipW / 2);
    const rightOverflow = center + tooltipW / 2 - (window.innerWidth - 8);
    setTooltipShift(leftOverflow > 0 ? leftOverflow : rightOverflow > 0 ? -rightOverflow : 0);
  }, []);

  const activateHover = useCallback(() => {
    setHovered(true);
    updateTooltipShift();
  }, [updateTooltipShift]);

  // "Press F to pay respects" — listen while hovered
  const handleF = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "f" || e.key === "F") {
        if (e.target === tombRef.current) return;
        onPayRespects(coin.id);
      }
    },
    [coin.id, onPayRespects],
  );

  useEffect(() => {
    if (!hovered) return;
    document.addEventListener("keydown", handleF);
    return () => document.removeEventListener("keydown", handleF);
  }, [hovered, handleF]);
  const size = getTombSize(coin.peakMcap);
  const cfg = SIZE[size];
  const color = CAUSE_HEX[coin.causeOfDeath];
  const cause = CAUSE_META[coin.causeOfDeath];
  const logoUrl = getCemeteryLogoUrl(coin.logo);
  const staggerLevel = index % 3;
  const staggerOffset = staggerLevel * 10;
  const rotation = ((index % 5) - 2) * 0.65;

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
  const tombStyle = {
    "--tomb-accent": color,
    "--tomb-height": `${cfg.heightPx}px`,
    "--tomb-rotation": `${rotation}deg`,
    "--tomb-stagger": `${staggerOffset}px`,
    "--tomb-width": `${cfg.px}px`,
  } as CSSProperties;
  const tombstoneStyle: CSSProperties = {
    borderTopColor: color,
    borderTopWidth: "3px",
    boxShadow: buildBoxShadow(),
    filter: `brightness(${brightness})`,
  };

  return (
    <div
      ref={tombRef}
      className={cn("pharos-focus-ring cursor-pointer", styles.tombRoot)}
      style={tombStyle}
      tabIndex={0}
      role="button"
      aria-label={`${coin.symbol} — ${coin.name}, ${cause.label}`}
      onMouseEnter={activateHover}
      onMouseMove={() => {
        if (!hovered) activateHover();
      }}
      onMouseLeave={() => {
        setHovered(false);
        setTooltipShift(0);
      }}
      onFocus={activateHover}
      onBlur={() => {
        setHovered(false);
        setTooltipShift(0);
      }}
      onClick={() => onSelect(coin.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(coin.id);
        } else if (e.key === "f" || e.key === "F") {
          onPayRespects(coin.id);
        }
      }}
    >
      <span className={styles.graveMound} aria-hidden="true" />

      {/* Cross top for abandoned tombstones */}
      {shape === "cross" && (
        <div
          className="absolute z-0 pointer-events-none"
          style={{ top: cross.top, left: "50%", transform: "translateX(-50%)" }}
        >
          {/* Vertical bar */}
          <div
            className="absolute left-1/2 -translate-x-1/2 bg-stone-100 dark:bg-muted border border-border"
            style={{ width: cross.vw, height: cross.vh, filter: `brightness(${brightness})` }}
            suppressHydrationWarning
          />
          {/* Horizontal bar */}
          <div
            className="absolute left-1/2 -translate-x-1/2 bg-stone-100 dark:bg-muted border border-border"
            style={{
              width: cross.hw,
              height: cross.hh,
              top: 2,
              filter: `brightness(${brightness})`,
            }}
            suppressHydrationWarning
          />
        </div>
      )}

      <div
        className={cn(
          styles.tombstone,
          hovered && styles.tombstoneActive,
          "border",
          "flex flex-col items-center justify-center gap-1.5",
          cfg.w, cfg.h, topRounding,
        )}
        style={tombstoneStyle}
        // Weathering brightness/moss derive from the grave's age vs the current
        // time; in a static export the build-time value differs from the client
        // load-time value. The delta is cosmetic and imperceptible, so suppress
        // the hydration attribute mismatch rather than defer the paint.
        suppressHydrationWarning
      >
        {/* Hammer smashing into tombstone for regulatory kills */}
        {shape === "hammer" && <HammerStrike size={size} />}

        <span className={styles.rip} aria-hidden="true">
          R.I.P.
        </span>

        <div
          className={styles.logoWell}
          style={{ width: cfg.logo, height: cfg.logo }}
        >
          {logoUrl ? (
            <Image
              src={logoUrl}
              alt={`${coin.name} logo`}
              width={cfg.logo}
              height={cfg.logo}
              className={styles.logoImage}
              unoptimized
            />
          ) : (
            <span className="text-xs font-bold text-muted-foreground">
              {coin.symbol.charAt(0)}
            </span>
          )}
        </div>

        <span className={styles.symbol}>
          {coin.symbol}
        </span>

        <span className={cn(styles.deathDate, "text-[11px] font-mono tabular-nums text-muted-foreground/90")}>
          {formatDeathDate(coin.deathDate)}
        </span>

        {coin.epitaph && (
          <span className={cn(styles.epitaph, "px-2 text-center text-[11px] italic leading-snug text-muted-foreground/80")}>
            {coin.epitaph}
          </span>
        )}

        {/* Flowers — "Press F to pay respects" */}
        {flowerCount > 0 && (
          <div
            className="absolute left-0 right-0 pointer-events-none z-10"
            style={{ bottom: -4, height: Math.ceil(flowerCount / Math.max(3, Math.floor(cfg.px / 16))) * 14 + 20 }}
          >
            {Array.from({ length: flowerCount }, (_, i) => (
              <Flower key={i} index={i} tombWidth={cfg.px} />
            ))}
          </div>
        )}
      </div>

      {/* Editorial plaque — kicker, Newsreader display title (top-20 only),
          cause-of-death byline chip, Courier-italic obituary body, structural
          detail grid. The long-tail of cemetery entries (no display title and
          no peak mcap) keeps a tighter lead-only treatment so the cemetery
          never promotes more than the historical record supports. */}
      <div
        className={cn(styles.plaque, "pointer-events-none")}
        style={{ "--plaque-shift": `${tooltipShift}px` } as CSSProperties}
      >
        <div className="flex items-start gap-2.5">
          <span className={styles.plaqueLogo}>
            {logoUrl ? (
              <Image
                src={logoUrl}
                alt=""
                width={32}
                height={32}
                className="rounded-full"
                unoptimized
              />
            ) : (
              <span className="text-xs font-bold text-muted-foreground">{coin.symbol.charAt(0)}</span>
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="pharos-kicker block">
              Obituary &middot; {formatYearMonth(coin.deathDate)}
            </span>
            <span className="mt-1 block truncate text-[13px] font-semibold leading-tight text-popover-foreground">
              {coin.name}
              <span className="ml-1.5 font-mono text-[11px] font-normal tabular-nums text-muted-foreground">
                {coin.symbol}
              </span>
            </span>
          </span>
        </div>

        {isEditorial && EDITORIAL_TITLES[coin.id] && (
          <h3
            className={cn(
              digestDisplay.className,
              "mt-2.5 text-[1.05rem] font-semibold leading-[1.15] tracking-[-0.01em] text-popover-foreground [text-wrap:balance]",
            )}
          >
            {EDITORIAL_TITLES[coin.id]}
          </h3>
        )}

        <span
          className={cn(
            "mt-2 inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em]",
            cause.textColor,
            cause.borderColor,
          )}
        >
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: color }}
          />
          {cause.label}
        </span>

        <p
          className={cn(styles.plaqueObituary, "mt-2.5 text-[12px] leading-relaxed text-muted-foreground")}
          style={EDITORIAL_BODY_STYLE}
        >
          {getObituaryPreview(coin.obituary, isEditorial)}
        </p>

        <div className={styles.detailGrid}>
          <div className={styles.detailCell}>
            <div className="text-[10px] text-muted-foreground">Death</div>
            <div className="mt-0.5 font-mono text-[11px] tabular-nums text-popover-foreground">{formatDeathDate(coin.deathDate)}</div>
          </div>
          <div className={styles.detailCell}>
            <div className="text-[10px] text-muted-foreground">Peak</div>
            <div className="mt-0.5 font-mono text-[11px] tabular-nums text-popover-foreground">
              {coin.peakMcap ? formatCurrency(coin.peakMcap, 1) : "Unrecorded"}
            </div>
          </div>
          <div className={styles.detailCell}>
            <div className="text-[10px] text-muted-foreground">Peg</div>
            <div className="mt-0.5 font-mono text-[11px] text-popover-foreground">{coin.pegCurrency}</div>
          </div>
          <div className={styles.detailCell}>
            <div className="text-[10px] text-muted-foreground">Archive</div>
            <div className="mt-0.5 text-[11px] text-popover-foreground">
              {coin.archivedDataAvailable ? "Frozen page" : "Cemetery row"}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const MemoizedTombstone = memo(Tombstone);

interface CemeteryTombstonesProps {
  coins: CemeteryEntry[];
  onSelect: (coinId: string) => void;
}

export function CemeteryTombstones({ coins, onSelect }: CemeteryTombstonesProps) {
  const [flowers, setFlowers] = useState<Record<string, number>>({});
  const sections = useMemo(() => buildCemeteryYearSections(coins), [coins]);

  // Top 20 entries by peak mcap get the full editorial obituary treatment in
  // the hover plaque. The rest of the cemetery keeps the structural lead-only
  // treatment so the surface never asserts authorship it does not have.
  const editorialIds = useMemo(() => {
    const sorted = coins
      .filter((c) => typeof c.peakMcap === "number" && c.peakMcap > 0)
      .slice()
      .sort((a, b) => (b.peakMcap ?? 0) - (a.peakMcap ?? 0))
      .slice(0, 20);
    return new Set(sorted.map((c) => c.id));
  }, [coins]);

  const handlePayRespects = useCallback((coinId: string) => {
    setFlowers((prev) => {
      const current = prev[coinId] ?? 0;
      if (current >= 50) return prev;
      return { ...prev, [coinId]: current + 1 };
    });
  }, []);

  return (
    <div>
      <div className={styles.scene}>
        <div className={styles.horizon} aria-hidden="true" />
        <div className={styles.path} aria-hidden="true" />
        <div className={styles.field}>
          <div className={styles.sections}>
            {sections.map((section) => (
              <section key={section.year} className={styles.yearSection}>
                <div className={styles.yearMarker}>
                  <h3 className={styles.yearPillar}>{section.year}</h3>
                  <div className={styles.graveCount}>
                    {section.coins.length} {section.coins.length === 1 ? "grave" : "graves"}
                  </div>
                </div>

                {section.coins.length > 0 && (
                  <div className={styles.gravesGrid}>
                    {section.coins.map((coin, i) => (
                      <MemoizedTombstone
                        key={coin.id}
                        coin={coin}
                        index={i}
                        onSelect={onSelect}
                        flowerCount={flowers[coin.id] ?? 0}
                        onPayRespects={handlePayRespects}
                        isEditorial={editorialIds.has(coin.id)}
                      />
                    ))}
                  </div>
                )}
              </section>
            ))}
          </div>
        </div>
      </div>

      {/* Legend */}
      <div className={cn(styles.legend, "mt-3")}>
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
        <span className="ml-auto text-xs text-muted-foreground/70 italic">
          Order follows the archive toggle. Tombstone size reflects peak market cap; logos use the cemetery dataset.
        </span>
      </div>
    </div>
  );
}
