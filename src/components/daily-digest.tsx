"use client";

import Link from "next/link";
import { Newsreader } from "next/font/google";
import { Skeleton } from "@/components/ui/skeleton";
import { useDailyDigest } from "@/hooks/api-hooks";
import { getDigestBodyParagraphs, EDITORIAL_BODY_STYLE } from "@/lib/digest";
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

// Editorial body style imported from @/lib/digest for consistent wire-service aesthetic

interface DigestFullDisplayProps {
  label: string;
  dateString: string;
  title: string;
  paragraphs: string[];
  ctaHref?: string;
  ctaLabel?: string;
}

function parseDigestParagraph(paragraph: string): { headerText: string | null; bodyText: string } {
  const headerMatch = paragraph.match(/^\*\*(.+?)\*\*\s*/);
  return {
    headerText: headerMatch?.[1]?.replace(/\.+$/, "") ?? null,
    bodyText: headerMatch ? paragraph.slice(headerMatch[0].length) : paragraph,
  };
}

interface DigestParagraphListProps {
  paragraphs: string[];
  getParagraphClassName: (index: number) => string;
}

function DigestParagraphList({ paragraphs, getParagraphClassName }: DigestParagraphListProps) {
  return (
    <>
      {paragraphs.map((paragraph, index) => {
        const { headerText, bodyText } = parseDigestParagraph(paragraph);
        return (
          <p
            key={`${index}-${paragraph.slice(0, 16)}`}
            className={getParagraphClassName(index)}
            style={EDITORIAL_BODY_STYLE}
          >
            {headerText && (
              <span className="font-semibold not-italic tracking-wide" style={{ fontFamily: "inherit" }}>
                {headerText}.{" "}
              </span>
            )}
            {bodyText}
          </p>
        );
      })}
    </>
  );
}

export function DigestFullDisplay({ label, dateString, title, paragraphs, ctaHref, ctaLabel }: DigestFullDisplayProps) {
  return (
    <div className="animate-in fade-in duration-300 mx-auto max-w-[68ch]">
      <div className="border-t border-b border-border py-3 text-left">
        <p className="text-sm font-semibold uppercase tracking-[0.25em] text-muted-foreground">
          {label}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">{dateString}</p>
      </div>

      <div className="space-y-3 py-5">
        <h2 className="text-2xl font-bold sm:text-3xl" style={EDITORIAL_BODY_STYLE}>
          {title}
        </h2>

        <DigestParagraphList
          paragraphs={paragraphs}
          getParagraphClassName={(index) => cn(
            "text-[1.05rem] leading-8 text-foreground/92",
            index === 0 && "border-l-2 border-border/60 pl-4 italic",
          )}
        />

        {ctaHref && ctaLabel && (
          <Link
            href={ctaHref}
            className="inline-block mt-2 text-sm font-semibold uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground"
          >
            {ctaLabel} &rarr;
          </Link>
        )}
      </div>
    </div>
  );
}

const digestDisplay = Newsreader({
  weight: "variable",
  style: ["normal", "italic"],
  subsets: ["latin"],
  display: "swap",
  axes: ["opsz"],
  fallback: ["Georgia", "Times New Roman", "serif"],
});

interface DailyDigestProps {
  variant?: "preview" | "full";
  /** Override the CTA link target (e.g. point to the detail page instead of the archive). */
  detailHref?: string;
}

