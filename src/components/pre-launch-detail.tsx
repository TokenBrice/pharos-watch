import Link from "next/link";
import Image from "next/image";
import { Suspense } from "react";
import { ExternalLink, Globe, Calendar, Shield, ArrowLeft, FileText, BookOpen, Play, Bell } from "lucide-react";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { BACKING_LABELS, GOVERNANCE_LABELS, PEG_LABELS_SHORT } from "@shared/lib/classification";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { CopyButton } from "@/components/copy-button";
import { PreLaunchTweetEmbed } from "@/components/pre-launch-tweet-embed";
import { LaunchDriftBadge, LaunchMilestoneBadge, LaunchPhaseBadge } from "@/components/pre-launch-badge";
import { TermText } from "@/components/term-text";
import { getRelatedStablecoins } from "@/lib/related-stablecoins";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { clampScore } from "@shared/lib/math";
import { TELEGRAM_BOT_URL } from "@shared/lib/telegram-bot-registration";
import {
  getDriftStatus,
  formatFuzzyDate,
  parseFuzzyDate,
  dateScore,
} from "@/lib/pre-launch";
import type { StablecoinMeta, LaunchMilestone, FeaturedContent } from "@shared/types";
import { formatLongDate } from "@shared/lib/format";

// ---------------------------------------------------------------------------
// Link icon mapping
// ---------------------------------------------------------------------------

function getLinkIcon(label: string) {
  const normalized = label.toLowerCase();
  if (normalized.includes("twitter") || normalized.includes("x")) {
    return <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />;
  }
  if (normalized.includes("website") || normalized.includes("homepage")) {
    return <Globe className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />;
  }
  if (normalized.includes("docs") || normalized.includes("documentation")) {
    return <FileText className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />;
  }
  if (normalized.includes("audit") || normalized.includes("security")) {
    return <Shield className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />;
  }
  return <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />;
}

function ContentTypeIcon({ type }: { type: FeaturedContent["type"] }) {
  const cls = "h-3.5 w-3.5";
  switch (type) {
    case "blog":
    case "article":
      return <BookOpen className={cls} aria-hidden="true" />;
    case "video":
      return <Play className={cls} aria-hidden="true" />;
    default:
      return <ExternalLink className={cls} aria-hidden="true" />;
  }
}

/** Extract tweet ID from an x.com or twitter.com URL. */
function extractTweetId(url: string): string | null {
  const match = url.match(/\/status\/(\d+)/);
  return match ? match[1] : null;
}

function formatSummaryUpdatedAt(updatedAt: string): string {
  return formatLongDate(new Date(`${updatedAt}T00:00:00Z`), { utc: true });
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function TimelineBar({ announcedDate, expectedLaunchDate }: { announcedDate: string; expectedLaunchDate: string }) {
  const start = parseFuzzyDate(announcedDate);
  const end = parseFuzzyDate(expectedLaunchDate);
  const now = new Date();

  if (!start || !end || end <= start) return null;

  const totalMs = end.getTime() - start.getTime();
  const elapsedMs = now.getTime() - start.getTime();
  const pct = clampScore((elapsedMs / totalMs) * 100);

  // ARIA values for accessibility
  const ariaValueNow = Math.round(pct);
  const ariaValueMin = 0;
  const ariaValueMax = 100;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{formatFuzzyDate(announcedDate)}</span>
        <span>Expected: {formatFuzzyDate(expectedLaunchDate)}</span>
      </div>
      <div
        className="relative h-2 w-full overflow-hidden rounded-full bg-muted/40"
        role="progressbar"
        aria-valuenow={ariaValueNow}
        aria-valuemin={ariaValueMin}
        aria-valuemax={ariaValueMax}
        aria-label="Launch timeline progress"
      >
        <div className="absolute inset-y-0 left-0 rounded-full bg-indigo-500/60" style={{ width: `${pct}%` }} />
        {pct > 2 && pct < 98 && (
          <div
            className="absolute top-1/2 h-3 w-0.5 -translate-y-1/2 rounded-full bg-foreground"
            style={{ left: `${pct}%` }}
            title="Today"
          />
        )}
      </div>
      {pct > 2 && pct < 98 && <div className="text-center text-xs text-muted-foreground">Today</div>}
    </div>
  );
}

function InfoGridItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <dt className="pharos-kicker">{label}</dt>
      <dd className="text-sm font-medium">{value}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Milestones timeline
// ---------------------------------------------------------------------------

