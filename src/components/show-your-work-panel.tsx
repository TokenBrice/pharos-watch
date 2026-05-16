"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useShowWorkMode } from "@/hooks/use-show-work-mode";
import { FeedbackModal } from "@/components/feedback-modal";
import { METHODOLOGY_CONTEXT } from "@/lib/methodology-context";
import {
  formatChainHealth,
  formatDews,
  formatLiquidity,
  formatPsi,
  formatRedemption,
  formatReportCard,
  type ShowYourWorkTable,
} from "@/lib/show-your-work-formatters";
import type { RawDimensionInputs } from "@shared/types";
import type { DexLiquidityData, StressSignalEntry } from "@shared/types/market";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";
import type { StabilityIndexCurrent } from "@shared/types/stability";
import type { ChainHealthFactors } from "@shared/types/chains";

export type ShowYourWorkPanelProps =
  | {
      kind: "report-card";
      rawInputs: RawDimensionInputs;
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
      chainName?: string;
    };

function buildTable(props: ShowYourWorkPanelProps): ShowYourWorkTable {
  switch (props.kind) {
    case "report-card":
      return formatReportCard(props.rawInputs);
    case "dews":
      return formatDews(props.current);
    case "liquidity":
      return formatLiquidity(props.scoreComponents);
    case "psi":
      return formatPsi(props.current);
    case "redemption":
      return formatRedemption(props.entry);
    case "chain-health":
      return formatChainHealth(props.factors);
  }
}

function getContextLabels(
  props: ShowYourWorkPanelProps,
): { stablecoinId?: string; stablecoinName?: string } {
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
      >
        <span className="flex items-center gap-2">
          <span className="pharos-kicker text-sky-700 dark:text-sky-400">
            Show Your Work · {item.title}
          </span>
          {item.versionLabel ? (
            <span className="font-mono text-[10px] text-muted-foreground">
              {item.versionLabel}
            </span>
          ) : null}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn("h-4 w-4 text-muted-foreground transition-transform", open && "rotate-180")}
        />
      </button>

      {open ? (
        <div className="mt-2 space-y-2">
          <p className="font-mono text-[11px] text-muted-foreground">{table.formula}</p>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-border/40 text-left text-muted-foreground">
                  <th className="py-1 pr-2 font-normal">Input</th>
                  <th className="py-1 pr-2 text-right font-normal">Value</th>
                  {hasWeights ? (
                    <th className="py-1 pr-2 text-right font-normal">Weight</th>
                  ) : null}
                  {hasContribution ? (
                    <th className="py-1 text-right font-normal">Contribution</th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row) => (
                  <tr key={row.label} className="border-b border-border/20 last:border-b-0">
                    <td className="py-1 pr-2 text-foreground/80">{row.label}</td>
                    <td className="py-1 pr-2 text-right font-mono tabular-nums">{row.value}</td>
                    {hasWeights ? (
                      <td className="py-1 pr-2 text-right font-mono tabular-nums text-muted-foreground">
                        {row.weight ?? ""}
                      </td>
                    ) : null}
                    {hasContribution ? (
                      <td className="py-1 text-right font-mono tabular-nums">
                        {row.contribution ?? ""}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

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
