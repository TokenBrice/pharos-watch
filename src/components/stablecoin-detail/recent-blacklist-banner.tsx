"use client";

import Link from "next/link";
import { Snowflake } from "lucide-react";
import { useRecentBlacklist7d } from "@/hooks/use-recent-blacklist-7d";
import { isBlacklistBannerEnabled } from "@/lib/feature-flags";

const SEVEN_DAY_THRESHOLD = 5;

interface RecentBlacklistBannerProps {
  symbol: string;
  frozenStatus?: "frozen" | "active";
}

export function RecentBlacklistBanner({ symbol, frozenStatus }: RecentBlacklistBannerProps) {
  const flagOn = isBlacklistBannerEnabled();
  const isFrozen = frozenStatus === "frozen";
  // Always call the hook — gating happens inside via `isEnabled`.
  const recent = useRecentBlacklist7d(symbol);
  if (!flagOn || isFrozen || !recent) return null;
  const { freezes, destroys, releases } = recent;
  if (freezes + destroys < SEVEN_DAY_THRESHOLD && destroys === 0) return null;
  return (
    <Link
      href="#blacklist"
      role="status"
      aria-live="polite"
      className="pharos-focus-ring block rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-700 transition-colors hover:border-amber-500/50 dark:text-amber-400"
    >
      <Snowflake className="mr-1.5 inline h-4 w-4" aria-hidden />
      <span className="font-medium">
        {freezes} {freezes === 1 ? "freeze" : "freezes"}
      </span>
      {destroys > 0 && (
        <>
          {" · "}
          <span className="font-medium">
            {destroys} {destroys === 1 ? "destroy" : "destroys"}
          </span>
        </>
      )}
      {releases > 0 && (
        <>
          {" · "}
          {releases} {releases === 1 ? "release" : "releases"}
        </>
      )}{" "}
      in the last 7 days.{" "}
      <span className="underline underline-offset-2">See blacklist activity →</span>
    </Link>
  );
}
