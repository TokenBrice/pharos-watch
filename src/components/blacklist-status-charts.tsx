"use client";

import { BarChart, Bar, Tooltip, Cell } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import { formatCurrency } from "@shared/lib/format";
import { PharosChartTooltip, TooltipLabel, TooltipRow } from "@/components/pharos-chart-tooltip";
import { CategoricalXAxis, ChartGrid, MonoYAxis } from "@/components/chart-primitives";
import {
  BLACKLIST_STATUS_BUCKET_COLORS,
  BLACKLIST_STATUS_BUCKET_LABELS,
  BLACKLIST_STATUS_BUCKET_ORDER,
  type BlacklistStatusBucket,
  type BlacklistStatusBucketKey,
} from "@/lib/blacklist-status-buckets";

const CHART_HEIGHT = "h-[200px] sm:h-[240px]";

function StatusBarChart({
  title,
  subtitle,
  data,
  dataKey,
  formatter,
  ariaLabel,
  selectedStatus,
  onStatusSelect,
}: {
  title: string;
  subtitle: string;
  data: BlacklistStatusBucket[];
  dataKey: "count" | "marketCap";
  formatter: (value: number) => string;
  ariaLabel: string;
  selectedStatus?: BlacklistStatusBucketKey | null;
  onStatusSelect?: (status: BlacklistStatusBucketKey) => void;
}) {
  const { ref, ready, width, height } = useChartContainerReady<HTMLDivElement>();

  return (
    <Card className="rounded-xl animate-in fade-in duration-300">
      <CardHeader>
        <div className="space-y-1">
          <CardTitle as="h2" className="pharos-kicker">{title}</CardTitle>
          <p className="text-sm text-muted-foreground">{subtitle}</p>
          {onStatusSelect ? (
            <p className="text-xs text-muted-foreground">Click a bar to view matching stablecoins below.</p>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>
        <div className="mb-3 flex flex-wrap gap-2">
          {BLACKLIST_STATUS_BUCKET_ORDER.map((key) => (
            <div key={key} className="pharos-chart-legend-chip">
              <span
                className="inline-block h-2.5 w-2.5 rounded-sm"
                style={{ backgroundColor: BLACKLIST_STATUS_BUCKET_COLORS[key] }}
              />
              {BLACKLIST_STATUS_BUCKET_LABELS[key]}
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
              <ChartGrid strokeDasharray="3 3" />
              <CategoricalXAxis
                dataKey="status"
                tick={{
                  fontSize: 11,
                  fontFamily: "var(--font-mono, monospace)",
                  fill: "var(--color-muted-foreground)",
                }}
              />
              <MonoYAxis
                tick={{
                  fontSize: 11,
                  fontFamily: "var(--font-mono, monospace)",
                  fill: "var(--color-muted-foreground)",
                }}
                tickFormatter={formatter}
                width={dataKey === "marketCap" ? 62 : 36}
              />
              <Tooltip
                content={<StatusTooltip dataKey={dataKey} formatter={formatter} />}
                cursor={{ fill: "currentColor", opacity: 0.05 }}
              />
              <Bar dataKey={dataKey} radius={[3, 3, 0, 0]} fillOpacity={0.75}>
                {data.map((entry) => (
                  <Cell
                    key={entry.key}
                    fill={BLACKLIST_STATUS_BUCKET_COLORS[entry.key]}
                    fillOpacity={selectedStatus && selectedStatus !== entry.key ? 0.45 : 0.82}
                    stroke={selectedStatus === entry.key ? "var(--color-foreground)" : undefined}
                    strokeWidth={selectedStatus === entry.key ? 1.25 : 0}
                    cursor={onStatusSelect ? "pointer" : undefined}
                    aria-label={onStatusSelect ? `Show ${entry.status} stablecoins` : undefined}
                    onClick={onStatusSelect ? () => onStatusSelect(entry.key) : undefined}
                  />
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
  payload?: Array<{ payload: BlacklistStatusBucket }>;
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
        color={BLACKLIST_STATUS_BUCKET_COLORS[bucket.key]}
        label={dataKey === "count" ? "Stablecoins" : "Market cap"}
        value={formatter(bucket[dataKey])}
      />
      {dataKey === "marketCap" && (
        <TooltipRow label="Count" value={String(bucket.count)} />
      )}
    </PharosChartTooltip>
  );
}

export function BlacklistStatusCharts({
  buckets,
  isLoading,
  selectedStatus = null,
  onStatusSelect,
}: {
  buckets: BlacklistStatusBucket[] | null;
  isLoading: boolean;
  selectedStatus?: BlacklistStatusBucketKey | null;
  onStatusSelect?: (status: BlacklistStatusBucketKey) => void;
}) {
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
        selectedStatus={selectedStatus}
        onStatusSelect={onStatusSelect}
      />
      <StatusBarChart
        title="Blacklistable Status by Market Cap"
        subtitle="Circulating supply split by blacklist capability"
        data={buckets}
        dataKey="marketCap"
        formatter={(v) => formatCurrency(v, 0)}
        ariaLabel="Bar chart showing market capitalization by blacklistable status"
        selectedStatus={selectedStatus}
        onStatusSelect={onStatusSelect}
      />
    </div>
  );
}
