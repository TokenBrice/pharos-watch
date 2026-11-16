import Image from "next/image";
import { Globe, UserRound } from "lucide-react";
import { TableBody, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/table";
import { cn } from "@/lib/utils";
import { formatDecimal } from "@shared/lib/format";
import { formatCoveragePct, type MonthlyFunding } from "@shared/lib/funding/helpers";
import type { CostLineItem } from "@shared/lib/funding/schema";

/** Whole-dollar grouped USD; every value here is a non-negative sum or line cost. */
export function formatUsdWhole(value: number): string {
  return `$${formatDecimal(value, 0, 0)}`;
}

/** Share label that keeps a small positive slice visible as "<1%". */
function formatShare(part: number, whole: number): string {
  return formatCoveragePct(part, whole);
}

/**
 * A cost line's mark: the vendor's square artwork from `public/media/` in a
 * circle, or a neutral person/globe glyph when the line has none.
 */
export function CostMark({ item }: { item: Pick<CostLineItem, "mark" | "category"> }) {
  if (item.mark) {
    return (
      <Image
        src={item.mark}
        alt=""
        width={20}
        height={20}
        unoptimized
        className="size-5 shrink-0 rounded-full ring-1 ring-border/60"
      />
    );
  }
  const Icon = item.category === "team" ? UserRound : Globe;
  return (
    <span aria-hidden="true" className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground ring-1 ring-border/60">
      <Icon className="size-3" />
    </span>
  );
}

// Neutral ink ramp, largest slice darkest: identity comes from the marks, not hue.
const SEGMENT_TONES = ["bg-foreground/80", "bg-foreground/60", "bg-foreground/45", "bg-foreground/30", "bg-foreground/20"] as const;

function segmentTone(index: number): string {
  return SEGMENT_TONES[Math.min(index, SEGMENT_TONES.length - 1)];
}

/** Paid lines of one category as a share bar plus a legend carrying exact values. */
export function CostAllocation({ items, ariaLabel }: { items: readonly CostLineItem[]; ariaLabel: string }) {
  const paid = items.filter((item) => item.usd_per_month > 0).sort((a, b) => b.usd_per_month - a.usd_per_month);
  const total = paid.reduce((sum, item) => sum + item.usd_per_month, 0);
  if (paid.length === 0 || total <= 0) return null;
  return (
    <div className="space-y-4">
      <div
        role="img"
        aria-label={`${ariaLabel}: ${paid.map((item) => `${item.label} ${formatShare(item.usd_per_month, total)}`).join(", ")}`}
        className="flex h-3 w-full gap-0.5"
      >
        {paid.map((item, index) => (
          <div
            key={item.label}
            title={`${item.label}: ${formatUsdWhole(item.usd_per_month)}/month (${formatShare(item.usd_per_month, total)})`}
            className={cn("h-full min-w-1 first:rounded-l-full last:rounded-r-full", segmentTone(index))}
            style={{ width: `${(item.usd_per_month / total) * 100}%` }}
          />
        ))}
      </div>
      <ul className="space-y-3">
        {paid.map((item, index) => (
          <li key={item.label} className="flex items-start gap-3">
            <CostMark item={item} />
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm font-medium text-foreground">{item.label}</span>
                <span className="pharos-numeric text-sm text-foreground">{formatUsdWhole(item.usd_per_month)}</span>
              </div>
              <div className="flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
                <span className="min-w-0">{item.note}</span>
                <span className="pharos-numeric inline-flex shrink-0 items-center gap-1.5">
                  <span aria-hidden="true" className={cn("size-2 rounded-xs", segmentTone(index))} />
                  {formatShare(item.usd_per_month, total)}
                </span>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function shortMonth(month: MonthlyFunding, index: number): React.ReactNode {
  const [name, year] = month.label.split(" ");
  // The first column and every January carry the year so a long window stays unambiguous;
  // narrow columns drop it rather than truncate the month.
  if (index !== 0 && !month.monthKey.endsWith("-01")) return name;
  return (
    <>
      {name}
      <span className="hidden sm:inline"> &apos;{year.slice(2)}</span>
    </>
  );
}

function describeMonth(month: MonthlyFunding): string {
  const cost = month.costUsd == null
    ? "monthly cost not recorded"
    : `${formatCoveragePct(month.communityUsd, month.costUsd)} of the ${formatUsdWhole(month.costUsd)} monthly cost`;
  return `${month.label}${month.isCurrent ? " so far" : ""}: ${formatUsdWhole(month.communityUsd)} donated, ${cost}`;
}

/**
 * Community donations per month as columns, each against a dashed tick at the
 * monthly cost published for that month (never today's cost backfilled). Exact
 * figures stay one click away in the table below the plot.
 */
export function MonthlyFundingChart({ months }: { months: readonly MonthlyFunding[] }) {
  if (months.length === 0) {
    return <p className="pharos-empty-note m-5 sm:m-6 lg:m-7">The monthly history starts with the first community donation.</p>;
  }
  const domain = Math.max(1, ...months.map((month) => Math.max(month.communityUsd, month.costUsd ?? 0))) * 1.15;
  const pct = (value: number) => `${(value / domain) * 100}%`;
  return (
    <figure className="flex h-full flex-col gap-4 p-5 sm:p-6 lg:p-7">
      <figcaption className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
        <span className="pharos-label">Community donations by month</span>
        <span aria-hidden="true" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-xs bg-foreground/55" />
            Donations
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-xs bg-foreground/20" />
            Month in progress
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-3.5 border-t border-dashed border-foreground/70" />
            Monthly cost at the time
          </span>
        </span>
      </figcaption>
      <div
        aria-hidden="true"
        className="grid min-h-52 flex-1 gap-1.5 sm:gap-2.5"
        style={{ gridTemplateColumns: `repeat(${months.length}, minmax(0, 1fr))` }}
      >
        {months.map((month, index) => (
          <div key={month.monthKey} className="flex min-w-0 flex-col gap-1.5" title={describeMonth(month)}>
            <div className="relative flex-1">
              {month.costUsd == null ? null : (
                <div className="absolute -inset-x-0.5 border-t border-dashed border-foreground/70" style={{ bottom: pct(month.costUsd) }} />
              )}
              <div
                className={cn("absolute inset-x-[14%] bottom-0 rounded-t-xs", month.isCurrent ? "bg-foreground/20" : "bg-foreground/55")}
                style={{ height: pct(month.communityUsd), minHeight: month.communityUsd > 0 ? 2 : 0 }}
              />
              <span
                className="pharos-numeric absolute inset-x-0 hidden text-center text-2xs text-foreground sm:block"
                style={{ bottom: `calc(${pct(month.communityUsd)} + 4px)` }}
              >
                {formatUsdWhole(month.communityUsd)}
              </span>
            </div>
            <span className="truncate text-center text-2xs text-muted-foreground">{shortMonth(month, index)}</span>
          </div>
        ))}
      </div>
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Monthly figures</summary>
        <TableFrame
          tableId="funding-monthly-figures"
          chrome="bare"
          className="mt-2 overflow-hidden rounded-lg border border-border/60"
          tableClassName="text-xs"
          tableProps={{ "aria-label": "Community donations against the monthly cost published for each month" }}
        >
          <TableHeader className="bg-muted/35">
            <TableRow rowIntent="static" className="hover:bg-transparent">
              <TableHead scope="col" className="h-8 px-3">Month</TableHead>
              <TableHead scope="col" className="h-8 px-3 text-right">Donations</TableHead>
              <TableHead scope="col" className="h-8 px-3 text-right">Monthly cost</TableHead>
              <TableHead scope="col" className="h-8 px-3 text-right">Coverage</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...months].reverse().map((month) => (
              <TableRow key={month.monthKey} rowIntent="static">
                <TableHead scope="row" className="h-auto px-3 py-2 font-medium text-foreground">
                  {month.isCurrent ? `${month.label} (so far)` : month.label}
                </TableHead>
                <TableCell className="pharos-numeric px-3 py-2 text-right">{formatUsdWhole(month.communityUsd)}</TableCell>
                <TableCell className="pharos-numeric px-3 py-2 text-right">
                  {month.costUsd == null ? "—" : formatUsdWhole(month.costUsd)}
                </TableCell>
                <TableCell className="pharos-numeric px-3 py-2 text-right">
                  {month.costUsd == null ? "—" : formatCoveragePct(month.communityUsd, month.costUsd)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </TableFrame>
      </details>
    </figure>
  );
}
