"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronRight, Search, X } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useDailyDigest, useDigestArchive } from "@/hooks/api-hooks";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { DailyDigest } from "@/components/daily-digest";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { PSI_BAND_CLASSES, type ConditionBand } from "@shared/lib/classification";
import { formatBps, formatCurrency, formatLongDate } from "@shared/lib/format";
import type { DigestArchiveEntry, DigestContentEntry, DigestRiskSignal } from "@shared/types";
import {
  buildDigestTriggerRecord,
  digestMonthKey,
  EDITORIAL_BODY_STYLE,
  EDITORIAL_META_STYLE,
  formatDigestMonthLabel,
  formatDigestTriggerRate,
  parseDigestParagraph,
  splitDigestParagraphs,
  type DigestTriggerRecord,
  type DigestTriggerRecordStatus,
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

function formatWireDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).toUpperCase();
}

function formatWeeklyMasthead(ts: number): string {
  const d = new Date(ts * 1000);
  const end = formatLongDate(d, { utc: true });
  const start = new Date(d.getTime() - 6 * 86400_000).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
  return `${start} – ${end}`;
}

// Editorial typography imported from @/lib/digest for consistent wire-service aesthetic

function formatArchiveRiskSignal(signal: DigestRiskSignal): string {
  return `${signal.symbol} ${formatBps(signal.bps)}`;
}

export type DigestArchiveView = "all" | "daily" | "weekly";

function normalizeDigestArchiveView(value: string | null): DigestArchiveView {
  return value === "daily" || value === "weekly" ? value : "all";
}

