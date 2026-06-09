import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { PRE_LAUNCH_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { LaunchPhase } from "@shared/types";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { buildStablecoinUrl } from "@/lib/urls";
import { logosById } from "@/lib/logos";
import { LAUNCH_PHASE_LABELS, PHASE_DOT, dateScore } from "@/lib/pre-launch";

// Phases ordered far-from-launch → nearest-to-launch. The approach rail reads
// left (announced) to right (launching soon = the live-market threshold).
const PHASE_ORDER: readonly LaunchPhase[] = ["announced", "testnet", "auditing", "beta", "launching-soon"];

const LOGO = 40;
const STAR_SPACING = 46;

// Phase → tinted circular field (static strings for the Tailwind scanner). Each
// stage's cluster sits on its own phase-colored disc so the five zones read as
// distinct constellations. Hues mirror PHASE_BADGE.
const PHASE_FIELD: Record<LaunchPhase, string> = {
  announced: "border-amber-500/25 bg-amber-500/[0.06] dark:border-amber-400/25 dark:bg-amber-400/[0.08]",
  testnet: "border-indigo-500/25 bg-indigo-500/[0.06] dark:border-indigo-400/25 dark:bg-indigo-400/[0.08]",
  auditing: "border-violet-500/25 bg-violet-500/[0.06] dark:border-violet-400/25 dark:bg-violet-400/[0.08]",
  beta: "border-emerald-500/25 bg-emerald-500/[0.06] dark:border-emerald-400/25 dark:bg-emerald-400/[0.08]",
  "launching-soon": "border-sky-500/45 bg-sky-500/[0.09] dark:border-sky-400/45 dark:bg-sky-400/[0.11]",
};

interface Packed {
  pts: { x: number; y: number }[];
  /** Field radius (cluster extent + breathing room). */
  fieldR: number;
}

// Pack n stars into a circular cluster centered on (0, 0). Up to 6 form a single
// polygon ring; 7+ get a center star wrapped by concentric rings spaced one S
// apart, so the disc grows with the count and fills both axes.
function packCircle(n: number): Packed {
  const pad = 10;
  if (n <= 0) return { pts: [], fieldR: STAR_SPACING * 0.7 };
  if (n === 1) return { pts: [{ x: 0, y: 0 }], fieldR: LOGO / 2 + pad };
  if (n <= 6) {
    const r = STAR_SPACING / (2 * Math.sin(Math.PI / n));
    const pts = Array.from({ length: n }, (_, k) => {
      const a = (k / n) * 2 * Math.PI - Math.PI / 2;
      return { x: Math.cos(a) * r, y: Math.sin(a) * r };
    });
    return { pts, fieldR: r + LOGO / 2 + pad };
  }
  const pts = [{ x: 0, y: 0 }];
  let rem = n - 1;
  let ring = 1;
  let lastR = 0;
  while (rem > 0) {
    const r = ring * STAR_SPACING;
    const cap = Math.max(1, Math.round((2 * Math.PI * r) / STAR_SPACING));
    const cnt = Math.min(cap, rem);
    for (let k = 0; k < cnt; k++) {
      // Offset each ring's start so outer stars nest between inner ones.
      const a = (k / cnt) * 2 * Math.PI - Math.PI / 2 + ring * 0.4;
      pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
    }
    lastR = r;
    rem -= cnt;
    ring++;
  }
  return { pts, fieldR: lastR + LOGO / 2 + pad };
}

function logoLinkClass(): string {
  return "pharos-focus-ring block rounded-full transition-transform duration-200 hover:z-10 hover:scale-110 focus-visible:z-20 active:scale-105 motion-reduce:transition-none motion-reduce:hover:scale-100";
}

export function HomeAltUpcomingHorizonConstellation(): React.JSX.Element | null {
  const total = PRE_LAUNCH_STABLECOINS.length;
  if (total === 0) return null;

  // Coins per phase, soonest-expected first so each band reads by readiness.
  const coinsByPhase = PHASE_ORDER.map((phase) =>
    PRE_LAUNCH_STABLECOINS.filter((c) => c.launchPhase === phase).sort(
      (a, b) => dateScore(a.expectedLaunchDate) - dateScore(b.expectedLaunchDate),
    ),
  );

  // Pack each stage into a circular cluster; the disc grows with coin count so
  // Announced reads as the largest constellation and the sparse stages as small
  // pairs. One shared row height keeps every disc centered on the same beam.
  const packs = coinsByPhase.map((c) => packCircle(c.length));
  const maxDiameter = 2 * Math.max(...packs.map((p) => p.fieldR));

  return (
    <section aria-labelledby="upcoming-horizon-constellation-title" className="pharos-card-shell overflow-hidden p-0">
      <h2 id="upcoming-horizon-constellation-title" className="sr-only">
        Upcoming stablecoins on the horizon — constellation view
      </h2>

      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border/50 px-4 py-3 sm:px-6">
        <div className="flex flex-col gap-0.5">
          <span className="font-mono text-[11px] font-semibold uppercase leading-none tracking-[0.16em] [color:color-mix(in_oklab,var(--brand-accent)_72%,var(--foreground))]">
            On the Horizon
          </span>
          <span className="text-xs text-muted-foreground">Announced stablecoins at different readiness levels</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            <span className="font-semibold text-foreground">{total}</span> tracked
          </span>
          <Link
            href="/upcoming/"
            className="pharos-focus-ring group inline-flex min-h-8 items-center gap-1 rounded-full border border-border/60 px-3 py-1.5 font-mono text-[11px] font-medium text-foreground transition-colors hover:border-frost-blue/40 hover:bg-frost-blue/5"
          >
            Open tracker
            <ArrowRight
              aria-hidden="true"
              className="h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-foreground"
              strokeWidth={2}
            />
          </Link>
        </div>
      </div>

      {/* ── Approach rail (constellations) ─────────────────────── */}
      <div className="pharos-rail-ground px-4 py-6 sm:px-6">
        <div className="mb-5 flex items-center justify-between gap-2">
          <span className="pharos-kicker">Approach to launch</span>
          <span className="hidden font-mono text-[10px] uppercase leading-none tracking-[0.14em] [color:color-mix(in_oklab,var(--brand-accent)_64%,var(--muted-foreground))] sm:inline">
            Toward live market
          </span>
        </div>

        {/* Wide layout (xl+): a phase-colored circular constellation per stage,
            sized by coin count, strung along the horizon beam. */}
        <div className="relative hidden items-start justify-between gap-x-3 xl:flex">
          {/* The horizon beam: a hairline dimming far from launch and
              brightening into the frost-lit live-market threshold at the right,
              threading behind every constellation. */}
          <span
            aria-hidden="true"
            style={{ top: maxDiameter / 2 }}
            className="pointer-events-none absolute left-[4%] right-[4%] h-px -translate-y-1/2 bg-gradient-to-r from-border to-frost-blue/60 dark:to-frost-blue/90 dark:shadow-[0_0_10px_0_color-mix(in_oklab,var(--frost-blue)_30%,transparent)]"
          />
          {PHASE_ORDER.map((phase, i) => {
            const coins = coinsByPhase[i];
            const count = coins.length;
            const { pts, fieldR } = packs[i];
            const isThreshold = phase === "launching-soon" && count > 0;
            const diameter = 2 * fieldR;
            return (
              <div key={phase} className="relative flex shrink-0 flex-col items-center gap-3">
                <div className="relative flex items-center justify-center" style={{ height: maxDiameter }}>
                  <div className="relative" style={{ width: diameter, height: diameter }}>
                    <span className="sr-only">
                      {LAUNCH_PHASE_LABELS[phase]}: {count} {count === 1 ? "coin" : "coins"}
                    </span>

                    {/* Phase-colored field — makes the stage recognizable. */}
                    <span
                      aria-hidden="true"
                      className={`pointer-events-none absolute inset-0 rounded-full border ${PHASE_FIELD[phase]} ${
                        isThreshold
                          ? "shadow-[0_0_26px_-4px_color-mix(in_oklab,var(--frost-blue)_55%,transparent)] dark:shadow-[0_0_30px_-2px_color-mix(in_oklab,var(--frost-blue)_70%,transparent)]"
                          : ""
                      }`}
                    />

                    {count === 0 ? (
                      <span
                        aria-hidden="true"
                        className="absolute left-1/2 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-border bg-muted/50 opacity-50"
                      />
                    ) : (
                      coins.map((coin, idx) => (
                        <Link
                          key={coin.id}
                          href={buildStablecoinUrl(coin.id)}
                          title={coin.name}
                          aria-label={`${coin.name} (${coin.symbol}) — ${LAUNCH_PHASE_LABELS[phase]}`}
                          style={{
                            left: fieldR + pts[idx].x,
                            top: fieldR + pts[idx].y,
                          }}
                          className={`absolute -translate-x-1/2 -translate-y-1/2 ${logoLinkClass()}`}
                        >
                          <StablecoinLogo src={logosById[coin.id]} name={coin.name} size={LOGO} />
                        </Link>
                      ))
                    )}
                  </div>
                </div>
                <span className="flex items-center gap-1.5 text-center text-[11px] font-semibold uppercase leading-tight tracking-wide text-muted-foreground">
                  <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${PHASE_DOT[phase]}`} />
                  {LAUNCH_PHASE_LABELS[phase]}
                  <span className="font-mono text-[10px] tabular-nums text-muted-foreground/70">{count}</span>
                </span>
              </div>
            );
          })}
        </div>

        {/* Narrow layout (below xl): phases stack as full-width labelled lanes
            so the large logos have room to spread and wrap. */}
        <div className="flex flex-col divide-y divide-border/40 xl:hidden">
          {PHASE_ORDER.map((phase, i) => {
            const coins = coinsByPhase[i];
            const count = coins.length;
            return (
              <div key={phase} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                <div className="flex w-24 shrink-0 items-center gap-1.5 sm:w-32">
                  <span
                    aria-hidden="true"
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${PHASE_DOT[phase]} ${
                      count === 0 ? "opacity-40" : ""
                    }`}
                  />
                  <span className="min-w-0">
                    <span className="block text-[11px] font-medium leading-tight text-muted-foreground">
                      {LAUNCH_PHASE_LABELS[phase]}
                    </span>
                    <span className="block font-mono text-[10px] leading-tight text-muted-foreground/65">
                      {count} {count === 1 ? "coin" : "coins"}
                    </span>
                  </span>
                </div>
                <div className="flex flex-1 flex-wrap items-center gap-2">
                  <span className="sr-only">
                    {count} {count === 1 ? "coin" : "coins"}
                  </span>
                  {count === 0 ? (
                    <span
                      aria-hidden="true"
                      className="h-3 w-3 rounded-full border border-border bg-muted/50 opacity-50"
                    />
                  ) : (
                    coins.map((coin) => (
                      <Link
                        key={coin.id}
                        href={buildStablecoinUrl(coin.id)}
                        title={coin.name}
                        aria-label={`${coin.name} (${coin.symbol}) — ${LAUNCH_PHASE_LABELS[phase]}`}
                        className={logoLinkClass()}
                      >
                        <StablecoinLogo src={logosById[coin.id]} name={coin.name} size={LOGO} />
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
