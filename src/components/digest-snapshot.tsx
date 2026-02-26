"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { useDigestSnapshot } from "@/hooks/use-digest-snapshot";
import { formatCurrency, formatAddress, formatPercentChange } from "@/lib/format";
import { PSI_BAND_CLASSES } from "@/lib/psi-colors";

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
                {" "}({inputData.totalMcapUsd - prev.totalMcapUsd >= 0 ? "+" : ""}
                {formatCurrency(inputData.totalMcapUsd - prev.totalMcapUsd)} from yesterday)
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
                ({formatPercentChange(
                  inputData.totalMcapUsd,
                  inputData.totalMcapUsd - inputData.mcap7dDelta
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
              {prev?.stabilityIndex && (
                <span className="text-muted-foreground">
                  {prev.stabilityIndex.score.toFixed(1)} &rarr;{" "}
                </span>
              )}
              <span className="font-medium">
                {inputData.stabilityIndex.score.toFixed(1)}
              </span>
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

        {/* 5. Blacklist Activity — spans full width since it's a list */}
        {blacklistEvents.length > 0 && (
          <div className="sm:col-span-2">
            <SnapshotCard title="Blacklist Activity">
              <p className="text-sm text-foreground/90">
                <span className="font-medium">{blacklistEvents.length}</span>{" "}
                event{blacklistEvents.length !== 1 ? "s" : ""} on this day
                {(() => {
                  const total = blacklistEvents.reduce((sum, e) => sum + (e.amount ?? 0), 0);
                  return total > 0 ? (
                    <span className="text-muted-foreground"> totaling {formatCurrency(total)}</span>
                  ) : null;
                })()}
              </p>
              <ul className="space-y-0.5">
                {blacklistEvents.slice(0, 5).map((e) => (
                  <li key={`${e.timestamp}-${e.address}`} className="text-xs text-muted-foreground">
                    {e.stablecoin} on {e.chainName} &mdash; {e.eventType}
                    {e.amount != null && (
                      <span> ({formatCurrency(e.amount)})</span>
                    )}
                    <span className="ml-1">{formatAddress(e.address)}</span>
                  </li>
                ))}
              </ul>
              {blacklistEvents.length > 5 && (
                <p className="text-xs text-muted-foreground mt-1">
                  and {blacklistEvents.length - 5} more
                </p>
              )}
            </SnapshotCard>
          </div>
        )}
      </div>
    </section>
  );
}
