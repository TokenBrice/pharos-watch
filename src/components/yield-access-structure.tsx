import { cn } from "@/lib/utils";
import type { YieldRanking } from "@shared/types";

type YieldSourceRisk = YieldRanking["sourceRisk"];

function formatEnum(value: string | null | undefined): string {
  if (!value) return "Unknown";
  return value.replaceAll("-", " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null) return "Unknown";
  if (seconds < 3_600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86_400) return `${(seconds / 3_600).toFixed(seconds % 3_600 === 0 ? 0 : 1)} hr`;
  return `${(seconds / 86_400).toFixed(seconds % 86_400 === 0 ? 0 : 1)} days`;
}

function AccessFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words text-xs text-foreground">{value}</dd>
    </div>
  );
}

export function YieldAccessStructure({
  sourceRisk,
  compact = false,
  className,
}: {
  sourceRisk: YieldSourceRisk;
  compact?: boolean;
  className?: string;
}) {
  const flags = sourceRisk?.investabilityFlags ?? [];
  const kyc =
    sourceRisk?.kycRequired === true ? "Required" : sourceRisk?.kycRequired === false ? "Not required" : "Unknown";
  const access =
    sourceRisk?.accessRestricted === true
      ? "Restricted"
      : sourceRisk?.accessRestricted === false
        ? "No restriction reported"
        : "Unknown";

  return (
    <section className={cn("border-t border-border/50 pt-3", className)} aria-label="Access and structure">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs font-semibold text-foreground">Access and structure</p>
        <p className="text-[10px] text-muted-foreground">Unknown means the source has not supplied the fact.</p>
      </div>
      <dl className={cn("mt-2 grid gap-x-3 gap-y-2", compact ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-3")}>
        <AccessFact label="Deployment" value={formatEnum(sourceRisk?.deploymentPlace)} />
        <AccessFact label="Venue" value={sourceRisk?.venueProtocol || "Unknown"} />
        <AccessFact label="Chain" value={sourceRisk?.venueChain || "Unknown"} />
        <AccessFact label="KYC" value={kyc} />
        <AccessFact label="Access" value={access} />
        <AccessFact label="Withdrawal delay" value={formatDuration(sourceRisk?.withdrawalDelaySeconds)} />
      </dl>
      <div className="mt-2 text-xs">
        <span className="text-muted-foreground">Investability flags: </span>
        <span className="text-foreground">{flags.length > 0 ? flags.join(", ") : "Unknown"}</span>
      </div>
    </section>
  );
}
