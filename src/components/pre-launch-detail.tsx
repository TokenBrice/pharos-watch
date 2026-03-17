import Link from "next/link";
import Image from "next/image";
import { Suspense } from "react";
import { Tweet } from "react-tweet";
import { ExternalLink, Globe, Calendar, Shield, ArrowLeft, FileText, BookOpen, Play } from "lucide-react";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import {
  BACKING_LABELS,
  GOVERNANCE_LABELS,
  PEG_LABELS_SHORT,
} from "@shared/lib/classification";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { buildStablecoinUrl } from "@/lib/urls";
import type { StablecoinMeta, LaunchPhase, FeaturedContent } from "@shared/types";

// ---------------------------------------------------------------------------
// Launch-phase labels
// ---------------------------------------------------------------------------

const LAUNCH_PHASE_LABELS: Record<LaunchPhase, string> = {
  announced: "Announced",
  testnet: "Testnet",
  auditing: "Auditing",
  beta: "Beta",
  "launching-soon": "Launching Soon",
};

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

// ---------------------------------------------------------------------------
// Date helpers — parse YYYY, YYYY-MM, YYYY-QN
// ---------------------------------------------------------------------------

function parseFuzzyDate(raw: string): Date | null {
  // YYYY-QN
  const qMatch = raw.match(/^(\d{4})-Q(\d)$/);
  if (qMatch) {
    const year = Number(qMatch[1]);
    const quarter = Number(qMatch[2]);
    // Use the first month of the quarter
    return new Date(year, (quarter - 1) * 3, 1);
  }
  // YYYY-MM
  const mMatch = raw.match(/^(\d{4})-(\d{2})$/);
  if (mMatch) {
    return new Date(Number(mMatch[1]), Number(mMatch[2]) - 1, 1);
  }
  // YYYY
  const yMatch = raw.match(/^(\d{4})$/);
  if (yMatch) {
    return new Date(Number(yMatch[1]), 0, 1);
  }
  return null;
}

