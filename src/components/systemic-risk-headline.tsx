"use client";

import { Card, CardContent } from "@/components/ui/card";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { formatCurrency } from "@shared/lib/format";
import { Network } from "lucide-react";
import { cn } from "@/lib/utils";

interface SystemicRisk {
  coinId: string;
  name: string;
  symbol: string;
  affectedCount: number;
  supplyAtRisk: number;
}

interface SystemicRiskHeadlineProps {
  risks: SystemicRisk[];
  logos?: Record<string, string>;
  onOpenSimulator: () => void;
}

export function SystemicRiskHeadline({ risks, logos, onOpenSimulator }: SystemicRiskHeadlineProps) {
  const top3 = risks.slice(0, 3);
  if (top3.length === 0) return null;

  const totalAtRisk = top3.reduce((sum, r) => sum + r.supplyAtRisk, 0);

  return (
    <Card className="border-rose-500/15 bg-rose-500/[0.03]">
      <CardContent className="py-5">
        <div className="flex items-start gap-3 mb-4">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-rose-500/15">
            <Network className="h-4 w-4 text-rose-600 dark:text-rose-400" aria-hidden="true" />
          </div>
          <div>
            <p className="text-sm font-semibold text-rose-700 dark:text-rose-400">
              What happens if a major stablecoin fails?
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {formatCurrency(totalAtRisk)} in downstream supply depends on just {top3.length} coins.{" "}
              <button
                type="button"
                onClick={onOpenSimulator}
                className="pharos-focus-ring text-foreground underline underline-offset-4 hover:text-foreground/80 transition-colors"
              >
                Run a simulation&nbsp;&darr;
              </button>
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {top3.map((risk, i) => (
            <div
              key={risk.coinId}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm",
                i === 0 ? "bg-rose-500/10 border border-rose-500/20" : "bg-muted/30",
              )}
            >
              <span
                className={cn(
                  "flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold shrink-0",
                  i === 0 ? "bg-rose-500 text-white" : "bg-muted text-muted-foreground",
                )}
              >
                {i + 1}
              </span>
              <StablecoinLogo src={logos?.[risk.coinId]} name={risk.symbol} size={20} />
              <div className="min-w-0 flex-1">
                <span className="font-medium text-sm block truncate">{risk.symbol}</span>
                <span className="text-xs text-muted-foreground">
                  {risk.affectedCount} dependent{risk.affectedCount !== 1 ? "s" : ""}
                </span>
              </div>
              <span className="font-mono text-xs font-semibold text-muted-foreground">
                {formatCurrency(risk.supplyAtRisk)}
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
