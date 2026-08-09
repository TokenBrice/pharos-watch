"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useDigestArchive } from "@/hooks/api-hooks";
import { DailyDigest } from "@/components/daily-digest";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { PSI_BAND_CLASSES, type ConditionBand } from "@shared/lib/psi-colors";
import { formatCurrency, formatLongDate } from "@shared/lib/format";
import type { DigestArchiveEntry, DigestRiskSignal } from "@shared/types";
import { splitDigestParagraphs, EDITORIAL_BODY_STYLE, EDITORIAL_META_STYLE, parseDigestParagraph } from "@/lib/digest";
import { cn } from "@/lib/utils";

const SKELETON_ROWS = Array.from({ length: 5 }, (_, i) => i);

function tsToDateSlug(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function toDigestSlug(ts: number, digestType: "daily" | "weekly"): string {
  const date = tsToDateSlug(ts);
  return digestType === "weekly" ? `${date}-weekly` : date;
}

export function resolveLatestDailyDigestSlug(
  entries: readonly Pick<DigestArchiveEntry, "generatedAt" | "digestType">[],
): string | null {
  const latestDaily = entries.find((entry) => (entry.digestType ?? "daily") !== "weekly");
  return latestDaily ? tsToDateSlug(latestDaily.generatedAt) : null;
}

function tsToMonthKey(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 7);
}

function formatMonthLabel(key: string): string {
  const [y, m] = key.split("-");
  const date = new Date(Number(y), Number(m) - 1);
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function formatWireDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("en-US", { day: "numeric", month: "short" }).toUpperCase();
}

function formatWeeklyMasthead(ts: number): string {
  const d = new Date(ts * 1000);
  const end = formatLongDate(d);
  const start = new Date(d.getTime() - 6 * 86400_000).toLocaleDateString("en-US", { month: "long", day: "numeric" });
  return `${start} – ${end}`;
}

// Editorial typography imported from @/lib/digest for consistent wire-service aesthetic

function formatArchiveRiskSignal(signal: DigestRiskSignal): string {
  return `${signal.symbol} ${Math.abs(signal.bps)}bps`;
}

function WeeklyTeaser({
  entry,
}: {
  entry: { digestTitle: string | null; digestExtended: string | null; generatedAt: number; editionNumber?: number };
}) {
  const paragraphs = splitDigestParagraphs(entry.digestExtended);
  if (paragraphs.length === 0) return null;

  // First sentence as teaser, stripping any bold markdown headers
  const raw = parseDigestParagraph(paragraphs[0]).bodyText;
  const teaser = raw.split(/(?<=\.)\s/)[0] || raw;

  const weeklyLabel = entry.editionNumber ? `Pharos Weekly Recap #${entry.editionNumber}` : "Pharos Weekly Recap";

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-mono text-[0.72rem] font-semibold uppercase tracking-[0.25em] text-muted-foreground">
          {weeklyLabel}
        </p>
        <p className="text-xs text-muted-foreground">{formatWeeklyMasthead(entry.generatedAt)}</p>
      </div>
      <h3 className="mt-2 text-lg font-bold tracking-tight" style={EDITORIAL_BODY_STYLE}>
        {entry.digestTitle || "The Week in Review"}
      </h3>
      <p className="mt-1.5 text-sm leading-relaxed text-foreground/75 line-clamp-2" style={EDITORIAL_BODY_STYLE}>
        {teaser}
      </p>
      <Link
        href={`/digest/${toDigestSlug(entry.generatedAt, "weekly")}/`}
        className="inline-block mt-3 font-mono text-[0.72rem] font-semibold uppercase tracking-[0.26em] text-muted-foreground transition-colors hover:text-foreground"
      >
        Read the full recap &rarr;
      </Link>
    </div>
  );
}

function WireSectionRule({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3">
      <span aria-hidden className="h-px flex-1 bg-border" />
      <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
        {label}
      </span>
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  );
}

