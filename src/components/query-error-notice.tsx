"use client";

import { AlertCircle, RefreshCw, WifiOff, Database } from "lucide-react";
import { ApiFetchError } from "@/lib/api";

interface QueryErrorNoticeProps {
  error: unknown | null | undefined;
  hasData?: boolean;
  onRetry?: () => void;
}

function getErrorDetail(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const message = error.message.trim();
  if (!message) return null;
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(message)) return null;
  if (/^http \d+/i.test(message)) return null;
  return message.length <= 140 ? message : null;
}

export function QueryErrorNotice({ error, hasData = false, onRetry }: QueryErrorNoticeProps) {
  if (!error) return null;

  const isUnavailable = error instanceof ApiFetchError && error.status === 503;
  const isNetworkFetchError =
    error instanceof TypeError &&
    /failed to fetch|networkerror|load failed|network request failed/i.test(error.message);

  const config = {
    stale: {
      icon: Database,
      title: "Refresh delayed",
      message: "Showing the last successful snapshot while live refresh retries.",
      detail: "The rest of this view should remain usable while the dataset catches up.",
      tone: "border-amber-500/30 bg-amber-500/8 text-amber-700 dark:text-amber-400",
      iconBg: "bg-amber-500/15",
    },
    unavailable: {
      icon: Database,
      title: "Waiting for first sync",
      message: "This dataset has not populated yet.",
      detail: "Structural parts of the route may still render while the first successful snapshot is pending.",
      tone: "border-border/60 bg-muted/40 text-muted-foreground",
      iconBg: "bg-muted",
    },
    network: {
      icon: WifiOff,
      title: "Connection issue",
      message: "Unable to reach the Pharos data API right now.",
      detail: "Retry when your connection stabilizes.",
      tone: "border-orange-500/30 bg-orange-500/8 text-orange-700 dark:text-orange-400",
      iconBg: "bg-orange-500/15",
    },
    error: {
      icon: AlertCircle,
      title: "Failed to load this dataset",
      message: "The dataset could not be loaded right now.",
      detail: getErrorDetail(error),
      tone: "border-red-500/30 bg-red-500/8 text-red-700 dark:text-red-400",
      iconBg: "bg-red-500/15",
    },
  };

  const type = hasData ? "stale" : isUnavailable ? "unavailable" : isNetworkFetchError ? "network" : "error";
  const { icon: Icon, title, message, detail, tone, iconBg } = config[type];

  return (
    <div 
      role="status" 
      aria-live="polite" 
      className={`rounded-lg border px-4 py-3 shadow-sm ${tone}`}
    >
      <div className="flex items-start gap-3">
        <div className={`shrink-0 rounded-full ${iconBg} p-1.5`}>
          <Icon className="h-4 w-4" aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">{title}</p>
          <p className="mt-1 text-sm opacity-90">{message}</p>
          {detail ? <p className="mt-1 text-xs opacity-80">{detail}</p> : null}
          {onRetry && (
            <button
              onClick={onRetry}
              className="pharos-focus-ring mt-2.5 inline-flex items-center gap-1.5 rounded-md border border-current/20 px-2.5 py-1 text-xs font-medium transition-colors hover:bg-white/10 dark:hover:bg-black/10"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              Retry
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
