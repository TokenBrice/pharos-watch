"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { useDigestSnapshot } from "@/hooks/use-digest-snapshot";
import { formatCurrency, formatAddress } from "@/lib/format";
import { PSI_BAND_CLASSES } from "@/lib/psi-colors";

/* ---------- helpers ---------- */

function deltaArrow(current: number, previous: number | undefined): string {
  if (previous === undefined) return "";
  if (current > previous) return " \u2191";
  if (current < previous) return " \u2193";
  return "";
}

function formatPct(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

/* ---------- sub-section wrapper ---------- */

function SnapshotCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border/50 p-3 space-y-1.5">
      <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
        {title}
      </p>
      {children}
    </div>
  );
}

/* ---------- main component ---------- */

export function DigestSnapshot({ date }: { date: string }) {
  const { data, isLoading, isError } = useDigestSnapshot(date);

  if (isError) return null;

  if (isLoading) {
    return (
      <section className="mt-8 space-y-3">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          The data behind this digest
        </p>
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-2/3" />
      </section>
    );
  }

  if (!data?.inputData) return null;

  const { inputData, prevInputData, blacklistEvents } = data;
  const prev = prevInputData ?? undefined;

  return (
    <section className="mt-8 space-y-4 animate-in fade-in duration-300">
      <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
        The data behind this digest
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        {/* 1. Market Snapshot — always shown */}
        <SnapshotCard title="Market Snapshot">
          <p className="text-sm text-foreground/90">
            Total mcap:{" "}
            <span className="font-medium">
              {formatCurrency(inputData.totalMcapUsd)}
            </span>
            {prev && (
              <span className="text-muted-foreground">
                {deltaArrow(inputData.totalMcapUsd, prev.totalMcapUsd)}
              </span>
            )}
          </p>
          <p className="text-sm text-muted-foreground">
            7d change:{" "}
            <span className="font-medium">
              {formatCurrency(inputData.mcap7dDelta)}
            </span>
            {inputData.totalMcapUsd - inputData.mcap7dDelta !== 0 && (
              <span>
                {" "}
                ({formatPct(
                  (inputData.mcap7dDelta /
                    (inputData.totalMcapUsd - inputData.mcap7dDelta)) *
                    100
                )})
              </span>
            )}
          </p>
        </SnapshotCard>

        {/* 2. Stability Index */}
        {inputData.stabilityIndex && (
          <SnapshotCard title="Stability Index">
            <p className="text-sm text-foreground/90">
              Score:{" "}
              <span className="font-medium">
                {inputData.stabilityIndex.score.toFixed(1)}
              </span>
              {prev?.stabilityIndex && (
                <span className="text-muted-foreground">
                  {" "}
                  &rarr; from {prev.stabilityIndex.score.toFixed(1)}
                  {deltaArrow(
                    inputData.stabilityIndex.score,
                    prev.stabilityIndex.score
                  )}
                </span>
              )}
            </p>
            <p className="text-sm">
              Band:{" "}
              <span
                className={
                  PSI_BAND_CLASSES[inputData.stabilityIndex.band] ??
                  "text-muted-foreground"
                }
              >
                {inputData.stabilityIndex.band}
              </span>
            </p>
            <p className="text-xs text-muted-foreground">
              Severity {inputData.stabilityIndex.components.severity.toFixed(1)}
              {" / "}
              Breadth {inputData.stabilityIndex.components.breadth.toFixed(1)}
              {" / "}
              Trend {inputData.stabilityIndex.components.trend.toFixed(1)}
            </p>
          </SnapshotCard>
        )}

        {/* 3. Biggest Supply Mover */}
        {inputData.biggestSupplyChange && (
          <SnapshotCard title="Biggest Supply Mover">
            <p className="text-sm text-foreground/90">
              <span className="font-medium">
                {inputData.biggestSupplyChange.symbol}
              </span>{" "}
              <span className="text-muted-foreground">
                {inputData.biggestSupplyChange.name}
              </span>
            </p>
            <p className="text-sm text-foreground/90">
              7d change:{" "}
              <span className="font-medium">
                {inputData.biggestSupplyChange.changeUsd >= 0 ? "+" : ""}
                {formatCurrency(inputData.biggestSupplyChange.changeUsd)}
              </span>
            </p>
            <p className="text-xs text-muted-foreground">
              Current mcap:{" "}
              {formatCurrency(inputData.biggestSupplyChange.currentMcap)}
            </p>
          </SnapshotCard>
        )}

        {/* 4. Active Depegs */}
        {inputData.activeDepegCount > 0 && (
          <SnapshotCard title="Active Depegs">
            <p className="text-sm text-foreground/90">
              <span className="font-medium">{inputData.activeDepegCount}</span>{" "}
              active depeg{inputData.activeDepegCount !== 1 ? "s" : ""}
            </p>
            {inputData.topDepegs.length > 0 && (
              <ul className="space-y-0.5">
                {inputData.topDepegs.map((d) => (
                  <li
                    key={d.symbol}
                    className="text-xs text-muted-foreground"
                  >
                    {d.symbol}: {d.bps > 0 ? "+" : ""}
                    {d.bps} bps ({formatCurrency(d.mcapUsd)})
                  </li>
                ))}
              </ul>
            )}
          </SnapshotCard>
        )}

        {/* 5. Blacklist Activity */}
        {blacklistEvents.length > 0 && (
          <SnapshotCard title="Blacklist Activity">
            <p className="text-sm text-foreground/90">
              <span className="font-medium">{blacklistEvents.length}</span>{" "}
              event{blacklistEvents.length !== 1 ? "s" : ""}
            </p>
            <ul className="space-y-0.5">
              {blacklistEvents.map((e, i) => (
                <li key={i} className="text-xs text-muted-foreground">
                  {e.stablecoin} on {e.chainName} &mdash; {e.eventType}
                  {e.amount != null && (
                    <span> ({formatCurrency(e.amount)})</span>
                  )}
                  <span className="ml-1">{formatAddress(e.address)}</span>
                </li>
              ))}
            </ul>
          </SnapshotCard>
        )}
      </div>
    </section>
  );
}
