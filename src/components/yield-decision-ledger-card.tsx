import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import { cn } from "@/lib/utils";
import { buildYieldDecisionLedgerDisplay } from "@/lib/yield-decision-ledger";
import type { YieldPublicDecisionLedger } from "@shared/types";

export interface YieldDecisionLedgerCardProps {
  ledger: YieldPublicDecisionLedger | null | undefined;
  className?: string;
  variant?: "card" | "inline";
  showAlternatives?: boolean;
}

export function YieldDecisionLedgerCard({
  ledger,
  className,
  variant = "card",
  showAlternatives = true,
}: YieldDecisionLedgerCardProps) {
  const display = buildYieldDecisionLedgerDisplay(ledger);
  if (!display) return null;

  const isInline = variant === "inline";

  return (
    <section
      aria-label="Why this source won"
      className={cn(
        isInline ? "border-t border-border/50 pt-2" : "rounded-xl border border-border/60 bg-muted/15 px-3 py-3",
        className,
      )}
    >
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Why this source won</p>
      <p className="mt-1 text-xs text-foreground">{display.reasonLabel}</p>

      {display.sourceSwitchLabel || display.rejectedCountLabel || display.previousSourceKey ? (
        <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] text-muted-foreground">
          {display.sourceSwitchLabel ? (
            <span className={cn("rounded-full border px-2 py-0.5", SEVERITY_TONE_CLASS.sky.pill)}>
              {display.sourceSwitchLabel}
            </span>
          ) : null}
          {display.rejectedCountLabel ? (
            <span className="rounded-full border border-border/50 bg-background/45 px-2 py-0.5">
              {display.rejectedCountLabel}
            </span>
          ) : null}
          {display.previousSourceKey ? (
            <span className="rounded-full border border-border/50 bg-background/45 px-2 py-0.5">
              Previous <span className="font-mono text-[10px]">{display.previousSourceKey}</span>
            </span>
          ) : null}
        </div>
      ) : null}

      {showAlternatives && display.alternatives.length > 0 ? (
        <ul className="mt-2 space-y-1 text-[11px] text-muted-foreground">
          {display.alternatives.map((alternative) => (
            <li key={alternative.sourceKey} className="min-w-0">
              <span className="text-foreground">{alternative.yieldSource}</span>
              {": "}
              <span>{alternative.rejectionLabel}</span>
              <span className="ml-1 font-mono tabular-nums">{alternative.apy30dDeltaLabel}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
