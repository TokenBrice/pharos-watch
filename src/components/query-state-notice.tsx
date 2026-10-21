"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";
import { NOTICE_TONE_COLORS } from "@shared/lib/classification";
import type { QueryViewState } from "@/lib/query-view-state";

interface QueryStateNoticeProps {
  state: Extract<QueryViewState, "unavailable" | "stale-with-data">;
  label: string;
  onRetry?: () => void;
  compact?: boolean;
}

export function QueryStateNotice({
  state,
  label,
  onRetry,
  compact = false,
}: QueryStateNoticeProps): React.JSX.Element | null {
  // A failed refresh over retained data is operator signal (Telegram, /status), not a reader notice.
  if (state === "stale-with-data") return null;
  const message = `${label} is temporarily unavailable. No status claim is being made.`;
  const tone = NOTICE_TONE_COLORS.unavailable;

  return (
    <div
      role="alert"
      aria-live="polite"
      className={`flex items-start gap-2 rounded-md ${tone.tone} ${
        compact ? "px-2.5 py-2 text-xs" : "px-3 py-2.5 text-sm"
      }`}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">{message}</span>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="pharos-focus-ring inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1 rounded-sm px-2 font-medium hover:text-foreground"
          aria-label={`Retry ${label.toLowerCase()}`}
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          <span className={compact ? "sr-only" : undefined}>Retry</span>
        </button>
      ) : null}
    </div>
  );
}
