"use client";

import type { CSSProperties, ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  BLACKLIST_STATUS_BUCKET_COLORS,
  BLACKLIST_STATUS_BUCKET_DESCRIPTIONS,
  BLACKLIST_STATUS_BUCKET_LABELS,
  BLACKLIST_STATUS_BUCKET_ORDER,
  type BlacklistStatusBucket,
  type BlacklistStatusBucketKey,
} from "@/lib/blacklist-status-buckets";
import { formatCurrency } from "@shared/lib/format";

const FREEZABLE_BUCKETS = new Set<BlacklistStatusBucketKey>(["yes", "upstream", "possible"]);

interface FreezableSupplyMeterProps {
  buckets: BlacklistStatusBucket[] | null | undefined;
  isLoading: boolean;
  selectedBucket?: BlacklistStatusBucketKey | null;
  onBucketSelect?: (bucket: BlacklistStatusBucketKey) => void;
}

export function formatShare(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0%";
  if (value > 99 && value < 100) return `${value.toFixed(2)}%`;
  if (value < 0.1) return `${value.toFixed(2)}%`;
  if (value < 1) return `${value.toFixed(1)}%`;
  return `${value.toFixed(0)}%`;
}

/**
 * Derive the freezable-supply headline figures from the status buckets. Shared
 * by the FreezeWatch hero header (which renders the beam + sub-metrics) and the
 * meter body below it, so the two stay in lockstep.
 */
export function computeFreezableSummary(buckets: BlacklistStatusBucket[] | null | undefined) {
  const ordered = BLACKLIST_STATUS_BUCKET_ORDER.map((key) =>
    buckets?.find((bucket) => bucket.key === key),
  ).filter((bucket): bucket is BlacklistStatusBucket => Boolean(bucket));
  const totalMarketCap = ordered.reduce((sum, bucket) => sum + bucket.marketCap, 0);
  const freezableBuckets = ordered.filter((bucket) => FREEZABLE_BUCKETS.has(bucket.key));
  const freezableMarketCap = freezableBuckets.reduce((sum, bucket) => sum + bucket.marketCap, 0);
  const freezableCount = freezableBuckets.reduce((sum, bucket) => sum + bucket.count, 0);
  const freezableShare = totalMarketCap > 0 ? (freezableMarketCap / totalMarketCap) * 100 : 0;
  return { ordered, totalMarketCap, freezableMarketCap, freezableCount, freezableShare };
}

export function FreezableSupplyMeter({
  buckets,
  isLoading,
  selectedBucket = null,
  onBucketSelect,
}: FreezableSupplyMeterProps) {
  if (isLoading) {
    return (
      <div className="p-5 sm:p-6">
        <Skeleton className="h-12 w-full rounded-md" />
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Skeleton className="h-32 rounded-xl lg:col-span-2" />
          <Skeleton className="h-32 rounded-xl" />
          <Skeleton className="h-32 rounded-xl" />
          <Skeleton className="h-32 rounded-xl" />
          <Skeleton className="h-32 rounded-xl" />
        </div>
      </div>
    );
  }

  const { ordered: orderedBuckets, totalMarketCap } = computeFreezableSummary(buckets);
  const yesBucket = orderedBuckets.find((bucket) => bucket.key === "yes") ?? null;
  const noBucket = orderedBuckets.find((bucket) => bucket.key === "no") ?? null;
  const midBuckets = orderedBuckets.filter((bucket) => bucket.key !== "yes" && bucket.key !== "no");

  return (
    <div className="p-5 animate-in fade-in duration-300 sm:p-6">
      <FreezeLineBar buckets={orderedBuckets} totalMarketCap={totalMarketCap} />

      <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {yesBucket ? (
          <BucketCard
            bucket={yesBucket}
            totalMarketCap={totalMarketCap}
            isSelected={selectedBucket === yesBucket.key}
            onSelect={onBucketSelect}
            variant="hero"
          />
        ) : null}
        {midBuckets.map((bucket) => (
          <BucketCard
            key={bucket.key}
            bucket={bucket}
            totalMarketCap={totalMarketCap}
            isSelected={selectedBucket === bucket.key}
            onSelect={onBucketSelect}
            variant="mid"
          />
        ))}
        {noBucket ? (
          <BucketCard
            bucket={noBucket}
            totalMarketCap={totalMarketCap}
            isSelected={selectedBucket === noBucket.key}
            onSelect={onBucketSelect}
            variant="safe"
          />
        ) : null}
      </div>
    </div>
  );
}

