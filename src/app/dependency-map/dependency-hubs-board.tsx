"use client";

import Link from "next/link";
import {
  TableBody,
  TableCaption,
  TableCell,
  TableFrame,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/table";
import { Card, CardContent } from "@/components/ui/card";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { formatCurrency } from "@shared/lib/format";
import type { DependencyHub, DependencyHubsModel } from "@/lib/dependency-hubs-model";

function DependencyMetric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-md border border-border/70 bg-background/55 p-3">
      <p className="pharos-kicker">{label}</p>
      <p className="mt-1 pharos-numeric text-lg font-bold text-foreground">{value}</p>
      <p className="text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

function formatEdgeType(value: string): string {
  const label = value.replaceAll("-", " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
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
  const weightPct =
    maxWeight > 0 ? Math.max(4, Math.min(100, (hub.summedDirectDependencyWeight / maxWeight) * 100)) : 4;

  return (
    <TableRow className="border-t border-b-0 border-border/60 transition-colors hover:bg-muted/20">
      <TableCell className="px-3 py-3 align-top">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 font-mono text-[11px] text-muted-foreground">
            {String(index + 1).padStart(2, "0")}
          </span>
          <StablecoinLogo src={logos?.[hub.id]} name={hub.label} size={30} />
          <div className="min-w-0">
            <Link
              href={buildStablecoinUrl(hub.id)}
              className="pharos-focus-ring truncate rounded-sm text-sm font-semibold text-foreground hover:text-frost-blue"
            >
              {hub.label}
            </Link>
            <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">{hub.symbol}</p>
          </div>
        </div>
      </TableCell>
      <TableCell className="px-3 py-3 align-top whitespace-normal">
        <div className="flex flex-wrap gap-1.5" aria-label="Edge type breakdown">
          {hub.edgeTypeBreakdown.map((entry) => (
            <span
              key={entry.type}
              className="inline-flex items-center gap-1.5 rounded-sm border border-border/60 bg-background/70 px-2 py-1 text-[11px] text-muted-foreground"
            >
              <span>{formatEdgeType(entry.type)}</span>
              <span className="pharos-numeric text-foreground">
                {entry.edgeCount} / {entry.summedDirectDependencyWeight.toFixed(2)}
              </span>
            </span>
          ))}
        </div>
      </TableCell>
      <TableCell className="px-3 py-3 align-top pharos-numeric text-sm font-semibold text-foreground">
        {hub.dependentCount}
      </TableCell>
      <TableCell className="px-3 py-3 align-top">
        <p className="pharos-numeric text-sm font-semibold text-foreground">
          {hub.summedDirectDependencyWeight.toFixed(2)}
        </p>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted/45" aria-hidden="true">
          <div className="h-full rounded-full bg-frost-blue" style={{ width: `${weightPct}%` }} />
        </div>
      </TableCell>
      <TableCell className="px-3 py-3 align-top">
        <p className="pharos-numeric text-sm font-semibold text-foreground">
          {formatCurrency(hub.uniqueDependentMcapUsd, 1)}
        </p>
        <p className="text-[11px] text-muted-foreground">Hub own market cap {formatCurrency(hub.hubMcapUsd, 1)}</p>
      </TableCell>
      <TableCell className="max-w-xs whitespace-normal px-3 py-3 align-top text-xs leading-relaxed text-muted-foreground">
        {hub.examples.length > 0 ? (
          <>
            Example direct dependents:{" "}
            <span className="font-medium text-foreground">
              {hub.examples.map((example) => example.symbol).join(", ")}
            </span>
          </>
        ) : (
          "No direct dependent examples in the displayed hub model."
        )}
      </TableCell>
      <TableCell className="px-3 py-3 align-top">
        <Link
          href={buildStablecoinUrl(hub.id)}
          className="pharos-focus-ring rounded-sm font-mono text-[11px] uppercase tracking-[0.14em] text-frost-blue hover:text-foreground"
          aria-label={`Trace ${hub.label} dependency hub`}
        >
          Trace
        </Link>
      </TableCell>
    </TableRow>
  );
}

export function DependencyHubsBoard({ model, logos }: { model: DependencyHubsModel; logos?: Record<string, string> }) {
  const hubs = model.hubs.slice(0, 6);
  if (hubs.length === 0) return null;

  const maxWeight = Math.max(...hubs.map((hub) => hub.summedDirectDependencyWeight), 0);

  return (
    <Card className="hidden overflow-hidden rounded-xl border-border/70 shadow-none md:block">
      <CardContent className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-1">
            <p className="pharos-kicker">
              Shared Dependency Infrastructure · Systemic Hubs
            </p>
            <h2 className="text-lg font-semibold tracking-tight">Direct dependency hubs</h2>
            <p className="max-w-3xl text-sm text-muted-foreground">
              Ranked by unique direct dependents, summed direct dependency weight, and modeled dependent market-cap
              context from the current report-card edge set.
            </p>
          </div>
          <p className="rounded-md border border-border/70 bg-background/55 px-3 py-2 text-xs leading-relaxed text-muted-foreground lg:max-w-xs">
            Modeled dependent market-cap context dedupes direct dependent IDs; summed direct dependency weight is
            dimensionless.
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
            value={model.summedDirectDependencyWeight.toFixed(2)}
            detail={`${model.directEdgeCount} live direct edges`}
          />
          <DependencyMetric
            label="Modeled dependent market-cap context"
            value={formatCurrency(model.uniqueDependentMcapUsd, 1)}
            detail="deduped across direct dependents"
          />
        </div>

        <TableFrame
          tableId="dependency-hubs-board"
          testId="dependency-hubs-board-table"
          density="compact"
          chrome="embedded"
          className="rounded-md border-border/70 bg-background/35"
          tableClassName="min-w-[64rem] text-left"
          viewportProps={{ mobileScrollHint: false }}
        >
          <TableCaption className="sr-only">Direct dependency hubs</TableCaption>
          <TableHeader>
            <TableRow className="border-b border-border/70 text-[10px] uppercase tracking-[0.16em] text-muted-foreground hover:bg-transparent">
              <TableHead scope="col" className="px-3 py-2 font-medium">
                Dependency
              </TableHead>
              <TableHead scope="col" className="px-3 py-2 font-medium">
                Kind
              </TableHead>
              <TableHead scope="col" className="px-3 py-2 font-medium">
                Direct dependents
              </TableHead>
              <TableHead scope="col" className="px-3 py-2 font-medium">
                Summed direct dependency weight
              </TableHead>
              <TableHead scope="col" className="px-3 py-2 font-medium">
                Modeled dependent market-cap context
              </TableHead>
              <TableHead scope="col" className="px-3 py-2 font-medium">
                Role / description
              </TableHead>
              <TableHead scope="col" className="px-3 py-2 font-medium">
                Action
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {hubs.map((hub, index) => (
              <DependencyHubRow key={hub.id} hub={hub} index={index} maxWeight={maxWeight} logos={logos} />
            ))}
          </TableBody>
        </TableFrame>
      </CardContent>
    </Card>
  );
}
