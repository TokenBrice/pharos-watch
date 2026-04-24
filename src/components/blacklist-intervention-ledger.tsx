"use client";

import { Skeleton } from "@/components/ui/skeleton";
import {
  BLACKLIST_STATUS_BUCKET_COLORS,
  BLACKLIST_STATUS_BUCKET_LABELS,
  BLACKLIST_STATUS_BUCKET_ORDER,
  type BlacklistStatusBucket,
  type BlacklistStatusBucketKey,
} from "@/lib/blacklist-status-buckets";
import { BLACKLIST_CHART_COLORS } from "@shared/lib/classification";
import { BLACKLIST_STABLECOINS, type BlacklistStablecoin, type BlacklistSummaryResponse } from "@shared/types";

const COUNT_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

const USD_FORMATTER = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
  style: "currency",
});

const EXPOSURE_COPY: Record<BlacklistStatusBucketKey, string> = {
  yes: "Direct blacklist/freeze control resolved in the current model.",
  possible: "Direct possible token/vault control.",
  upstream: "Reserve/custody/parent exposure.",
  no: "No resolved exposure in current model.",
};

const EXPOSURE_LABELS: Record<BlacklistStatusBucketKey, string> = {
  yes: "Direct",
  possible: BLACKLIST_STATUS_BUCKET_LABELS.possible,
  upstream: BLACKLIST_STATUS_BUCKET_LABELS.upstream,
  no: BLACKLIST_STATUS_BUCKET_LABELS.no,
};

const MAX_EVENT_ROWS = 5;

export interface BlacklistInterventionExposureRow {
  key: BlacklistStatusBucketKey;
  label: string;
  description: string;
  count: number;
  marketCapUsd: number;
  marketCapShare: number;
}

export interface BlacklistInterventionEventRow {
  symbol: BlacklistStablecoin;
  eventCount: number;
  frozenUsd: number;
  destroyedUsd: number;
}

export interface BlacklistInterventionContextRow {
  key: "peak" | "recent" | "destroyed";
  label: string;
  marker: string;
  amountUsd: number;
  detail: string;
}

export interface BlacklistInterventionLedgerModel {
  exposureRows: BlacklistInterventionExposureRow[];
  eventRows: BlacklistInterventionEventRow[];
  contextRows: BlacklistInterventionContextRow[];
}

interface BuildBlacklistInterventionLedgerModelArgs {
  buckets: BlacklistStatusBucket[] | null | undefined;
  stats: BlacklistSummaryResponse["stats"] | undefined;
  chart: BlacklistSummaryResponse["chart"] | undefined;
}

interface BlacklistInterventionLedgerProps extends BuildBlacklistInterventionLedgerModelArgs {
  isLoading: boolean;
}

function formatCount(value: number): string {
  return COUNT_FORMATTER.format(Number.isFinite(value) ? value : 0);
}

function formatUsd(value: number): string {
  return USD_FORMATTER.format(Number.isFinite(value) ? value : 0);
}

function buildExposureRows(buckets: BlacklistStatusBucket[] | null | undefined): BlacklistInterventionExposureRow[] {
  const bucketByKey = new Map((buckets ?? []).map((bucket) => [bucket.key, bucket]));
  const totalMarketCapUsd = (buckets ?? []).reduce((sum, bucket) => sum + bucket.marketCap, 0);

  return BLACKLIST_STATUS_BUCKET_ORDER.map((key) => {
    const bucket = bucketByKey.get(key);
    const marketCapUsd = bucket?.marketCap ?? 0;

    return {
      key,
      label: EXPOSURE_LABELS[key],
      description: EXPOSURE_COPY[key],
      count: bucket?.count ?? 0,
      marketCapUsd,
      marketCapShare: totalMarketCapUsd > 0 ? marketCapUsd / totalMarketCapUsd : 0,
    };
  });
}

function buildEventRows(stats: BlacklistSummaryResponse["stats"] | undefined): BlacklistInterventionEventRow[] {
  if (!stats) return [];

  return BLACKLIST_STABLECOINS.map((symbol) => ({
    symbol,
    eventCount: stats.perCoinTotalEvents[symbol] ?? 0,
    frozenUsd: stats.perCoinFrozenTotal[symbol] ?? 0,
    destroyedUsd: stats.perCoinDestroyedTotal[symbol] ?? 0,
  }))
    .filter((row) => row.eventCount > 0)
    .sort((a, b) => {
      if (b.eventCount !== a.eventCount) return b.eventCount - a.eventCount;
      const bUsd = b.frozenUsd + b.destroyedUsd;
      const aUsd = a.frozenUsd + a.destroyedUsd;
      if (bUsd !== aUsd) return bUsd - aUsd;
      return a.symbol.localeCompare(b.symbol);
    })
    .slice(0, MAX_EVENT_ROWS);
}

