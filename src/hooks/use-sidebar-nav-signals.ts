"use client";

import { useEffect, useMemo } from "react";
import { usePathname } from "next/navigation";
import { getWindowStorage, safeStorageGetItem, safeStorageSetItem } from "@/lib/browser-storage";
import {
  useSidebarDailyDigestSignal,
  useSidebarHealthSignal,
  useSidebarPegSummarySignal,
  useSidebarStabilityIndexSignal,
} from "@/hooks/use-sidebar-nav-signal-data";
import {
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
  const { data: pegSummary } = useSidebarPegSummarySignal();
  const { data: stabilityIndex } = useSidebarStabilityIndexSignal();
  const { data: health } = useSidebarHealthSignal();
  const { data: dailyDigest } = useSidebarDailyDigestSignal();
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
      "/timeline": null,
      "/stability-index": getStabilityIndexNavSignal(stabilityIndex),
      "/freezewatch": null,
      "/status": getStatusNavSignal(health),
      "/digest": getDigestNavSignal(dailyDigest?.generatedAt, seenDigestGeneratedAt),
    }),
    [dailyDigest?.generatedAt, health, pegSummary, seenDigestGeneratedAt, stabilityIndex],
  );
}
