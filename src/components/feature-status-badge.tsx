import { Badge } from "@/components/ui/badge";

type FeatureStatus = "mature" | "experimental" | "testing-in-prod";

const STATUS_CONFIG: Record<FeatureStatus, { label: string; className: string }> = {
  mature: {
    label: "Mature",
    className:
      "bg-emerald-500/15 text-emerald-700 border-emerald-500/30 dark:text-emerald-400 dark:border-emerald-500/40",
  },
  experimental: {
    label: "Experimental",
    className:
      "bg-amber-500/15 text-amber-700 border-amber-500/30 dark:text-amber-400 dark:border-amber-500/40",
  },
  "testing-in-prod": {
    label: "Testing in Prod",
    className:
      "bg-orange-500/15 text-orange-700 border-orange-500/30 dark:text-orange-400 dark:border-orange-500/40",
  },
};

interface FeatureStatusBadgeProps {
  status: FeatureStatus;
  version?: string;
}

export function FeatureStatusBadge({ status, version }: FeatureStatusBadgeProps) {
  const { label, className } = STATUS_CONFIG[status];
  return (
    <span className="inline-flex items-center gap-1.5 font-normal text-base">
      <Badge variant="outline" className={className}>
        {label}
      </Badge>
      {version && (
        <Badge
          variant="outline"
          className="bg-muted/50 text-muted-foreground border-border/60"
        >
          {version}
        </Badge>
      )}
    </span>
  );
}
