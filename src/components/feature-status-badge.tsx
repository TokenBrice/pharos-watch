import { Badge } from "@/components/ui/badge";
import { FEATURE_STATUS_CONFIG, type FeatureStatus } from "@/lib/classification";

export type { FeatureStatus };

interface FeatureStatusBadgeProps {
  status: FeatureStatus;
  version?: string;
}

export function FeatureStatusBadge({ status, version }: FeatureStatusBadgeProps) {
  const { label, cls } = FEATURE_STATUS_CONFIG[status];
  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-1.5 tracking-normal font-normal">
      <Badge variant="outline" className={`${cls} shrink-0`}>
        {label}
      </Badge>
      {version && (
        <Badge
          variant="outline"
          className="w-fit basis-full bg-muted/50 text-muted-foreground border-border/60 sm:basis-auto"
        >
          {version}
        </Badge>
      )}
    </span>
  );
}
