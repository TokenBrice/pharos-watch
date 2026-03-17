import Link from "next/link";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { PRE_LAUNCH_STABLECOINS } from "@shared/lib/stablecoins";
import { BACKING_LABELS_SHORT, GOVERNANCE_LABELS_SHORT, PEG_LABELS_SHORT } from "@shared/lib/classification";
import { buildStablecoinUrl } from "@/lib/urls";
import type { LaunchPhase } from "@shared/types";
import aiSummaries from "../../data/ai-summaries.json";

const LAUNCH_PHASE_LABELS: Record<LaunchPhase, string> = {
  announced: "Announced",
  testnet: "Testnet",
  auditing: "Auditing",
  beta: "Beta",
  "launching-soon": "Launching Soon",
};

/** Format expectedLaunchDate: YYYY-QN → "YYYY QN", YYYY-MM → "Mon YYYY", YYYY → "YYYY" */
function formatExpectedDate(raw: string): string {
  const quarterMatch = raw.match(/^(\d{4})-Q(\d)$/);
  if (quarterMatch) return `${quarterMatch[1]} Q${quarterMatch[2]}`;

  const monthMatch = raw.match(/^(\d{4})-(\d{2})$/);
  if (monthMatch) {
    const date = new Date(Number(monthMatch[1]), Number(monthMatch[2]) - 1);
    return date.toLocaleString("en-US", { month: "short", year: "numeric" });
  }

  return raw; // "YYYY" or anything else passes through
}

function truncateTeaser(text: string, max = 100): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf(" ", max);
  return text.slice(0, cut > 0 ? cut : max) + "\u2026";
}

interface Props {
  logos: Record<string, string>;
}

export function UpcomingStablecoinsSection({ logos }: Props) {
  if (PRE_LAUNCH_STABLECOINS.length === 0) return null;

  const summaries = aiSummaries as Record<string, { title?: string; text?: string; updatedAt?: string }>;

  return (
    <section aria-labelledby="upcoming-heading" className="mt-8 space-y-3">
      <div className="flex items-center gap-2">
        <h2 id="upcoming-heading" className="pharos-kicker">Upcoming Stablecoins</h2>
        <span
          className="inline-flex items-center rounded-full border border-indigo-500/30 bg-indigo-500/10 px-2 py-0.5 text-[11px] font-medium tabular-nums text-indigo-600 dark:text-indigo-400"
          aria-hidden="true"
        >
          {PRE_LAUNCH_STABLECOINS.length}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {PRE_LAUNCH_STABLECOINS.map((coin) => {
          const summary = summaries[coin.id];
          const teaser = summary?.text ? truncateTeaser(summary.text) : null;

          return (
            <Link
              key={coin.id}
              href={buildStablecoinUrl(coin.id)}
              className="pharos-focus-ring pharos-interactive-card group flex flex-col gap-2.5 rounded-xl border border-border/60 bg-card/50 p-4 hover:bg-accent"
              aria-label={`${coin.name} (${coin.symbol})${coin.launchPhase ? ` — ${LAUNCH_PHASE_LABELS[coin.launchPhase]}` : ""}`}
            >
              {/* Name row */}
              <div className="flex items-center gap-2.5">
                <StablecoinLogo src={logos[coin.id]} name={coin.name} size={28} />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{coin.name}</p>
                  <p className="font-mono text-xs text-muted-foreground">{coin.symbol}</p>
                </div>
              </div>

              {/* Badges */}
              <div className="flex flex-wrap gap-1.5">
                <span className="inline-flex rounded-full border border-border/50 bg-muted/50 px-2 py-0.5 text-[11px] text-muted-foreground">
                  {PEG_LABELS_SHORT[coin.flags.pegCurrency]}
                </span>
                <span className="inline-flex rounded-full border border-border/50 bg-muted/50 px-2 py-0.5 text-[11px] text-muted-foreground">
                  {BACKING_LABELS_SHORT[coin.flags.backing]}
                </span>
                <span className="inline-flex rounded-full border border-border/50 bg-muted/50 px-2 py-0.5 text-[11px] text-muted-foreground">
                  {GOVERNANCE_LABELS_SHORT[coin.flags.governance]}
                </span>
                {coin.launchPhase && (
                  <span className="inline-flex rounded-full border border-indigo-500/30 bg-indigo-500/10 px-2 py-0.5 text-[11px] font-medium text-indigo-600 dark:text-indigo-400">
                    {LAUNCH_PHASE_LABELS[coin.launchPhase]}
                  </span>
                )}
              </div>

              {/* Teaser */}
              {teaser ? (
                <p className="line-clamp-3 text-xs leading-snug text-muted-foreground">
                  {teaser}
                </p>
              ) : (
                <p className="line-clamp-3 text-xs italic leading-snug text-muted-foreground/50">
                  No description available
                </p>
              )}

              {/* Expected launch */}
              {coin.expectedLaunchDate && (
                <p className="mt-auto text-xs text-muted-foreground/70">
                  Expected {formatExpectedDate(coin.expectedLaunchDate)}
                </p>
              )}
            </Link>
          );
        })}
      </div>
    </section>
  );
}
