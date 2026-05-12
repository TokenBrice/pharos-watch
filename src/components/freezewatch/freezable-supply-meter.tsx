"use client";

import { Skeleton } from "@/components/ui/skeleton";
import {
  BLACKLIST_STATUS_BUCKET_COLORS,
  BLACKLIST_STATUS_BUCKET_DESCRIPTIONS,
  BLACKLIST_STATUS_BUCKET_LABELS,
  BLACKLIST_STATUS_BUCKET_ORDER,
  type BlacklistStatusBucket,
  type BlacklistStatusBucketKey,
} from "@/lib/blacklist-status-buckets";
import { formatCurrency } from "@shared/lib/format";
import type { BlacklistSummaryResponse } from "@shared/types";

const FREEZABLE_BUCKETS = new Set<BlacklistStatusBucketKey>(["yes", "dilutable", "upstream", "possible"]);

interface FreezableSupplyMeterProps {
  buckets: BlacklistStatusBucket[] | null | undefined;
  stats: BlacklistSummaryResponse["stats"] | undefined;
  isLoading: boolean;
}

const USD_FORMATTER = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 0,
  style: "currency",
});

function formatShare(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0%";
  if (value < 0.1) return `${value.toFixed(2)}%`;
  if (value < 1) return `${value.toFixed(1)}%`;
  return `${value.toFixed(0)}%`;
}

export function FreezableSupplyMeter({ buckets, stats, isLoading }: FreezableSupplyMeterProps) {
  if (isLoading) {
    return (
      <section className="pharos-card-shell p-4 sm:p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-2">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-8 w-72 max-w-full" />
          </div>
          <Skeleton className="h-10 w-44" />
        </div>
        <Skeleton className="mt-5 h-4 w-full rounded-full" />
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, index) => (
            <Skeleton key={index} className="h-20 rounded-xl" />
          ))}
        </div>
      </section>
    );
  }

  const orderedBuckets = BLACKLIST_STATUS_BUCKET_ORDER.map((key) => buckets?.find((bucket) => bucket.key === key)).filter(
    (bucket): bucket is BlacklistStatusBucket => Boolean(bucket),
  );
  const totalMarketCap = orderedBuckets.reduce((sum, bucket) => sum + bucket.marketCap, 0);
  const freezableMarketCap = orderedBuckets
    .filter((bucket) => FREEZABLE_BUCKETS.has(bucket.key))
    .reduce((sum, bucket) => sum + bucket.marketCap, 0);
  const freezableShare = totalMarketCap > 0 ? (freezableMarketCap / totalMarketCap) * 100 : 0;

  return (
    <section
      className="pharos-card-shell p-4 animate-in fade-in duration-300 sm:p-5"
      aria-labelledby="freezable-supply-meter-title"
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-1">
          <p className="pharos-kicker">Freezable Supply Meter</p>
          <h2 id="freezable-supply-meter-title" className="pharos-section-title">
            {formatCurrency(freezableMarketCap, 0)} sits under issuer freeze control
          </h2>
          <p className="text-sm text-muted-foreground">
            {formatShare(freezableShare)} of tracked stablecoin market cap resolves to direct, dilutable, upstream, or
            possible freeze exposure — only the &quot;no&quot; bucket falls outside the freeze line.
          </p>
        </div>
        <div className="rounded-lg border border-border/70 bg-background/70 px-4 py-3">
          <p className="text-[11px] font-semibold uppercase text-muted-foreground">Tracked frozen total</p>
          <p className="mt-1 font-mono text-xl font-semibold tabular-nums text-foreground">
            {formatCurrency(stats?.trackedFrozenTotal ?? 0, 0)}
          </p>
        </div>
      </div>

      <FreezeLineBar buckets={orderedBuckets} totalMarketCap={totalMarketCap} />


      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {orderedBuckets.map((bucket) => {
          const share = totalMarketCap > 0 ? (bucket.marketCap / totalMarketCap) * 100 : 0;

          return (
            <div key={bucket.key} className="rounded-xl border border-border/60 bg-background/60 p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: BLACKLIST_STATUS_BUCKET_COLORS[bucket.key] }}
                  />
                  <span className="text-sm font-semibold text-foreground">{BLACKLIST_STATUS_BUCKET_LABELS[bucket.key]}</span>
                </div>
                <span className="font-mono text-xs tabular-nums text-muted-foreground">{formatShare(share)}</span>
              </div>
              <p className="mt-3 font-mono text-lg font-semibold tabular-nums text-foreground">
                {USD_FORMATTER.format(bucket.marketCap)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{bucket.count} stablecoins</p>
              <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                {BLACKLIST_STATUS_BUCKET_DESCRIPTIONS[bucket.key]}
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function FreezeLineBar({
  buckets,
  totalMarketCap,
}: {
  buckets: BlacklistStatusBucket[];
  totalMarketCap: number;
}) {
  if (totalMarketCap <= 0) {
    return (
      <div className="mt-5 flex h-6 items-center justify-center rounded-full border border-border/70 bg-muted/30 text-[11px] text-muted-foreground">
        No tracked market-cap data yet.
      </div>
    );
  }

  const segments = BLACKLIST_STATUS_BUCKET_ORDER.reduce<Array<{ key: BlacklistStatusBucketKey; left: number; width: number }>>((acc, key) => {
    const bucket = buckets.find((entry) => entry.key === key);
    const ratio = (bucket?.marketCap ?? 0) / totalMarketCap;
    const left = acc.reduce((sum, segment) => sum + segment.width, 0);
    const width = ratio * 100;
    acc.push({ key, left, width });
    return acc;
  }, []);
  const freezableEnd = segments
    .filter((segment) => FREEZABLE_BUCKETS.has(segment.key))
    .reduce((sum, segment) => sum + segment.width, 0);

  return (
    <div className="relative mt-5 h-6">
      <div
        className="relative h-full overflow-hidden rounded-full border border-border/70 bg-muted/40"
        role="img"
        aria-label="Freeze exposure distribution across tracked stablecoin market cap"
      >
        {segments.map(({ key, left, width }) =>
          width > 0 ? (
            <div
              key={key}
              className="absolute top-0 h-full"
              style={{
                left: `${left}%`,
                width: `${width}%`,
                backgroundColor: BLACKLIST_STATUS_BUCKET_COLORS[key],
              }}
            />
          ) : null,
        )}
        {freezableEnd > 0 ? (
          <div
            aria-hidden
            className="pointer-events-none absolute top-0 h-full"
            style={{
              left: 0,
              width: `${freezableEnd}%`,
              backgroundImage:
                "repeating-linear-gradient(135deg, oklch(1 0 0 / 0.16) 0 1.5px, transparent 1.5px 5px), linear-gradient(180deg, oklch(1 0 0 / 0.14) 0%, transparent 70%)",
            }}
          />
        ) : null}
      </div>
      {freezableEnd > 0 && freezableEnd < 100 ? (
        <div
          aria-hidden
          className="pointer-events-none absolute -top-1 h-[calc(100%+0.5rem)]"
          style={{ left: `${freezableEnd}%` }}
        >
          <div className="absolute -left-px h-full w-0.5 bg-frost-blue shadow-[0_0_6px_oklch(0.74_0.16_240_/_0.55)]" />
          <span className="absolute -top-3.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-sm border border-frost-blue/40 bg-background/90 px-1.5 py-px font-mono text-[9px] uppercase tracking-[0.14em] text-frost-blue">
            freeze line
          </span>
        </div>
      ) : null}
    </div>
  );
}
