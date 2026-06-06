import type { HomepageHeroSnapshot } from "@/lib/homepage-static-snapshot";
import { CHART_SLATE, USDT_GREEN, USDC_BLUE, SKY_YELLOW } from "@/lib/chart-colors";
import { HomeAltHeroChartGate } from "@/components/home-alt-hero-chart-gate";
import { formatCurrency } from "@shared/lib/format";

export function HomeAltHero({ snapshot }: { snapshot: HomepageHeroSnapshot }): React.JSX.Element {
  const latest = snapshot.cohort;

  return (
    <section
      className="pharos-card-shell grid grid-cols-1 overflow-hidden lg:grid-cols-[minmax(0,5fr)_minmax(0,8fr)]"
      aria-label="Stablecoin market cap snapshot"
    >
      <div className="flex flex-col gap-6 border-b border-border/50 p-5 sm:p-6 lg:border-b-0 lg:border-r lg:p-7">
        <div className="space-y-2.5">
          <p
            className="pharos-kicker"
            title="Excludes 2 shadow assets used only for PSI continuity"
          >
            Total Stablecoin Market Cap
          </p>
          <p
            className="font-semibold leading-[0.92] tracking-tight tabular-nums text-foreground"
            style={{
              fontSize: "clamp(2.5rem, 5.5vw, 4.75rem)",
              fontFamily: "SFMono-Regular, ui-monospace, Menlo, Monaco, Consolas, monospace",
            }}
          >
            {formatCurrency(snapshot.totalUsd, 1)}
          </p>
          {snapshot.asOfISO ? (
            <p className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
              Snapshot {new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(snapshot.asOfISO))}
            </p>
          ) : null}
        </div>

        {/* Cohort breakdown — sits directly under the headline so the column
            reads as one continuous story instead of headline-then-gap-then-list. */}
        <div className="space-y-2 border-t border-border/50 pt-5">
          <p className="pharos-kicker">Market Cohorts</p>
          <ul className="flex flex-col gap-1.5 text-xs">
            {latest ? (
              <>
                <CohortRow color={USDT_GREEN} label="USDT" value={latest.usdt} total={latest.total} />
                <CohortRow color={USDC_BLUE} label="USDC" value={latest.usdc} total={latest.total} />
                <CohortRow color={SKY_YELLOW} label="USDS + DAI" value={latest.sky} total={latest.total} />
                <CohortRow color={CHART_SLATE} label="Others" value={latest.others} total={latest.total} />
                <li className="flex items-baseline justify-between gap-2 pt-1 text-[11px] text-muted-foreground">
                  <span className="font-mono uppercase tracking-wider">Non-USD share</span>
                  <span className="font-mono tabular-nums text-foreground/90">
                    {snapshot.nonUsdShare !== null
                      ? `${formatCurrency(snapshot.nonUsdUsd, 1)} · ${(snapshot.nonUsdShare * 100).toFixed(1)}%`
                      : "—"}
                  </span>
                </li>
              </>
            ) : (
              <li className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                Loading cohorts…
              </li>
            )}
          </ul>
        </div>
      </div>

      <HomeAltHeroChartGate />
    </section>
  );
}
function CohortRow({
  color,
  label,
  value,
  total,
}: {
  color: string;
  label: string;
  value: number;
  total: number;
}): React.JSX.Element {
  const share = total > 0 ? (value / total) * 100 : 0;
  return (
    <li className="flex items-baseline justify-between gap-3 font-mono">
      <span className="flex items-center gap-2 text-muted-foreground">
        <span
          className="inline-block h-2 w-2 rounded-sm"
          style={{ backgroundColor: color }}
          aria-hidden="true"
        />
        <span className="uppercase tracking-tight">{label}</span>
      </span>
      <span className="flex items-baseline gap-2 tabular-nums">
        <span className="text-foreground">{formatCurrency(value, 1)}</span>
        <span className="w-12 text-right text-muted-foreground">{share.toFixed(1)}%</span>
      </span>
    </li>
  );
}
