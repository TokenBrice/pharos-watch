"use client";

import { ReceiptText } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  buildFlowPressureReceiptModel,
  type FlowPressureReceiptRow,
} from "@/lib/flow-pressure-receipt-model";
import { formatCurrency, formatSignedCurrency, getNetColor } from "@shared/lib/format";
import type {
  MintBurnCoinFlow,
  MintBurnGauge,
  MintBurnHourlyBucket,
} from "@shared/types";

interface FlowReceiptBandProps {
  gauge: MintBurnGauge | null;
  coins: MintBurnCoinFlow[];
  weeklyHourly?: MintBurnHourlyBucket[];
  scopeLabel: string;
  syncWarning: string | null;
  className?: string;
  variant?: "default" | "compact";
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

function valueClass(row: FlowPressureReceiptRow): string {
  return row.tone === "net" && row.valueUsd !== null ? getNetColor(row.valueUsd) : toneClass(row.tone);
}

function statusLabel(status: string): string {
  return status.replace("-", " ");
}

const RECEIPT_ROW_STYLES: Record<"default" | "compact", { container: string; label: string }> = {
  default: {
    container: "rounded-lg border border-border/60 bg-background/50 p-3",
    label: "text-[11px] font-semibold uppercase tracking-wide text-muted-foreground",
  },
  compact: {
    container: "rounded-lg border border-border/60 bg-background/45 px-3 py-2.5",
    label: "text-[10px] font-semibold uppercase tracking-wide text-muted-foreground",
  },
};

function ReceiptRow({
  row,
  variant,
}: {
  row: FlowPressureReceiptRow;
  variant: "default" | "compact";
}) {
  const styles = RECEIPT_ROW_STYLES[variant];
  return (
    <div className={styles.container}>
      <div className="flex items-center justify-between gap-3">
        <span className={styles.label}>{row.label}</span>
        <span className={cn("pharos-numeric text-sm font-semibold", valueClass(row))}>
          {formatReceiptCurrency(row)}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{row.detail}</p>
    </div>
  );
}

export function FlowReceiptBand({
  gauge,
  coins,
  weeklyHourly,
  scopeLabel,
  syncWarning,
  className,
  variant = "default",
}: FlowReceiptBandProps) {
  const model = buildFlowPressureReceiptModel({
    gauge,
    coins,
    weeklyHourly,
    scopeLabel,
    syncWarning,
  });
  const isCompact = variant === "compact";
  const receiptRowVariant = isCompact ? "compact" : "default";
  const receiptRows = model.rows.map((row) => (
    <ReceiptRow key={row.id} row={row} variant={receiptRowVariant} />
  ));

  if (isCompact) {
    return (
      <section className={cn("grid gap-2 sm:grid-cols-2 lg:grid-cols-3", className)} aria-label="Flow receipt">
        {receiptRows}
      </section>
    );
  }

  return (
    <section
      className={cn("space-y-3", className)}
      aria-labelledby="flow-receipt-band-heading"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="pharos-kicker">Flow receipt</p>
          <h3
            id="flow-receipt-band-heading"
            className="flex items-center gap-2 text-base font-semibold"
          >
            <ReceiptText className="h-4 w-4 text-sky-700 dark:text-sky-300" aria-hidden />
            Printer and shredder accounting
          </h3>
        </div>
        <div className="rounded-full border border-border/70 bg-muted/30 px-3 py-1 text-xs text-muted-foreground">
          {model.trackedCoins} tracked {model.trackedCoins === 1 ? "coin" : "coins"}
        </div>
      </header>

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{receiptRows}</div>

      <div className="border-t border-border/60 pt-3">
        <div className="flex flex-wrap items-start gap-x-6 gap-y-2 text-sm">
          <div className="min-w-[12rem]">
            <p className="pharos-kicker">Scope</p>
            <p className="mt-0.5 text-sm font-medium">{model.scopeLabel}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Observed configured-chain events, not market-wide supply creation or redemption.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="text-muted-foreground text-xs">Top minter</span>
            <span className="pharos-numeric text-sm font-semibold text-emerald-700 dark:text-emerald-300">
              {model.topMint
                ? `${model.topMint.symbol} ${formatSignedCurrency(model.topMint.valueUsd)}`
                : "None"}
            </span>
            <span className="text-muted-foreground text-xs">Top burner</span>
            <span className="pharos-numeric text-sm font-semibold text-red-700 dark:text-red-300">
              {model.topBurn
                ? `${model.topBurn.symbol} ${formatSignedCurrency(model.topBurn.valueUsd)}`
                : "None"}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-muted-foreground text-xs">Coverage</span>
            <span className="text-xs font-medium">{model.coverageSummary}</span>
            {model.coverageRows.map((row) => (
              <span
                key={row.status}
                className="rounded-full border border-border/70 bg-muted/25 px-2 py-0.5 text-[11px] capitalize text-muted-foreground"
              >
                {statusLabel(row.status)} {row.count}
              </span>
            ))}
          </div>
        </div>

        {model.syncWarning ? (
          <p className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
            {model.syncWarning}
          </p>
        ) : null}
      </div>
    </section>
  );
}
