"use client";

import { useEffect, useMemo } from "react";
import { usePathname } from "next/navigation";
import { getWindowStorage, safeStorageGetItem, safeStorageSetItem } from "@/lib/browser-storage";
import { useDailyDigest, useHealth, usePegSummary, useStabilityIndex } from "@/hooks/api-hooks";
import { useBlacklistSummary } from "@/hooks/use-blacklist-events";
import {
  getBlacklistNavSignal,
  getDepegNavSignal,
  getDigestNavSignal,
  getStabilityIndexNavSignal,
  getStatusNavSignal,
  parseSidebarDigestSeenAt,
  SIDEBAR_DIGEST_SEEN_STORAGE_KEY,
  type SidebarNavSignal,
} from "@/lib/sidebar-signals";

export function useSidebarNavSignals() {
  const pathname = usePathname();
  const { data: pegSummary } = usePegSummary();
  const { data: stabilityIndex } = useStabilityIndex();
  const { data: blacklistSummary } = useBlacklistSummary();
  const { data: health } = useHealth();
  const { data: dailyDigest } = useDailyDigest();
  const seenDigestGeneratedAt = useMemo(() => {
    if (pathname.startsWith("/digest") && dailyDigest?.generatedAt != null) {
      return dailyDigest.generatedAt;
    }
    return parseSidebarDigestSeenAt(
      safeStorageGetItem(getWindowStorage("local"), SIDEBAR_DIGEST_SEEN_STORAGE_KEY),
    );
  }, [pathname, dailyDigest?.generatedAt]);

  useEffect(() => {
    if (!pathname.startsWith("/digest")) return;
    if (dailyDigest?.generatedAt == null) return;

    safeStorageSetItem(getWindowStorage("local"), SIDEBAR_DIGEST_SEEN_STORAGE_KEY, String(dailyDigest.generatedAt));
  }, [pathname, dailyDigest?.generatedAt]);

  return useMemo<Record<string, SidebarNavSignal | null>>(
    () => ({
      "/depeg": getDepegNavSignal(pegSummary),
      "/stability-index": getStabilityIndexNavSignal(stabilityIndex),
      "/blacklist": getBlacklistNavSignal(blacklistSummary),
      "/status": getStatusNavSignal(health),
      "/digest": getDigestNavSignal(dailyDigest?.generatedAt, seenDigestGeneratedAt),
    }),
    [blacklistSummary, dailyDigest?.generatedAt, health, pegSummary, seenDigestGeneratedAt, stabilityIndex],
  );
}
