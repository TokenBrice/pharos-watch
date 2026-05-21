"use client";

import { useMemo, useSyncExternalStore } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * Map of first-segment paths to the human-readable label shown in the
 * "Back to <surface>" link. Only same-origin referrers whose first path
 * segment appears here render an affordance — anything else (search engines,
 * sidebar nav, deeplinks, no referrer) gracefully renders nothing.
 */
const TRACKER_LABELS: Record<string, string> = {
  "/screener": "Screener results",
  "/compare": "Compare",
  "/timeline": "Tape",
  "/portfolio": "Portfolio",
  "/depeg": "Depeg tracker",
  "/yield": "Yield leaderboard",
  "/liquidity": "Liquidity",
  "/safety-scores": "Safety Scores",
  "/freezewatch": "FreezeWatch",
  "/flows": "Mint/Burn Flows",
};

/**
 * Small `← Back to <prior surface>` link rendered above the breadcrumb on
 * detail pages. Reads `document.referrer` once on mount and surfaces a link
 * only when the referrer is same-origin and matches a known tracker; that
 * preserves the user's filter query-string by linking back to the original
 * URL. When the referrer is empty, cross-origin, or unrecognized, the
 * component renders nothing — the breadcrumb is the only fallback.
 */
function subscribeReferrer(): () => void {
  return () => {};
}

function getReferrerSnapshot(): string {
  if (typeof document === "undefined") return "";
  return document.referrer;
}

function getServerReferrerSnapshot(): string {
  return "";
}

export function BackToSource({ className }: { className?: string }) {
  const referrer = useSyncExternalStore(subscribeReferrer, getReferrerSnapshot, getServerReferrerSnapshot);

  const backLink = useMemo<{ href: string; label: string } | null>(() => {
    if (!referrer) return null;
    try {
      const url = new URL(referrer);
      if (typeof window === "undefined" || url.origin !== window.location.origin) return null;
      const segment = "/" + url.pathname.split("/").filter(Boolean)[0];
      const label = TRACKER_LABELS[segment];
      if (!label) return null;
      return { href: referrer, label };
    } catch {
      return null;
    }
  }, [referrer]);

  if (!backLink) return null;
  return (
    <Link
      href={backLink.href}
      className={cn(
        "pharos-focus-ring inline-flex items-center gap-1.5 rounded-sm text-xs text-muted-foreground transition-colors hover:text-foreground",
        className,
      )}
    >
      <span aria-hidden="true">←</span> Back to {backLink.label}
    </Link>
  );
}
