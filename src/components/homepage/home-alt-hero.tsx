"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { HomepageHeroSnapshot } from "@shared/lib/homepage-hero-snapshot";
import type { TotalMcapChartRow } from "@shared/lib/total-mcap-chart";
import type { ApiMeta } from "@/lib/api";
import { CHART_ORANGE, CHART_PALETTE, CHART_SLATE_STRONG, USDT_GREEN, USDC_BLUE } from "@/lib/chart-colors";
import { HomeAltHeroChartGate } from "@/components/homepage/home-alt-hero-chart-gate";
import { CardExpandButton } from "@/components/home-alt-mini-cards/pulse-card-header";
import { useHomepageSnapshot } from "@/hooks/api-hooks";
import { HOMEPAGE_HERO_MAX_FALLBACK_AGE_MS, selectHomepageHeroSnapshot } from "@/lib/homepage-hero-snapshot";
import { formatCurrency, formatLongDate } from "@shared/lib/format";
import { deriveDataHealth } from "@/lib/data-health";
import { DATA_HEALTH_PRESETS } from "@/lib/data-health-config";
import { HomeMarketStateLine } from "@/components/homepage/home-market-state-line";
import { trackFreshDataReady } from "@/lib/analytics";
import { useHomepageEvidence } from "@/lib/homepage-evidence";
import { HEADLINE_STABLECOIN_COUNT, HEADLINE_STABLECOIN_LABEL } from "@/lib/universe-vocabulary";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { buildStaticCompareHref } from "@/lib/compare-links";
import { DIRECTION_TONE_CLASSES } from "@shared/lib/classification";
import { DAY_MS } from "@shared/lib/time-constants";

// OTHERS cohort dot; violet pulled from the shared chart palette.
const OTHERS_PURPLE = CHART_PALETTE[1];
const SKY_COMPARE_HREF = buildStaticCompareHref(["usds-sky", "dai-makerdao"]);
const DELTA_MAX_BEFORE_MS = 3 * DAY_MS;
const DELTA_MAX_AFTER_MS = DAY_MS;

function computeHistorySupplyDeltaPct(rows: readonly TotalMcapChartRow[], days: number): number | null {
  let latest: { ts: number; total: number } | null = null;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row && row.total != null && Number.isFinite(row.total) && row.total > 0) {
      latest = { ts: row.ts, total: row.total };
      break;
    }
  }
  if (!latest) return null;

  const targetTs = latest.ts - days * DAY_MS;
  let bestPrior: { diff: number; total: number } | null = null;
  for (const row of rows) {
    if (row.total == null || !Number.isFinite(row.total) || row.total <= 0) continue;
    if (row.ts >= latest.ts) continue;
    const offset = row.ts - targetTs;
    if (offset < -DELTA_MAX_BEFORE_MS || offset > DELTA_MAX_AFTER_MS) continue;
    const diff = Math.abs(offset);
    if (!bestPrior || diff < bestPrior.diff) {
      bestPrior = { diff, total: row.total };
    }
  }
  if (!bestPrior) return null;
  const pct = ((latest.total - bestPrior.total) / bestPrior.total) * 100;
  return Number.isFinite(pct) ? pct : null;
}

