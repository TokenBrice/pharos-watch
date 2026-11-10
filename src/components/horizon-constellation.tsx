import Link from "next/link";

import { PHASE_DOT, type DriftDisplayStatus } from "@/lib/pre-launch";
import { LAUNCH_PHASE_LABELS, PRE_LAUNCH_UNPHASED_LABEL } from "@shared/lib/classification/pre-launch";
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
import { cn } from "@/lib/utils";

const DOT = HORIZON_CONSTELLATION_LAYOUT.dot;
const LOGO_INNER = HORIZON_CONSTELLATION_LAYOUT.logoInner;
const NARROW_LANE_DOTS = HORIZON_CONSTELLATION_LAYOUT.narrowLaneDots;
/** Tracker phone lane: up to six dots fit a 320px screen; past that, five plus "+N". */
const TRACKER_LANE_FIT = 6;
const TRACKER_LANE_CLIP = 5;

const DOT_LINK_CLASS =
  "pharos-focus-ring group block rounded-full transition-transform duration-200 hover:z-5 hover:scale-125 focus-visible:z-10 active:scale-110 motion-reduce:transition-none motion-reduce:hover:scale-100";

const DOT_CLASS =
  "flex items-center justify-center overflow-hidden rounded-full border border-border/50 bg-background/90 text-3xs font-bold text-muted-foreground shadow-[inset_0_1px_0_oklch(1_0_0_/0.05)] transition-colors group-hover:border-border group-hover:bg-background dark:bg-white/90 dark:text-black/75 dark:group-hover:bg-white";

/** Slippage mark: a hairline halo, amber once the target moved, red once it expired. */
const SLIPPAGE_RING_CLASS: Partial<Record<DriftDisplayStatus, string>> = {
  "pushed-once": "ring-[1.5px] ring-state-warn-solid/80 ring-offset-1 ring-offset-background",
  "pushed-multiple": "ring-[1.5px] ring-state-warn-solid/80 ring-offset-1 ring-offset-background",
  overdue: "ring-[1.5px] ring-state-danger-solid/85 ring-offset-1 ring-offset-background",
};

const SLIPPAGE_LABEL: Partial<Record<DriftDisplayStatus, string>> = {
  "pushed-once": "target pushed",
  "pushed-multiple": "target pushed",
  overdue: "target overdue",
};

const UNPHASED_FIELD_CLASS = "border-dashed border-border bg-muted/20";
const UNPHASED_DOT_CLASS = "border border-dashed border-muted-foreground/60 bg-transparent";

type HorizonCellCoin = Pick<StablecoinClientMeta, "id" | "name" | "symbol">;

interface HorizonCell {
  key: string;
  label: string;
  /** Long label for accessible names. */
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
      className={cn(DOT_CLASS, drift ? SLIPPAGE_RING_CLASS[drift] : undefined)}
      style={{ width: DOT, height: DOT }}
    >
      {logoSrc ? (
        <img
          src={logoSrc}
          alt=""
          loading="lazy"
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
  const slippage = drift ? SLIPPAGE_LABEL[drift] : undefined;
  return `${coin.name} (${coin.symbol}) — ${cell.srLabel}${slippage ? `, ${slippage}` : ""}`;
}

/** Pushed/overdue tallies for the coins a cell does not draw, so drawn rings + tallies = Slipped. */
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
  href,
  className,
  style,
}: {
  cell: HorizonCell;
  hiddenCoins: readonly HorizonCellCoin[];
  driftById?: ReadonlyMap<string, DriftDisplayStatus>;
  href: string;
  className?: string;
  style?: React.CSSProperties;
}): React.JSX.Element {
  const { pushed, overdue } = tallyHidden(hiddenCoins, driftById);
  const tallyLabel = [pushed > 0 ? `${pushed} pushed` : null, overdue > 0 ? `${overdue} overdue` : null]
    .filter(Boolean)
    .join(", ");
  return (
    <Link
      href={href}
      aria-label={`${hiddenCoins.length} more ${cell.label.toLowerCase()} stablecoins${tallyLabel ? ` (${tallyLabel})` : ""}`}
      style={style}
      className={cn(
        "pharos-focus-ring pharos-numeric inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted px-1.5 py-0.5 text-2xs font-medium text-muted-foreground transition-colors hover:border-border hover:text-foreground",
        className,
      )}
    >
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
    </Link>
  );
}

