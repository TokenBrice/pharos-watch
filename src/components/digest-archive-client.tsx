"use client";

import { useMemo } from "react";
import Link from "next/link";
import { ChevronRight, Search, X } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useDigestArchive } from "@/hooks/api-hooks";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { DailyDigest } from "@/components/daily-digest";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { PSI_BAND_CLASSES, type ConditionBand } from "@shared/lib/psi-colors";
import { formatCurrency, formatLongDate } from "@shared/lib/format";
import type { DigestArchiveEntry, DigestRiskSignal } from "@shared/types";
import {
  buildDigestTriggerRecord,
  EDITORIAL_BODY_STYLE,
  EDITORIAL_META_STYLE,
  formatDigestTriggerRate,
  parseDigestParagraph,
  splitDigestParagraphs,
  type DigestTriggerRecord,
} from "@/lib/digest";
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

export type DigestArchiveView = "all" | "daily" | "weekly";

export function normalizeDigestArchiveView(value: string | null): DigestArchiveView {
  return value === "daily" || value === "weekly" ? value : "all";
}

export function filterDigestArchiveEntries(
  entries: readonly DigestArchiveEntry[],
  options: {
    view: DigestArchiveView;
    month: string | null;
    query: string;
    latestDailySlug?: string | null;
  },
): DigestArchiveEntry[] {
  const query = options.query.trim().toLocaleLowerCase();
  return entries.filter((entry) => {
    const isWeekly = entry.digestType === "weekly";
    if (options.latestDailySlug && !isWeekly && tsToDateSlug(entry.generatedAt) === options.latestDailySlug) {
      return false;
    }
    if (options.view !== "all" && (isWeekly ? "weekly" : "daily") !== options.view) return false;
    if (options.month && tsToMonthKey(entry.generatedAt) !== options.month) return false;
    if (query) {
      const haystack = [entry.digestTitle, entry.digestText, entry.digestExtended]
        .filter((value): value is string => Boolean(value))
        .join(" ")
        .toLocaleLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
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

const TRIGGER_STATUS_LABELS: Record<"hit" | "missed" | "expired" | "pending", string> = {
  hit: "Hit",
  missed: "Missed",
  expired: "Expired",
  pending: "Pending",
};

const TRIGGER_STATUS_CLASSES: Record<"hit" | "missed" | "expired" | "pending", string> = {
  hit: "text-emerald-700 dark:text-emerald-300",
  missed: "text-red-700 dark:text-red-300",
  expired: "text-muted-foreground",
  pending: "text-amber-700 dark:text-amber-300",
};

function TriggerRecordStat({
  label,
  value,
  status,
}: {
  label: string;
  value: number;
  status: "hit" | "missed" | "expired" | "pending";
}) {
  return (
    <div className="rounded-md border border-border/50 bg-background/45 px-2.5 py-2">
      <p className="font-mono text-[0.63rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </p>
      <p className={cn("mt-1 font-mono text-lg font-semibold", TRIGGER_STATUS_CLASSES[status])}>{value}</p>
    </div>
  );
}

function TriggerRecordSection({ record }: { record: DigestTriggerRecord }) {
  return (
    <section aria-labelledby="digest-trigger-record" className="space-y-3">
      <WireSectionRule label="Trigger record" />
      <div className="pharos-card-shell space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <p className="pharos-kicker">The digest's own scoreboard</p>
            <h2 id="digest-trigger-record" className="text-lg font-semibold tracking-tight text-foreground">
              Issued triggers, with every outcome visible
            </h2>
          </div>
          <p className="pharos-meta">{record.total} recorded outcome{record.total === 1 ? "" : "s"}</p>
        </div>

        {record.total === 0 ? (
          <p className="pharos-empty-note">
            The archive does not currently carry forward-look outcomes, so there is no trigger record to summarize.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <TriggerRecordStat label={TRIGGER_STATUS_LABELS.hit} value={record.hit} status="hit" />
              <TriggerRecordStat label={TRIGGER_STATUS_LABELS.missed} value={record.missed} status="missed" />
              <TriggerRecordStat label={TRIGGER_STATUS_LABELS.expired} value={record.expired} status="expired" />
              <TriggerRecordStat label={TRIGGER_STATUS_LABELS.pending} value={record.pending} status="pending" />
            </div>

            <div className="space-y-2 border-t border-border/50 pt-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-mono text-[0.68rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                  Resolved trigger record
                </p>
                <p className="font-mono text-sm font-semibold text-foreground">
                  {formatDigestTriggerRate(record.hitRate)} hit share
                </p>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Headline denominator: hit ÷ (hit + missed + expired). Pending stays outside that denominator and remains listed above.
              </p>
            </div>

            <div className="space-y-2 border-t border-border/50 pt-3">
              <p className="font-mono text-[0.68rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                By trigger class
              </p>
              <div className="space-y-2">
                {record.buckets.map((bucket) => (
                  <div key={bucket.key} className="grid gap-1.5 rounded-md border border-border/40 px-2.5 py-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground">{bucket.label}</p>
                      <p className="text-xs text-muted-foreground">
                        {bucket.total} outcome{bucket.total === 1 ? "" : "s"} · {bucket.resolved} resolved · {formatDigestTriggerRate(bucket.hitRate)} hit share
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[0.68rem] uppercase tracking-[0.12em]">
                      <span className={TRIGGER_STATUS_CLASSES.hit}>H {bucket.hit}</span>
                      <span className={TRIGGER_STATUS_CLASSES.missed}>M {bucket.missed}</span>
                      <span className={TRIGGER_STATUS_CLASSES.expired}>E {bucket.expired}</span>
                      <span className={TRIGGER_STATUS_CLASSES.pending}>P {bucket.pending}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {record.unclassifiedCount > 0 && (
              <p className="text-xs leading-relaxed text-muted-foreground">
                Trigger classes are separate lenses, not directly comparable. Unclassified outcomes stay separate because their archived trigger metric is unavailable. No naive-persistence baseline is shown because the archive does not publish one.
              </p>
            )}
            {record.unclassifiedCount === 0 && (
              <p className="text-xs leading-relaxed text-muted-foreground">
                Classes use the metric carried by each archived trigger; their rates are separate lenses, not directly comparable. The archive does not publish a naive-persistence baseline.
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

export function DigestArchiveClient() {
  const { data, isLoading, dataUpdatedAt, error, refetch, meta } = useDigestArchive();
  const { searchParams, setParam, replaceParams } = useUrlFilters();

  const setSearchQuery = (value: string): void => {
    replaceParams((params) => {
      if (value.trim()) {
        params.set("q", value);
      } else {
        params.delete("q");
      }
    });
  };

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

  const activeView = normalizeDigestArchiveView(searchParams.get("view"));
  const searchQuery = searchParams.get("q") ?? "";
  const requestedMonth = searchParams.get("month");
  const activeMonth = requestedMonth && monthOptions.some((month) => month.key === requestedMonth)
    ? requestedMonth
    : monthOptions[0]?.key ?? null;

  // Latest weekly recap (if any)
  const latestWeekly = useMemo(() => {
    return data?.digests.find((d) => d.digestType === "weekly") ?? null;
  }, [data]);

  // Skip only today's daily digest (shown in broadsheet above), filter by month.
  const latestDailySlug = useMemo(() => resolveLatestDailyDigestSlug(data?.digests ?? []), [data]);
  const wireDigests = useMemo(
    () => filterDigestArchiveEntries(data?.digests ?? [], {
      view: activeView,
      month: activeMonth,
      query: searchQuery,
      latestDailySlug,
    }),
    [data, activeMonth, activeView, latestDailySlug, searchQuery],
  );

  const triggerRecord = useMemo(() => buildDigestTriggerRecord(data?.digests ?? []), [data]);

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

      <TriggerRecordSection record={triggerRecord} />

      {/* Archive */}
      <section aria-label="Digest archive" className="space-y-4">
        <WireSectionRule label="Archive" />

        <div className="space-y-3 rounded-lg border border-border/50 bg-muted/10 p-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <fieldset className="space-y-1.5">
              <legend className="font-mono text-[0.68rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                Edition type
              </legend>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by edition type">
                {(["all", "daily", "weekly"] as const).map((view) => (
                  <button
                    key={view}
                    type="button"
                    aria-pressed={activeView === view}
                    onClick={() => setParam("view", view)}
                    className={cn(
                      "pharos-control-pill min-h-10 px-3 text-xs font-semibold uppercase tracking-[0.14em] sm:min-h-8",
                      activeView === view && "pharos-control-pill-active",
                    )}
                  >
                    {view === "all" ? "All" : view}
                  </button>
                ))}
              </div>
            </fieldset>

            {monthOptions.length > 1 && (
              <label className="space-y-1.5 text-left">
                <span className="block font-mono text-[0.68rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                  Month
                </span>
                <select
                  aria-label="Filter by month"
                  value={activeMonth ?? ""}
                  onChange={(event) => setParam("month", event.target.value)}
                  className="min-h-10 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background md:min-h-8 md:py-1"
                >
                  {monthOptions.map((month) => (
                    <option key={month.key} value={month.key} className="bg-background text-foreground">
                      {month.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          <label className="block space-y-1.5">
            <span className="block font-mono text-[0.68rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
              Search title and body
            </span>
            <span className="relative block">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <input
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search the archive"
                aria-label="Search digest title and body"
                className="min-h-10 w-full rounded-md border border-border bg-background py-2 pl-9 pr-9 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              />
              {searchQuery && (
                <button
                  type="button"
                  aria-label="Clear archive search"
                  onClick={() => setSearchQuery("")}
                  className="pharos-focus-ring absolute right-2 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
            </span>
          </label>

          <p className="pharos-meta" aria-live="polite">
            Showing {wireDigests.length} archive entr{wireDigests.length === 1 ? "y" : "ies"}
            {searchQuery.trim() ? ` matching “${searchQuery.trim()}”` : ""}.
          </p>
        </div>

        {/* Wire table */}
        <div role="region" aria-live="polite" aria-label="Digest archive list">
          {wireDigests.length === 0 && (
            <p className="text-sm text-muted-foreground py-4">No digests match these filters.</p>
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
