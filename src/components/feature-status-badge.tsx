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
    <span className="inline-flex items-center gap-1.5">
      <Badge variant="outline" className={cls}>
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
