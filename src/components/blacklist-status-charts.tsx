"use client";

import { useMemo } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useReportCards } from "@/hooks/api-hooks";
import { formatCurrency } from "@shared/lib/format";
import { ACTIVE_STABLECOINS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { getCirculatingRaw } from "@shared/lib/supply";
import { isBlacklistable } from "@shared/lib/report-cards";
import { buildReportCardMap } from "@/lib/stablecoin-lookups";
import { PharosChartTooltip, TooltipLabel, TooltipRow } from "@/components/pharos-chart-tooltip";

type BlacklistStatus = "yes" | "possible" | "upstream" | "no";

interface StatusBucket {
  status: string;
  key: BlacklistStatus;
  count: number;
  marketCap: number;
}

const STATUS_ORDER: readonly BlacklistStatus[] = ["yes", "possible", "upstream", "no"];

const STATUS_COLORS: Record<BlacklistStatus, string> = {
  yes: "#ef4444",       // red-500
  possible: "#f59e0b",  // amber-500
  upstream: "#f97316",  // orange-500
  no: "#22c55e",        // green-500
};

const STATUS_LABELS: Record<BlacklistStatus, string> = {
  yes: "Yes",
  possible: "Possible",
  upstream: "Upstream",
  no: "No",
};

function resolveStatus(value: boolean | "possible" | "inherited"): BlacklistStatus {
  if (value === true) return "yes";
  if (value === "possible") return "possible";
  if (value === "inherited") return "upstream";
  return "no";
}

const CHART_HEIGHT = "h-[200px] sm:h-[240px]";

function StatusBarChart({
  title,
  subtitle,
  data,
  dataKey,
  formatter,
  ariaLabel,
}: {
  title: string;
  subtitle: string;
  data: StatusBucket[];
  dataKey: "count" | "marketCap";
  formatter: (value: number) => string;
  ariaLabel: string;
}) {
  const { ref, ready, width, height } = useChartContainerReady<HTMLDivElement>();

  return (
    <Card className="rounded-xl animate-in fade-in duration-300">
      <CardHeader>
        <div className="space-y-1">
          <CardTitle as="h2" className="pharos-kicker">{title}</CardTitle>
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        </div>
      </CardHeader>
      <CardContent>
        <div className="mb-3 flex flex-wrap gap-2">
          {STATUS_ORDER.map((key) => (
            <div key={key} className="pharos-chart-legend-chip">
              <span
                className="inline-block h-2.5 w-2.5 rounded-sm"
                style={{ backgroundColor: STATUS_COLORS[key] }}
              />
              {STATUS_LABELS[key]}
            </div>
          ))}
        </div>
        <div ref={ref} className={CHART_HEIGHT} role="figure" aria-label={ariaLabel}>
          {ready ? (
            <BarChart
              width={width}
              height={height}
              data={data}
              margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
            >
              <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis
                dataKey="status"
                tick={{
                  fontSize: 11,
                  fontFamily: "var(--font-mono, monospace)",
                  fill: "var(--color-muted-foreground)",
                }}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                tick={{
                  fontSize: 11,
                  fontFamily: "var(--font-mono, monospace)",
                  fill: "var(--color-muted-foreground)",
                }}
                tickLine={false}
                axisLine={false}
                tickFormatter={formatter}
                width={dataKey === "marketCap" ? 62 : 36}
              />
              <Tooltip
                content={<StatusTooltip dataKey={dataKey} formatter={formatter} />}
                cursor={{ fill: "currentColor", opacity: 0.05 }}
              />
              <Bar dataKey={dataKey} radius={[3, 3, 0, 0]} fillOpacity={0.75}>
                {data.map((entry) => (
                  <Cell key={entry.key} fill={STATUS_COLORS[entry.key]} />
                ))}
              </Bar>
            </BarChart>
          ) : (
            <Skeleton className="h-full w-full" />
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function StatusTooltip({
  active,
  payload,
  label,
  dataKey,
  formatter,
}: {
  active?: boolean;
  payload?: Array<{ payload: StatusBucket }>;
  label?: string;
  dataKey: "count" | "marketCap";
  formatter: (value: number) => string;
}) {
  if (!active || !payload?.[0]) return null;
  const bucket = payload[0].payload;

  return (
    <PharosChartTooltip active={active}>
      <TooltipLabel>{label}</TooltipLabel>
      <TooltipRow
        color={STATUS_COLORS[bucket.key]}
        label={dataKey === "count" ? "Stablecoins" : "Market cap"}
        value={formatter(bucket[dataKey])}
      />
      {dataKey === "marketCap" && (
        <TooltipRow label="Count" value={String(bucket.count)} />
      )}
    </PharosChartTooltip>
  );
}

export function BlacklistStatusCharts() {
  const { data: stablecoinData, isLoading: supplyLoading } = useStablecoins();
  const { data: reportCardsData, isLoading: rcLoading } = useReportCards();
  const isLoading = supplyLoading || rcLoading;

  const buckets = useMemo(() => {
    if (!stablecoinData) return null;

    const reportCards = buildReportCardMap(reportCardsData?.cards);
    const supplyById = new Map(
      stablecoinData.peggedAssets.map((a) => [a.id, getCirculatingRaw(a)]),
    );

    const counts: Record<BlacklistStatus, { count: number; marketCap: number }> = {
      yes: { count: 0, marketCap: 0 },
      possible: { count: 0, marketCap: 0 },
      upstream: { count: 0, marketCap: 0 },
      no: { count: 0, marketCap: 0 },
    };

    for (const coin of ACTIVE_STABLECOINS) {
      const meta = TRACKED_META_BY_ID.get(coin.id);
      if (!meta) continue;
      const resolved = reportCards?.[coin.id]?.rawInputs.canBeBlacklisted ?? isBlacklistable(meta);
      const status = resolveStatus(resolved);
      counts[status].count += 1;
      counts[status].marketCap += supplyById.get(coin.id) ?? 0;
    }

    return STATUS_ORDER.map(
      (key): StatusBucket => ({
        status: STATUS_LABELS[key],
        key,
        count: counts[key].count,
        marketCap: counts[key].marketCap,
      }),
    );
  }, [stablecoinData, reportCardsData]);

  if (isLoading || !buckets) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-5">
        {[0, 1].map((i) => (
          <Card key={i} className="rounded-xl">
            <CardHeader><Skeleton className="h-6 w-48" /></CardHeader>
            <CardContent><Skeleton className={`${CHART_HEIGHT} w-full`} /></CardContent>
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-5">
      <StatusBarChart
        title="Blacklistable Status by Count"
        subtitle="Distribution of tracked stablecoins by blacklist capability"
        data={buckets}
        dataKey="count"
        formatter={(v) => String(v)}
        ariaLabel="Bar chart showing stablecoin count by blacklistable status"
      />
      <StatusBarChart
        title="Blacklistable Status by Market Cap"
        subtitle="Circulating supply split by blacklist capability"
        data={buckets}
        dataKey="marketCap"
        formatter={(v) => formatCurrency(v, 0)}
        ariaLabel="Bar chart showing market capitalization by blacklistable status"
      />
    </div>
  );
}
