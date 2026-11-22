"use client";

import Link from "next/link";
import { X } from "lucide-react";

import { PHASE_DOT, type DriftDisplayStatus } from "@/lib/pre-launch";
import {
  LAUNCH_PHASE_LABELS,
  PRE_LAUNCH_DRIFT_RING_CLASSES,
  PRE_LAUNCH_DRIFT_SHORT_LABELS,
  PRE_LAUNCH_UNPHASED_LABEL,
} from "@shared/lib/classification/pre-launch";
import {
  HORIZON_COINS_BY_PHASE,
  HORIZON_CONSTELLATION_LAYOUT,
  HORIZON_PHASE_FIELD_CLASSES,
  HORIZON_PHASE_LAYOUTS,
  HORIZON_PHASE_ORDER,
  HORIZON_UNPHASED_LAYOUT,
  HORIZON_UNPHASED_STABLECOINS,
  type HorizonPhaseLayout,
  phaseRingSize,
} from "@/lib/horizon-constellation-layout";
import { resolveCompactLogoSrc } from "@/lib/logo-variants";
import { getLogoSrc, logosById } from "@/lib/logos";
import { buildStablecoinUrl } from "@shared/lib/urls";
import type { StablecoinClientMeta } from "@shared/types/stablecoin-client-meta";
import type { UpcomingLaunchPhase } from "@shared/types/stablecoin-lifecycle";
import { cn } from "@/lib/utils";

type HorizonPhaseKey = UpcomingLaunchPhase | "unphased";

const DOT = HORIZON_CONSTELLATION_LAYOUT.dot;
const LOGO_INNER = HORIZON_CONSTELLATION_LAYOUT.logoInner;
/** Tracker phone lane: up to six dots fit a 320px screen; past that, five plus "+N". */
const TRACKER_LANE_FIT = 6;
const TRACKER_LANE_CLIP = 5;

const DOT_LINK_CLASS =
  "pharos-focus-ring group block rounded-full transition-transform duration-200 hover:z-10 hover:scale-125 focus-visible:z-10 active:scale-110 motion-reduce:transition-none motion-reduce:hover:scale-100";

const DOT_CLASS =
  "flex items-center justify-center overflow-hidden rounded-full border border-border/60 bg-background/90 text-3xs font-bold text-muted-foreground transition-colors group-hover:border-border group-hover:bg-background dark:border-transparent dark:bg-foreground/12 dark:text-foreground/80 dark:ring-1 dark:ring-border/60 dark:group-hover:bg-foreground/20";

const UNPHASED_FIELD_CLASS = "border-dashed border-muted-foreground/45 bg-muted/30 dark:border-border dark:bg-muted/20";
const UNPHASED_DOT_CLASS = "border border-dashed border-muted-foreground/60 bg-transparent";

type HorizonCellCoin = Pick<StablecoinClientMeta, "id" | "name" | "symbol">;

interface HorizonCell {
  key: HorizonPhaseKey;
  label: string;
  srLabel: string;
  markerClass: string;
  fieldClass: string;
  coins: readonly HorizonCellCoin[];
  layout: HorizonPhaseLayout;
}

const PHASE_CELLS: readonly HorizonCell[] = HORIZON_PHASE_ORDER.map((phase, index) => ({
  key: phase,
  label: LAUNCH_PHASE_LABELS[phase],
  srLabel: LAUNCH_PHASE_LABELS[phase],
  markerClass: PHASE_DOT[phase],
  fieldClass: HORIZON_PHASE_FIELD_CLASSES[phase],
  coins: HORIZON_COINS_BY_PHASE[index],
  layout: HORIZON_PHASE_LAYOUTS[index],
}));

const UNPHASED_CELL: HorizonCell = {
  key: "unphased",
  label: PRE_LAUNCH_UNPHASED_LABEL,
  srLabel: "Phase not assigned",
  markerClass: UNPHASED_DOT_CLASS,
  fieldClass: UNPHASED_FIELD_CLASS,
  coins: HORIZON_UNPHASED_STABLECOINS,
  layout: HORIZON_UNPHASED_LAYOUT,
};