function formatFuzzyDate(raw: string): string {
  const qMatch = raw.match(/^(\d{4})-Q(\d)$/);
  if (qMatch) return `Q${qMatch[2]} ${qMatch[1]}`;
  const mMatch = raw.match(/^(\d{4})-(\d{2})$/);
  if (mMatch) {
    const d = new Date(Number(mMatch[1]), Number(mMatch[2]) - 1, 1);
    return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Related-coin scoring
// ---------------------------------------------------------------------------

function getRelatedActiveCoins(coin: StablecoinMeta, limit = 6): StablecoinMeta[] {
  const others = ACTIVE_STABLECOINS.filter((s) => s.id !== coin.id);
  const scored = others.map((s) => {
    let score = 0;
    if (s.flags.governance === coin.flags.governance) score += 3;
    if (s.flags.backing === coin.flags.backing) score += 2;
    if (s.flags.pegCurrency === coin.flags.pegCurrency) score += 1;
    return { coin: s, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.coin);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function LaunchPhaseBadge({ phase }: { phase: LaunchPhase }) {
  return (
    <span className="inline-flex items-center rounded-full border border-indigo-500/30 bg-indigo-500/10 px-2.5 py-0.5 text-xs font-medium text-indigo-600 dark:text-indigo-400">
      {LAUNCH_PHASE_LABELS[phase]}
    </span>
  );
}

function TimelineBar({
  announcedDate,
  expectedLaunchDate,
}: {
  announcedDate: string;
  expectedLaunchDate: string;
}) {
  const start = parseFuzzyDate(announcedDate);
  const end = parseFuzzyDate(expectedLaunchDate);
  const now = new Date();

  if (!start || !end || end <= start) return null;

  const totalMs = end.getTime() - start.getTime();
  const elapsedMs = now.getTime() - start.getTime();
  const pct = Math.max(0, Math.min(100, (elapsedMs / totalMs) * 100));

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
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-indigo-500/60"
          style={{ width: `${pct}%` }}
        />
        {pct > 2 && pct < 98 && (
          <div
            className="absolute top-1/2 h-3 w-0.5 -translate-y-1/2 rounded-full bg-foreground"
            style={{ left: `${pct}%` }}
            title="Today"
          />
        )}
      </div>
      {pct > 2 && pct < 98 && (
        <div className="text-center text-xs text-muted-foreground">Today</div>
      )}
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
  const related = getRelatedActiveCoins(coin);
  const chains = coin.contracts?.map((c) => c.chain) ?? [];
  const uniqueChains = [...new Set(chains)];

  // Build jurisdiction display with regulator if available
  const jurisdictionDisplay = coin.jurisdiction?.regulator
    ? `${coin.jurisdiction.country} (${coin.jurisdiction.regulator})`
    : coin.jurisdiction?.country;

  return (
    <div className="space-y-8">
      {/* Screen-reader-only page title */}
      <h1 className="sr-only">
        {coin.name} ({coin.symbol}) — Pre-Launch Stablecoin
      </h1>

      {/* ── Back Navigation ───────────────────────────────────────── */}
      <nav aria-label="Breadcrumb">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          <span>Back to Dashboard</span>
        </Link>
      </nav>

      {/* ── Pre-Launch Banner ─────────────────────────────────────── */}
      <div className="rounded-xl border border-indigo-500/25 bg-indigo-500/[0.06] px-4 py-4 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-semibold text-indigo-600 dark:text-indigo-400">
            Pre-Launch
          </span>
          <span className="text-sm text-muted-foreground">
            No data processed by Pharos yet
          </span>
          {coin.launchPhase && (
            <LaunchPhaseBadge phase={coin.launchPhase} />
          )}
        </div>
        {coin.launchPhaseDetail && (
          <p className="mt-2 text-sm text-muted-foreground">{coin.launchPhaseDetail}</p>
        )}
      </div>

      {/* ── Header ────────────────────────────────────────────────── */}
      <header className="flex items-start gap-4">
        <StablecoinLogo src={logoSrc} name={coin.name} size={48} />
        <div className="min-w-0 space-y-1">
          <h2 className="break-words text-2xl font-extrabold tracking-tight sm:text-3xl">
            {coin.name}
          </h2>
          <p className="font-mono text-sm text-muted-foreground">{coin.symbol}</p>
        </div>
      </header>

      {/* ── Launch Timeline ───────────────────────────────────────── */}
      {coin.announcedDate && coin.expectedLaunchDate ? (
        <section className="pharos-card-shell p-4 sm:p-5">
          <h3 className="mb-3 text-lg font-semibold tracking-tight">Launch Timeline</h3>
          <TimelineBar
            announcedDate={coin.announcedDate}
            expectedLaunchDate={coin.expectedLaunchDate}
          />
        </section>
      ) : coin.expectedLaunchDate ? (
        <section className="pharos-card-shell p-4 sm:p-5">
          <div className="flex items-center gap-2 text-sm">
            <Calendar className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <span className="text-muted-foreground">Expected Launch:</span>
            <span className="font-medium">{formatFuzzyDate(coin.expectedLaunchDate)}</span>
          </div>
        </section>
      ) : null}

      {/* ── Editorial Summary ─────────────────────────────────────── */}
      {summary && (
        <section className="pharos-card-shell space-y-2 p-4 sm:p-5">
          <h3 className="text-lg font-semibold tracking-tight">{summary.title}</h3>
          <p className="text-sm leading-relaxed text-muted-foreground">{summary.text}</p>
          <p className="text-[11px] text-muted-foreground/60">
            Updated {summary.updatedAt}
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
                      <Tweet id={tweetId} />
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
                        className="object-cover transition-transform duration-300 group-hover:scale-[1.02]"
                        unoptimized
                      />
                    </div>
                  )}
                  <div className="flex flex-1 flex-col gap-1.5 p-4">
                    <p className="text-sm font-semibold text-foreground">{item.title}</p>
                    {item.description && (
                      <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                        {item.description}
                      </p>
                    )}
                    <div className="mt-auto flex items-center gap-1.5 pt-1 text-[11px] text-muted-foreground/60">
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

      {/* ── At-a-Glance Grid ─────────────────────────────────────── */}
      <section className="pharos-card-shell p-4 sm:p-5">
        <h3 className="mb-3 text-lg font-semibold tracking-tight">At a Glance</h3>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          <InfoGridItem
            label="Backing"
            value={BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing}
          />
          <InfoGridItem
            label="Governance"
            value={GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance}
          />
          <InfoGridItem
            label="Peg Currency"
            value={PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency}
          />
          {jurisdictionDisplay && (
            <InfoGridItem label="Jurisdiction" value={jurisdictionDisplay} />
          )}
          {coin.flags.yieldBearing && (
            <InfoGridItem label="Yield-Bearing" value="Yes" />
          )}
        </dl>
      </section>

      {/* ── Planned Reserves ──────────────────────────────────────── */}
      {coin.reserves && coin.reserves.length > 0 && (
        <section className="pharos-card-shell p-4 sm:p-5">
          <h3 className="mb-3 text-lg font-semibold tracking-tight">
            Planned Collateral Composition
          </h3>
          <div className="space-y-2">
            {coin.reserves.map((slice) => (
              <div
                key={slice.name}
                className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/45 px-3 py-2"
              >
                <span className="text-sm">{slice.name}</span>
                <span className="shrink-0 font-mono text-sm text-muted-foreground">
                  {slice.pct}%
                </span>
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
                <ExternalLink className="h-3 w-3 text-muted-foreground/60" aria-hidden="true" />
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
              : "No active stablecoins with matching governance, backing, or peg currency."}
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
                <span className="font-mono text-xs font-medium">{rel.symbol}</span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
