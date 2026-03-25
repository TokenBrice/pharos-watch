import Link from "next/link";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { PRE_LAUNCH_STABLECOINS } from "@shared/lib/stablecoins";
import {
  BACKING_LABELS_SHORT,
  GOVERNANCE_LABELS_SHORT,
  PEG_LABELS_SHORT,
} from "@shared/lib/classification";
import { buildStablecoinUrl } from "@/lib/urls";
import {
  LAUNCH_PHASE_LABELS,
  PHASE_BADGE,
  PHASE_RING,
  dateScore,
  formatFuzzyDate,
} from "@/lib/pre-launch";
import { trimTextAtWordBoundary } from "@/lib/page-metadata";
import type { LaunchPhase, StablecoinMeta } from "@shared/types";
import aiSummaries from "../../data/ai-summaries.json";

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function PhaseBadge({ phase }: { phase: LaunchPhase }) {
  return (
    <span
      className={`inline-flex rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none ${PHASE_BADGE[phase]}`}
    >
      {LAUNCH_PHASE_LABELS[phase]}
    </span>
  );
}

function ClassificationBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex rounded-full border border-border/50 bg-muted/50 px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Desktop timeline node
// ---------------------------------------------------------------------------

function TimelineNode({
  coin,
  logoSrc,
  teaser,
  align,
}: {
  coin: StablecoinMeta;
  logoSrc: string | undefined;
  teaser: string | null;
  align: "left" | "center" | "right";
}) {
  const phase = coin.launchPhase;
  const ringClass = phase ? PHASE_RING[phase] : "ring-border/40 hover:ring-border/70";

  // Popover alignment — keep it on-screen for edge nodes
  const popoverAlign =
    align === "left"
      ? "left-0"
      : align === "right"
        ? "right-0"
        : "left-1/2 -translate-x-1/2";

  return (
    <div className="group/node relative z-0 flex flex-col items-center hover:z-20 focus-within:z-20">
      {/* ── Popover ──────────────────────────────────────────── */}
      <div
        className={`pointer-events-none invisible absolute bottom-full w-60 pb-4 translate-y-1 opacity-0 transition-[opacity,visibility,transform] duration-200 ease-out group-hover/node:pointer-events-auto group-hover/node:visible group-hover/node:translate-y-0 group-hover/node:opacity-100 group-focus-within/node:pointer-events-auto group-focus-within/node:visible group-focus-within/node:translate-y-0 group-focus-within/node:opacity-100 ${popoverAlign}`}
      >
        <div className="rounded-lg border border-border/70 bg-card p-3 shadow-xl">
          {/* Header */}
          <div className="flex items-center gap-2">
            <StablecoinLogo src={logoSrc} name={coin.name} size={26} />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-foreground">
                {coin.name}
              </p>
              <p className="font-mono text-[11px] text-muted-foreground">
                {coin.symbol}
              </p>
            </div>
          </div>

          {/* Badges */}
          <div className="mt-2 flex flex-wrap gap-1">
            <ClassificationBadge
              label={PEG_LABELS_SHORT[coin.flags.pegCurrency]}
            />
            <ClassificationBadge
              label={BACKING_LABELS_SHORT[coin.flags.backing]}
            />
            <ClassificationBadge
              label={GOVERNANCE_LABELS_SHORT[coin.flags.governance]}
            />
            {phase && <PhaseBadge phase={phase} />}
          </div>

          {/* Teaser */}
          {teaser && (
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
              {teaser}
            </p>
          )}

          {/* Date */}
          {coin.expectedLaunchDate && (
            <p className="mt-2 font-mono text-[10px] text-muted-foreground/50">
              Expected {formatFuzzyDate(coin.expectedLaunchDate)}
            </p>
          )}
        </div>
        {/* Arrow */}
        <div className="flex justify-center">
          <div className="h-1.5 w-1.5 rotate-45 border-b border-r border-border/70 bg-card" />
        </div>
      </div>

      {/* ── Node: logo with phase ring ───────────────────────── */}
      <Link
        href={buildStablecoinUrl(coin.id)}
        className={`pharos-focus-ring relative rounded-full ring-2 ring-offset-2 ring-offset-background transition-[ring-color,transform] duration-200 group-hover/node:scale-110 ${ringClass}`}
        aria-label={`${coin.name} (${coin.symbol})${phase ? ` — ${LAUNCH_PHASE_LABELS[phase]}` : ""}`}
      >
        <StablecoinLogo src={logoSrc} name={coin.name} size={44} />
      </Link>

      {/* ── Labels below ─────────────────────────────────────── */}
      <span className="mt-2 max-w-20 truncate text-center text-[11px] font-medium text-foreground">
        {coin.symbol}
      </span>
      {coin.expectedLaunchDate && (
        <span className="font-mono text-[10px] text-muted-foreground/50">
          {formatFuzzyDate(coin.expectedLaunchDate)}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mobile vertical timeline entry
// ---------------------------------------------------------------------------

function MobileEntry({
  coin,
  logoSrc,
  teaser,
  isLast,
}: {
  coin: StablecoinMeta;
  logoSrc: string | undefined;
  teaser: string | null;
  isLast: boolean;
}) {
  const phase = coin.launchPhase;

  return (
    <Link
      href={buildStablecoinUrl(coin.id)}
      className="pharos-focus-ring group relative flex gap-4"
      aria-label={`${coin.name} (${coin.symbol})${phase ? ` — ${LAUNCH_PHASE_LABELS[phase]}` : ""}`}
    >
      {/* Vertical connector */}
      {!isLast && (
        <div className="absolute bottom-0 left-[17px] top-10 w-px bg-border/30" />
      )}

      {/* Logo */}
      <div className="shrink-0 pt-0.5">
        <StablecoinLogo src={logoSrc} name={coin.name} size={36} />
      </div>

      {/* Details */}
      <div className="min-w-0 flex-1 pb-5">
        <div className="flex items-baseline gap-2">
          <p className="truncate text-sm font-medium text-foreground group-hover:text-foreground/80">
            {coin.name}
          </p>
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
            {coin.symbol}
          </span>
        </div>

        <div className="mt-1.5 flex flex-wrap gap-1">
          <ClassificationBadge
            label={PEG_LABELS_SHORT[coin.flags.pegCurrency]}
          />
          <ClassificationBadge
            label={BACKING_LABELS_SHORT[coin.flags.backing]}
          />
          <ClassificationBadge
            label={GOVERNANCE_LABELS_SHORT[coin.flags.governance]}
          />
          {phase && <PhaseBadge phase={phase} />}
        </div>

        {teaser && (
          <p className="mt-1.5 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
            {teaser}
          </p>
        )}

        {coin.expectedLaunchDate && (
          <p className="mt-1.5 font-mono text-[10px] text-muted-foreground/50">
            Expected {formatFuzzyDate(coin.expectedLaunchDate)}
          </p>
        )}
      </div>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Main section
// ---------------------------------------------------------------------------

interface Props {
  logos: Record<string, string>;
}

export function UpcomingStablecoinsSection({ logos }: Props) {
  if (PRE_LAUNCH_STABLECOINS.length === 0) return null;

  const summaries = aiSummaries as Record<
    string,
    { title?: string; text?: string; updatedAt?: string }
  >;
  const sorted = [...PRE_LAUNCH_STABLECOINS]
    .sort((a, b) => dateScore(a.expectedLaunchDate) - dateScore(b.expectedLaunchDate))
    .slice(0, 7);

  return (
    <section
      aria-labelledby="upcoming-heading"
      className="mt-8 space-y-5 border-t border-border/40 pt-6"
    >
      <div className="space-y-1.5">
        <p className="pharos-kicker">Upcoming Stablecoins</p>
        <div className="space-y-1">
          <div className="flex items-baseline justify-between gap-4">
            <h2 id="upcoming-heading" className="text-2xl font-semibold tracking-tight text-foreground">
              {PRE_LAUNCH_STABLECOINS.length} stablecoins on the horizon
            </h2>
            <Link
              href="/upcoming"
              className="shrink-0 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              View all &rarr;
            </Link>
          </div>
          <p className="text-sm text-muted-foreground">
            Pre-launch projects tracked by Pharos. Hover a coin for details, or click to view the full profile.
          </p>
        </div>
      </div>

      {/* ── Desktop: horizontal timeline ─────────────────────── */}
      <div className="hidden md:block" role="navigation" aria-label="Launch timeline">
        <div className="relative pb-2 pt-4">
          {/* Timeline rail — gradient from brand accent into border */}
          <div className="absolute inset-x-0 top-[calc(1rem+22px)] h-px bg-gradient-to-r from-indigo-500/30 via-border/50 to-transparent" />

          {/* Arrowhead */}
          <div className="absolute right-0 top-[calc(1rem+18px)] font-mono text-[10px] text-muted-foreground/30">
            →
          </div>

          {/* Nodes */}
          <div className="relative flex justify-around px-4">
            {sorted.map((coin, i) => (
              <TimelineNode
                key={coin.id}
                coin={coin}
                logoSrc={logos[coin.id]}
                teaser={
                  summaries[coin.id]?.text
                    ? trimTextAtWordBoundary(summaries[coin.id].text!, 120)
                    : null
                }
                align={
                  i === 0
                    ? "left"
                    : i === sorted.length - 1
                      ? "right"
                      : "center"
                }
              />
            ))}
          </div>
        </div>
      </div>

      {/* ── Mobile: vertical timeline ────────────────────────── */}
      <div className="md:hidden" role="navigation" aria-label="Launch timeline">
        {sorted.map((coin, i) => (
          <MobileEntry
            key={coin.id}
            coin={coin}
            logoSrc={logos[coin.id]}
            teaser={summaries[coin.id]?.text ?? null}
            isLast={i === sorted.length - 1}
          />
        ))}
      </div>
    </section>
  );
}
