"use client";

import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useShowWorkMode } from "@/hooks/use-show-work-mode";
import { FeedbackModal } from "@/components/feedback-modal";
import { TableBody, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/table";
import { METHODOLOGY_CONTEXT } from "@/lib/methodology-context";
import {
  formatChainHealth,
  formatDews,
  formatLiquidity,
  formatPsi,
  formatRedemption,
  formatReportCard,
  formatReportCardV9,
  type ShowYourWorkTable,
} from "@/lib/show-your-work-formatters";
import type { RawDimensionInputs, SafetyScoreV9CurrentCard } from "@shared/types";
import type { DexLiquidityData, StressSignalEntry } from "@shared/types/market";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";
import type { StabilityIndexCurrent } from "@shared/types/stability";
import type { ChainEnvironmentEvidence, ChainHealthFactors } from "@shared/types/chains";

export type ShowYourWorkPanelProps =
  | {
      kind: "report-card";
      rawInputs: RawDimensionInputs;
      stablecoinId?: string;
      stablecoinName?: string;
    }
  | {
      kind: "report-card-v9";
      card: SafetyScoreV9CurrentCard;
      methodologyVersion: string;
      stablecoinId?: string;
      stablecoinName?: string;
    }
  | {
      kind: "dews";
      current: StressSignalEntry;
      stablecoinId?: string;
      stablecoinName?: string;
    }
  | {
      kind: "liquidity";
      scoreComponents: NonNullable<DexLiquidityData["scoreComponents"]>;
      stablecoinId?: string;
      stablecoinName?: string;
    }
  | {
      kind: "psi";
      current: StabilityIndexCurrent;
    }
  | {
      kind: "redemption";
      entry: RedemptionBackstopEntry;
      stablecoinId?: string;
      stablecoinName?: string;
    }
  | {
      kind: "chain-health";
      factors: ChainHealthFactors;
      chainEnvironmentEvidence?: ChainEnvironmentEvidence;
      chainName?: string;
    };

function buildTable(props: ShowYourWorkPanelProps): ShowYourWorkTable {
  switch (props.kind) {
    case "report-card":
      return formatReportCard(props.rawInputs);
    case "report-card-v9":
      return formatReportCardV9(props.card, props.methodologyVersion);
    case "dews":
      return formatDews(props.current);
    case "liquidity":
      return formatLiquidity(props.scoreComponents);
    case "psi":
      return formatPsi(props.current);
    case "redemption":
      return formatRedemption(props.entry);
    case "chain-health":
      return formatChainHealth(props.factors, props.chainEnvironmentEvidence);
  }
}

function getContextLabels(props: ShowYourWorkPanelProps): { stablecoinId?: string; stablecoinName?: string } {
  if (props.kind === "psi") return {};
  if (props.kind === "chain-health") {
    return { stablecoinName: props.chainName };
  }
  return {
    stablecoinId: props.stablecoinId,
    stablecoinName: props.stablecoinName,
  };
}

/**
 * Surfaces the visible inputs that feed a score plus a one-line formula.
 * Gated on `useShowWorkMode().enabled` — returns null when off.
 */
export function ShowYourWorkPanel(props: ShowYourWorkPanelProps) {
  const { enabled } = useShowWorkMode();
  const [open, setOpen] = useState(true);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const panelId = useId();

  if (!enabled) return null;

  const table = buildTable(props);
  const item = METHODOLOGY_CONTEXT[table.topic];
  const hasWeights = table.rows.some((r) => r.weight != null);
  const hasContribution = table.rows.some((r) => r.contribution != null);
  const labels = getContextLabels(props);

  return (
    <div className="rounded-lg border border-dashed border-sky-500/40 bg-sky-500/5 px-3 py-3 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="pharos-focus-ring flex w-full items-center justify-between gap-2 rounded-sm text-left"
        aria-expanded={open}
        aria-controls={panelId}
      >
        <span className="flex items-center gap-2">
          <span className="pharos-kicker text-sky-700 dark:text-sky-400">Inputs · {item.title}</span>
          {table.versionLabel ?? item.versionLabel ? (
            <span className="font-mono text-[10px] text-muted-foreground">
              {table.versionLabel ?? item.versionLabel}
            </span>
          ) : null}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn("h-4 w-4 text-muted-foreground transition-transform", open && "rotate-180")}
        />
      </button>

      {open ? (
        <div id={panelId} className="mt-2 space-y-2">
          <p className="font-mono text-[11px] text-muted-foreground">{table.formula}</p>

          <TableFrame
            tableId={`show-your-work-${table.topic}`}
            testId={`show-your-work-${table.topic}-table`}
            chrome="bare"
            density="compact"
            tableClassName="border-collapse text-xs"
            tableProps={{ "aria-label": `${item.title} inputs` }}
            viewportProps={{ mobileScrollHint: false, compactBottomPadding: false }}
          >
            <TableHeader>
              <TableRow className="border-b border-border/40 text-left text-muted-foreground hover:bg-transparent">
                <TableHead scope="col" className="h-auto px-0 py-1 pr-2 font-normal">
                  Input
                </TableHead>
                <TableHead scope="col" className="h-auto px-0 py-1 pr-2 text-right font-normal">
                  Value
                </TableHead>
                {hasWeights ? (
                  <TableHead scope="col" className="h-auto px-0 py-1 pr-2 text-right font-normal">
                    Weight
                  </TableHead>
                ) : null}
                {hasContribution ? (
                  <TableHead scope="col" className="h-auto px-0 py-1 text-right font-normal">
                    Contribution
                  </TableHead>
                ) : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {table.rows.map((row) => (
                <TableRow key={row.label} className="border-b border-border/20 last:border-b-0 hover:bg-transparent">
                  <TableCell className="px-0 py-1 pr-2 text-foreground/80">{row.label}</TableCell>
                  <TableCell className="px-0 py-1 pr-2 text-right font-mono tabular-nums">{row.value}</TableCell>
                  {hasWeights ? (
                    <TableCell className="px-0 py-1 pr-2 text-right font-mono tabular-nums text-muted-foreground">
                      {row.weight ?? ""}
                    </TableCell>
                  ) : null}
                  {hasContribution ? (
                    <TableCell className="px-0 py-1 text-right font-mono tabular-nums">
                      {row.contribution ?? ""}
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </TableFrame>

          <button
            type="button"
            onClick={() => setFeedbackOpen(true)}
            className="pharos-focus-ring rounded-sm text-[11px] text-muted-foreground underline decoration-dashed underline-offset-2 transition-colors hover:text-foreground"
          >
            Discrepancy? Report it
          </button>

          <FeedbackModal
            open={feedbackOpen}
            onOpenChange={setFeedbackOpen}
            defaultType="data-correction"
            stablecoinId={labels.stablecoinId}
            stablecoinName={labels.stablecoinName}
          />
        </div>
      ) : null}
    </div>
  );
}
