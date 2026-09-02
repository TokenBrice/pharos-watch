"use client";

import { AlertTriangle } from "lucide-react";
import { formatRelativeTimeMs } from "@shared/lib/relative-time";
import { NOTICE_TONE_COLORS } from "@shared/lib/classification";
import type { QueryViewState } from "@/lib/query-view-state";
import { QueryNoticeSurface } from "@/components/query-notice-surface";

interface QueryStateNoticeProps {
  state: Extract<QueryViewState, "unavailable" | "stale-with-data">;
  label: string;
  dataUpdatedAt?: number;
  onRetry?: () => void;
  compact?: boolean;
}

export function QueryStateNotice({
  state,
  label,
  dataUpdatedAt = 0,
  onRetry,
  compact = false,
}: QueryStateNoticeProps): React.JSX.Element {
  const isStale = state === "stale-with-data";
  const age = isStale && dataUpdatedAt > 0 ? formatRelativeTimeMs(dataUpdatedAt) : null;
  const message = isStale
    ? `${label} refresh failed; showing the last available data${age ? ` from ${age}` : ""}.`
    : `${label} is temporarily unavailable. No status claim is being made.`;
  const tone = NOTICE_TONE_COLORS[isStale ? "stale" : "unavailable"];

  return (
    <QueryNoticeSurface
      layout="compact"
      role={isStale ? "status" : "alert"}
      icon={AlertTriangle}
      toneClassName={tone.tone}
      body={message}
      compact={compact}
      retryLabel={`Retry ${label.toLowerCase()}`}
      onRetry={onRetry}
    />
  );
}