function HorizonLogoDot({ coin, drift }: { coin: HorizonCellCoin; drift?: DriftDisplayStatus }): React.JSX.Element {
  const logoSrc = resolveCompactLogoSrc(getLogoSrc(logosById, coin.id), LOGO_INNER);
  const fallback = (coin.symbol || coin.name).trim().charAt(0).toUpperCase();

  return (
    <span
      aria-hidden="true"
      className={cn(DOT_CLASS, drift ? PRE_LAUNCH_DRIFT_RING_CLASSES[drift] : undefined)}
      style={{ width: DOT, height: DOT }}
    >
      {logoSrc ? (
        <img
          src={logoSrc}
          alt=""
          loading="eager"
          decoding="async"
          draggable={false}
          className="rounded-full object-contain"
          style={{ width: LOGO_INNER, height: LOGO_INNER }}
        />
      ) : (
        fallback
      )}
    </span>
  );
}

function dotAriaLabel(coin: HorizonCellCoin, cell: HorizonCell, drift?: DriftDisplayStatus): string {
  const slippage = drift ? PRE_LAUNCH_DRIFT_SHORT_LABELS[drift] : undefined;
  return `${coin.name} (${coin.symbol}): ${cell.srLabel}${slippage ? `, ${slippage}` : ""}`;
}

function tallyHidden(
  coins: readonly HorizonCellCoin[],
  driftById: ReadonlyMap<string, DriftDisplayStatus> | undefined,
): { pushed: number; overdue: number } {
  let pushed = 0;
  let overdue = 0;
  if (!driftById) return { pushed, overdue };
  for (const coin of coins) {
    const drift = driftById.get(coin.id);
    if (drift === "overdue") overdue += 1;
    else if (drift === "pushed-once" || drift === "pushed-multiple") pushed += 1;
  }
  return { pushed, overdue };
}

function OverflowMarker({
  cell,
  hiddenCoins,
  driftById,
  onTogglePhase,
  className,
  style,
}: {
  cell: HorizonCell;
  hiddenCoins: readonly HorizonCellCoin[];
  driftById?: ReadonlyMap<string, DriftDisplayStatus>;
  onTogglePhase?: (phase: HorizonPhaseKey) => void;
  className?: string;
  style?: React.CSSProperties;
}): React.JSX.Element {
  const { pushed, overdue } = tallyHidden(hiddenCoins, driftById);
  const tallyLabel = [pushed > 0 ? `${pushed} pushed` : null, overdue > 0 ? `${overdue} overdue` : null]
    .filter(Boolean)
    .join(", ");
  const ariaLabel = `${hiddenCoins.length} more ${cell.label.toLowerCase()} stablecoins${tallyLabel ? ` (${tallyLabel})` : ""}`;
  const sharedClass = cn(
    "pharos-focus-ring pharos-numeric inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted px-1.5 py-0.5 text-2xs font-medium text-muted-foreground transition-colors hover:border-border hover:text-foreground",
    className,
  );
  const content = (
    <>
      +{hiddenCoins.length}
      {pushed > 0 ? (
        <span aria-hidden="true" className="inline-flex items-center gap-0.5 text-3xs">
          <span className="h-1.5 w-1.5 rounded-full bg-state-warn-solid" />
          {pushed}
        </span>
      ) : null}
      {overdue > 0 ? (
        <span aria-hidden="true" className="inline-flex items-center gap-0.5 text-3xs">
          <span className="h-1.5 w-1.5 rounded-full bg-state-danger-solid" />
          {overdue}
        </span>
      ) : null}
    </>
  );

  if (onTogglePhase) {
    return (
      <button
        type="button"
        aria-label={ariaLabel}
        style={style}
        onClick={() => onTogglePhase(cell.key)}
        className={sharedClass}
      >
        {content}
      </button>
    );
  }

  return (
    <Link
      href={`/upcoming/?phase=${cell.key}#data`}
      aria-label={ariaLabel}
      style={style}
      className={sharedClass}
    >
      {content}
    </Link>
  );
}

/**
 * Hero-scale interactive phase constellation for `/upcoming/`.
 * Clicking any phase orb or mobile lane toggles the table's launch-phase filter
 * while individual coin dots remain direct links to their pre-launch dossiers.
 */
