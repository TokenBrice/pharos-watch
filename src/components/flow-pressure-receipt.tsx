"use client";

import { ReceiptText } from "lucide-react";
import { cn } from "@/lib/utils";
import { buildFlowPressureReceiptModel, type FlowPressureReceiptRow } from "@/lib/flow-pressure-receipt-model";
import { formatCurrency, formatSignedCurrency } from "@shared/lib/format";
import type { MintBurnCoinFlow, MintBurnGauge, MintBurnHourlyBucket } from "@shared/types";

interface FlowPressureReceiptProps {
  gauge: MintBurnGauge | null;
  coins: MintBurnCoinFlow[];
  weeklyHourly?: MintBurnHourlyBucket[];
  scopeLabel: string;
  syncWarning: string | null;
}

function formatReceiptCurrency(row: FlowPressureReceiptRow): string {
  if (row.valueUsd === null) return "NR";
  return row.tone === "net" ? formatSignedCurrency(row.valueUsd) : formatCurrency(row.valueUsd);
}

function toneClass(tone: FlowPressureReceiptRow["tone"]): string {
  if (tone === "mint") return "text-emerald-700 dark:text-emerald-300";
  if (tone === "burn") return "text-red-700 dark:text-red-300";
  return "text-foreground";
}

function statusLabel(status: string): string {
  return status.replace("-", " ");
}

export function FlowPressureReceipt({
  gauge,
  coins,
  weeklyHourly,
  scopeLabel,
  syncWarning,
}: FlowPressureReceiptProps) {
  const model = buildFlowPressureReceiptModel({
    gauge,
    coins,
    weeklyHourly,
    scopeLabel,
    syncWarning,
  });

  return (
    <article className="relative -mt-2 overflow-hidden rounded-xl border border-dashed border-border/80 bg-card/85 shadow-sm" aria-labelledby="flow-pressure-receipt-heading">
      <div
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-1"
        style={{
          background:
            "linear-gradient(90deg, oklch(0.66 0.15 155), oklch(0.68 0.17 32), oklch(0.58 0.11 240))",
        }}
      />
      <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="pharos-kicker">Flow receipt</p>
              <h3 id="flow-pressure-receipt-heading" className="flex items-center gap-2 text-base font-semibold">
                <ReceiptText className="h-4 w-4 text-sky-700 dark:text-sky-300" aria-hidden />
                Printer and shredder accounting
              </h3>
            </div>
            <div className="rounded-full border border-border/70 bg-muted/30 px-3 py-1 text-xs text-muted-foreground">
              {model.trackedCoins} tracked {model.trackedCoins === 1 ? "coin" : "coins"}
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {model.rows.map((row) => (
              <div key={row.id} className="rounded-lg border border-border/60 bg-background/50 p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {row.label}
                  </span>
                  <span className={cn("font-mono text-sm font-semibold tabular-nums", toneClass(row.tone))}>
                    {formatReceiptCurrency(row)}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{row.detail}</p>
              </div>
            ))}
          </div>
        </div>

        <aside className="space-y-3 rounded-lg border border-border/60 bg-background/55 p-3">
          <div>
            <p className="pharos-kicker">Scope</p>
            <p className="mt-1 text-sm font-medium">{model.scopeLabel}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              These are observed configured-chain events, not market-wide supply creation or redemption.
            </p>
          </div>

          <div className="grid gap-2 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Top minter</span>
              <span className="font-mono font-semibold text-emerald-700 dark:text-emerald-300">
                {model.topMint ? `${model.topMint.symbol} ${formatSignedCurrency(model.topMint.valueUsd)}` : "None"}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Top burner</span>
              <span className="font-mono font-semibold text-red-700 dark:text-red-300">
                {model.topBurn ? `${model.topBurn.symbol} ${formatSignedCurrency(model.topBurn.valueUsd)}` : "None"}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Coverage state</span>
              <span className="text-right font-medium">{model.coverageSummary}</span>
            </div>
          </div>

          {model.coverageRows.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {model.coverageRows.map((row) => (
                <span key={row.status} className="rounded-full border border-border/70 bg-muted/25 px-2 py-0.5 text-[11px] capitalize text-muted-foreground">
                  {statusLabel(row.status)} {row.count}
                </span>
              ))}
            </div>
          ) : null}

          {model.syncWarning ? (
            <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
              {model.syncWarning}
            </p>
          ) : null}
        </aside>
      </div>
    </article>
  );
}