function filterDigestArchiveEntries(
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
    if (options.latestDailySlug && toDigestSlug(entry.generatedAt, entry.digestType ?? "daily") === options.latestDailySlug) {
      return false;
    }
    if (options.view !== "all" && (isWeekly ? "weekly" : "daily") !== options.view) return false;
    if (options.month && digestMonthKey(entry.generatedAt) !== options.month) return false;
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

const TRIGGER_STATUS_LABELS: Record<DigestTriggerRecordStatus, string> = {
  hit: "Hit",
  missed: "Missed",
  expired: "Expired",
  pending: "Pending",
  unavailable: "Unavailable",
};

const TRIGGER_STATUS_CLASSES: Record<DigestTriggerRecordStatus, string> = {
  hit: "text-emerald-700 dark:text-emerald-300",
  missed: "text-red-700 dark:text-red-300",
  expired: "text-muted-foreground",
  pending: "text-amber-700 dark:text-amber-300",
  unavailable: "text-muted-foreground",
};

function TriggerRecordStat({
  label,
  value,
  status,
}: {
  label: string;
  value: number;
  status: DigestTriggerRecordStatus;
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
            <p className="pharos-kicker">The digest’s own scoreboard</p>
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
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              <TriggerRecordStat label={TRIGGER_STATUS_LABELS.hit} value={record.hit} status="hit" />
              <TriggerRecordStat label={TRIGGER_STATUS_LABELS.missed} value={record.missed} status="missed" />
              <TriggerRecordStat label={TRIGGER_STATUS_LABELS.expired} value={record.expired} status="expired" />
              <TriggerRecordStat label={TRIGGER_STATUS_LABELS.pending} value={record.pending} status="pending" />
              <TriggerRecordStat label={TRIGGER_STATUS_LABELS.unavailable} value={record.unavailable} status="unavailable" />
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
                Headline denominator: hit ÷ (hit + missed + expired). Pending and unavailable stay outside that denominator and remain listed above.
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
                      <span className={TRIGGER_STATUS_CLASSES.unavailable}>Unavailable {bucket.unavailable}</span>
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

export function DigestArchiveClient({ initialLead }: { initialLead?: DigestContentEntry } = {}) {
  const [seed] = useState(initialLead);
  const archiveQuery = useDigestArchive();
  const { data: dailyLead } = useDailyDigest();
  const archiveLead = seed ? archiveQuery.data?.digests.find((entry) => entry.digestType !== "weekly") : null;
  const liveLead = archiveLead && (!dailyLead?.digest || !dailyLead.generatedAt || archiveLead.generatedAt > dailyLead.generatedAt)
    ? { ...archiveLead, digest: archiveLead.digestText }
    : dailyLead;
  const liveSlug = liveLead?.digest && liveLead.generatedAt ? tsToDateSlug(liveLead.generatedAt) : null;
  const seedData = seed ? {
    digest: seed.text, digestTitle: seed.title, digestExtended: seed.extended, generatedAt: seed.generatedAt,
  } : null;
  const lead = liveSlug && (!seed || liveSlug > seed.date) ? liveLead : seedData && liveSlug === seed?.date ? {
    ...seedData,
    riskSignal: liveLead?.riskSignal,
    riskTape: liveLead?.riskTape,
    nextTriggers: liveLead?.nextTriggers,
  } : seedData;
  const leadSlug = lead?.generatedAt ? tsToDateSlug(lead.generatedAt) : null;
  const leadDate = lead?.generatedAt ? formatLongDate(new Date(lead.generatedAt * 1000), { utc: true }) : null;

  return (
    <div className="space-y-8">
      {lead && leadDate ? (
        <section aria-label={leadDate} className="min-h-[58rem] space-y-4 sm:min-h-[34rem]">
          <WireSectionRule label={leadDate} />
          <DailyDigest
            data={lead}
            detailHref={`/digest/${leadSlug}/`}
          />
        </section>
      ) : null}
      <DigestArchive latestDailySlug={leadSlug} query={archiveQuery} />
    </div>
  );
}

function DigestArchive({ latestDailySlug, query }: { latestDailySlug: string | null; query: ReturnType<typeof useDigestArchive> }) {
  const { data, isLoading, dataUpdatedAt, error, refetch, meta } = query;
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
      const key = digestMonthKey(d.generatedAt);
      if (!seen.has(key)) {
        seen.add(key);
        options.push({ key, label: formatDigestMonthLabel(key) });
      }
    }
    return options;
  }, [data]);

  const activeView = normalizeDigestArchiveView(searchParams.get("view"));
  const searchQuery = searchParams.get("q") ?? "";
  const requestedMonth = searchParams.get("month");
  // Everything except the month filter, so a selected month always has a row
  // unless the reader explicitly chose an empty one.
  const matchingEntries = useMemo(
    () => filterDigestArchiveEntries(data?.digests ?? [], {
      view: activeView,
      month: null,
      query: searchQuery,
      latestDailySlug,
    }),
    [data, activeView, latestDailySlug, searchQuery],
  );
  const defaultMonth = useMemo(
    () => matchingEntries[0] ? digestMonthKey(matchingEntries[0].generatedAt) : monthOptions[0]?.key ?? null,
    [matchingEntries, monthOptions],
  );
  const activeMonth = requestedMonth && monthOptions.some((month) => month.key === requestedMonth)
    ? requestedMonth
    : defaultMonth;

  // Latest weekly recap (if any)
  const latestWeekly = useMemo(() => {
    return data?.digests.find((d) => d.digestType === "weekly") ?? null;
  }, [data]);

  const wireDigests = useMemo(
    () => activeMonth
      ? matchingEntries.filter((entry) => digestMonthKey(entry.generatedAt) === activeMonth)
      : matchingEntries,
    [matchingEntries, activeMonth],
  );

  const triggerRecord = useMemo(() => buildDigestTriggerRecord(data?.digests ?? []), [data]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen flex-col gap-6">
        <div className="flex flex-col gap-3 border-t border-b border-border py-6">
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

  // A failed refetch keeps the admitted archive envelope; only a read with nothing retained is an error.
  if (!data) {
    if (error) {
      return (
        <QueryErrorNotice
          error={error}
          onRetry={() => {
            void refetch();
          }}
        />
      );
    }
    return <p className="text-sm text-muted-foreground py-8">No digests yet. Check back tomorrow.</p>;
  }

  // Envelope availability, not row count: an aged empty generation still crosses its own budget.
  const healthBanner = (
    <StaleDataBanner queries={[{ preset: "digestArchive", dataUpdatedAt, error, hasData: true, meta }]} />
  );

  if (data.digests.length === 0) {
    return (
      <div className="space-y-8">
        {healthBanner}
        <p className="text-sm text-muted-foreground py-8">No digests yet. Check back tomorrow.</p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {healthBanner}

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
          {wireDigests.map((d, index) => {
            const isWeekly = d.digestType === "weekly";
            const coverage = d.supplyCoverage;
            const mcapLabel = coverage?.observedCount === 0
              ? "Mcap unavailable (0 coins observed)"
              : d.totalMcapUsd == null ? null
                : `${coverage?.complete ? "Total mcap" : "Known mcap subtotal"}: ${formatCurrency(d.totalMcapUsd, 0)} · ${
                  coverage ? `${coverage.observedCount}/${coverage.observedCount + coverage.unavailableCount} coins observed` : "coverage unproven"
                }`;
            // The risk signal often repeats verbatim across consecutive editions;
            // show it where it first appears or changes, not on every row.
            const previousSignal = index > 0 ? wireDigests[index - 1]?.riskSignal : null;
            const riskSignal =
              d.riskSignal &&
              (previousSignal?.symbol !== d.riskSignal.symbol || previousSignal?.bps !== d.riskSignal.bps)
                ? d.riskSignal
                : null;
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
                      "flex flex-wrap items-center gap-x-1.5 gap-y-0.5 sm:flex-nowrap sm:truncate",
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
                    {riskSignal && (
                      <span
                        className={cn(
                          "hidden rounded border px-1.5 py-0.5 font-mono text-[0.65rem] font-semibold uppercase tracking-wider sm:inline",
                          riskSignal.severity === "critical"
                            ? "border-red-500/35 bg-red-500/10 text-red-700 dark:text-red-300"
                            : "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300",
                        )}
                      >
                        {formatArchiveRiskSignal(riskSignal)}
                      </span>
                    )}
                    {!isWeekly && d.editionNumber != null && (
                      <span className="font-mono text-[0.65rem] text-muted-foreground/70">#{d.editionNumber}</span>
                    )}
                  </span>
                  {(d.psiBand || mcapLabel || riskSignal) && (
                    <div className="flex flex-wrap items-center gap-2 mt-0.5 sm:hidden">
                      {riskSignal && (
                        <span
                          className={cn(
                            "text-xs font-mono font-medium",
                            riskSignal.severity === "critical"
                              ? "text-red-700 dark:text-red-300"
                              : "text-amber-700 dark:text-amber-300",
                          )}
                        >
                          {formatArchiveRiskSignal(riskSignal)}
                        </span>
                      )}
                      {d.psiBand && d.psiScore != null && (
                        <span
                          className={`text-xs font-mono font-medium ${d.psiBand in PSI_BAND_CLASSES ? PSI_BAND_CLASSES[d.psiBand as ConditionBand] : ""}`}
                        >
                          {d.psiBand} {d.psiScore.toFixed(1)}
                        </span>
                      )}
                      {mcapLabel && (
                        <span className="text-xs font-mono text-muted-foreground">
                          {mcapLabel}
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
                {mcapLabel && (
                  <span className="max-w-64 text-right text-xs font-mono text-muted-foreground hidden sm:inline">
                    {mcapLabel}
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
