"use client";

import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";
import { useDailyDigest } from "@/hooks/use-daily-digest";
import { getDigestBodyParagraphs } from "@/lib/digest";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { cn } from "@/lib/utils";

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
}

export function DailyDigest({ variant = "full" }: DailyDigestProps) {
  const { data, isLoading, error, refetch } = useDailyDigest();
  const paragraphs = getDigestBodyParagraphs({
    digest: data?.digest,
    digestExtended: data?.digestExtended,
  });
  const isPreview = variant === "preview";
  const visibleParagraphs = variant === "preview" ? paragraphs.slice(0, 1) : paragraphs;
  const shouldShowCta = variant === "preview";
  const ctaLabel = variant === "preview" ? "Read today's full digest" : "Read all previous recaps";

  if (!isLoading && !data) {
    if (error) return <QueryErrorNotice error={error} onRetry={() => void refetch()} />;
    return null;
  }

  if (isLoading) {
    return (
      <div
        className={cn(
          "animate-pulse border-t border-b border-border py-6",
          isPreview ? "space-y-5" : "mx-auto max-w-[68ch] space-y-3",
        )}
      >
        <div className={cn(isPreview ? "flex flex-wrap items-center justify-between gap-3" : "space-y-2")}>
          <Skeleton className="h-3 w-48" />
          <Skeleton className="h-3 w-36" />
        </div>
        <div className={cn(isPreview ? "grid gap-5 lg:grid-cols-[minmax(0,0.72fr)_minmax(0,1.28fr)]" : "space-y-3")}>
          <div className="space-y-3">
            {isPreview && <Skeleton className="h-6 w-40 rounded-full" />}
            <Skeleton className="h-10 w-full max-w-[28rem]" />
          </div>
          <div className="space-y-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-11/12" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("animate-in fade-in duration-300", isPreview ? "space-y-5" : "mx-auto max-w-[68ch]")}>
      {/* Masthead */}
      <div
        className={cn(
          "border-t border-b border-border py-3 text-left",
          isPreview && "flex flex-wrap items-end justify-between gap-3",
        )}
      >
        <p className="text-sm font-semibold uppercase tracking-[0.25em] text-muted-foreground">Pharos Daily Digest</p>
        {data?.generatedAt && (
          <p className="mt-0.5 text-xs text-muted-foreground">{formatMasthead(data.generatedAt)}</p>
        )}
      </div>

      {isPreview ? (
        <div className="grid gap-5 py-5 lg:grid-cols-[minmax(0,0.72fr)_minmax(0,1.28fr)] lg:gap-10">
          <div className="space-y-4">
            <div className="flex justify-end">
              <span className="inline-flex rounded-full border border-border/60 bg-background/55 px-3 py-1 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
                Executive Summary
              </span>
            </div>
            <h2 className="text-3xl font-bold tracking-tight sm:text-[2.55rem]" style={SERIF}>
              {data?.digestTitle || "Signal & Noise"}
            </h2>
          </div>
          <div className="flex min-w-0 flex-col gap-4">
            {visibleParagraphs.map((para, i) => (
              <p
                key={i}
                className={cn(
                  "text-[1.08rem] leading-8 text-foreground/92 lg:text-[1.14rem]",
                  i === 0 && "border-l-2 border-border/60 pl-4 italic sm:pl-5",
                )}
                style={SERIF}
              >
                {para}
              </p>
            ))}
            {shouldShowCta && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 lg:self-end">
                <Link
                  href="/digest/"
                  className="text-sm font-semibold uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground"
                >
                  {ctaLabel} &rarr;
                </Link>
                <span className="text-border">|</span>
                <a
                  href="https://t.me/pharoswatch"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm font-semibold uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground"
                >
                  Telegram &rarr;
                </a>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-3 py-5">
          <h2 className="text-2xl font-bold sm:text-3xl" style={SERIF}>
            {data?.digestTitle || "Signal & Noise"}
          </h2>

          {visibleParagraphs.map((para, i) => (
            <p
              key={i}
              className={cn(
                "text-[1.05rem] leading-8 text-foreground/92",
                i === 0 && "border-l-2 border-border/60 pl-4 italic",
              )}
              style={SERIF}
            >
              {para}
            </p>
          ))}

          {shouldShowCta && (
            <Link
              href="/digest/"
              className="inline-block mt-2 text-sm font-semibold uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground"
            >
              {ctaLabel} &rarr;
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