function MilestoneTimeline({ milestones }: { milestones: LaunchMilestone[] }) {
  const sorted = [...milestones].sort((a, b) => dateScore(b.date) - dateScore(a.date));

  return (
    <div className="space-y-0">
      {sorted.map((m, i) => {
        const isLast = i === sorted.length - 1;
        const dateDisplay = formatFuzzyDate(m.date);

        return (
          <div key={`${m.date}-${m.title}`} className="relative flex gap-3">
            {/* Vertical connector */}
            {!isLast && <div className="absolute bottom-0 left-[7px] top-5 w-px bg-border/40" />}

            {/* Dot */}
            <div className="relative mt-1.5 h-3.5 w-3.5 shrink-0 rounded-full border-2 border-border bg-background" />

            {/* Content */}
            <div className="min-w-0 flex-1 pb-4">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="pharos-numeric text-xs text-muted-foreground">{dateDisplay}</span>
                <LaunchMilestoneBadge type={m.type} />
              </div>
              <p className="mt-1 text-sm font-medium text-foreground">{m.title}</p>
              {m.description && <p className="mt-0.5 break-words text-xs leading-relaxed text-muted-foreground">{m.description}</p>}
              {m.sourceUrl && (
                <a
                  href={m.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground/70 hover:text-foreground"
                >
                  <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  Source
                </a>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface PreLaunchDetailProps {
  coin: StablecoinMeta;
  logoSrc: string | undefined;
  summary: { title: string; text: string; updatedAt: string } | null;
  logos: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Main component (server component — no "use client")
// ---------------------------------------------------------------------------

export function PreLaunchDetail({ coin, logoSrc, summary, logos }: PreLaunchDetailProps) {
  const related = getRelatedStablecoins(coin, { candidates: ACTIVE_STABLECOINS });
  const chains = coin.contracts?.map((c) => c.chain) ?? [];
  const uniqueChains = [...new Set(chains)];
  const launchAlertCommand = `/subscribe launch ${coin.id}`;
  const summaryDateline = summary ? formatSummaryUpdatedAt(summary.updatedAt) : null;

  // Build jurisdiction display with regulator if available
  const jurisdictionDisplay = coin.jurisdiction?.regulator
    ? `${coin.jurisdiction.country} (${coin.jurisdiction.regulator})`
    : coin.jurisdiction?.country;

  const launchAlertCallout = (
    <section className="rounded-xl border border-sky-500/25 bg-sky-500/[0.05] px-4 py-4 sm:px-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-semibold text-sky-700 dark:text-sky-300">
            <Bell className="h-4 w-4" aria-hidden="true" />
            <span>Launch Alert</span>
          </div>
          <div className="space-y-1">
            <p className="text-sm font-semibold text-foreground">
              Get a Telegram alert when {coin.symbol} becomes tracked on Pharos
            </p>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Copy this exact command and send it to{" "}
              <a
                href={TELEGRAM_BOT_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="pharos-focus-ring inline-flex items-center gap-1 rounded-sm text-foreground underline underline-offset-4 transition-colors hover:text-foreground/80"
              >
                @PharosWatchBot
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </a>
              . It uses this coin&apos;s exact Pharos ID, so it works even when a ticker is ambiguous.
            </p>
          </div>
        </div>

        <div className="min-w-0 rounded-xl border border-border/60 bg-background/55 p-3">
          <p className="pharos-kicker">Copy Exact Bot Command</p>
          <div className="mt-2 flex items-center gap-2">
            <code tabIndex={0} className="pharos-focus-ring block min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-lg bg-background/80 px-3 py-2 text-xs font-mono tabular-nums text-foreground sm:text-sm">
              {launchAlertCommand}
            </code>
            <CopyButton
              text={launchAlertCommand}
              className="shrink-0 rounded-lg border border-border/60 bg-background/70 text-muted-foreground hover:bg-background hover:text-foreground"
            />
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-3 text-xs text-muted-foreground">
        <a
          href={TELEGRAM_BOT_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="pharos-focus-ring inline-flex items-center gap-1 rounded-sm underline underline-offset-4 transition-colors hover:text-foreground"
        >
          Open @PharosWatchBot
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </a>
        <Link
          href="/pharoswatchbot/#getting-started"
          className="pharos-focus-ring inline-flex items-center gap-1 rounded-sm underline underline-offset-4 transition-colors hover:text-foreground"
        >
          See all Telegram alert options
        </Link>
      </div>
    </section>
  );

  return (
    <div className="space-y-8">
      {/* ── Back Navigation ───────────────────────────────────────── */}
      <nav aria-label="Back navigation">
        <Link
          href="/upcoming/"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          <span>Back to Upcoming</span>
        </Link>
      </nav>

      {/* ── Header ────────────────────────────────────────────────── */}
      <header className="flex items-start gap-4">
        <StablecoinLogo src={logoSrc} name={coin.name} size={48} />
        <div className="min-w-0 space-y-1">
          <h1 className="break-words text-2xl font-extrabold tracking-tight sm:text-3xl">
            {coin.name} ({coin.symbol}) Pre-launch Stablecoin Tracker
          </h1>
          <p className="font-mono tabular-nums text-sm text-muted-foreground">{coin.symbol}</p>
        </div>
      </header>

      {/* ── Pre-Launch Banner ─────────────────────────────────────── */}
      <div className="rounded-xl border border-indigo-500/25 bg-indigo-500/[0.06] px-4 py-4 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-semibold text-indigo-600 dark:text-indigo-400">Pre-launch</span>
          <span className="text-sm text-muted-foreground">Pharos hasn&apos;t ingested data for this one yet.</span>
          {coin.launchPhase && <LaunchPhaseBadge phase={coin.launchPhase} size="detail" />}
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          Pharos can still tell you how this asset is supposed to work, when it expects to launch, and what sources to
          watch. Live market, peg, liquidity, and safety surfaces activate only after the first post-launch data sync.
        </p>
        {coin.launchPhaseDetail && (
          <details className="mt-3">
            <summary className="pharos-focus-ring cursor-pointer rounded-sm text-sm font-medium text-foreground">
              Full launch status and history
            </summary>
            <p className="mt-2 break-words text-sm text-muted-foreground">{coin.launchPhaseDetail}</p>
          </details>
        )}
      </div>

      {/* ── At-a-Glance Grid ─────────────────────────────────────── */}
      <section className="pharos-card-shell p-4 sm:p-5">
        <h3 className="mb-3 text-lg font-semibold tracking-tight">At a Glance</h3>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          <InfoGridItem label="Backing" value={BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing} />
          <InfoGridItem label="Governance" value={GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance} />
          <InfoGridItem
            label="Peg Currency"
            value={PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency}
          />
          {jurisdictionDisplay && <InfoGridItem label="Jurisdiction" value={jurisdictionDisplay} />}
          {coin.flags.yieldBearing && <InfoGridItem label="Yield-Bearing" value="Yes" />}
        </dl>
      </section>

      {/* ── Launch Timeline ───────────────────────────────────────── */}
      {(() => {
        const drift = getDriftStatus(coin.dateHistory, coin.expectedLaunchDate);
        const hasDrift = coin.dateHistory && coin.dateHistory.length > 0;
        const driftBadge = hasDrift ? <LaunchDriftBadge status={drift} size="detail" /> : null;
        const dateTrail =
          hasDrift && coin.expectedLaunchDate ? (
            <p className="mt-2 text-xs text-muted-foreground/70">
              {coin.dateHistory!.map((entry) => formatFuzzyDate(entry.date)).join(" → ")}
              {" → "}
              {formatFuzzyDate(coin.expectedLaunchDate)} (current)
            </p>
          ) : null;

        if (coin.announcedDate && coin.expectedLaunchDate) {
          return (
            <section className="pharos-card-shell p-4 sm:p-5">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-lg font-semibold tracking-tight">Launch Timeline</h3>
                {driftBadge}
              </div>
              <TimelineBar announcedDate={coin.announcedDate} expectedLaunchDate={coin.expectedLaunchDate} />
              {dateTrail}
            </section>
          );
        }
        if (coin.expectedLaunchDate) {
          return (
            <section className="pharos-card-shell p-4 sm:p-5">
              <div className="flex items-center gap-2 text-sm">
                <Calendar className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <span className="text-muted-foreground">Expected Launch:</span>
                <span className="font-medium">{formatFuzzyDate(coin.expectedLaunchDate)}</span>
                {driftBadge}
              </div>
              {dateTrail}
            </section>
          );
        }
        return null;
      })()}

      {/* ── Launch Alert CTA ──────────────────────────────────────── */}
      {launchAlertCallout}

      {/* ── Activity Timeline (milestones) ─────────────────────────── */}
      {coin.milestones && coin.milestones.length > 0 && (
        <section className="pharos-card-shell p-4 sm:p-5">
          <h3 className="mb-3 text-lg font-semibold tracking-tight">Activity Timeline</h3>
          <MilestoneTimeline milestones={coin.milestones} />
        </section>
      )}

      {/* ── Editorial Summary ─────────────────────────────────────── */}
      {summary && (
        <section className="pharos-card-shell space-y-2 p-4 sm:p-5">
          <h3 className="text-lg font-semibold tracking-tight">{summary.title}</h3>
          <p className="text-sm leading-relaxed text-muted-foreground">
            <TermText text={summary.text} />
          </p>
          <p className="text-[11px] text-muted-foreground/70">
            Updated <time dateTime={summary.updatedAt}>{summaryDateline}</time>
          </p>
        </section>
      )}

      {/* ── Discover ───────────────────────────────────────────────── */}
      {coin.featuredContent && coin.featuredContent.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-lg font-semibold tracking-tight">Discover</h3>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {coin.featuredContent.map((item) => {
              const tweetId = item.type === "tweet" ? extractTweetId(item.url) : null;

              /* ── Tweet embed ─────────────────────────────────── */
              if (tweetId) {
                return (
                  <div key={item.url} className="overflow-hidden rounded-xl [&_.react-tweet-theme]:!my-0">
                    <Suspense
                      fallback={
                        <div className="flex h-40 items-center justify-center rounded-xl border border-border/60 bg-card/50 text-sm text-muted-foreground">
                          Loading tweet…
                        </div>
                      }
                    >
                      <PreLaunchTweetEmbed id={tweetId} />
                    </Suspense>
                  </div>
                );
              }

              /* ── Rich card (blog / article / video) ─────────── */
              return (
                <a
                  key={item.url}
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="pharos-focus-ring pharos-interactive-card group flex flex-col overflow-hidden rounded-xl border border-border/60 bg-card/50"
                >
                  {item.image && (
                    <div className="relative aspect-[1200/630] w-full overflow-hidden bg-muted/30">
                      <Image
                        src={item.image}
                        alt={item.title}
                        fill
                        sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
                        className="object-cover transition-transform duration-300 group-hover:scale-[1.02]"
                        unoptimized
                      />
                    </div>
                  )}
                  <div className="flex flex-1 flex-col gap-1.5 p-4">
                    <p className="text-sm font-semibold text-foreground">{item.title}</p>
                    {item.description && (
                      <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">{item.description}</p>
                    )}
                    <div className="mt-auto flex items-center gap-1.5 pt-1 text-[11px] text-muted-foreground/70">
                      <ContentTypeIcon type={item.type} />
                      <span>{item.source ?? item.type}</span>
                    </div>
                  </div>
                </a>
              );
            })}
          </div>
        </section>
      )}

      {/* ── Planned Reserves ──────────────────────────────────────── */}
      {coin.reserves && coin.reserves.length > 0 && (
        <section className="pharos-card-shell p-4 sm:p-5">
          <h3 className="mb-3 text-lg font-semibold tracking-tight">Planned Collateral Composition</h3>
          <div className="space-y-2">
            {coin.reserves.map((slice) => (
              <div
                key={slice.name}
                className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/45 px-3 py-2"
              >
                <span className="text-sm">{slice.name}</span>
                <span className="shrink-0 pharos-numeric text-sm text-muted-foreground">{slice.pct}%</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Target Chains ─────────────────────────────────────────── */}
      {uniqueChains.length > 0 && (
        <section className="pharos-card-shell p-4 sm:p-5">
          <h3 className="mb-3 text-lg font-semibold tracking-tight">Target Chains</h3>
          <div className="flex flex-wrap gap-2">
            {uniqueChains.map((chain) => (
              <span
                key={chain}
                className="inline-flex items-center rounded-full border border-border/60 bg-background/50 px-3 py-1 text-xs font-medium capitalize"
              >
                {chain}
              </span>
            ))}
          </div>
        </section>
      )}

      {/* ── Links ─────────────────────────────────────────────────── */}
      {coin.links && coin.links.length > 0 && (
        <section className="pharos-card-shell p-4 sm:p-5">
          <h3 className="mb-3 text-lg font-semibold tracking-tight">Links</h3>
          <div className="flex flex-wrap gap-2">
            {coin.links.map((link) => (
              <a
                key={link.url}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="pharos-focus-ring inline-flex min-h-11 items-center gap-2 rounded-xl border border-border/60 bg-background/45 px-3 py-2 text-sm text-foreground transition-colors hover:border-foreground/20 hover:bg-accent sm:min-h-9"
                aria-label={`${link.label} (opens in new tab)`}
              >
                {getLinkIcon(link.label)}
                <span>{link.label}</span>
                <ExternalLink className="h-3 w-3 text-muted-foreground/70" aria-hidden="true" />
              </a>
            ))}
          </div>
        </section>
      )}

      {/* ── Related Active Stablecoins ────────────────────────────── */}
      <section className="pharos-card-shell p-4 sm:p-5">
        <div className="mb-3 space-y-1.5">
          <h3 className="text-lg font-semibold tracking-tight">Related Stablecoins</h3>
          <p className="text-sm text-muted-foreground">
            {related.length > 0
              ? "Active stablecoins with similar governance, backing, or peg currency."
              : "No active stablecoin shares this profile yet."}
          </p>
        </div>
        {related.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {related.map((rel) => (
              <Link
                key={rel.id}
                href={buildStablecoinUrl(rel.id)}
                className="pharos-focus-ring inline-flex min-h-11 items-center gap-2 rounded-full border border-border/60 bg-background/50 px-3 py-2 text-sm text-foreground transition-colors hover:border-foreground/20 hover:bg-accent"
              >
                <StablecoinLogo src={logos[rel.id]} name={rel.name} size={20} />
                <span className="font-mono tabular-nums text-xs font-medium">{rel.symbol}</span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