function buildContextRows(
  stats: BlacklistSummaryResponse["stats"] | undefined,
  chart: BlacklistSummaryResponse["chart"] | undefined,
): BlacklistInterventionContextRow[] {
  const nonZeroQuarters = (chart ?? []).filter((point) => point.total > 0);
  const peakQuarter = nonZeroQuarters.reduce<BlacklistSummaryResponse["chart"][number] | null>(
    (peak, point) => (!peak || point.total > peak.total ? point : peak),
    null,
  );
  const recentQuarter = nonZeroQuarters.length > 0 ? nonZeroQuarters[nonZeroQuarters.length - 1] : null;
  const destroyedRows = stats
    ? BLACKLIST_STABLECOINS.map((symbol) => ({
        symbol,
        amountUsd: stats.perCoinDestroyedTotal[symbol] ?? 0,
      })).filter((row) => row.amountUsd > 0)
    : [];
  const destroyedTotalUsd = destroyedRows.reduce((sum, row) => sum + row.amountUsd, 0);
  const topDestroyed = destroyedRows.sort((a, b) => b.amountUsd - a.amountUsd)[0] ?? null;

  return [
    {
      key: "peak",
      label: "Peak tracked frozen quarter",
      marker: peakQuarter?.quarter ?? "No quarter",
      amountUsd: peakQuarter?.total ?? 0,
      detail: peakQuarter
        ? "Highest quarter balance in the current freeze ledger."
        : "No quarter freeze-ledger balance in the current summary.",
    },
    {
      key: "recent",
      label: "Latest tracked frozen quarter",
      marker: recentQuarter?.quarter ?? "No quarter",
      amountUsd: recentQuarter?.total ?? 0,
      detail: recentQuarter
        ? "Most recent non-zero quarter from the freeze ledger."
        : "No recent quarter balance in the current summary.",
    },
    {
      key: "destroyed",
      label: "Destroyed supported-event history",
      marker: topDestroyed ? `Top ${topDestroyed.symbol}` : "No destroyed total",
      amountUsd: destroyedTotalUsd,
      detail: topDestroyed
        ? `${topDestroyed.symbol} is the largest symbol-level destroyed total.`
        : "No destroyed amount in the current symbol summary.",
    },
  ];
}

export function buildBlacklistInterventionLedgerModel({
  buckets,
  stats,
  chart,
}: BuildBlacklistInterventionLedgerModelArgs): BlacklistInterventionLedgerModel {
  return {
    exposureRows: buildExposureRows(buckets),
    eventRows: buildEventRows(stats),
    contextRows: buildContextRows(stats, chart),
  };
}

