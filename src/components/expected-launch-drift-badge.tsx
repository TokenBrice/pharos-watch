"use client";

import { useEffect, useState } from "react";
import type { ComponentProps } from "react";
import { LaunchDriftBadge } from "@/components/pre-launch-badge";
import { getDriftStatus, parseFuzzyDeadline } from "@/lib/pre-launch";
import type { DateHistoryEntry } from "@shared/types";

/** Browser-clock island shared by the static detail page and upcoming cards. */
export function ExpectedLaunchDriftBadge({ dateHistory, expectedLaunchDate, size = "compact" }: {
  dateHistory?: DateHistoryEntry[];
  expectedLaunchDate?: string;
  size?: ComponentProps<typeof LaunchDriftBadge>["size"];
}) {
  const [nowMs, setNowMs] = useState<number | null>(null);
  const deadlineMs = expectedLaunchDate ? parseFuzzyDeadline(expectedLaunchDate)?.getTime() : undefined;
  useEffect(() => {
    let timer: number | undefined;
    const update = () => {
      const now = Date.now();
      setNowMs(now);
      if (deadlineMs != null && deadlineMs > now) {
        timer = window.setTimeout(update, Math.min(deadlineMs - now, 2_147_483_647));
      }
    };
    update();
    return () => window.clearTimeout(timer);
  }, [deadlineMs]);
  if (nowMs === null) return null;
  const status = getDriftStatus(dateHistory, expectedLaunchDate, nowMs);
  return status === "on-track" ? null : <LaunchDriftBadge status={status} size={size} />;
}
