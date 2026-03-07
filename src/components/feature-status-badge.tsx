import { Badge } from "@/components/ui/badge";
import { FEATURE_STATUS_CONFIG, type FeatureStatus } from "@shared/lib/classification";

export type { FeatureStatus };

interface FeatureStatusBadgeProps {
  status: FeatureStatus;
  version?: string;
}

export function FeatureStatusBadge({ status, version }: FeatureStatusBadgeProps) {
  const { label, cls } = FEATURE_STATUS_CONFIG[status];
  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-1.5 tracking-normal font-normal">
      <Badge variant="outline" className={`${cls} shrink-0`} aria-label={`Feature status: ${label}`}>
        {label}
      </Badge>
      {version && (
        <Badge
          variant="outline"
          className="w-fit basis-full border-border/60 bg-background/35 font-mono text-muted-foreground sm:basis-auto"
        >
          {version}
        </Badge>
      )}
    </span>
  );
}