export function BlacklistInterventionLedger({
  buckets,
  stats,
  chart,
  isLoading,
}: BlacklistInterventionLedgerProps) {
  if (isLoading) {
    return (
      <section className="pharos-card-shell overflow-hidden">
        <div className="pharos-panel-header space-y-2">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-6 w-80 max-w-full" />
        </div>
        <div className="grid gap-0 lg:grid-cols-[1.1fr_1.2fr_0.9fr]">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="space-y-3 border-border/60 p-4 sm:p-5 lg:border-l lg:first:border-l-0">
              <Skeleton className="h-4 w-44" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ))}
        </div>
      </section>
    );
  }

  const model = buildBlacklistInterventionLedgerModel({ buckets, stats, chart });

  return (
    <section
      className="pharos-card-shell overflow-hidden animate-in fade-in duration-300"
      aria-labelledby="blacklist-intervention-ledger-title"
    >
      <div className="pharos-panel-header flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-1">
          <p className="pharos-kicker">Intervention Ledger</p>
          <h2 id="blacklist-intervention-ledger-title" className="pharos-section-title">
            Exposure status and observed event history stay separate
          </h2>
        </div>
        <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
          Event count is observed supported tracker history, not policy probability. Frozen and destroyed values come
          from the current public summary.
        </p>
      </div>

      <div className="grid gap-0 lg:grid-cols-[1.1fr_1.2fr_0.9fr]">
        <div className="space-y-3 border-border/60 p-4 sm:p-5 lg:border-r">
          <SectionLabel
            title="Resolved blacklist/freeze exposure buckets"
            detail="Current model status"
          />
          <ul className="space-y-2">
            {model.exposureRows.map((row) => (
              <ExposureLedgerRow key={row.key} row={row} />
            ))}
          </ul>
        </div>

        <div className="space-y-3 border-t border-border/60 p-4 sm:p-5 lg:border-r lg:border-t-0">
          <SectionLabel
            title="Stablecoin symbols with observed supported events"
            detail="Symbol-level history"
          />
          {model.eventRows.length > 0 ? (
            <ul className="space-y-2">
              {model.eventRows.map((row) => (
                <EventLedgerRow key={row.symbol} row={row} />
              ))}
            </ul>
          ) : (
            <EmptyLedgerRow>No observed supported events in the current summary.</EmptyLedgerRow>
          )}
        </div>

        <div className="space-y-3 border-t border-border/60 p-4 sm:p-5 lg:border-t-0">
          <SectionLabel
            title="Quarter and amount context"
            detail="Visible values"
          />
          <ul className="space-y-2">
            {model.contextRows.map((row) => (
              <ContextLedgerRow key={row.key} row={row} />
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function SectionLabel({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-xs font-semibold uppercase text-muted-foreground">{title}</h3>
      <span className="rounded-full border border-border/60 bg-background/50 px-2 py-1 text-[10px] text-muted-foreground">
        {detail}
      </span>
    </div>
  );
}

function ExposureLedgerRow({ row }: { row: BlacklistInterventionExposureRow }) {
  return (
    <li className="min-h-11 rounded-lg border border-border/60 bg-background/35 px-3 py-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
          <span
            className="h-2.5 w-2.5 rounded-sm"
            style={{ backgroundColor: BLACKLIST_STATUS_BUCKET_COLORS[row.key] }}
            aria-hidden="true"
          />
          {row.label}
        </span>
        <span className="font-mono text-xs tabular-nums text-foreground">
          {formatCount(row.count)} stablecoins · {formatUsd(row.marketCapUsd)}
        </span>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{row.description}</p>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted/50" aria-hidden="true">
        <span
          className="block h-full rounded-full"
          style={{
            backgroundColor: BLACKLIST_STATUS_BUCKET_COLORS[row.key],
            width: `${row.marketCapShare * 100}%`,
          }}
        />
      </div>
    </li>
  );
}

function EventLedgerRow({ row }: { row: BlacklistInterventionEventRow }) {
  return (
    <li
      className="grid min-h-11 gap-2 rounded-lg border border-border/60 bg-background/35 px-3 py-2.5 sm:grid-cols-[auto_1fr]"
      aria-label={`${row.symbol} observed supported event history`}
    >
      <div className="flex items-center gap-2">
        <span
          className="h-2.5 w-2.5 rounded-sm"
          style={{ backgroundColor: BLACKLIST_CHART_COLORS[row.symbol] }}
          aria-hidden="true"
        />
        <span className="font-mono text-sm font-semibold tabular-nums text-foreground">{row.symbol}</span>
      </div>
      <div className="grid gap-1 text-xs sm:grid-cols-3 sm:text-right">
        <MetricLabel label="Observed events" value={formatCount(row.eventCount)} />
        <MetricLabel label="Frozen" value={formatUsd(row.frozenUsd)} />
        <MetricLabel label="Destroyed" value={formatUsd(row.destroyedUsd)} />
      </div>
    </li>
  );
}

function ContextLedgerRow({ row }: { row: BlacklistInterventionContextRow }) {
  return (
    <li className="min-h-11 rounded-lg border border-border/60 bg-background/35 px-3 py-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-sm font-medium text-foreground">{row.label}</span>
        <span className="font-mono text-xs tabular-nums text-foreground">{formatUsd(row.amountUsd)}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="rounded-full border border-border/60 bg-background/50 px-2 py-0.5 font-mono tabular-nums text-foreground">
          {row.marker}
        </span>
        <span>{row.detail}</span>
      </div>
    </li>
  );
}

function MetricLabel({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex min-w-0 items-baseline justify-between gap-2 sm:block">
      <span className="text-muted-foreground sm:block">{label}</span>
      <span className="font-mono tabular-nums text-foreground">{value}</span>
    </span>
  );
}

function EmptyLedgerRow({ children }: { children: string }) {
  return (
    <div className="flex min-h-11 items-center rounded-lg border border-dashed border-border/70 bg-background/25 px-3 py-2.5 text-sm text-muted-foreground">
      {children}
    </div>
  );
}