function formatSignedDeltaPct(pct: number): string {
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

export function HomeAltHero({
  snapshot,
  fallbackSelectedAtMs,
}: {
  snapshot: HomepageHeroSnapshot;
  fallbackSelectedAtMs: number;
}): React.JSX.Element {
  const stablecoinsQuery = useHomepageSnapshot();
  // Hydration-stable first render: the build-time clock keeps server and
  // client output identical, then a deferred tick re-evaluates fallback
  // expiry with the viewer's clock.
  const [nowMs, setNowMs] = useState(fallbackSelectedAtMs);
  const [liveHistoryRows, setLiveHistoryRows] = useState<readonly TotalMcapChartRow[] | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setNowMs(Date.now()), 0);
    const interval = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => {
      clearTimeout(timer);
      clearInterval(interval);
    };
  }, []);
  const handleLiveHistoryRows = useCallback((rows: readonly TotalMcapChartRow[]) => {
    setLiveHistoryRows(rows.length > 0 ? rows : null);
  }, []);

  const evidence = useHomepageEvidence(stablecoinsQuery.data, nowMs);
  const browserRetained = evidence.retainedLanes.includes("market");
  // Producer clocks remain lane-specific, including restored browser evidence.
  const marketMeta = evidence.data?.market.meta;
  const meta: ApiMeta = marketMeta?.updatedAt === undefined
    ? { updatedAt: null, ageSeconds: null, status: "unknown", reason: "missing-generation" }
    : marketMeta;
  const fallbackGenerationMs = snapshot.asOfISO ? Date.parse(snapshot.asOfISO) : 0;
  const liveSnapshot: HomepageHeroSnapshot | null = browserRetained && marketMeta?.updatedAt != null
    && fallbackGenerationMs > marketMeta.updatedAt * 1000
    ? null
    : evidence.data?.market.data ?? null;
  const liveHealth = deriveDataHealth({
    ...DATA_HEALTH_PRESETS.stablecoins,
    dataUpdatedAt: stablecoinsQuery.dataUpdatedAt,
    hasData: liveSnapshot !== null,
    error: stablecoinsQuery.error,
    meta,
  }, nowMs);
  const selection = selectHomepageHeroSnapshot({
    liveSnapshot, liveHealth, fallbackSnapshot: snapshot, nowMs,
  });
  useEffect(() => {
    if (selection.source === "live") trackFreshDataReady("home-hero");
  }, [selection.source]);

  const visibleSnapshot = selection.snapshot;
  const latest = visibleSnapshot?.cohort ?? null;
  const cohortTotal = latest?.total ?? null;
  const selectedDate = visibleSnapshot?.asOfISO
    ? formatLongDate(new Date(visibleSnapshot.asOfISO), { utc: true })
    : null;

  // Prefer live history for 7d/30d supply deltas; otherwise use unexpired build history.
  const deltaRows = useMemo(() => {
    if (liveHistoryRows && liveHistoryRows.length > 0) return liveHistoryRows;
    const updatedAt = snapshot.history?.sources.total.updatedAt;
    if (
      snapshot.history
      && updatedAt != null
      && updatedAt * 1000 <= nowMs
      && nowMs - updatedAt * 1000 <= HOMEPAGE_HERO_MAX_FALLBACK_AGE_MS
    ) {
      return snapshot.history.rows;
    }
    return null;
  }, [liveHistoryRows, nowMs, snapshot.history]);

  const delta7d = useMemo(
    () => (deltaRows ? computeHistorySupplyDeltaPct(deltaRows, 7) : null),
    [deltaRows],
  );
  const delta30d = useMemo(
    () => (deltaRows ? computeHistorySupplyDeltaPct(deltaRows, 30) : null),
    [deltaRows],
  );

  return (
    <section aria-labelledby="market-pulse-title" className="space-y-3.5">
      <div className="space-y-1.5">
        <h1
          id="market-pulse-title"
          className="pharos-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl"
        >
          Market Pulse
        </h1>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <p className="text-sm text-muted-foreground">
            Independent safety grades, peg stress, freeze risk, and liquidity across{" "}
            <span className="pharos-numeric font-medium text-foreground">{HEADLINE_STABLECOIN_COUNT}</span>{" "}
            {HEADLINE_STABLECOIN_LABEL}.
          </p>
          <span aria-hidden="true" className="hidden text-sm text-muted-foreground sm:inline">·</span>
          <HomeMarketStateLine nowMs={nowMs} />
        </div>
      </div>

      <div
        className="pharos-card-shell relative grid grid-cols-1 overflow-hidden lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:grid-rows-[auto_1fr]"
        role="group"
        aria-label="Stablecoin market cap snapshot"
      >
        <div className="border-b border-border/50 p-4 sm:p-5 lg:border-b-0 lg:border-r lg:p-5">
          <div className="space-y-2">
            <div className="flex items-start justify-between gap-3">
              <p
                className="text-sm font-medium text-muted-foreground"
                title="Excludes 2 off-catalog PSI historical assets"
              >
                Core market cap
              </p>
              <CardExpandButton href="/screener/" expandLabel="Open Screener" className="-mr-1.5" />
            </div>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <p className="pharos-hero-kpi">
                {visibleSnapshot?.totalUsd != null ? formatCurrency(visibleSnapshot.totalUsd, 1) : "—"}
              </p>
              {(delta7d !== null || delta30d !== null) && visibleSnapshot?.totalUsd != null ? (
                <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 text-xs">
                  {delta7d !== null ? (
                    <span className="inline-flex items-baseline gap-1 text-muted-foreground">
                      <span>7d</span>
                      <span
                        className={`pharos-numeric font-medium ${delta7d >= 0 ? DIRECTION_TONE_CLASSES.up : DIRECTION_TONE_CLASSES.down}`}
                      >
                        {formatSignedDeltaPct(delta7d)}
                      </span>
                    </span>
                  ) : null}
                  {delta30d !== null ? (
                    <span className="inline-flex items-baseline gap-1 text-muted-foreground">
                      <span>30d</span>
                      <span
                        className={`pharos-numeric font-medium ${delta30d >= 0 ? DIRECTION_TONE_CLASSES.up : DIRECTION_TONE_CLASSES.down}`}
                      >
                        {formatSignedDeltaPct(delta30d)}
                      </span>
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
            <p className="pharos-meta min-h-4">
              {selectedDate ? `As of ${selectedDate}` : visibleSnapshot ? null : "Updating"}
            </p>
          </div>
        </div>

        {/* The chart fills the whole right column at lg: the cell sizes from the
            headline + cohort column and the chart is pinned inside it. */}
        <div className="border-b border-border/50 lg:relative lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:min-h-[268px] lg:border-b-0">
          <HomeAltHeroChartGate
            history={snapshot.history}
            nowMs={nowMs}
            onLiveHistoryRows={handleLiveHistoryRows}
          />
        </div>

        {/* Cohort breakdown directly under the headline so the column reads as one continuous story. */}
        <div className="space-y-1.5 p-4 sm:p-5 lg:col-start-1 lg:border-r lg:border-t lg:border-border/50 lg:p-5">
          <p className="pharos-label">Market cohorts</p>
          <ul className="flex min-h-[6.5rem] flex-col gap-0.5 text-xs">
            {latest ? (
              <>
                <CohortRow
                  color={USDT_GREEN}
                  label="USDT"
                  href={buildStablecoinUrl("usdt-tether")}
                  value={latest.usdt}
                  total={cohortTotal}
                />
                <CohortRow
                  color={USDC_BLUE}
                  label="USDC"
                  href={buildStablecoinUrl("usdc-circle")}
                  value={latest.usdc}
                  total={cohortTotal}
                />
                <CohortRow
                  color={CHART_ORANGE}
                  label="USDS + DAI"
                  href={SKY_COMPARE_HREF}
                  value={latest.sky}
                  total={cohortTotal}
                />
                <CohortRow
                  color={OTHERS_PURPLE}
                  label="Others"
                  href="/#home-alt-rankings"
                  value={latest.others}
                  total={cohortTotal}
                />
                <li>
                  <Link
                    href="/alt-pegs/"
                    prefetch={false}
                    className="pharos-focus-ring group -mx-1.5 flex items-baseline justify-between gap-3 rounded-md px-1.5 py-0.5 transition-colors hover:bg-muted/50"
                  >
                    <span className="flex items-center gap-2 text-muted-foreground group-hover:text-foreground">
                      <span className="inline-flex h-2 w-2 items-center" aria-hidden="true">
                        <span className="w-2 border-t border-dashed" style={{ borderColor: CHART_SLATE_STRONG }} />
                      </span>
                      <span className="pharos-label group-hover:text-foreground">Non-USD share</span>
                    </span>
                    <span className="flex items-baseline gap-1.5 pharos-numeric text-muted-foreground">
                      {visibleSnapshot?.nonUsdUsd != null ? (
                        <>
                          <span className="text-foreground">{formatCurrency(visibleSnapshot.nonUsdUsd, 1)}</span>
                          <span aria-hidden="true">·</span>
                          <span>{visibleSnapshot.nonUsdShare !== null ? `${(visibleSnapshot.nonUsdShare * 100).toFixed(1)}%` : "share unavailable"}</span>
                        </>
                      ) : (
                        "—"
                      )}
                    </span>
                  </Link>
                </li>
              </>
            ) : (
              <li className="pharos-label flex flex-1 items-center">
                Market data unavailable
              </li>
            )}
          </ul>
        </div>
      </div>
    </section>
  );
}

function CohortRow({
  color,
  label,
  href,
  value,
  total,
}: {
  color: string;
  label: string;
  href: string;
  value: number | null;
  total: number | null;
}): React.JSX.Element {
  const share = value != null && total != null && total > 0 ? (value / total) * 100 : null;
  return (
    <li>
      <Link
        href={href}
        prefetch={false}
        className="pharos-focus-ring group -mx-1.5 flex items-baseline justify-between gap-3 rounded-md px-1.5 py-0.5 transition-colors hover:bg-muted/50"
      >
        <span className="flex items-center gap-2 text-muted-foreground group-hover:text-foreground">
          <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: color }} aria-hidden="true" />
          <span className="pharos-label group-hover:text-foreground">{label}</span>
        </span>
        <span className="flex items-baseline gap-1.5 pharos-numeric text-muted-foreground">
          {value != null ? (
            <>
              <span className="text-foreground">{formatCurrency(value, 1)}</span>
              <span aria-hidden="true">·</span>
              <span>{share != null ? `${share.toFixed(1)}%` : "—"}</span>
            </>
          ) : (
            <span title="Supply unavailable">—</span>
          )}
        </span>
      </Link>
    </li>
  );
}
