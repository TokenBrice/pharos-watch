import Link from "next/link";

import { LAUNCH_PHASE_LABELS, PHASE_DOT } from "@/lib/pre-launch";
import {
  HORIZON_COINS_BY_PHASE,
  HORIZON_CONSTELLATION_LAYOUT,
  HORIZON_PHASE_FIELD_CLASSES,
  HORIZON_PHASE_LAYOUTS,
  HORIZON_PHASE_ORDER,
  HORIZON_PHASE_SHORT_LABELS,
  type HorizonPreLaunchCoin,
  phaseRingSize,
} from "@/lib/horizon-constellation-layout";
import { resolveCompactLogoSrc } from "@/lib/logo-variants";
import { logosById } from "@/lib/logos";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { cn } from "@/lib/utils";

const DOT = HORIZON_CONSTELLATION_LAYOUT.dot;
const LOGO_INNER = HORIZON_CONSTELLATION_LAYOUT.logoInner;
const NARROW_LANE_DOTS = HORIZON_CONSTELLATION_LAYOUT.narrowLaneDots;

const DOT_LINK_CLASS =
  "pharos-focus-ring group block rounded-full transition-transform duration-200 hover:z-10 hover:scale-125 focus-visible:z-20 active:scale-110 motion-reduce:transition-none motion-reduce:hover:scale-100";

const DOT_CLASS =
  "flex items-center justify-center overflow-hidden rounded-full border border-border/50 bg-background/90 text-[9px] font-bold text-muted-foreground shadow-[inset_0_1px_0_oklch(1_0_0_/0.05)] transition-colors group-hover:border-border group-hover:bg-background dark:bg-muted";

function HorizonLogoDot({ coin }: { coin: HorizonPreLaunchCoin }): React.JSX.Element {
  const logoSrc = resolveCompactLogoSrc(logosById[coin.id], LOGO_INNER);
  const fallback = (coin.symbol || coin.name).trim().charAt(0).toUpperCase();

  return (
    <span aria-hidden="true" className={DOT_CLASS} style={{ width: DOT, height: DOT }}>
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

interface HorizonConstellationProps {
  wideClassName?: string;
  widePhaseClassName: string;
  narrowPhaseClassName: string;
}

export function HorizonConstellation({
  wideClassName,
  widePhaseClassName,
  narrowPhaseClassName,
}: HorizonConstellationProps): React.JSX.Element {
  return (
    <>
      <div className={cn("hidden grid-cols-5 divide-x divide-border/50 lg:grid", wideClassName)}>
        {HORIZON_PHASE_ORDER.map((phase, index) => {
          const coins = HORIZON_COINS_BY_PHASE[index];
          const count = coins.length;
          const { pts, hidden } = HORIZON_PHASE_LAYOUTS[index];
          const ringSize = phaseRingSize(count, HORIZON_PHASE_LAYOUTS[index]);
          return (
            <div key={phase} className={widePhaseClassName}>
              <div className="flex h-[184px] w-full items-center justify-center">
                <div className="relative" style={{ width: ringSize, height: ringSize }}>
                  <span className="sr-only">
                    {LAUNCH_PHASE_LABELS[phase]}: {count} {count === 1 ? "coin" : "coins"}
                  </span>
                  <span
                    aria-hidden="true"
                    className={`pointer-events-none absolute inset-0 rounded-full border ${HORIZON_PHASE_FIELD_CLASSES[phase]}`}
                  />
                  {count === 0 ? (
                    <span
                      aria-hidden="true"
                      className="absolute left-1/2 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-border bg-muted/50 opacity-50"
                    />
                  ) : (
                    coins.slice(0, pts.length).map((coin, coinIndex) => (
                      <Link
                        key={coin.id}
                        href={buildStablecoinUrl(coin.id)}
                        title={coin.name}
                        aria-label={`${coin.name} (${coin.symbol}) — ${LAUNCH_PHASE_LABELS[phase]}`}
                        style={{
                          left: ringSize / 2 + pts[coinIndex].x,
                          top: ringSize / 2 + pts[coinIndex].y,
                        }}
                        className={`absolute -translate-x-1/2 -translate-y-1/2 ${DOT_LINK_CLASS}`}
                      >
                        <HorizonLogoDot coin={coin} />
                      </Link>
                    ))
                  )}
                  {hidden > 0 && (
                    <Link
                      href="/upcoming/"
                      aria-label={`${hidden} more ${HORIZON_PHASE_SHORT_LABELS[phase].toLowerCase()} stablecoins`}
                      style={{ left: ringSize / 2, top: ringSize / 2 }}
                      className="pharos-focus-ring pharos-numeric absolute -translate-x-1/2 -translate-y-1/2 rounded-md border border-border/60 bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:border-border hover:text-foreground"
                    >
                      +{hidden}
                    </Link>
                  )}
                </div>
              </div>
              <span className="flex w-full items-center gap-1.5">
                <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-[3px] ${PHASE_DOT[phase]}`} />
                <span className="font-mono text-[11px] font-semibold uppercase tracking-wide text-foreground">
                  {HORIZON_PHASE_SHORT_LABELS[phase]}
                </span>
                <span aria-hidden="true" className="text-[9px] leading-none text-muted-foreground/50 sm:text-[11px]">
                  ·
                </span>
                <span className="pharos-numeric text-[11px] text-muted-foreground">{count}</span>
              </span>
            </div>
          );
        })}
      </div>

      <div className="divide-y divide-border/50 lg:hidden">
        {HORIZON_PHASE_ORDER.map((phase, index) => {
          const coins = HORIZON_COINS_BY_PHASE[index];
          const count = coins.length;
          const visibleCoins = coins.slice(0, NARROW_LANE_DOTS);
          return (
            <div key={phase} className={narrowPhaseClassName}>
              <div className="flex w-[5.1rem] shrink-0 items-center gap-1.5 sm:w-36">
                <span
                  aria-hidden="true"
                  className={`h-2 w-2 shrink-0 rounded-[3px] ${PHASE_DOT[phase]} ${count === 0 ? "opacity-40" : ""}`}
                />
                <span className="font-mono text-[9px] font-semibold uppercase tracking-wide text-foreground sm:text-[11px]">
                  {HORIZON_PHASE_SHORT_LABELS[phase]}
                </span>
                <span aria-hidden="true" className="text-[9px] leading-none text-muted-foreground/50 sm:text-[11px]">
                  ·
                </span>
                <span className="pharos-numeric text-[9px] text-muted-foreground sm:text-[11px]">{count}</span>
              </div>
              <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-0 overflow-hidden border-l border-border/50 pl-2 sm:flex-wrap sm:gap-2 sm:overflow-visible sm:pl-3">
                <span className="sr-only">
                  {count} {count === 1 ? "coin" : "coins"}
                </span>
                {count === 0 ? (
                  <span
                    aria-hidden="true"
                    className="h-3 w-3 rounded-full border border-border bg-muted/50 opacity-50"
                  />
                ) : (
                  visibleCoins.map((coin) => (
                    <Link
                      key={coin.id}
                      href={buildStablecoinUrl(coin.id)}
                      title={coin.name}
                      aria-label={`${coin.name} (${coin.symbol}) — ${LAUNCH_PHASE_LABELS[phase]}`}
                      className={DOT_LINK_CLASS}
                    >
                      <HorizonLogoDot coin={coin} />
                    </Link>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