export function UpcomingHorizonHero({
  driftById,
  selectedPhases,
  onTogglePhase,
  onClearPhases,
}: {
  driftById?: ReadonlyMap<string, DriftDisplayStatus>;
  selectedPhases?: ReadonlySet<HorizonPhaseKey>;
  onTogglePhase?: (phase: HorizonPhaseKey) => void;
  onClearPhases?: () => void;
}): React.JSX.Element {
  const withUnphased = UNPHASED_CELL.coins.length > 0;
  const cells = withUnphased ? [...PHASE_CELLS, UNPHASED_CELL] : PHASE_CELLS;
  const hasSelection = (selectedPhases?.size ?? 0) > 0;
  const selectedLabels = hasSelection
    ? cells.filter((cell) => selectedPhases?.has(cell.key)).map((cell) => cell.label)
    : [];

  return (
    <div className="flex h-full flex-col">
      <div
        className={cn(
          "hidden flex-1 divide-x divide-border/50",
          withUnphased ? "grid-cols-6 xl:grid" : "grid-cols-5 lg:grid",
        )}
      >
        {cells.map((cell) => {
          const { coins, layout } = cell;
          const count = coins.length;
          const { pts, hidden } = layout;
          const ringSize = phaseRingSize(count, layout);
          const isSelected = selectedPhases?.has(cell.key) ?? false;

          return (
            <div
              key={cell.key}
              className={cn(
                "relative flex flex-col items-center justify-center gap-4 px-3 py-6 transition-colors",
                isSelected ? "bg-brand-accent/8" : "",
                hasSelection && !isSelected ? "opacity-60 hover:opacity-90" : "",
              )}
            >
              {onTogglePhase ? (
                <button
                  type="button"
                  data-phase-orb={cell.key}
                  aria-pressed={isSelected}
                  aria-label={`Filter table by ${cell.label} phase (${count} ${count === 1 ? "coin" : "coins"})`}
                  onClick={() => onTogglePhase(cell.key)}
                  className="pharos-focus-ring absolute inset-0 z-0 cursor-pointer transition-colors hover:bg-muted/25"
                />
              ) : null}

              <div className="pointer-events-none relative z-10 flex h-[184px] w-full items-center justify-center">
                <div className="relative" style={{ width: ringSize, height: ringSize }}>
                  <span className="sr-only">
                    {cell.srLabel}: {count} {count === 1 ? "coin" : "coins"}
                  </span>
                  <span
                    aria-hidden="true"
                    className={cn(
                      "pointer-events-none absolute inset-0 rounded-full border-2 ring-1 ring-inset ring-border/45 transition-all dark:border dark:ring-0",
                      cell.fieldClass,
                      isSelected
                        ? "ring-2 ring-brand-accent ring-offset-2 ring-offset-card dark:ring-2 dark:ring-brand-accent"
                        : "",
                    )}
                  />
                  {count === 0 ? (
                    <span
                      aria-hidden="true"
                      className="absolute left-1/2 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-border bg-muted/50 opacity-50"
                    />
                  ) : (
                    coins.slice(0, pts.length).map((coin, coinIndex) => {
                      const drift = driftById?.get(coin.id);
                      return (
                        <Link
                          key={coin.id}
                          href={buildStablecoinUrl(coin.id)}
                          prefetch={false}
                          title={coin.name}
                          aria-label={dotAriaLabel(coin, cell, drift)}
                          style={{
                            left: ringSize / 2 + pts[coinIndex].x,
                            top: ringSize / 2 + pts[coinIndex].y,
                          }}
                          className={`pointer-events-auto absolute z-10 -translate-x-1/2 -translate-y-1/2 ${DOT_LINK_CLASS}`}
                        >
                          <HorizonLogoDot coin={coin} drift={drift} />
                        </Link>
                      );
                    })
                  )}
                  {hidden > 0 && (
                    <OverflowMarker
                      cell={cell}
                      hiddenCoins={coins.slice(pts.length)}
                      driftById={driftById}
                      onTogglePhase={onTogglePhase}
                      style={{ left: ringSize / 2, top: ringSize / 2 }}
                      className="pointer-events-auto absolute z-10 -translate-x-1/2 -translate-y-1/2"
                    />
                  )}
                </div>
              </div>

              <span className="pointer-events-none relative z-10 flex w-full items-center gap-1.5">
                <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-xs ${cell.markerClass}`} />
                <span className={cn("text-2xs font-semibold", isSelected ? "text-brand-accent-text" : "text-foreground")}>
                  {cell.label}
                </span>
                <span aria-hidden="true" className="text-3xs leading-none text-muted-foreground/50 sm:text-2xs">
                  ·
                </span>
                <span className="pharos-numeric text-2xs text-muted-foreground">{count}</span>
              </span>
            </div>
          );
        })}
      </div>

      <div className={cn("divide-y divide-border/50", withUnphased ? "xl:hidden" : "lg:hidden")}>
        {cells.map((cell) => {
          const count = cell.coins.length;
          const laneDots = count > TRACKER_LANE_FIT ? TRACKER_LANE_CLIP : count;
          const hiddenCoins = cell.coins.slice(laneDots);
          const isSelected = selectedPhases?.has(cell.key) ?? false;

          return (
            <div
              key={cell.key}
              className={cn(
                "flex items-center gap-2 px-3 py-2.5 transition-colors sm:gap-3 sm:px-4 sm:py-3.5",
                isSelected ? "bg-brand-accent/8" : "",
                hasSelection && !isSelected ? "opacity-65" : "",
              )}
            >
              {onTogglePhase ? (
                <button
                  type="button"
                  data-phase-lane={cell.key}
                  aria-pressed={isSelected}
                  aria-label={`Toggle ${cell.label} phase filter (${count} ${count === 1 ? "coin" : "coins"})`}
                  onClick={() => onTogglePhase(cell.key)}
                  className={cn(
                    "pharos-focus-ring flex min-h-11 w-[7.25rem] shrink-0 items-center gap-1.5 rounded-md px-1.5 text-left transition-colors sm:min-h-8 sm:w-40",
                    isSelected
                      ? "bg-brand-accent/12 ring-1 ring-brand-accent"
                      : "hover:bg-muted/40",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={`h-2 w-2 shrink-0 rounded-xs ${cell.markerClass} ${count === 0 ? "opacity-40" : ""}`}
                  />
                  <span className={cn("text-2xs font-semibold", isSelected ? "text-brand-accent-text" : "text-foreground")}>
                    {cell.label}
                  </span>
                  <span aria-hidden="true" className="text-3xs leading-none text-muted-foreground/50 sm:text-2xs">
                    ·
                  </span>
                  <span className="pharos-numeric text-3xs text-muted-foreground sm:text-2xs">{count}</span>
                </button>
              ) : (
                <div className="flex w-[7.25rem] shrink-0 items-center gap-1.5 sm:w-40">
                  <span
                    aria-hidden="true"
                    className={`h-2 w-2 shrink-0 rounded-xs ${cell.markerClass} ${count === 0 ? "opacity-40" : ""}`}
                  />
                  <span className="text-2xs font-semibold text-foreground">{cell.label}</span>
                  <span aria-hidden="true" className="text-3xs leading-none text-muted-foreground/50 sm:text-2xs">
                    ·
                  </span>
                  <span className="pharos-numeric text-3xs text-muted-foreground sm:text-2xs">{count}</span>
                </div>
              )}

              <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-0.5 overflow-hidden border-l border-border/50 py-1 pl-2 pr-1 sm:flex-wrap sm:gap-2 sm:overflow-visible sm:pl-3">
                <span className="sr-only">
                  {count} {count === 1 ? "coin" : "coins"}
                </span>
                {count === 0 ? (
                  <span
                    aria-hidden="true"
                    className="h-3 w-3 rounded-full border border-border bg-muted/50 opacity-50"
                  />
                ) : (
                  cell.coins.map((coin, coinIndex) => {
                    const drift = driftById?.get(coin.id);
                    return (
                      <Link
                        key={coin.id}
                        href={buildStablecoinUrl(coin.id)}
                        prefetch={false}
                        title={coin.name}
                        aria-label={dotAriaLabel(coin, cell, drift)}
                        className={cn(DOT_LINK_CLASS, coinIndex >= laneDots ? "hidden sm:block" : undefined)}
                      >
                        <HorizonLogoDot coin={coin} drift={drift} />
                      </Link>
                    );
                  })
                )}
                {hiddenCoins.length > 0 ? (
                  <OverflowMarker
                    cell={cell}
                    hiddenCoins={hiddenCoins}
                    driftById={driftById}
                    onTogglePhase={onTogglePhase}
                    className="shrink-0 sm:hidden"
                  />
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {hasSelection && onClearPhases ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/50 bg-muted/20 px-4 py-2 text-xs">
          <span className="text-muted-foreground">
            Filtering table by{" "}
            <span className="font-medium text-foreground">{selectedLabels.join(", ")}</span>
          </span>
          <button
            type="button"
            data-testid="clear-phase-orb-filter"
            onClick={onClearPhases}
            className="pharos-focus-ring inline-flex min-h-7 items-center gap-1 rounded-full border border-border/70 bg-background px-2.5 py-0.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
          >
            <span>Clear phase filter</span>
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
