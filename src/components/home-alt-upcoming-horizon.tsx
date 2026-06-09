import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { PRE_LAUNCH_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { LaunchPhase } from "@shared/types";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { buildStablecoinUrl } from "@/lib/urls";
import { logosById } from "@/lib/logos";
import {
  LAUNCH_PHASE_LABELS,
  PHASE_BADGE,
  PHASE_DOT,
  DRIFT_STATUS_LABEL,
  type DriftStatus,
  getDriftStatus,
  dateScore,
  formatFuzzyDate,
} from "@/lib/pre-launch";

// Phases ordered far-from-launch → nearest-to-launch. The approach rail reads
// left (announced) to right (launching soon = the live-market threshold).
const PHASE_ORDER: readonly LaunchPhase[] = [
  "announced",
  "testnet",
  "auditing",
  "beta",
  "launching-soon",
];

// Compact labels for the rail's narrow mobile columns.
const PHASE_ABBR: Record<LaunchPhase, string> = {
  announced: "Ann.",
  testnet: "Test",
  auditing: "Audit",
  beta: "Beta",
  "launching-soon": "Soon",
};

function phaseRank(phase: LaunchPhase | undefined): number {
  return phase ? PHASE_ORDER.indexOf(phase) : -1;
}

function driftTextClass(drift: DriftStatus): string {
  return drift === "overdue" || drift === "pushed-multiple"
    ? "text-red-700 dark:text-red-400"
    : "text-amber-700 dark:text-amber-400";
}

// Node diameter scales with the phase's coin count so the rail's silhouette
// reads as the live distribution at a glance. A wide dynamic range keeps the
// busiest and quietest phases visibly distinct rather than near-identical.
function nodeSize(count: number, maxCount: number): number {
  if (count === 0) return 26;
  return 32 + Math.round((count / maxCount) * 26);
}

export function HomeAltUpcomingHorizon(): React.JSX.Element | null {
  const total = PRE_LAUNCH_STABLECOINS.length;
  if (total === 0) return null;

  const counts = PHASE_ORDER.map(
    (phase) => PRE_LAUNCH_STABLECOINS.filter((c) => c.launchPhase === phase).length,
  );
  const maxCount = Math.max(1, ...counts);

  const nearest = [...PRE_LAUNCH_STABLECOINS]
    .sort((a, b) => {
      const byPhase = phaseRank(b.launchPhase) - phaseRank(a.launchPhase);
      if (byPhase !== 0) return byPhase;
      return dateScore(a.expectedLaunchDate) - dateScore(b.expectedLaunchDate);
    })
    .slice(0, 6);

  return (
    <section
      aria-labelledby="upcoming-horizon-title"
      className="pharos-card-shell overflow-hidden p-0"
    >
      <h2 id="upcoming-horizon-title" className="sr-only">
        Upcoming stablecoins on the horizon
      </h2>

      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border/50 px-4 py-3 sm:px-6">
        <div className="flex flex-col gap-0.5">
          <span className="font-mono text-[11px] font-semibold uppercase leading-none tracking-[0.16em] [color:color-mix(in_oklab,var(--brand-accent)_72%,var(--foreground))]">
            On the Horizon
          </span>
          <span className="text-xs text-muted-foreground">
            Pre-launch stablecoins approaching the live market
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            <span className="font-semibold text-foreground">{total}</span> tracked
          </span>
          <Link
            href="/upcoming/"
            className="pharos-focus-ring group inline-flex items-center gap-1 rounded-full border border-border/60 px-2.5 py-1 font-mono text-[11px] font-medium text-foreground transition-colors hover:border-frost-blue/40 hover:bg-frost-blue/5"
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

      {/* ── Approach rail ──────────────────────────────────────── */}
      <div className="pharos-rail-ground px-4 py-6 sm:px-6">
        <div className="mb-5 flex items-center justify-between gap-2">
          <span className="pharos-kicker">Approach to launch</span>
          <span className="hidden font-mono text-[10px] uppercase leading-none tracking-[0.14em] [color:color-mix(in_oklab,var(--brand-accent)_64%,var(--muted-foreground))] sm:inline">
            Toward live market
          </span>
        </div>

        <div className="relative grid grid-cols-5">
          {/* The beam: a hairline dimming far from launch and brightening into
              the frost-lit live-market threshold at the right. */}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-[10%] right-[10%] top-[30px] h-px -translate-y-1/2 bg-gradient-to-r from-border to-frost-blue/60 dark:to-frost-blue/90 dark:shadow-[0_0_10px_0_color-mix(in_oklab,var(--frost-blue)_30%,transparent)]"
          />
          {PHASE_ORDER.map((phase, i) => {
            const count = counts[i];
            const size = nodeSize(count, maxCount);
            const isThreshold = phase === "launching-soon" && count > 0;
            return (
              <div key={phase} className="relative flex flex-col items-center gap-2">
                <div className="flex h-[60px] items-center">
                  <span
                    style={{ width: size, height: size }}
                    className={`relative z-10 inline-flex items-center justify-center rounded-full border font-mono text-[13px] font-bold tabular-nums ${PHASE_BADGE[phase]} ${
                      count === 0 ? "opacity-45" : ""
                    } ${
                      isThreshold
                        ? "shadow-[0_0_0_4px_color-mix(in_oklab,var(--frost-blue)_14%,transparent),0_0_18px_-2px_color-mix(in_oklab,var(--frost-blue)_32%,transparent)] dark:shadow-[0_0_0_5px_color-mix(in_oklab,var(--frost-blue)_22%,transparent),0_0_24px_-2px_color-mix(in_oklab,var(--frost-blue)_55%,transparent)]"
                        : ""
                    }`}
                  >
                    {count}
                  </span>
                </div>
                <span className="text-center text-[10px] font-medium leading-tight text-muted-foreground">
                  <span className="sm:hidden">{PHASE_ABBR[phase]}</span>
                  <span className="hidden sm:inline">{LAUNCH_PHASE_LABELS[phase]}</span>
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Nearest launches ───────────────────────────────────── */}
      <div className="border-t border-border/50 px-4 py-4 sm:px-6">
        <div className="mb-3 flex items-baseline justify-between gap-2">
          <span className="pharos-kicker">Nearest launches</span>
          <span className="hidden font-mono text-[10px] uppercase leading-none tracking-[0.14em] text-muted-foreground/70 sm:inline">
            By readiness
          </span>
        </div>

        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 xl:grid-cols-6">
          {nearest.map((coin) => {
            const phase = coin.launchPhase;
            const drift = getDriftStatus(coin.dateHistory, coin.expectedLaunchDate);
            const flagged = drift === "overdue" || drift === "pushed-multiple";
            const expected = coin.expectedLaunchDate;
            const yearOnly = expected ? /^\d{4}$/.test(expected) : false;
            return (
              <Link
                key={coin.id}
                href={buildStablecoinUrl(coin.id)}
                title={coin.name}
                aria-label={`${coin.name} (${coin.symbol})${
                  phase ? ` — ${LAUNCH_PHASE_LABELS[phase]}` : ""
                }${expected ? `, expected ${formatFuzzyDate(expected)}` : ""}${
                  flagged ? ` — ${DRIFT_STATUS_LABEL[drift]}` : ""
                }`}
                className={`pharos-focus-ring flex items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors ${
                  flagged
                    ? "bg-red-500/[0.06] hover:bg-red-500/10 dark:bg-red-500/[0.09]"
                    : "hover:bg-muted/50"
                }`}
              >
                <StablecoinLogo src={logosById[coin.id]} name={coin.name} size={30} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-semibold text-foreground">
                    {coin.symbol}
                  </p>
                  {phase ? (
                    <div className="mt-0.5 flex items-center gap-1.5">
                      <span
                        aria-hidden="true"
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${PHASE_DOT[phase]}`}
                      />
                      <span className="truncate text-[10px] font-medium text-muted-foreground">
                        {LAUNCH_PHASE_LABELS[phase]}
                      </span>
                    </div>
                  ) : null}
                  <p
                    className={`mt-0.5 truncate font-mono text-[10px] ${
                      flagged
                        ? `font-medium ${driftTextClass(drift)}`
                        : yearOnly
                          ? "text-muted-foreground/55"
                          : "text-muted-foreground"
                    }`}
                  >
                    {flagged
                      ? DRIFT_STATUS_LABEL[drift]
                      : expected
                        ? formatFuzzyDate(expected)
                        : "Date TBD"}
                  </p>
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </section>
  );
}
