"use client";

import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";
import { useDigestArchive } from "@/hooks/use-digest-archive";
import { formatDateline } from "@/components/daily-digest";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { CRON_24H } from "@/hooks/use-api-query";

function tsToDateSlug(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

export function DigestArchiveClient() {
  const { data, isLoading, dataUpdatedAt } = useDigestArchive();

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
    <div className="space-y-4">
      <StaleDataBanner
        queries={[{ label: "Digests", dataUpdatedAt, staleTime: CRON_24H }]}
      />
      <div className="space-y-0">
      {data.digests.map((d) => (
        <Link key={d.generatedAt} href={`/digest/${tsToDateSlug(d.generatedAt)}/`} className="block border-b border-border/50 py-5 hover:bg-muted/30 transition-colors -mx-2 px-2 rounded-lg">
          <p className="text-sm font-semibold uppercase tracking-widest text-muted-foreground mb-3">
            {d.digestTitle || "Signal & Noise"}
            <span className="font-normal tracking-wide"> · {formatDateline(d.generatedAt)}</span>
          </p>
          <p
            className="text-[1.1rem] leading-relaxed text-foreground/90 italic"
            style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}
          >
            {d.digestText}
          </p>
          {d.digestExtended && (
            <p
              className="text-[1.1rem] leading-relaxed text-foreground/90 italic mt-3"
              style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}
            >
              {d.digestExtended}
            </p>
          )}
        </Link>
      ))}
      </div>
    </div>
  );
}