interface HorizonConstellationProps {
  wideClassName?: string;
  widePhaseClassName: string;
  narrowPhaseClassName: string;
  /**
   * Tracker layout: roomier phone lanes that clip early into a "+N" marker,
   * every coin drawn from `sm` up, and "+N" linking to the phase filter. Layout
   * only, so the static HTML already ships the final geometry.
   */
  slippage?: boolean;
  /**
   * Visitor-clock drift per coin id (`selectPreLaunchClockView`), read after
   * mount: slipped coins carry a ring and folded coins are tallied on the "+N"
   * marker. Data only; it never changes the layout.
   */
  driftById?: ReadonlyMap<string, DriftDisplayStatus>;
  /** Append the "Unphased" cell so the cells sum to the full pre-launch count. */
  includeUnphased?: boolean;
}

export function HorizonConstellation({
  wideClassName,
  widePhaseClassName,
  narrowPhaseClassName,
  slippage = false,
  driftById,
  includeUnphased = false,
}: HorizonConstellationProps): React.JSX.Element {
  const withUnphased = includeUnphased && UNPHASED_CELL.coins.length > 0;
  const cells = withUnphased ? [...PHASE_CELLS, UNPHASED_CELL] : PHASE_CELLS;
  const overflowHref = (cell: HorizonCell) => (slippage ? `/upcoming/?phase=${cell.key}#data` : "/upcoming/");

  return (
    <>
      <div
        className={cn(
          "hidden divide-x divide-border/50",
          // Six rings need the xl width; below it the lanes carry the cells.
          withUnphased ? "grid-cols-6 xl:grid" : "grid-cols-5 lg:grid",
          wideClassName,
        )}
      >
        {cells.map((cell) => {
          const { coins, layout } = cell;
          const count = coins.length;
          const { pts, hidden } = layout;
          const ringSize = phaseRingSize(count, layout);
          return (
            <div key={cell.key} className={widePhaseClassName}>
              <div className="flex h-[184px] w-full items-center justify-center">
                <div className="relative" style={{ width: ringSize, height: ringSize }}>
                  <span className="sr-only">
                    {cell.srLabel}: {count} {count === 1 ? "coin" : "coins"}
                  </span>
                  <span
                    aria-hidden="true"
                    className={`pointer-events-none absolute inset-0 rounded-full border ${cell.fieldClass}`}
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
                          className={`absolute -translate-x-1/2 -translate-y-1/2 ${DOT_LINK_CLASS}`}
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
                      href={overflowHref(cell)}
                      style={{ left: ringSize / 2, top: ringSize / 2 }}
                      className="absolute -translate-x-1/2 -translate-y-1/2"
                    />
                  )}
                </div>
              </div>
              <span className="flex w-full items-center gap-1.5">
                <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-xs ${cell.markerClass}`} />
                <span className="text-2xs font-semibold text-foreground">{cell.label}</span>
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
          // Tracker lanes draw every coin from `sm` up (the lanes wrap); a phone
          // lane past six coins clips to five and ends in a tallied "+N" instead
          // of silently dropping coins on narrow phones, so rings + tallies still
          // sum to Slipped.
          const laneDots = !slippage ? NARROW_LANE_DOTS : count > TRACKER_LANE_FIT ? TRACKER_LANE_CLIP : count;
          const visibleCoins = slippage ? cell.coins : cell.coins.slice(0, laneDots);
          const hiddenCoins = slippage ? cell.coins.slice(laneDots) : [];
          return (
            <div key={cell.key} className={narrowPhaseClassName}>
              <div
                className={cn(
                  "flex shrink-0 items-center gap-1.5",
                  slippage ? "w-[7.25rem] sm:w-40" : "w-[5.1rem] sm:w-36",
                )}
              >
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
              <div
                className={cn(
                  "flex min-w-0 flex-1 flex-nowrap items-center overflow-hidden border-l border-border/50 pl-2 sm:flex-wrap sm:gap-2 sm:overflow-visible sm:pl-3",
                  // Rings sit outside the dot box: leave room so the lane clip does not cut them.
                  slippage ? "gap-0.5 py-1 pr-1" : "gap-0",
                )}
              >
                <span className="sr-only">
                  {count} {count === 1 ? "coin" : "coins"}
                </span>
                {count === 0 ? (
                  <span
                    aria-hidden="true"
                    className="h-3 w-3 rounded-full border border-border bg-muted/50 opacity-50"
                  />
                ) : (
                  visibleCoins.map((coin, coinIndex) => {
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
                    href={overflowHref(cell)}
                    className="shrink-0 sm:hidden"
                  />
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
