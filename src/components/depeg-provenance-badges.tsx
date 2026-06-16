import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface DepegProvenanceBadgesProps {
  pendingReason: string | null;
  confirmationSources: string | null;
  source?: "live" | "backfill";
  reasonLeadingClass?: string;
}

const BADGE_CLASS =
  "rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground";

const REASON_LABELS: Record<string, string> = {
  "large-cap": "large cap",
  "low-confidence": "price needs verification",
  "extreme-move": "extreme move",
};

const SOURCE_LABELS: Record<string, string> = {
  "cex:binance": "Binance",
  "coingecko-confirm": "CoinGecko",
  "defillama-confirm": "DefiLlama",
  "dex:curve": "Curve DEX",
  "dex:uniswap": "Uniswap DEX",
  "dex:aerodrome": "Aerodrome DEX",
  "dex:velodrome": "Velodrome DEX",
  "dex:balancer": "Balancer DEX",
  "pool:curve:geckoterminal": "Curve pool",
};

function labelReason(reason: string): string {
  return reason
    .split("+")
    .map((part) => REASON_LABELS[part] ?? part.replaceAll("-", " "))
    .join(", ");
}

function labelConfirmationSource(source: string): string {
  if (SOURCE_LABELS[source]) return SOURCE_LABELS[source];
  if (source.startsWith("native:")) return `native ${source.slice("native:".length).toUpperCase()} quote`;
  if (source.startsWith("dex:")) return `${source.slice("dex:".length)} DEX`;
  if (source.startsWith("pool:")) {
    const [, protocol] = source.split(":");
    return protocol ? `${protocol} pool` : "DEX pool";
  }
  return source.replaceAll("-", " ").replaceAll("_", " ");
}

function labelConfirmationSources(sources: string): string {
  const parts = sources.includes("+") ? sources.split("+") : sources.split(",");
  return parts.map((part) => labelConfirmationSource(part.trim())).filter(Boolean).join(", ");
}

export function DepegProvenanceBadges({
  pendingReason,
  confirmationSources,
  source,
  reasonLeadingClass = "",
}: DepegProvenanceBadgesProps) {
  if (!pendingReason && !confirmationSources && !source) return null;
  const sourceTooltip = source === "live"
    ? "Detected by the live depeg pipeline."
    : "Inserted by historical backfill.";
  return (
    <TooltipProvider delayDuration={220}>
      {source ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              data-testid="event-source"
              className={cn(reasonLeadingClass, BADGE_CLASS, "cursor-help")}
              aria-label={sourceTooltip}
            >
              {source}
            </span>
          </TooltipTrigger>
          <TooltipContent className="text-[11px]">{sourceTooltip}</TooltipContent>
        </Tooltip>
      ) : null}
      {pendingReason ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              data-testid="event-pending-reason"
              className={cn(source ? "ml-1" : reasonLeadingClass, BADGE_CLASS, "cursor-help")}
              aria-label="Reason this incident used the pending-confirmation path."
            >
              {labelReason(pendingReason)}
            </span>
          </TooltipTrigger>
          <TooltipContent className="text-[11px]">
            Reason this incident used the pending-confirmation path.
          </TooltipContent>
        </Tooltip>
      ) : null}
      {confirmationSources ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              data-testid="event-confirmed-by"
              className={cn(pendingReason || source ? "ml-1" : reasonLeadingClass, BADGE_CLASS, "cursor-help")}
              aria-label="Sources that corroborated the pending incident."
            >
              confirmed: {labelConfirmationSources(confirmationSources)}
            </span>
          </TooltipTrigger>
          <TooltipContent className="text-[11px]">
            Sources that corroborated the pending incident.
          </TooltipContent>
        </Tooltip>
      ) : null}
    </TooltipProvider>
  );
}