export function DailyDigest({ variant = "full", detailHref }: DailyDigestProps) {
  const { data, isLoading, error, refetch } = useDailyDigest();
  const paragraphs = getDigestBodyParagraphs({
    digest: data?.digest,
    digestExtended: data?.digestExtended,
  });
  const isPreview = variant === "preview";
  const visibleParagraphs = variant === "preview" ? paragraphs.slice(0, 1) : paragraphs;
  const shouldShowCta = variant === "preview";
  const ctaLabel = detailHref
    ? "Continue reading"
    : variant === "preview"
      ? "Read today's full digest"
      : "Read all previous recaps";

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
        <div className={cn(isPreview ? "grid gap-5 lg:grid-cols-[minmax(0,0.64fr)_minmax(0,1.36fr)]" : "space-y-3")}>
          <div className="space-y-3">
            {isPreview && <Skeleton className="h-3 w-36" />}
            <Skeleton className={cn("w-full", isPreview ? "h-20 max-w-[20rem] sm:max-w-[24rem]" : "h-10 max-w-[28rem]")} />
          </div>
          <div className="space-y-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-11/12" />
          </div>
        </div>
      </div>
    );
  }

  const editionLabel = data?.editionNumber
    ? `Pharos Daily Digest #${data.editionNumber}`
    : "Pharos Daily Digest";

  if (!isPreview) {
    return (
      <DigestFullDisplay
        label={editionLabel}
        dateString={data?.generatedAt ? formatMasthead(data.generatedAt) : ""}
        title={data?.digestTitle || "Signal & Noise"}
        paragraphs={visibleParagraphs}
      />
    );
  }

  return (
    <div className="animate-in fade-in duration-300 space-y-5">
      {/* Masthead (preview) */}
      <div className="border-t border-b border-border py-3 text-left flex flex-wrap items-end justify-between gap-3">
        <p className="font-mono text-[0.76rem] font-semibold uppercase tracking-[0.34em] text-muted-foreground/90 sm:text-[0.8rem]">
          {editionLabel}
        </p>
        {data?.generatedAt && (
          <p className="mt-0.5 text-xs text-muted-foreground/85">
            {formatMasthead(data.generatedAt)}
          </p>
        )}
      </div>

      {(() => {
        const bodyBlock = (
          <div className="flex min-w-0 flex-col gap-4">
            <DigestParagraphList
              paragraphs={visibleParagraphs}
              getParagraphClassName={(index) => cn(
                "text-[1.08rem] leading-[1.9] text-foreground/88 sm:text-[1.14rem] lg:text-[1.22rem]",
                index === 0 && "border-l border-border/70 pl-5 italic sm:pl-6",
              )}
            />
            {shouldShowCta && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-2 lg:self-end">
                <Link
                  href={detailHref ?? "/digest/"}
                  className="font-mono text-[0.76rem] font-semibold uppercase tracking-[0.26em] text-muted-foreground transition-colors hover:text-foreground"
                >
                  {ctaLabel} &rarr;
                </Link>
                {!detailHref && (
                  <>
                    <span className="text-border/70">|</span>
                    <a
                      href="https://t.me/pharoswatch"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-[0.76rem] font-semibold uppercase tracking-[0.26em] text-muted-foreground transition-colors hover:text-foreground"
                    >
                      Telegram &rarr;
                    </a>
                  </>
                )}
              </div>
            )}
          </div>
        );

        const title = data?.digestTitle || "Signal & Noise";

        return detailHref ? (
          /* Archive: stacked layout — title above text */
          <div className="py-6 space-y-5">
            <h2
              className={cn(
                digestDisplay.className,
                "text-[clamp(2.2rem,5vw,3.5rem)] font-semibold leading-[0.92] tracking-[-0.04em] text-foreground/98 [text-wrap:balance]",
              )}
            >
              {title}
            </h2>
            {bodyBlock}
          </div>
        ) : (
          /* Homepage: two-column layout */
          <div className="grid gap-6 py-6 lg:grid-cols-[minmax(0,0.64fr)_minmax(0,1.36fr)] lg:gap-10">
            <div className="min-w-0 space-y-5">
              <div className="flex items-center gap-3 text-[0.72rem] uppercase tracking-[0.28em] text-muted-foreground/80">
                <span className="h-px w-12 bg-border/70" />
                <span className="pharos-kicker">Executive Summary</span>
              </div>
              <h2
                className={cn(
                  digestDisplay.className,
                  "max-w-[10ch] text-[clamp(2.8rem,6vw,5rem)] font-semibold leading-[0.88] tracking-[-0.045em] text-foreground/98 [text-wrap:balance]",
                )}
              >
                {title}
              </h2>
            </div>
            {bodyBlock}
          </div>
        );
      })()}
    </div>
  );
}
