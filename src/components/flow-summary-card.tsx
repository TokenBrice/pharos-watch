"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useMintBurnFlows } from "@/hooks/use-mint-burn-flows";
import { formatCurrency } from "@/lib/format";
import { GAUGE_BANDS } from "@/components/flow-gauge";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getNetColor(value: number): string {
  if (value > 0) return "text-emerald-500";
  if (value < 0) return "text-red-500";
  return "text-muted-foreground";
}

function getNetPrefix(value: number): string {
  return value > 0 ? "+" : "";
}

function getBandForScore(score: number): string {
  if (score < 15) return "CRISIS";
  if (score < 30) return "STRESS";
  if (score < 45) return "CAUTIOUS";
  if (score < 55) return "NEUTRAL";
  if (score < 70) return "HEALTHY";
  if (score < 85) return "CONFIDENT";
  return "SURGE";
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface FlowSummaryCardProps {
  stablecoinId: string;
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function SummarySkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h3" className="text-sm">
          <Skeleton className="h-4 w-28" />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3">
          <Skeleton className="h-3 flex-1 rounded-full" />
          <Skeleton className="h-5 w-10" />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function FlowSummaryCard({ stablecoinId }: FlowSummaryCardProps) {
  // Use aggregate endpoint (no stablecoin param) — per-coin endpoint returns a
  // different response shape without the `coins` array.
  const { data, isLoading } = useMintBurnFlows();

  if (isLoading) return <SummarySkeleton />;

  // Return nothing if there's no data for this coin
  if (!data?.coins) return null;

  const coin = data.coins.find((c) => c.stablecoinId === stablecoinId);
  if (!coin) return null;

  const intensity = coin.flowIntensity;
  const bandKey = intensity != null ? getBandForScore(intensity) : null;
  const bandConfig = bandKey ? GAUGE_BANDS[bandKey] : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h3" className="text-sm">
          Mint &amp; Burn Flows
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Flow Intensity bar */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Flow Intensity</span>
            {intensity != null && bandConfig ? (
              <span className={bandConfig.textClass}>{bandConfig.label}</span>
            ) : (
              <span>&mdash;</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <div className="h-2 flex-1 rounded-full bg-muted overflow-hidden">
              {intensity != null && bandConfig && (
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{
                    width: `${Math.min(100, intensity)}%`,
                    backgroundColor: bandConfig.hex,
                  }}
                />
              )}
            </div>
            <span className="font-mono tabular-nums text-sm font-semibold w-8 text-right">
              {intensity != null ? intensity : "\u2014"}
            </span>
          </div>
        </div>

        {/* Net flows */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-0.5">
            <p className="text-xs text-muted-foreground">Net 24h</p>
            <p className={`font-mono tabular-nums text-sm font-semibold ${getNetColor(coin.netFlow24hUsd)}`}>
              {getNetPrefix(coin.netFlow24hUsd)}{formatCurrency(coin.netFlow24hUsd)}
            </p>
          </div>
          <div className="space-y-0.5">
            <p className="text-xs text-muted-foreground">Net 7d</p>
            <p className={`font-mono tabular-nums text-sm font-semibold ${getNetColor(coin.netFlow7dUsd)}`}>
              {getNetPrefix(coin.netFlow7dUsd)}{formatCurrency(coin.netFlow7dUsd)}
            </p>
          </div>
        </div>

        {/* Mint / Burn volume breakdown */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-0.5">
            <p className="text-xs text-muted-foreground">Minted 24h</p>
            <p className="font-mono tabular-nums text-sm text-emerald-500">
              {formatCurrency(coin.mintVolume24hUsd)}
            </p>
          </div>
          <div className="space-y-0.5">
            <p className="text-xs text-muted-foreground">Burned 24h</p>
            <p className="font-mono tabular-nums text-sm text-red-500">
              {formatCurrency(coin.burnVolume24hUsd)}
            </p>
          </div>
        </div>

        {/* Link to flows page */}
        <Link
          href="/flows"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          View all flows
          <ArrowRight className="h-3 w-3" />
        </Link>
      </CardContent>
    </Card>
  );
}
