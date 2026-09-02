"use client";

import { AlertCircle, WifiOff, Database, type LucideIcon } from "lucide-react";
import { ApiFetchError } from "@/lib/api";
import { NOTICE_TONE_COLORS } from "@shared/lib/classification";
import { QueryNoticeSurface } from "@/components/query-notice-surface";

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
    <QueryNoticeSurface
      layout="detailed"
      role="status"
      icon={Icon}
      toneClassName={tone}
      iconBgClassName={iconBg}
      title={title}
      body={message}
      detail={detail}
      onRetry={onRetry}
    />
  );
}
