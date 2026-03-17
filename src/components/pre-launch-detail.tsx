import Link from "next/link";
import { ExternalLink, Globe, Calendar, Shield, Landmark, Sparkles } from "lucide-react";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import {
  BACKING_LABELS,
  GOVERNANCE_LABELS,
  PEG_LABELS_SHORT,
} from "@shared/lib/classification";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { buildStablecoinUrl } from "@/lib/urls";
import type { StablecoinMeta, LaunchPhase } from "@shared/types";

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
    <span className="inline-flex items-center rounded-full border border-indigo-500/30 bg-indigo-500/10 px-2.5 py-0.5 text-xs font-medium text-indigo-400">
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

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{formatFuzzyDate(announcedDate)}</span>
        <span>Expected: {formatFuzzyDate(expectedLaunchDate)}</span>
      </div>
      <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted/40">
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
        <div className="text-center text-[11px] text-muted-foreground">Today</div>
      )}
    </div>
  );
}

function InfoGridItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
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

  return (
    <div className="space-y-8">
      {/* ── Pre-Launch Banner ─────────────────────────────────────── */}
      <div className="rounded-xl border border-indigo-500/25 bg-indigo-500/[0.06] px-4 py-4 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-semibold text-indigo-400">
            Pre-Launch
          </span>
          <span className="text-sm text-muted-foreground">
            Not yet tracked by Pharos
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
        <div className="space-y-1">
          <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">
            {coin.name}
          </h1>
          <p className="font-mono text-sm text-muted-foreground">{coin.symbol}</p>
        </div>
      </header>

      {/* ── Launch Timeline ───────────────────────────────────────── */}
      {coin.announcedDate && coin.expectedLaunchDate ? (
        <section className="pharos-card-shell p-4 sm:p-5">
          <h2 className="mb-3 text-lg font-semibold tracking-tight">Launch Timeline</h2>
          <TimelineBar
            announcedDate={coin.announcedDate}
            expectedLaunchDate={coin.expectedLaunchDate}
          />
        </section>
      ) : coin.expectedLaunchDate ? (
        <section className="pharos-card-shell p-4 sm:p-5">
          <div className="flex items-center gap-2 text-sm">
            <Calendar className="h-4 w-4 text-muted-foreground" />
            <span className="text-muted-foreground">Expected Launch:</span>
            <span className="font-medium">{formatFuzzyDate(coin.expectedLaunchDate)}</span>
          </div>
        </section>
      ) : null}

      {/* ── Editorial Summary ─────────────────────────────────────── */}
      {summary && (
        <section className="pharos-card-shell space-y-2 p-4 sm:p-5">
          <h2 className="text-lg font-semibold tracking-tight">{summary.title}</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">{summary.text}</p>
          <p className="text-[11px] text-muted-foreground/60">
            Updated {summary.updatedAt}
          </p>
        </section>
      )}

      {/* ── At-a-Glance Grid ─────────────────────────────────────── */}
      <section className="pharos-card-shell p-4 sm:p-5">
        <h2 className="mb-4 text-lg font-semibold tracking-tight">At a Glance</h2>
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
          {coin.jurisdiction?.country && (
            <InfoGridItem label="Jurisdiction" value={coin.jurisdiction.country} />
          )}
          {coin.flags.yieldBearing && (
            <InfoGridItem label="Yield-Bearing" value="Yes" />
          )}
        </dl>
      </section>

      {/* ── Planned Reserves ──────────────────────────────────────── */}
      {coin.reserves && coin.reserves.length > 0 && (
        <section className="pharos-card-shell p-4 sm:p-5">
          <h2 className="mb-4 text-lg font-semibold tracking-tight">
            Planned Collateral Composition
          </h2>
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
          <h2 className="mb-3 text-lg font-semibold tracking-tight">Target Chains</h2>
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
          <h2 className="mb-3 text-lg font-semibold tracking-tight">Links</h2>
          <div className="flex flex-wrap gap-2">
            {coin.links.map((link) => (
              <a
                key={link.url}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="pharos-focus-ring inline-flex min-h-11 items-center gap-2 rounded-xl border border-border/60 bg-background/45 px-3 py-2 text-sm text-foreground transition-colors hover:border-foreground/20 hover:bg-accent sm:min-h-9"
              >
                {link.label === "Website" ? (
                  <Globe className="h-3.5 w-3.5 text-muted-foreground" />
                ) : link.label === "Twitter" ? (
                  <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
                ) : link.label === "Docs" ? (
                  <Shield className="h-3.5 w-3.5 text-muted-foreground" />
                ) : (
                  <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
                )}
                <span>{link.label}</span>
                <ExternalLink className="h-3 w-3 text-muted-foreground/60" />
              </a>
            ))}
          </div>
        </section>
      )}

      {/* ── Related Active Stablecoins ────────────────────────────── */}
      {related.length > 0 && (
        <section className="pharos-card-shell p-4 sm:p-5">
          <div className="space-y-1.5">
            <h2 className="text-lg font-semibold tracking-tight">Related Stablecoins</h2>
            <p className="text-sm text-muted-foreground">
              Active stablecoins with similar governance, backing, or peg currency.
            </p>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
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
        </section>
      )}
    </div>
  );
}
