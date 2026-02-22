"use client";

import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";
import { useDailyDigest } from "@/hooks/use-daily-digest";

export function formatDateline(ts: number): string {
  return new Date(ts * 1000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
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
      <p className="text-sm font-semibold uppercase tracking-widest text-muted-foreground mb-3">
        Signal &amp; Noise
        {data!.generatedAt && (
          <span className="font-normal tracking-wide"> · {formatDateline(data!.generatedAt)}</span>
        )}
      </p>
      <p className="text-[1.1rem] leading-relaxed text-foreground/90 italic" style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}>
        {data!.digest}
      </p>
      <Link
        href="/digest/"
        className="inline-block mt-3 text-sm font-semibold uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors"
      >
        Read all previous recaps &rarr;
      </Link>
    </div>
  );
}
