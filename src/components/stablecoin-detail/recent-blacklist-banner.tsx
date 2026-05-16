"use client";

import Link from "next/link";
import { Snowflake } from "lucide-react";
import { useRecentBlacklist7d } from "@/hooks/use-recent-blacklist-7d";
import { isBlacklistBannerEnabled } from "@/lib/feature-flags";
import type { StablecoinMeta } from "@shared/types";

const SEVEN_DAY_THRESHOLD = 5;

interface RecentBlacklistBannerProps {
  symbol: string;
  coinStatus?: StablecoinMeta["status"];
}

export function RecentBlacklistBanner({ symbol, coinStatus }: RecentBlacklistBannerProps) {
  const flagOn = isBlacklistBannerEnabled();
  const isDefunct = coinStatus === "frozen";
  // Always call the hook — gating happens inside via `isEnabled`.
  const recent = useRecentBlacklist7d(symbol);
  if (!flagOn || isDefunct || !recent) return null;
  const { freezes, destroys } = recent;
  if (destroys === 0 && freezes < SEVEN_DAY_THRESHOLD) return null;
  const ariaParts: string[] = [];
  ariaParts.push(`${freezes} ${freezes === 1 ? "freeze" : "freezes"}`);
  if (destroys > 0) ariaParts.push(`${destroys} ${destroys === 1 ? "destroy" : "destroys"}`);
  ariaParts.push("in the last 7 days");
  return (
    <Link
      href="#blacklist"
      role="status"
      aria-live="polite"
      aria-label={`${ariaParts.join(", ")} — see blacklist activity`}
      className="pharos-focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 transition-colors hover:border-amber-500/50 hover:bg-amber-500/15 dark:text-amber-400"
    >
      <Snowflake className="h-3.5 w-3.5" aria-hidden />
      <span className="font-semibold tabular-nums">{freezes}</span>
      <span className="text-amber-700/80 dark:text-amber-400/80">
        {freezes === 1 ? "freeze" : "freezes"}
      </span>
      {destroys > 0 ? (
        <>
          <span aria-hidden className="text-amber-700/40 dark:text-amber-400/40">·</span>
          <span className="font-semibold tabular-nums">{destroys}</span>
          <span className="text-amber-700/80 dark:text-amber-400/80">
            {destroys === 1 ? "destroy" : "destroys"}
          </span>
        </>
      ) : null}
      <span className="text-amber-700/60 dark:text-amber-400/60">· 7d</span>
    </Link>
  );
}
