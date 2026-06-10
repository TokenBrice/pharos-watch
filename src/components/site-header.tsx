import { formatCompactCount } from "@shared/lib/format";
import { PharosLogo } from "@/components/pharos-logo";

interface SiteHeaderProps {
  /** Full tracked registry, including pre-launch and frozen coins. */
  tracked: number;
  /** Active (live-listed) subset of the tracked registry. */
  total: number;
  pegCount: number;
  chainCount: number;
}

const METRIC_PILL_CLASS =
  "inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 font-mono tabular-nums text-muted-foreground sm:px-2.5 sm:py-1" +
  " border-[var(--control-pill-border)] bg-[var(--control-pill-bg)] shadow-[inset_0_1px_0_oklch(1_0_0_/0.08)]";

interface MetricPill {
  value: string;
  label: string;
}

function MetricPills({ metrics }: { metrics: MetricPill[] }) {
  return (
    <>
      {metrics.map((metric) => (
        <span key={metric.label} className={METRIC_PILL_CLASS}>
          <span className="text-foreground">{metric.value}</span>
          <span className="ml-1 text-muted-foreground/70">{metric.label}</span>
        </span>
      ))}
    </>
  );
}

export function SiteHeader({ tracked, total, pegCount, chainCount }: SiteHeaderProps) {
  // One coin-count story: "tracked" is the full registry (pre-launch and
  // frozen included), "active" the live-listed subset shown on the dashboard.
  const headlineMetrics = [
    { value: formatCompactCount(tracked), label: "tracked" },
    { value: formatCompactCount(total), label: "active" },
    { value: formatCompactCount(pegCount), label: "pegs" },
    { value: formatCompactCount(chainCount), label: "chains" },
  ];

  return (
    <div className="pharos-card-shell flex flex-col gap-2 px-3 py-2 sm:gap-2.5 sm:px-4 sm:py-2.5 md:flex-row md:items-center md:justify-between md:gap-6 md:px-5 md:py-3">
      <div className="flex min-w-0 items-center gap-2.5 md:gap-3.5">
        <span className="hidden md:block">
          <PharosLogo size={32} className="rounded-lg shadow-sm" priority />
        </span>
        <div className="flex min-w-0 flex-col gap-0.5 md:flex-row md:items-baseline md:gap-3">
          {/* Below md the sticky site chrome directly above already carries the
              brand lockup, so the masthead h1 stays for SEO/a11y (exactly one
              raw h1 per page) but only renders visually from md up. */}
          <h1 className="sr-only md:not-sr-only md:shrink-0 md:font-mono md:text-[1.02rem] md:font-semibold md:uppercase md:tracking-[0.16em] md:text-foreground">
            Pharos
          </h1>
          <div className="hidden min-w-0 flex-1 md:flex md:items-baseline md:gap-2">
            <p className="whitespace-nowrap text-xs leading-snug tracking-[0.01em] text-muted-foreground/85 md:text-[13px]">
              Every tracked stablecoin: backing, freeze risk, liquidity, and peg stress.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5 text-[11px] md:hidden">
          <MetricPills metrics={headlineMetrics} />
        </div>
      </div>

      <div className="hidden shrink-0 flex-nowrap items-center justify-end gap-2 text-[11px] md:flex">
        <MetricPills metrics={headlineMetrics} />
      </div>
    </div>
  );
}