interface BucketCardProps {
  bucket: BlacklistStatusBucket;
  totalMarketCap: number;
  isSelected: boolean;
  onSelect?: (bucket: BlacklistStatusBucketKey) => void;
  variant: "hero" | "mid" | "safe";
}

function BucketCard({ bucket, totalMarketCap, isSelected, onSelect, variant }: BucketCardProps) {
  const share = totalMarketCap > 0 ? (bucket.marketCap / totalMarketCap) * 100 : 0;
  const color = BLACKLIST_STATUS_BUCKET_COLORS[bucket.key];
  const isInteractive = typeof onSelect === "function";

  const spanClass = variant === "hero" ? "lg:col-span-2" : "lg:col-span-1";
  const padClass = variant === "hero" ? "p-4 sm:p-5" : "p-3 sm:p-3.5";
  const labelClass =
    variant === "hero" ? "text-base font-semibold text-foreground" : "text-sm font-semibold text-foreground";
  const valueClass =
    variant === "hero"
      ? "mt-3 pharos-numeric text-2xl font-extrabold text-foreground sm:text-3xl"
      : "mt-2.5 pharos-numeric text-lg font-bold text-foreground";
  const descClass =
    variant === "hero"
      ? "mt-2.5 line-clamp-3 text-xs leading-relaxed text-muted-foreground"
      : "mt-1.5 line-clamp-1 text-[11px] leading-snug text-muted-foreground";
  const safeAccentClass = variant === "safe" ? "bg-emerald-500/[0.06]" : "";

  const accentStripStyle: CSSProperties = {
    background:
      variant === "safe" && !isSelected
        ? color
        : isSelected
          ? color
          : `linear-gradient(90deg, ${color} 0%, ${color}55 55%, transparent 100%)`,
    opacity: isSelected || variant === "safe" ? 1 : 0.75,
  };
  const fillStyle: CSSProperties | undefined = isSelected
    ? { background: `linear-gradient(180deg, ${color}26 0%, ${color}08 60%, transparent 100%)` }
    : undefined;
  const borderStyle: CSSProperties | undefined = isSelected ? { borderColor: color } : undefined;

  const baseClass = cn(
    "group relative overflow-hidden rounded-xl border border-border/60 bg-background/55 text-left transition-[background-color,border-color,box-shadow,transform]",
    safeAccentClass,
    padClass,
    spanClass,
  );
  const interactiveClass = isInteractive
    ? "pharos-focus-ring cursor-pointer hover:-translate-y-px hover:bg-muted/40 hover:border-foreground/25"
    : "";

  const content: ReactNode = (
    <>
      <div aria-hidden className="absolute inset-x-0 top-0 h-[3px]" style={accentStripStyle} />
      {fillStyle ? <div aria-hidden className="pointer-events-none absolute inset-0" style={fillStyle} /> : null}
      <div className="relative">
        {variant === "hero" ? (
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
              <span className={labelClass}>{BLACKLIST_STATUS_BUCKET_LABELS[bucket.key]}</span>
            </div>
            <span className="shrink-0 pharos-numeric text-xs text-muted-foreground">{formatShare(share)}</span>
          </div>
        ) : (
          <div className="flex min-w-0 items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
            <span className={labelClass}>{BLACKLIST_STATUS_BUCKET_LABELS[bucket.key]}</span>
          </div>
        )}
        {variant === "safe" ? (
          <p className="mt-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-emerald-500">
            Safe haven
          </p>
        ) : null}
        <p className={valueClass}>{formatCurrency(bucket.marketCap, 2)}</p>
        <p className="mt-1 text-[11px] text-muted-foreground">
          {variant === "hero" ? (
            `${bucket.count} stablecoins`
          ) : (
            <>
              <span className="pharos-numeric text-foreground/85">{formatShare(share)}</span>
              <span aria-hidden="true" className="mx-1 text-muted-foreground/60">·</span>
              {bucket.count} stablecoins
            </>
          )}
        </p>
        <p className={descClass}>{BLACKLIST_STATUS_BUCKET_DESCRIPTIONS[bucket.key]}</p>
      </div>
    </>
  );

  if (isInteractive) {
    return (
      <button
        type="button"
        className={cn(baseClass, interactiveClass)}
        style={borderStyle}
        aria-pressed={isSelected}
        onClick={() => onSelect(bucket.key)}
      >
        {content}
      </button>
    );
  }

  return (
    <div className={baseClass} style={borderStyle}>
      {content}
    </div>
  );
}

