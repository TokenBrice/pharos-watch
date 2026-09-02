"use client";

import { AlertCircle, RefreshCw, WifiOff, Database, type LucideIcon } from "lucide-react";
import { ApiFetchError } from "@/lib/api";
import { NOTICE_TONE_COLORS } from "@shared/lib/classification";

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

const NOTICE_ICONS: Record<"stale" | "unavailable" | "network" | "error", LucideIcon> = {
  stale: Database,
  unavailable: Database,
  network: WifiOff,
  error: AlertCircle,
};

export function QueryErrorNotice({ error, hasData = false, onRetry }: QueryErrorNoticeProps) {
  if (!error) return null;

  const isUnavailable = error instanceof ApiFetchError && error.status === 503;
  const isNetworkFetchError =
    error instanceof TypeError &&
    /failed to fetch|networkerror|load failed|network request failed/i.test(error.message);

  const type = hasData ? "stale" : isUnavailable ? "unavailable" : isNetworkFetchError ? "network" : "error";
  const Icon = NOTICE_ICONS[type];
  const { title, message, tone, iconBg } = NOTICE_TONE_COLORS[type];
  const detail = type === "error" ? getErrorDetail(error) : NOTICE_TONE_COLORS[type].detail;

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
            <button type="button"
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
