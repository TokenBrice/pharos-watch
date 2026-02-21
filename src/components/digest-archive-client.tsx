"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { useDigestArchive } from "@/hooks/use-digest-archive";
import { formatDateline } from "@/components/daily-digest";

export function DigestArchiveClient() {
  const { data, isLoading } = useDigestArchive();

  if (isLoading) {
    return (
      <div className="space-y-6">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="border-b border-border/50 pb-5 space-y-2">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
          </div>
        ))}
      </div>
    );
  }

  if (!data || data.digests.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-8">
        No digests yet. Check back tomorrow.
      </p>
    );
  }

  return (
    <div className="space-y-0">
      {data.digests.map((d) => (
        <div key={d.generatedAt} className="border-b border-border/50 py-5">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground mb-3">
            {formatDateline(d.generatedAt)}
          </p>
          <p
            className="text-[1.1rem] leading-relaxed text-foreground/90"
            style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}
          >
            {d.digestText}
          </p>
        </div>
      ))}
    </div>
  );
}
