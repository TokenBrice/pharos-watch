"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useDigestArchive } from "@/hooks/use-digest-archive";
import { DailyDigest } from "@/components/daily-digest";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { PSI_BAND_CLASSES, type ConditionBand } from "@/lib/psi-colors";
import { formatCurrency } from "@/lib/format";
import { CRON_24H } from "@/hooks/use-api-query";

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

export function DigestArchiveClient() {
  const { data, isLoading, dataUpdatedAt, error } = useDigestArchive();
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

  // Skip today's digest (shown in broadsheet) and filter by selected month
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
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 py-2">
            <Skeleton className="h-3 w-14" />
            <Skeleton className="h-3 w-48" />
            <Skeleton className="h-3 w-20 ml-auto" />
          </div>
        ))}
      </div>
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
      <QueryErrorNotice error={error} hasData={!!data?.digests?.length} onRetry={() => window.location.reload()} />
      <StaleDataBanner
        queries={[{ label: "Digests", dataUpdatedAt, staleTime: CRON_24H }]}
      />

      {/* Broadsheet: today's digest */}
      <DailyDigest showArchiveLink={false} />

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
        {wireDigests.map((d) => (
          <Link
            key={d.generatedAt}
            href={`/digest/${tsToDateSlug(d.generatedAt)}/`}
            className="flex items-start sm:items-center gap-3 sm:gap-4 py-2.5 border-b border-border/30 hover:bg-muted/20 transition-colors -mx-2 px-2 rounded"
          >
            <span className="font-mono text-xs text-muted-foreground w-14 shrink-0 mt-0.5 sm:mt-0">
              {formatWireDate(d.generatedAt)}
            </span>
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium truncate block">
                {d.digestTitle || "Signal & Noise"}
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
        ))}
      </div>
    </div>
  );
}
