"use client";

import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";
import { useDailyDigest } from "@/hooks/use-daily-digest";
import { getDigestBodyParagraphs } from "@/lib/digest";
import { QueryErrorNotice } from "@/components/query-error-notice";

function formatMasthead(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

const SERIF = { fontFamily: "Georgia, 'Times New Roman', serif" };

interface DailyDigestProps {
  variant?: "preview" | "full";
  showCta?: boolean;
}

export function DailyDigest({ variant = "full", showCta }: DailyDigestProps) {
  const { data, isLoading, error, refetch } = useDailyDigest();
  const paragraphs = getDigestBodyParagraphs({
    digest: data?.digest,
    digestExtended: data?.digestExtended,
  });
  const visibleParagraphs = variant === "preview" ? paragraphs.slice(0, 1) : paragraphs;
  const shouldShowCta = showCta ?? (variant === "preview");
  const ctaLabel = variant === "preview" ? "Read today's full digest" : "Read all previous recaps";

  if (!isLoading && !data) {
    if (error) return <QueryErrorNotice error={error} onRetry={() => void refetch()} />;
    return null;
  }

  if (isLoading) {
    return (
      <div className="border-t border-b border-border py-6 space-y-3">
        <Skeleton className="h-3 w-48 mx-auto" />
        <Skeleton className="h-3 w-36 mx-auto" />
        <Skeleton className="h-6 w-72 mt-4" />
        <Skeleton className="h-4 w-full mt-2" />
        <Skeleton className="h-4 w-4/5" />
      </div>
    );
  }

  return (
    <div className="animate-in fade-in duration-300">
      {/* Masthead */}
      <div className="border-t border-b border-border py-3 text-center">
        <p className="text-sm font-semibold uppercase tracking-[0.25em] text-muted-foreground">
          Pharos Daily Digest
        </p>
        {data?.generatedAt && (
          <p className="text-xs text-muted-foreground mt-0.5">
            {formatMasthead(data.generatedAt)}
          </p>
        )}
      </div>

      {/* Headline + Body */}
      <div className="py-5 space-y-3">
        <h2 className="text-2xl sm:text-3xl font-bold" style={SERIF}>
          {data?.digestTitle || "Signal & Noise"}
        </h2>

        {visibleParagraphs.map((para, i) => (
          <p
            key={i}
            className="text-[1.1rem] leading-relaxed text-foreground/90 italic"
            style={SERIF}
          >
            {para}
          </p>
        ))}

        {shouldShowCta && (
          <Link
            href="/digest/"
            className="inline-block mt-2 text-sm font-semibold uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors"
          >
            {ctaLabel} &rarr;
          </Link>
        )}
      </div>
    </div>
  );
}
