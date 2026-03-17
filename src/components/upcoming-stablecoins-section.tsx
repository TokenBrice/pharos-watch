import Link from "next/link";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { PRE_LAUNCH_STABLECOINS } from "@shared/lib/stablecoins";
import {
  BACKING_LABELS_SHORT,
  GOVERNANCE_LABELS_SHORT,
  PEG_LABELS_SHORT,
} from "@shared/lib/classification";
import { buildStablecoinUrl } from "@/lib/urls";
import type { LaunchPhase, StablecoinMeta } from "@shared/types";
import aiSummaries from "../../data/ai-summaries.json";

// ---------------------------------------------------------------------------
// Constants & styles
// ---------------------------------------------------------------------------

const LAUNCH_PHASE_LABELS: Record<LaunchPhase, string> = {
  announced: "Announced",
  testnet: "Testnet",
  auditing: "Auditing",
  beta: "Beta",
  "launching-soon": "Launching Soon",
};

/** Phase → full badge class string (static for Tailwind scanner). */
const PHASE_BADGE: Record<LaunchPhase, string> = {
  announced:
    "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  testnet:
    "border-indigo-500/30 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",
  auditing:
    "border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-400",
  beta: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  "launching-soon":
    "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400",
};

/** Phase → ring color around logo node (static for Tailwind scanner). */
const PHASE_RING: Record<LaunchPhase, string> = {
  announced: "ring-amber-500/40 hover:ring-amber-500/70",
  testnet: "ring-indigo-500/40 hover:ring-indigo-500/70",
  auditing: "ring-violet-500/40 hover:ring-violet-500/70",
  beta: "ring-emerald-500/40 hover:ring-emerald-500/70",
  "launching-soon": "ring-sky-500/40 hover:ring-sky-500/70",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert fuzzy date strings to a numeric score for chronological sorting. */
function dateScore(raw?: string): number {
  if (!raw) return 999999;
  const q = raw.match(/^(\d{4})-Q(\d)$/);
  if (q) return Number(q[1]) * 13 + Number(q[2]) * 3 + 1;
  const m = raw.match(/^(\d{4})-(\d{2})$/);
  if (m) return Number(m[1]) * 13 + Number(m[2]);
  const y = raw.match(/^(\d{4})$/);
  if (y) return Number(y[1]) * 13 + 13;
  return 999999;
}

function formatExpectedDate(raw: string): string {
  const q = raw.match(/^(\d{4})-Q(\d)$/);
  if (q) return `Q${q[2]} ${q[1]}`;
  const m = raw.match(/^(\d{4})-(\d{2})$/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1);
    return d.toLocaleString("en-US", { month: "short", year: "numeric" });
  }
  return raw;
}

function truncateTeaser(text: string, max = 120): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf(" ", max);
  return text.slice(0, cut > 0 ? cut : max) + "\u2026";
}

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
        className={`pointer-events-none invisible absolute bottom-full mb-4 w-60 translate-y-1 opacity-0 transition-[opacity,visibility,transform] duration-200 ease-out group-hover/node:pointer-events-auto group-hover/node:visible group-hover/node:translate-y-0 group-hover/node:opacity-100 group-focus-within/node:pointer-events-auto group-focus-within/node:visible group-focus-within/node:translate-y-0 group-focus-within/node:opacity-100 ${popoverAlign}`}
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
              Expected {formatExpectedDate(coin.expectedLaunchDate)}
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
          {formatExpectedDate(coin.expectedLaunchDate)}
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
            Expected {formatExpectedDate(coin.expectedLaunchDate)}
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
  const sorted = [...PRE_LAUNCH_STABLECOINS].sort(
    (a, b) => dateScore(a.expectedLaunchDate) - dateScore(b.expectedLaunchDate),
  );

  return (
    <section
      aria-labelledby="upcoming-heading"
      className="mt-8 space-y-5 border-t border-border/40 pt-6"
    >
      <div className="flex items-center gap-2">
        <h2 id="upcoming-heading" className="pharos-kicker">
          Upcoming Stablecoins
        </h2>
        <span
          className="inline-flex items-center rounded-full border border-indigo-500/30 bg-indigo-500/10 px-2 py-0.5 text-[11px] font-medium tabular-nums text-indigo-600 dark:text-indigo-400"
          aria-hidden="true"
        >
          {PRE_LAUNCH_STABLECOINS.length}
        </span>
      </div>

      {/* ── Desktop: horizontal timeline ─────────────────────── */}
      <div className="hidden md:block" aria-label="Launch timeline">
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
                    ? truncateTeaser(summaries[coin.id].text!)
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
      <div className="md:hidden">
        {sorted.map((coin, i) => (
          <MobileEntry
            key={coin.id}
            coin={coin}
            logoSrc={logos[coin.id]}
            teaser={
              summaries[coin.id]?.text
                ? truncateTeaser(summaries[coin.id].text!, 80)
                : null
            }
            isLast={i === sorted.length - 1}
          />
        ))}
      </div>
    </section>
  );
}
