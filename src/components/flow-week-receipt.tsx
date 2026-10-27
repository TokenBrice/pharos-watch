"use client";

import { cn } from "@/lib/utils";
import { FLOW_RECEIPT_TONE_CLASSES } from "@shared/lib/classification";
import {
  buildFlowPressureReceiptModel,
  type FlowPressureReceiptRow,
} from "@/lib/flow-pressure-receipt-model";
import { formatCurrency, formatSignedCurrency, getNetColor } from "@shared/lib/format";
import { formatMintBurnVolume } from "@shared/lib/mint-burn-valuation-display";
import { FlowSignedNetValue } from "@/components/flow-valuation-value";
import type { MintBurnCoinFlow, MintBurnHourlyBucket } from "@shared/types";

interface FlowWeekReceiptProps {
  coins: MintBurnCoinFlow[];
  weeklyHourly?: MintBurnHourlyBucket[];
  scopeLabel: string;
  isLoading?: boolean;
}

/** Net rows: unavailable nets render NR with their reason, never $0. Volumes: NR without hourly data, `≥` when a lower bound. */
function ReceiptValue({ row }: { row: FlowPressureReceiptRow }) {
  const className = "pharos-numeric text-base font-semibold";
  if (row.tone === "net") {
    return (
      <FlowSignedNetValue
        net={{ valueUsd: row.valueUsd, completeness: row.completeness, note: row.note, bound: row.bound }}
        format={formatSignedCurrency}
        colorClassName={getNetColor}
        className={className}
        placeholder="NR"
      />
    );
  }
  if (row.valueUsd === null) return <span className={cn(className, "text-muted-foreground")}>NR</span>;
  return (
    <span className={cn(className, "text-foreground")} title={row.note ?? undefined}>
      {formatMintBurnVolume(row.valueUsd, row.completeness, formatCurrency, row.scanComplete)}
      {row.note ? <span className="sr-only"> ({row.note})</span> : null}
    </span>
  );
}

function statusLabel(status: string): string {
  const label = status.replace("-", " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * "7-day receipt" fold: printed, shredded and net tracked flow over the week,
 * the week's leaders, and the coverage behind them, on hairlines rather than
 * nested cards. Labels describe observed configured-chain events, never
 * market-wide issuance.
 */
export function FlowWeekReceipt({ coins, weeklyHourly, scopeLabel, isLoading }: FlowWeekReceiptProps) {
  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading the weekly receipt…</p>;
  }
  const model = buildFlowPressureReceiptModel({ coins, weeklyHourly, scopeLabel });
  const { topMint, topBurn } = model;
  const absentLeader = model.leadersUnavailable ? "Unavailable" : "None";

  return (
    <div className="space-y-4">
      <dl className="grid divide-y divide-border/50 border-y border-border/50 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        {model.rows.map((row) => (
          <div key={row.id} className="space-y-1 py-3 sm:px-4 sm:first:pl-0">
            <dt className="text-sm text-muted-foreground">{row.label}</dt>
            <dd>
              <ReceiptValue row={row} />
            </dd>
            <dd className="text-xs text-muted-foreground">
              {row.tone === "net" && row.valueUsd === null && row.note ? row.note : row.detail}
            </dd>
          </div>
        ))}
      </dl>

      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted-foreground">Top net minter, 7d</dt>
          <dd className={cn("pharos-numeric font-semibold", topMint ? FLOW_RECEIPT_TONE_CLASSES.mint : "text-muted-foreground")}>
            {topMint ? `${topMint.symbol} ${formatSignedCurrency(topMint.valueUsd)}` : absentLeader}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Top net burner, 7d</dt>
          <dd className={cn("pharos-numeric font-semibold", topBurn ? FLOW_RECEIPT_TONE_CLASSES.burn : "text-muted-foreground")}>
            {topBurn ? `${topBurn.symbol} ${formatSignedCurrency(topBurn.valueUsd)}` : absentLeader}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Coverage</dt>
          <dd className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium">{model.coverageSummary}</span>
            {model.coverageRows.map((row) => (
              <span
                key={row.status}
                className="rounded-full border border-border/70 px-2 py-0.5 text-2xs text-muted-foreground"
              >
                {statusLabel(row.status)} {row.count}
              </span>
            ))}
          </dd>
        </div>
      </dl>

      <p className="text-xs text-muted-foreground">
        Scope: {model.scopeLabel}. Observed configured-chain events, not market-wide supply creation or redemption.
      </p>
    </div>
  );
}
