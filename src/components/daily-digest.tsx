"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { useDailyDigest } from "@/hooks/use-daily-digest";

function formatDateline(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function DailyDigest() {
  const { data, isLoading } = useDailyDigest();

  if (!isLoading && (!data || !data.digest)) return null;

  if (isLoading) {
    return (
      <div className="border-t border-b border-border/50 py-5 space-y-2">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-4/5" />
      </div>
    );
  }

  return (
    <div className="border-t border-b border-border/50 py-5 animate-in fade-in duration-300">
      <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground mb-3">
        Daily Digest
        {data!.generatedAt && (
          <span className="font-normal tracking-wide"> · {formatDateline(data!.generatedAt)}</span>
        )}
      </p>
      <p className="text-[1.1rem] leading-relaxed text-foreground/90" style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}>
        {data!.digest}
      </p>
    </div>
  );
}
