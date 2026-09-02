import type { LucideIcon } from "lucide-react";
import { RefreshCw } from "lucide-react";

interface QueryNoticeSurfaceProps {
  layout: "detailed" | "compact";
  role: "status" | "alert";
  icon: LucideIcon;
  toneClassName: string;
  body: string;
  title?: string;
  detail?: string | null;
  iconBgClassName?: string;
  compact?: boolean;
  retryLabel?: string;
  onRetry?: () => void;
}

export function QueryNoticeSurface({
  layout,
  role,
  icon: Icon,
  toneClassName,
  body,
  title,
  detail,
  iconBgClassName,
  compact = false,
  retryLabel = "Retry",
  onRetry,
}: QueryNoticeSurfaceProps) {
  if (layout === "detailed") {
    return (
      <div
        role={role}
        aria-live="polite"
        className={`rounded-lg border px-4 py-3 shadow-sm ${toneClassName}`}
      >
        <div className="flex items-start gap-3">
          <div className={`shrink-0 rounded-full ${iconBgClassName} p-1.5`}>
            <Icon className="h-4 w-4" aria-hidden="true" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">{title}</p>
            <p className="mt-1 text-sm opacity-90">{body}</p>
            {detail ? <p className="mt-1 text-xs opacity-80">{detail}</p> : null}
            {onRetry && (
              <button type="button"
                onClick={onRetry}
                className="pharos-focus-ring mt-2.5 inline-flex items-center gap-1.5 rounded-md border border-current/20 px-2.5 py-1 text-xs font-medium transition-colors hover:bg-white/10 dark:hover:bg-black/10"
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                {retryLabel}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      role={role}
      aria-live="polite"
      className={`flex items-start gap-2 rounded-md ${toneClassName} ${
        compact ? "px-2.5 py-2 text-xs" : "px-3 py-2.5 text-sm"
      }`}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">{body}</span>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="pharos-focus-ring inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1 rounded-sm px-2 font-medium hover:text-foreground"
          aria-label={retryLabel}
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          <span className={compact ? "sr-only" : undefined}>Retry</span>
        </button>
      ) : null}
    </div>
  );
}
