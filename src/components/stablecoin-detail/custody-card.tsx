// src/components/stablecoin-detail/custody-card.tsx
"use client";

import { EvidenceRailCard } from "@/components/stablecoin-detail/evidence-rail-card";
import { FactGrid, type FactGridItem } from "@/components/stablecoin-detail/fact-grid";
import { ModuleDisclosure } from "@/components/stablecoin-detail/module-disclosure";
import { deriveVerdictLine } from "@/components/stablecoin-detail/verdict-line";
import type { CustodyClientSummary, CustodyProviderClientRow } from "@/lib/stablecoin-detail-custody-client";
import { cn } from "@/lib/utils";

/** Providers beyond this many fold into "All providers" so long rosters stay short. */
const VISIBLE_PROVIDER_LIMIT = 4;

function ShareBar({ pct, barClassName }: { pct: number; barClassName?: string }) {
  const width = Math.max(0, Math.min(100, pct));
  return (
    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
      <div className={cn("h-full rounded-full bg-foreground/40", barClassName)} style={{ width: `${width}%` }} />
    </div>
  );
}

function ProviderRow({ provider }: { provider: CustodyProviderClientRow }) {
  return (
    <li>
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 break-words text-xs text-foreground">{provider.name}</span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
          {provider.sharePct != null ? `${provider.sharePct}%` : "—"}
        </span>
      </div>
      <div className="text-[10px] uppercase leading-tight tracking-[0.14em] text-muted-foreground">
        {provider.roleLabel}
        {provider.jurisdiction ? ` · ${provider.jurisdiction}` : ""}
      </div>
      {provider.sharePct != null ? <ShareBar pct={provider.sharePct} /> : null}
    </li>
  );
}

/**
 * Who holds the reserves, under what legal structure: the reviewed
 * `custodyProfile` (provider roster with share bars, segregation /
 * bankruptcy-remoteness / rehypothecation facts) in the rail-card grammar.
 * Renders nothing when no custody review exists.
 *
 * When no provider discloses a share (every row would read "—") the roster
 * collapses into one line of names instead of a column of empty bars.
 */
export function CustodyCard({ summary, frameless }: { summary?: CustodyClientSummary | null; frameless?: boolean }) {
  if (!summary) return null;

  const facts: FactGridItem[] = [
    { key: "segregation", label: "Segregation", value: summary.segregationLabel },
    { key: "bankruptcy", label: "Bankr. remote", value: summary.bankruptcyRemotenessLabel },
    {
      key: "rehypothecation",
      label: "Rehypothecation",
      value: summary.rehypothecationLabel,
      ...(summary.rehypothecationToneClass ? { valueClassName: summary.rehypothecationToneClass } : {}),
    },
    { key: "confidence", label: "Confidence", value: summary.confidenceLabel },
  ];

  const verdict = deriveVerdictLine(summary.summary) ?? summary.postureLabel;
  const sharesDisclosed = summary.providers.some((provider) => provider.sharePct != null);
  const visibleProviders = summary.providers.slice(0, VISIBLE_PROVIDER_LIMIT);
  const overflowProviders = summary.providers.slice(VISIBLE_PROVIDER_LIMIT);

  return <EvidenceRailCard frameless={frameless} title="Custody" badge={{ label: summary.postureLabel, className: cn("text-[11px] font-medium", summary.postureToneClass) }} evidence={{ sources: summary.sources.map((source) => ({ label: source.label, url: source.url })), sourcesFootnote: summary.uncertainty ? <p className="text-muted-foreground/80">{summary.uncertainty}</p> : null, trailing: summary.reviewedAt ? `Reviewed ${summary.reviewedAt}` : undefined }}>
      <p className="text-xs leading-relaxed text-muted-foreground">{verdict}</p>
      {summary.providers.length > 0 && !sharesDisclosed && summary.undisclosedSharePct == null ? (
        <p className="text-xs text-muted-foreground">
          <span className="text-foreground">Providers (shares not disclosed):</span>{" "}
          {summary.providers.map((provider) => provider.name).join(" · ")}
        </p>
      ) : summary.providers.length > 0 || summary.undisclosedSharePct != null ? (
        <>
          <ul aria-label="Custody providers" className="space-y-2.5">
            {visibleProviders.map((provider) => <ProviderRow key={provider.key} provider={provider} />)}
            {summary.undisclosedSharePct != null ? (
              <li>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs text-amber-700 dark:text-amber-400">Undisclosed</span>
                  <span className="shrink-0 font-mono text-[11px] tabular-nums text-amber-700 dark:text-amber-400">
                    {summary.undisclosedSharePct}%
                  </span>
                </div>
                <ShareBar pct={summary.undisclosedSharePct} barClassName="bg-amber-500/50" />
              </li>
            ) : null}
          </ul>
          {overflowProviders.length > 0 ? (
            <ModuleDisclosure label="All providers" count={summary.providers.length}>
              <ul aria-label="Remaining custody providers" className="space-y-2.5 pb-1 pt-1">
                {overflowProviders.map((provider) => <ProviderRow key={provider.key} provider={provider} />)}
              </ul>
            </ModuleDisclosure>
          ) : null}
        </>
      ) : null}
      {/* No `grid-cols-3` override: forcing three tracks into the 22rem rail
          clipped the `Rehypothecation` label at the card edge. */}
      <FactGrid aria-label="Custody facts" items={facts} />
    </EvidenceRailCard>;
}
