"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useDigestArchive } from "@/hooks/api-hooks";
import { DailyDigest, DigestFullDisplay } from "@/components/daily-digest";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { PSI_BAND_CLASSES, type ConditionBand } from "@shared/lib/psi-colors";
import { formatCurrency } from "@shared/lib/format";
import { splitDigestParagraphs } from "@/lib/digest";
import { cn } from "@/lib/utils";

const SKELETON_ROWS = Array.from({ length: 5 }, (_, i) => i);

function tsToDateSlug(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
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
  return new Date(ts * 1000)
    .toLocaleDateString("en-US", { day: "numeric", month: "short" })
    .toUpperCase();
}

function formatWeeklyMasthead(ts: number): string {
  const d = new Date(ts * 1000);
  const end = d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  const start = new Date(d.getTime() - 6 * 86400_000).toLocaleDateString("en-US", { month: "long", day: "numeric" });
  return `${start} – ${end}`;
}

function WeeklyRecapSection({ entry }: { entry: { digestTitle: string | null; digestExtended: string | null; generatedAt: number } }) {
  const paragraphs = splitDigestParagraphs(entry.digestExtended);
  if (paragraphs.length === 0) return null;

  return (
    <div className="mt-8">
      <DigestFullDisplay
        label="Weekly Recap"
        dateString={formatWeeklyMasthead(entry.generatedAt)}
        title={entry.digestTitle || "The Week in Review"}
        paragraphs={paragraphs}
        ctaHref={`/digest/${tsToDateSlug(entry.generatedAt)}/`}
        ctaLabel="Full weekly detail"
      />
    </div>
  );
}

export function DigestArchiveClient() {
  const { data, isLoading, dataUpdatedAt, error, refetch } = useDigestArchive();
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

  // Skip only today's digest (shown in broadsheet above), filter by month
  const latestSlug = data?.digests[0] ? tsToDateSlug(data.digests[0].generatedAt) : null;
  const wireDigests = useMemo(() => {
    if (!data?.digests || !activeMonth) return [];
    return data.digests.filter((d) => {
      if (tsToDateSlug(d.generatedAt) === latestSlug) return false;
      return tsToMonthKey(d.generatedAt) === activeMonth;
    });
  }, [data, activeMonth, latestSlug]);

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
    return (
      <p className="text-sm text-muted-foreground py-8">
        No digests yet. Check back tomorrow.
      </p>
    );
  }

  return (
    <div>
      <StaleDataBanner
        queries={[{ preset: "digestArchive", dataUpdatedAt, error, hasData: !!data?.digests?.length }]}
      />

      {/* Broadsheet: today's digest */}
      <DailyDigest variant="full" />

      {/* Weekly recap (latest) */}
      {latestWeekly && latestWeekly.digestExtended && (
        <WeeklyRecapSection entry={latestWeekly} />
      )}

      {/* Archive divider (double-rule) */}
      <div className="my-6 space-y-0.5">
        <div className="border-t border-border" />
        <div className="flex items-center gap-3">
          <div className="flex-1 border-t border-border" />
          <span className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            Archive
          </span>
          <div className="flex-1 border-t border-border" />
        </div>
      </div>

      {/* Month picker */}
      {monthOptions.length > 1 && (
        <div className="mb-4">
          <select
            aria-label="Filter by month"
            value={activeMonth ?? ""}
            onChange={(e) => setSelectedMonth(e.target.value)}
            className="text-sm bg-background border border-border rounded px-2 py-1 text-foreground"
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
      <div>
        {wireDigests.length === 0 && (
          <p className="text-sm text-muted-foreground py-4">
            No other digests this month.
          </p>
        )}
        {wireDigests.map((d) => {
          const isWeekly = d.digestType === "weekly";
          return (
            <Link
              key={d.generatedAt}
              href={`/digest/${tsToDateSlug(d.generatedAt)}/`}
              className={cn(
                "flex items-start sm:items-center gap-3 sm:gap-4 border-b transition-colors -mx-2 px-2 rounded",
                isWeekly
                  ? "py-3.5 border-border/60 hover:bg-muted/30 border-l-2 border-l-foreground/20"
                  : "py-2.5 border-border/30 hover:bg-muted/20",
              )}
            >
              <span className="font-mono text-xs text-muted-foreground w-14 shrink-0 mt-0.5 sm:mt-0">
                {formatWireDate(d.generatedAt)}
              </span>
              <div className="flex-1 min-w-0">
                <span className={cn("truncate flex items-center gap-1.5", isWeekly ? "text-sm font-semibold" : "text-sm font-medium")}>
                  {d.digestTitle || (isWeekly ? "The Week in Review" : "Signal & Noise")}
                  {isWeekly && (
                    <span className="rounded border border-border/60 px-1.5 py-0.5 font-mono text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">
                      Weekly
                    </span>
                  )}
                </span>
                {(d.psiBand || d.totalMcapUsd != null) && (
                  <div className="flex items-center gap-2 mt-0.5 sm:hidden">
                    {d.psiBand && d.psiScore != null && (
                      <span className={`text-xs font-mono font-medium ${PSI_BAND_CLASSES[d.psiBand as ConditionBand] ?? ""}`}>
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
                  className={`text-xs font-mono font-medium px-1.5 py-0.5 rounded bg-muted/50 shrink-0 hidden sm:inline ${PSI_BAND_CLASSES[d.psiBand as ConditionBand] ?? ""}`}
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
    </div>
  );
}
