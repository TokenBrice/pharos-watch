"use client";

import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { formatCurrency } from "@shared/lib/format";
import { TYPE_COLORS, TYPE_DASH } from "@/components/contagion-graph-model";
import type { DependencyHub, DependencyHubsModel } from "./dependency-hubs-model";
import type { DependencyType } from "@shared/types";

const EDGE_TYPE_LABELS: Record<DependencyType, string> = {
  collateral: "Collateral",
  mechanism: "Mechanism",
  wrapper: "Wrapper",
};

function formatWeight(value: number): string {
  return value.toFixed(2);
}

function DependencyMetric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-background/40 p-3">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-lg font-bold tabular-nums text-foreground">{value}</p>
      <p className="text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

function DependencyHubRow({
  hub,
  index,
  maxWeight,
  logos,
}: {
  hub: DependencyHub;
  index: number;
  maxWeight: number;
  logos?: Record<string, string>;
}) {
  const weightPct = maxWeight > 0
    ? Math.max(4, Math.min(100, (hub.summedDirectDependencyWeight / maxWeight) * 100))
    : 4;

  return (
    <Link
      href={`/stablecoin/${hub.id}`}
      className="pharos-focus-ring group block rounded-xl border border-border/60 bg-background/35 p-3 transition-colors hover:bg-muted/25"
      aria-label={`${hub.label} dependency hub`}
    >
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1.4fr)] lg:items-start">
        <div className="min-w-0 space-y-3">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 font-mono text-xs text-muted-foreground">
              {String(index + 1).padStart(2, "0")}
            </span>
            <StablecoinLogo src={logos?.[hub.id]} name={hub.label} size={34} />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-foreground group-hover:text-frost-blue">
                {hub.label}
              </p>
              <p className="text-xs text-muted-foreground">{hub.symbol}</p>
            </div>
          </div>

          {hub.examples.length > 0 && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              Example direct dependents:{" "}
              <span className="font-medium text-foreground">
                {hub.examples.map((example) => example.symbol).join(", ")}
              </span>
            </p>
          )}
        </div>

        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <div>
              <p className="text-[11px] text-muted-foreground">Direct dependents</p>
              <p className="font-mono text-sm font-semibold tabular-nums text-foreground">{hub.dependentCount}</p>
            </div>
            <div>
              <p className="text-[11px] text-muted-foreground">Summed direct dependency weight</p>
              <p className="font-mono text-sm font-semibold tabular-nums text-foreground">
                {formatWeight(hub.summedDirectDependencyWeight)}
              </p>
            </div>
            <div>
              <p className="text-[11px] text-muted-foreground">Modeled dependent market-cap context</p>
              <p className="font-mono text-sm font-semibold tabular-nums text-foreground">
                {formatCurrency(hub.uniqueDependentMcapUsd, 1)}
              </p>
            </div>
            <div>
              <p className="text-[11px] text-muted-foreground">Hub own market cap</p>
              <p className="font-mono text-sm font-semibold tabular-nums text-foreground">
                {formatCurrency(hub.hubMcapUsd, 1)}
              </p>
            </div>
          </div>

          <div className="h-2 overflow-hidden rounded-full bg-muted/45" aria-hidden="true">
            <div
              className="h-full rounded-full bg-frost-blue"
              style={{ width: `${weightPct}%` }}
            />
          </div>

          <div className="flex flex-wrap gap-2" aria-label="Edge type breakdown">
            {hub.edgeTypeBreakdown.map((entry) => (
              <span
                key={entry.type}
                className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-card/70 px-2.5 py-1 text-[11px] text-muted-foreground"
              >
                <svg width="18" height="6" aria-hidden="true" className="shrink-0">
                  <line
                    x1="0"
                    y1="3"
                    x2="18"
                    y2="3"
                    stroke={TYPE_COLORS[entry.type]}
                    strokeWidth={2}
                    strokeDasharray={TYPE_DASH[entry.type]}
                  />
                </svg>
                <span>{EDGE_TYPE_LABELS[entry.type]}</span>
                <span className="font-mono tabular-nums text-foreground">
                  {entry.edgeCount} / {formatWeight(entry.summedDirectDependencyWeight)}
                </span>
              </span>
            ))}
          </div>
        </div>
      </div>
    </Link>
  );
}

export function DependencyHubsBoard({
  model,
  logos,
}: {
  model: DependencyHubsModel;
  logos?: Record<string, string>;
}) {
  const hubs = model.hubs.slice(0, 6);
  if (hubs.length === 0) return null;

  const maxWeight = Math.max(...hubs.map((hub) => hub.summedDirectDependencyWeight), 0);

  return (
    <Card className="hidden overflow-hidden rounded-xl border-border/70 md:block">
      <CardContent className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-1">
            <p className="pharos-kicker">Upstream hubs</p>
            <h2 className="text-lg font-semibold tracking-tight">Direct dependency hubs</h2>
            <p className="max-w-3xl text-sm text-muted-foreground">
              Ranked by unique direct dependents, summed direct dependency weight, and modeled dependent market-cap context from the current report-card edge set.
            </p>
          </div>
          <p className="rounded-xl border border-border/60 bg-background/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground lg:max-w-xs">
            Modeled dependent market-cap context dedupes direct dependent IDs; summed direct dependency weight is dimensionless.
          </p>
        </div>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <DependencyMetric
            label="Upstream hubs"
            value={String(model.upstreamHubCount)}
            detail="live hubs with direct dependents"
          />
          <DependencyMetric
            label="Direct dependents"
            value={String(model.uniqueDirectDependentCount)}
            detail="unique dependent stablecoins"
          />
          <DependencyMetric
            label="Summed direct dependency weight"
            value={formatWeight(model.summedDirectDependencyWeight)}
            detail={`${model.directEdgeCount} live direct edges`}
          />
          <DependencyMetric
            label="Modeled dependent market-cap context"
            value={formatCurrency(model.uniqueDependentMcapUsd, 1)}
            detail="deduped across direct dependents"
          />
        </div>

        <div className="space-y-2">
          {hubs.map((hub, index) => (
            <DependencyHubRow
              key={hub.id}
              hub={hub}
              index={index}
              maxWeight={maxWeight}
              logos={logos}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