export function DigestArchiveClient() {
  const { data, isLoading, dataUpdatedAt, error, refetch, meta } = useDigestArchive();
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);

  const monthOptions = useMemo(() => {
    if (!data?.digests.length) return [];
    const seen = new Set<string>();
    const options: { key: string; label: string }[] = [];
    for (const d of data.digests) {
      const key = tsToMonthKey(d.generatedAt);
      if (!seen.has(key)) {
        seen.add(key);
        options.push({ key, label: formatMonthLabel(key) });
      }
    }
    return options;
  }, [data]);

  const activeMonth = selectedMonth ?? monthOptions[0]?.key ?? null;

  // Latest weekly recap (if any)
  const latestWeekly = useMemo(() => {
    return data?.digests.find((d) => d.digestType === "weekly") ?? null;
  }, [data]);

  // Skip only today's daily digest (shown in broadsheet above), filter by month.
  const latestDailySlug = useMemo(() => resolveLatestDailyDigestSlug(data?.digests ?? []), [data]);
  const wireDigests = useMemo(() => {
    if (!data?.digests || !activeMonth) return [];
    return data.digests.filter((d) => {
      if (latestDailySlug && tsToDateSlug(d.generatedAt) === latestDailySlug) return false;
      return tsToMonthKey(d.generatedAt) === activeMonth;
    });
  }, [data, activeMonth, latestDailySlug]);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="border-t border-b border-border py-6 space-y-3">
          <Skeleton className="h-3 w-48 mx-auto" />
          <Skeleton className="h-3 w-36 mx-auto" />
          <Skeleton className="h-6 w-72 mt-4" />
          <Skeleton className="h-4 w-full mt-2" />
          <Skeleton className="h-4 w-4/5" />
        </div>
        {SKELETON_ROWS.map((i) => (
          <div key={i} className="flex items-center gap-4 py-2">
            <Skeleton className="h-3 w-14" />
            <Skeleton className="h-3 w-48" />
            <Skeleton className="h-3 w-20 ml-auto" />
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <QueryErrorNotice
        error={error}
        hasData={!!data?.digests?.length}
        onRetry={() => {
          void refetch();
        }}
      />
    );
  }

  if (!data || data.digests.length === 0) {
    return <p className="text-sm text-muted-foreground py-8">No digests yet. Check back tomorrow.</p>;
  }

  return (
    <div className="space-y-8">
      <StaleDataBanner
        queries={[{ preset: "digestArchive", dataUpdatedAt, error, hasData: !!data?.digests?.length, meta }]}
      />

      {/* Lead story: today's digest (nameplate above carries the edition + date) */}
      <section aria-label="Today's lead digest" className="space-y-4">
        <WireSectionRule label="Today's Lead" />
        <DailyDigest
          variant="preview"
          hideMasthead
          detailHref={latestDailySlug ? `/digest/${latestDailySlug}/` : undefined}
        />
      </section>

      {/* Weekly column: compact teaser */}
      {latestWeekly && latestWeekly.digestExtended && (
        <section aria-label="Weekly recap" className="space-y-4">
          <WireSectionRule label="The Week in Review" />
          <WeeklyTeaser entry={latestWeekly} />
        </section>
      )}

      {/* Archive */}
      <section aria-label="Digest archive" className="space-y-4">
        <WireSectionRule label="Archive" />

        {/* Month picker */}
        {monthOptions.length > 1 && (
          <div>
            <select
              aria-label="Filter by month"
              value={activeMonth ?? ""}
              onChange={(e) => setSelectedMonth(e.target.value)}
              className="text-sm bg-background border border-border rounded px-3 py-2 min-h-[44px] md:min-h-0 md:py-1 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              {monthOptions.map((m) => (
                <option key={m.key} value={m.key} className="bg-background text-foreground">
                  {m.label}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Wire table */}
        <div role="region" aria-live="polite" aria-label="Digest archive list">
          {wireDigests.length === 0 && (
            <p className="text-sm text-muted-foreground py-4">No other digests this month.</p>
          )}
          {wireDigests.map((d) => {
            const isWeekly = d.digestType === "weekly";
            return (
              <Link
                key={d.generatedAt}
                href={`/digest/${toDigestSlug(d.generatedAt, d.digestType ?? "daily")}/`}
                className={cn(
                  "pharos-focus-ring flex items-start sm:items-center gap-3 sm:gap-4 border-b transition-colors -mx-2 px-2 rounded",
                  isWeekly
                    ? "py-3.5 border-border/60 bg-muted/25 hover:bg-muted/40"
                    : "py-3 md:py-2.5 border-border/30 hover:bg-muted/20",
                )}
              >
                <span className="font-mono text-xs text-muted-foreground w-14 shrink-0 mt-0.5 sm:mt-0">
                  {formatWireDate(d.generatedAt)}
                </span>
                <div className="flex-1 min-w-0">
                  <span
                    className={cn(
                      "truncate flex items-center gap-1.5",
                      isWeekly ? "text-sm font-semibold" : "text-sm font-medium",
                    )}
                    style={EDITORIAL_META_STYLE}
                  >
                    {d.digestTitle || (isWeekly ? "The Week in Review" : "Signal & Noise")}
                    {isWeekly && (
                      <span className="rounded border border-border/60 px-1.5 py-0.5 font-mono text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">
                        Weekly{d.editionNumber ? ` #${d.editionNumber}` : ""}
                      </span>
                    )}
                    {d.riskSignal && (
                      <span
                        className={cn(
                          "rounded border px-1.5 py-0.5 font-mono text-[0.65rem] font-semibold uppercase tracking-wider",
                          d.riskSignal.severity === "critical"
                            ? "border-red-500/35 bg-red-500/10 text-red-700 dark:text-red-300"
                            : "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300",
                        )}
                      >
                        {formatArchiveRiskSignal(d.riskSignal)}
                      </span>
                    )}
                    {!isWeekly && d.editionNumber != null && (
                      <span className="font-mono text-[0.65rem] text-muted-foreground/70">#{d.editionNumber}</span>
                    )}
                  </span>
                  {(d.psiBand || d.totalMcapUsd != null || d.riskSignal) && (
                    <div className="flex items-center gap-2 mt-0.5 sm:hidden">
                      {d.riskSignal && (
                        <span
                          className={cn(
                            "text-xs font-mono font-medium",
                            d.riskSignal.severity === "critical"
                              ? "text-red-700 dark:text-red-300"
                              : "text-amber-700 dark:text-amber-300",
                          )}
                        >
                          {formatArchiveRiskSignal(d.riskSignal)}
                        </span>
                      )}
                      {d.psiBand && d.psiScore != null && (
                        <span
                          className={`text-xs font-mono font-medium ${d.psiBand in PSI_BAND_CLASSES ? PSI_BAND_CLASSES[d.psiBand as ConditionBand] : ""}`}
                        >
                          {d.psiBand} {d.psiScore.toFixed(1)}
                        </span>
                      )}
                      {d.totalMcapUsd != null && (
                        <span className="text-xs font-mono text-muted-foreground">
                          {formatCurrency(d.totalMcapUsd, 0)}
                        </span>
                      )}
                    </div>
                  )}
                </div>
                {d.psiBand && d.psiScore != null && (
                  <span
                    className={`text-xs font-mono font-medium px-1.5 py-0.5 rounded bg-muted/50 shrink-0 hidden sm:inline ${d.psiBand in PSI_BAND_CLASSES ? PSI_BAND_CLASSES[d.psiBand as ConditionBand] : ""}`}
                  >
                    {d.psiBand} {d.psiScore.toFixed(1)}
                  </span>
                )}
                {d.totalMcapUsd != null && (
                  <span className="text-xs font-mono text-muted-foreground shrink-0 hidden sm:inline">
                    {formatCurrency(d.totalMcapUsd, 0)}
                  </span>
                )}
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5 sm:mt-0" />
              </Link>
            );
          })}
        </div>
      </section>
    </div>
  );
}
