"use client";

import Image from "next/image";
import { useHealth } from "@/hooks/use-health";

const HEALTH_STYLES = {
  healthy:  { dot: "bg-green-500", text: "text-green-500", label: "HEALTHY" },
  degraded: { dot: "bg-amber-500", text: "text-amber-500", label: "DEGRADED" },
  stale:    { dot: "bg-red-500",   text: "text-red-500",   label: "STALE" },
} as const;

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

interface SiteHeaderProps {
  total: number;
  pegCount: number;
  chainCount: number;
}

export function SiteHeader({ total, pegCount, chainCount }: SiteHeaderProps) {
  const { data: health } = useHealth();

  const style = health ? HEALTH_STYLES[health.status] : null;
  const syncAge = health?.caches.stablecoins?.ageSeconds;

  return (
    <div className="hidden lg:flex items-center gap-3">
      <Image src="/pharos-icon.png" alt="" width={32} height={32} className="rounded-lg" priority />
      <h1 className="text-xl font-mono uppercase tracking-[0.2em] font-semibold">Pharos</h1>
      <span className="text-xs text-muted-foreground/60 font-mono">
        {total} stablecoins &middot; {pegCount} pegs &middot; {chainCount} chains
      </span>
      {style && health && (
        <span className="ml-auto flex items-center gap-1.5 text-xs font-mono">
          <span className={`inline-block h-1.5 w-1.5 rounded-full animate-pulse ${style.dot}`} />
          <span className={`uppercase ${style.text}`}>{style.label}</span>
          {syncAge != null && (
            <span className="text-muted-foreground/60">
              &middot; synced {formatAge(syncAge)}
            </span>
          )}
        </span>
      )}
    </div>
  );
}
