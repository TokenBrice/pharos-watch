"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useDailyDigest } from "@/hooks/use-daily-digest";

function timeAgo(epochSec: number): string {
  const diffMin = Math.floor((Date.now() / 1000 - epochSec) / 60);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}min ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  return `${Math.floor(diffH / 24)}d ago`;
}

export function DailyDigest() {
  const { data, isLoading } = useDailyDigest();

  // Don't render anything if no digest available (graceful fallback)
  if (!isLoading && (!data || !data.digest)) return null;

  if (isLoading) {
    return (
      <Card className="rounded-2xl border-dashed">
        <CardContent className="py-5 space-y-2">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-4 w-3/5" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="rounded-2xl border-dashed">
      <CardContent className="py-5">
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Daily Digest
          </p>
          {data!.generatedAt && (
            <span className="text-[10px] text-muted-foreground">
              Updated {timeAgo(data!.generatedAt)}
            </span>
          )}
        </div>
        <p className="text-sm leading-relaxed italic text-foreground/90">
          {data!.digest}
        </p>
      </CardContent>
    </Card>
  );
}
