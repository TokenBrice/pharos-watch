import Link from "next/link";
import { SquareArrowRight } from "lucide-react";

import { CLIENT_TRACKED_STABLECOINS } from "@shared/lib/stablecoins/client-registry";
import { isPreLaunchStablecoinMeta } from "@shared/lib/stablecoins/status";
import type { LaunchPhase } from "@shared/types";
import type { StablecoinClientMeta } from "@shared/types/stablecoin-client-meta";
import { logosById } from "@/lib/logos";
import { resolveCompactLogoSrc } from "@/lib/logo-variants";
import { buildStablecoinUrl } from "@/lib/urls";
import { LAUNCH_PHASE_LABELS, PHASE_DOT, dateScore } from "@/lib/pre-launch";
import {
  HORIZON_CONSTELLATION_LAYOUT,
  layoutHorizonPhase,
  phaseRingSize,
} from "@/lib/horizon-constellation-layout";

// Phases ordered far-from-launch → nearest-to-launch. The readiness columns read
// left (announced) to right (launching = the live-market threshold).
const PHASE_ORDER: readonly LaunchPhase[] = ["announced", "testnet", "auditing", "beta", "launching-soon"];

const DOT = HORIZON_CONSTELLATION_LAYOUT.dot;
const LOGO_INNER = HORIZON_CONSTELLATION_LAYOUT.logoInner;
const NARROW_LANE_DOTS = HORIZON_CONSTELLATION_LAYOUT.narrowLaneDots;

// Short, single-word phase labels for the visible chips (the readiness rings).
// Screen-reader/link copy keeps the canonical LAUNCH_PHASE_LABELS; only the
// compact uppercase chip trims "Launching Soon" → "Launching" to match the
// redesign and avoid wrapping in the narrow label column.
const PHASE_SHORT_LABEL: Record<LaunchPhase, string> = {
  announced: "Announced",
  testnet: "Testnet",
  auditing: "Auditing",
  beta: "Beta",
  "launching-soon": "Launching",
};

// Phase → thin tinted ring (static strings for the Tailwind scanner). Every stage
// shares one ring size; the hue is the only differentiator so the five readiness
// zones read as distinct. Hues mirror PHASE_BADGE.
const PHASE_FIELD: Record<LaunchPhase, string> = {
  announced: "border-amber-500/35 bg-amber-500/[0.05] dark:border-amber-400/35 dark:bg-amber-400/[0.07]",
  testnet: "border-indigo-500/35 bg-indigo-500/[0.05] dark:border-indigo-400/35 dark:bg-indigo-400/[0.07]",
  auditing: "border-violet-500/35 bg-violet-500/[0.05] dark:border-violet-400/35 dark:bg-violet-400/[0.07]",
  beta: "border-emerald-500/35 bg-emerald-500/[0.05] dark:border-emerald-400/35 dark:bg-emerald-400/[0.07]",
  "launching-soon": "border-sky-500/45 bg-sky-500/[0.07] dark:border-sky-400/45 dark:bg-sky-400/[0.09]",
};

function dotLinkClass(): string {
  return "pharos-focus-ring group block rounded-full transition-transform duration-200 hover:z-10 hover:scale-125 focus-visible:z-20 active:scale-110 motion-reduce:transition-none motion-reduce:hover:scale-100";
}

const DOT_CLASS =
  "flex items-center justify-center overflow-hidden rounded-full border border-border/50 bg-background/90 text-[9px] font-bold text-muted-foreground shadow-[inset_0_1px_0_oklch(1_0_0_/0.05)] transition-colors group-hover:border-border group-hover:bg-background dark:bg-muted";

type PreLaunchCoin = StablecoinClientMeta & { launchPhase: LaunchPhase };

const PRE_LAUNCH_STABLECOINS = CLIENT_TRACKED_STABLECOINS.filter(
  (coin): coin is PreLaunchCoin => isPreLaunchStablecoinMeta(coin) && Boolean(coin.launchPhase),
);

// The pre-launch set is static at module scope, so derive the per-phase buckets
// and their dot layouts once at import rather than on every render.
//
// Coins per phase, soonest-expected first so each band reads by readiness.
const coinsByPhase = PHASE_ORDER.map((phase) =>
  PRE_LAUNCH_STABLECOINS.filter((c) => c.launchPhase === phase).sort(
    (a, b) => dateScore(a.expectedLaunchDate) - dateScore(b.expectedLaunchDate),
  ),
);

// Lay each stage out, then size the field from its total count so high-volume
// phases read larger even when their visible dot links are capped behind a
// "+N" tracker link.
const layouts = coinsByPhase.map((c) => layoutHorizonPhase(c.length));

