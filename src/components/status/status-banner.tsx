const STATUS_CONFIG = {
  healthy: {
    label: "Healthy",
    bg: "bg-green-500/15",
    text: "text-green-700 dark:text-green-400",
    border: "border-green-500/30",
  },
  degraded: {
    label: "Degraded",
    bg: "bg-amber-500/15",
    text: "text-amber-700 dark:text-amber-400",
    border: "border-amber-500/30",
  },
  stale: {
    label: "Stale",
    bg: "bg-red-500/15",
    text: "text-red-700 dark:text-red-400",
    border: "border-red-500/30",
  },
} as const;

interface StatusBannerProps {
  status: "healthy" | "degraded" | "stale";
  timestamp: number;
  availabilityStatus: "healthy" | "degraded" | "stale";
  dataQualityStatus: "healthy" | "degraded" | "stale";
  rawStatus: "healthy" | "degraded" | "stale";
  confidence: number;
}

export function StatusBanner({
  status,
  timestamp,
  availabilityStatus,
  dataQualityStatus,
  rawStatus,
  confidence,
}: StatusBannerProps) {
  const config = STATUS_CONFIG[status];
  const time = new Date(timestamp * 1000).toLocaleString();

  return (
    <div className={`rounded-lg border p-4 ${config.bg} ${config.border}`}>
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div
            className={`h-3 w-3 rounded-full ${status === "healthy" ? "bg-green-500" : status === "degraded" ? "bg-amber-500" : "bg-red-500"}`}
          />
          <span className={`text-lg font-semibold ${config.text}`}>{config.label}</span>
          <span className="text-xs text-muted-foreground">
            raw: {rawStatus} • confidence: {(confidence * 100).toFixed(1)}% • availability: {availabilityStatus} •
            data quality: {dataQualityStatus}
          </span>
        </div>
        <span className="text-sm text-muted-foreground">Checked: {time}</span>
      </div>
    </div>
  );
}