function FreezeLineBar({ buckets, totalMarketCap }: { buckets: BlacklistStatusBucket[]; totalMarketCap: number }) {
  if (totalMarketCap <= 0) {
    return (
      <div className="mt-6 flex h-12 items-center justify-center rounded-md border border-border/70 bg-muted/30 text-[11px] text-muted-foreground">
        No tracked market-cap data yet.
      </div>
    );
  }

  const segments = BLACKLIST_STATUS_BUCKET_ORDER.reduce<
    Array<{ key: BlacklistStatusBucketKey; left: number; width: number }>
  >((acc, key) => {
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
  const labelTransform =
    freezableEnd <= 12 ? "translateX(0%)" : freezableEnd >= 88 ? "translateX(-100%)" : "translateX(-50%)";

  return (
    <div className="relative mt-3 h-14">
      <div
        className="relative h-12 overflow-hidden rounded-md border border-border/70 bg-muted/40 shadow-[inset_0_1px_0_oklch(1_0_0_/0.04),inset_0_-1px_0_oklch(0_0_0_/0.22)]"
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
                "repeating-linear-gradient(135deg, oklch(1 0 0 / 0.24) 0 2px, transparent 2px 7px), linear-gradient(180deg, oklch(1 0 0 / 0.18) 0%, transparent 70%)",
            }}
          />
        ) : null}
        {freezableEnd > 0 ? (
          <div
            aria-hidden
            className="freezable-meter-scan pointer-events-none absolute top-0 h-full"
            style={{ left: 0, width: `${freezableEnd}%` }}
          />
        ) : null}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 inset-y-0">
          {[25, 50, 75].map((tick) => (
            <span
              key={`t-${tick}`}
              className="absolute top-0 h-1.5 w-px bg-foreground/30"
              style={{ left: `${tick}%` }}
            />
          ))}
          {[25, 50, 75].map((tick) => (
            <span
              key={`b-${tick}`}
              className="absolute bottom-0 h-1.5 w-px bg-foreground/30"
              style={{ left: `${tick}%` }}
            />
          ))}
        </div>
      </div>

      {freezableEnd > 0 && freezableEnd < 100 ? (
        <div
          aria-hidden
          className="pointer-events-none absolute -top-4 h-[calc(3rem+1rem)]"
          style={{ left: `${freezableEnd}%` }}
        >
          <div className="absolute left-0 h-full w-[2px] -translate-x-1/2 bg-frost-blue" />
          <span
            className="absolute -top-0.5 whitespace-nowrap rounded-sm border border-frost-blue/60 bg-background/95 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-frost-blue"
            style={{ left: 0, transform: labelTransform }}
          >
            Freeze line
          </span>
        </div>
      ) : null}
    </div>
  );
}