function HorizonLogoDot({ coin }: { coin: PreLaunchCoin }): React.JSX.Element {
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

export function HomeAltUpcomingHorizonConstellation(): React.JSX.Element | null {
  const total = PRE_LAUNCH_STABLECOINS.length;
  if (total === 0) return null;

  return (
    <section aria-labelledby="upcoming-horizon-constellation-title" className="space-y-3 sm:space-y-4">
      <h2 id="upcoming-horizon-constellation-title" className="sr-only">
        Upcoming stablecoins on the horizon — constellation view
      </h2>

      {/* ── Section header (sits above the panel, editorial display) ───────── */}
      <div className="space-y-1 sm:space-y-1.5">
        <div className="flex items-center justify-between gap-3">
          <p className="font-display text-2xl font-bold text-foreground sm:text-3xl">On The Horizon</p>
          <div className="flex shrink-0 items-center gap-3 sm:pt-0">
            <span className="hidden text-sm text-muted-foreground sm:inline">
              <span className="pharos-numeric font-semibold text-foreground">{total}</span> Tokens
            </span>
            <span aria-hidden="true" className="hidden h-1 w-1 rounded-full bg-border sm:inline-block" />
            <Link
              href="/upcoming/"
              aria-label="Open tracker"
              className="pharos-focus-ring group inline-flex min-h-7 items-center gap-1.5 rounded-[4px] border border-border/70 bg-muted/30 px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:border-border hover:bg-muted/60 sm:min-h-8 sm:rounded-md sm:px-3 sm:py-1.5 sm:text-[13px]"
            >
              Tracker
              <SquareArrowRight
                aria-hidden="true"
                className="h-3 w-3 text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-foreground sm:h-3.5 sm:w-3.5"
                strokeWidth={2}
              />
            </Link>
          </div>
        </div>
        <p className="max-w-[13rem] text-[10px] leading-snug text-muted-foreground sm:max-w-none sm:text-sm">
          Explore announced stablecoins and their varying levels of readiness.
        </p>
      </div>

      {/* ── Readiness panel ──────────────────────────────────────────────── */}
      <div className="pharos-card-shell overflow-hidden">
        {/* Wide layout (lg+): one count-scaled tinted ring per readiness stage,
            the packed dot cluster centered inside, columns split by hairlines. */}
        <div className="hidden grid-cols-5 divide-x divide-border/50 lg:grid">
          {PHASE_ORDER.map((phase, i) => {
            const coins = coinsByPhase[i];
            const count = coins.length;
            const { pts, hidden } = layouts[i];
            const ringSize = phaseRingSize(count, layouts[i]);
            return (
              <div key={phase} className="flex flex-col items-center gap-4 px-3 py-5">
                <div className="flex h-[184px] w-full items-center justify-center">
                  <div className="relative" style={{ width: ringSize, height: ringSize }}>
                    <span className="sr-only">
                      {LAUNCH_PHASE_LABELS[phase]}: {count} {count === 1 ? "coin" : "coins"}
                    </span>

                    {/* Thin tinted ring — the only per-stage hue. */}
                    <span
                      aria-hidden="true"
                      className={`pointer-events-none absolute inset-0 rounded-full border ${PHASE_FIELD[phase]}`}
                    />

                    {count === 0 ? (
                      <span
                        aria-hidden="true"
                        className="absolute left-1/2 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-border bg-muted/50 opacity-50"
                      />
                    ) : (
                      coins.slice(0, pts.length).map((coin, idx) => (
                        <Link
                          key={coin.id}
                          href={buildStablecoinUrl(coin.id)}
                          title={coin.name}
                          aria-label={`${coin.name} (${coin.symbol}) — ${LAUNCH_PHASE_LABELS[phase]}`}
                          style={{
                            left: ringSize / 2 + pts[idx].x,
                            top: ringSize / 2 + pts[idx].y,
                          }}
                          className={`absolute -translate-x-1/2 -translate-y-1/2 ${dotLinkClass()}`}
                        >
                          <HorizonLogoDot coin={coin} />
                        </Link>
                      ))
                    )}

                    {/* Overflow: the remainder beyond the capped dots, kept reachable
                        via the tracker rather than silently dropped. */}
                    {hidden > 0 && (
                      <Link
                        href="/upcoming/"
                        aria-label={`${hidden} more ${PHASE_SHORT_LABEL[phase].toLowerCase()} stablecoins`}
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
                    {PHASE_SHORT_LABEL[phase]}
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

        {/* Narrow layout (below lg): phases stack as labelled lanes — a fixed
            label column, a hairline, then the dots spread to the right. */}
        <div className="divide-y divide-border/50 lg:hidden">
          {PHASE_ORDER.map((phase, i) => {
            const coins = coinsByPhase[i];
            const count = coins.length;
            const visibleCoins = coins.slice(0, NARROW_LANE_DOTS);
            return (
              <div key={phase} className="flex items-center gap-2 px-3 py-[2px] sm:gap-3 sm:px-4 sm:py-3.5">
                <div className="flex w-[5.1rem] shrink-0 items-center gap-1.5 sm:w-36">
                  <span
                    aria-hidden="true"
                    className={`h-2 w-2 shrink-0 rounded-[3px] ${PHASE_DOT[phase]} ${count === 0 ? "opacity-40" : ""}`}
                  />
                  <span className="font-mono text-[9px] font-semibold uppercase tracking-wide text-foreground sm:text-[11px]">
                    {PHASE_SHORT_LABEL[phase]}
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
                        className={dotLinkClass()}
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
      </div>
    </section>
  );
}
