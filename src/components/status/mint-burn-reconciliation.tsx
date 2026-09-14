"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@shared/lib/format";
import type { MintBurnReconciliationSummary, StatusSectionError } from "@shared/types";
import { cn } from "@/lib/utils";
import { StatusCardEmptyState, STATUS_PANEL_SHELL_CLASS } from "@/components/status/page-primitives";

const COLLAPSED_ROW_COUNT = 6;
type IntegrityStatus = "Verified" | "Critical" | "Unverified";
type ReconciliationRow = MintBurnReconciliationSummary["rows"][number];

function integrityStatus(row: ReconciliationRow, version?: number): IntegrityStatus {
  if (version !== 1 || !row.conservation?.length) return "Unverified";
  if (row.status === "critical" && row.conservation.some((record) => record.status === "mismatch")) return "Critical";
  if (row.status === "ok" && row.conservation.every((record) => record.status === "ok")) return "Verified";
  return "Unverified";
}

function auditPriority(row: ReconciliationRow, version?: number): number {
  const status = integrityStatus(row, version);
  if (status === "Critical") return 0;
  if (status === "Verified") return 2;
  if (version === 1 && row.conservation?.length && row.conservation.every((record) => record.status === "unsupported")) return 3;
  return 1;
}

function auditDate(timestamp: number): string | undefined {
  const date = new Date(timestamp * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function statusTone(status: IntegrityStatus): string {
  if (status === "Critical") return "text-red-700 dark:text-red-300";
  if (status === "Verified") return "text-emerald-700 dark:text-emerald-300";
  return "text-muted-foreground";
}

function statusTileTone(status: IntegrityStatus): string {
  if (status === "Critical") return "border-red-500/25 bg-red-500/[0.045]";
  if (status === "Verified") return "border-emerald-500/20 bg-emerald-500/[0.04]";
  return "border-border/60 bg-background/35";
}

// Keep base-unit precision: a one-wei residual must never round to zero.
function formatRawTokens(raw: string | undefined, decimals: number): string {
  if (raw == null || !/^-?\d+$/.test(raw) || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) return "—";
  const negative = raw.startsWith("-");
  const digits = raw.replace(/^-/, "").replace(/^0+(?=\d)/, "").padStart(decimals + 1, "0");
  const whole = BigInt(decimals ? digits.slice(0, -decimals) : digits).toLocaleString("en-US");
  const fraction = decimals ? digits.slice(-decimals).replace(/0+$/, "") : "";
  return `${negative && /[1-9]/.test(digits) ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export function MintBurnReconciliationCard({ summary, error }: {
  summary: MintBurnReconciliationSummary | null;
  error?: StatusSectionError;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  if (!summary) {
    return (
      <StatusCardEmptyState title="Mint/Burn Integrity">
        {error ? `Mint/burn integrity loader failed: ${error.message}` : "No supply-conservation audit available yet."}
      </StatusCardEmptyState>
    );
  }

  const rows = [...summary.rows].sort((a, b) => auditPriority(a, summary.conservationVersion) - auditPriority(b, summary.conservationVersion));
  const canCollapse = rows.length > COLLAPSED_ROW_COUNT;
  const visibleRows = canCollapse && !isExpanded ? rows.slice(0, COLLAPSED_ROW_COUNT) : rows;
  const hiddenCount = rows.length - visibleRows.length;
  const counts = { Verified: 0, Critical: 0, Unverified: 0 };
  for (const row of rows) counts[integrityStatus(row, summary.conservationVersion)]++;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle as="h3" className="text-base">Mint/Burn Integrity</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-3">
          {(["Verified", "Critical", "Unverified"] as const).map((status) => (
            <div key={status} className={cn("rounded-lg border p-3", statusTileTone(status))}>
              <div className="text-xs text-muted-foreground">{status} assets</div>
              <div className={cn("pharos-numeric text-xl font-semibold", statusTone(status))}>{counts[status]}</div>
            </div>
          ))}
        </div>

        <div className={cn("flex flex-wrap items-start justify-between gap-3 rounded-[1rem] px-4 py-3", STATUS_PANEL_SHELL_CLASS)}>
          <div className="space-y-1 text-xs text-muted-foreground">
            <p>Compares all mint/burn events with on-chain total-supply changes over matched blocks in the latest audited scan ranges.</p>
            <p>Each contract has its own range. This is not a 24-hour audit. Critical means a verified conservation mismatch; missing, stale or unsupported audits remain unverified.</p>
            {summary.conservationVersion !== 1 ? <p>This payload has no matched-block audit. Legacy circulating-supply comparisons cannot establish integrity.</p> : null}
            <p>Showing {visibleRows.length} of {rows.length} assets, with critical and actionable unverified audits first; wholly unsupported assets last.</p>
          </div>
          {canCollapse ? (
            <Button type="button" variant="outline" size="sm" className="min-h-11 min-w-[9rem]" aria-expanded={isExpanded}
              onClick={() => setIsExpanded((current) => !current)}>
              {isExpanded ? "Show fewer" : `See all ${rows.length} assets`}
            </Button>
          ) : null}
        </div>

        <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
          {visibleRows.map((row) => {
            const status = integrityStatus(row, summary.conservationVersion);
            const records = summary.conservationVersion === 1 ? row.conservation : undefined;
            return (
              <div key={row.stablecoinId} role="group" aria-label={`${row.symbol} mint/burn integrity`} className={cn("min-w-0 rounded-[1rem] border p-4", statusTileTone(status))}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-foreground">{row.symbol}</span>
                  <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em]", statusTone(status))}>{status}</span>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">Audit coverage: {status === "Verified" ? "All configured contracts verified" : "See contract audit status below"}</p>
                {!records?.length ? <p className="mt-3 text-xs text-muted-foreground">No matched-block audit available.</p> : records.map((record) => {
                  const checkedAt = auditDate(record.checkedAt);
                  return (
                    <div key={record.key} className="mt-3 space-y-2 border-t border-border/50 pt-3 text-xs">
                      <div className="flex flex-wrap justify-between gap-2">
                        <span className="font-medium">{record.chainId}</span>
                        <span>{record.status === "ok" ? "Matched" : record.status === "mismatch" ? "Mismatch" : record.status === "unsupported" ? "Unsupported" : "Unavailable"}</span>
                      </div>
                      <p className="break-all font-mono text-muted-foreground">{record.address}</p>
                      <p className="text-muted-foreground">Supply checkpoints {record.fromBlock == null || record.toBlock == null ? "unavailable" : `${record.fromBlock.toLocaleString("en-US")}–${record.toBlock.toLocaleString("en-US")}`}</p>
                      <p className="text-muted-foreground">Checked {checkedAt ? <time dateTime={checkedAt}>{checkedAt.replace("T", " ").replace(".000Z", " UTC")}</time> : "date unavailable"}</p>
                      {record.reason ? <p className="text-muted-foreground">{record.reason}</p> : null}
                      <dl className="grid grid-cols-2 gap-3">
                        {([
                          ["Minted", record.mintRaw], ["Burned", record.burnRaw],
                          ["Supply change", record.supplyDeltaRaw], ["Residual", record.residualRaw],
                        ] as const).map(([label, raw]) => (
                          <div key={label} className="min-w-0">
                            <dt className="text-muted-foreground">{label} ({row.symbol})</dt>
                            <dd className="pharos-numeric break-all">{formatRawTokens(raw, record.decimals)}</dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  );
                })}
                <details className="mt-4 border-t border-border/50 pt-3 text-xs text-muted-foreground">
                  <summary className="cursor-pointer rounded-sm py-2 font-medium focus-visible:outline-2 focus-visible:outline-offset-2">Indicative circulating-supply comparison</summary>
                  <div className="space-y-3 pt-2">
                    <p>Timing, filters and valuation are unverified. Classified 24h flows exclude bridge, review, atomic and below-threshold events; upstream circulating supply may use a different window or supply definition. These gaps are not integrity verdicts.</p>
                    {row.comparisonIssue ? <p>{row.comparisonIssue}</p> : null}
                    <p>Source coverage: {row.coverageStatus}</p>
                    <dl className="grid grid-cols-2 gap-3">
                      {([
                        ["Classified flow net 24h", formatCurrency(row.flowNet24hUsd)],
                        ["Upstream daily supply delta", row.chainSupplyDelta24hUsd == null ? "—" : formatCurrency(row.chainSupplyDelta24hUsd)],
                        ["Indicative gap", row.absoluteDiffUsd == null ? "—" : formatCurrency(row.absoluteDiffUsd)],
                        ["Difference ratio", row.diffRatio == null ? "—" : `${(row.diffRatio * 100).toFixed(1)}%`],
                      ] as const).map(([label, value]) => <div key={label}><dt>{label}</dt><dd className="mt-1 pharos-numeric text-foreground">{value}</dd></div>)}
                    </dl>
                  </div>
                </details>
              </div>
            );
          })}
        </div>
        {!isExpanded && hiddenCount > 0 ? <p className="text-xs text-muted-foreground">{hiddenCount} lower-priority rows are collapsed behind the disclosure button.</p> : null}
      </CardContent>
    </Card>
  );
}
