"use client";

import Link from "next/link";
import { Newspaper, Send } from "lucide-react";
import { useDigestPromo } from "@/hooks/api-hooks";
import { digestDisplay } from "@/lib/fonts/digest";
import { cn } from "@/lib/utils";
import type { DigestPromoEdition } from "@shared/types/digest";


function compactDigestText(value: string | null | undefined): string | null {
  const compact = value?.replace(/\s+/g, " ").trim();
  return compact ? compact : null;
}


// Promo card sitting at the top-right of the Market Pulse band. Unlike its
// data siblings it carries no live signal, so it leads with the serif digest
// nameplate and two CTAs instead of the label + expand header pattern.
export function DailyDigestCard(): React.JSX.Element {
  const { data } = useDigestPromo();
  const latest = data?.latest;
  const title = latest
    ? compactDigestText(latest.digestTitle) ?? "Daily Digest"
    : "Read the latest edition on Telegram";
  const editionPrefix = latest?.editionNumber ? `#${latest.editionNumber}` : null;
  const previousEditions = data?.previousEditions ?? [];
  const text = latest?.excerpt;

  return (
    <div className="pharos-card-shell relative h-full min-h-0 overflow-hidden px-5 pt-7 text-center">
      <div className="relative z-10 space-y-2">
        <h3 className={`${digestDisplay.className} text-[2rem] font-semibold leading-none tracking-[-0.02em] text-foreground`}>
          Daily Digest
        </h3>
        <p className="mx-auto max-w-full whitespace-nowrap text-[12px] leading-snug text-muted-foreground">
          Updates from the world of stablecoins — every single day.
        </p>
      </div>

      <div className="relative z-10 mt-2 flex flex-wrap items-center justify-center gap-2">
        <DigestCardAction href="/digest/" icon={Newspaper}>
          View Digest
        </DigestCardAction>
        <DigestCardAction href="https://t.me/pharoswatch" icon={Send} external>
          Read on Telegram
        </DigestCardAction>
      </div>

      {/* Serif promo on a squared edition stack — the two previous editions
          peek above the front card as straight offset leaves (no tilt), so
          the archive reads as a filed record rather than a loose paper pile. */}
      <div className="absolute inset-x-0 bottom-3 z-10 h-[164px] text-left">
        <DigestFoldPreview
          entry={previousEditions[1]}
          className="left-10 right-7 top-0 h-[150px] border-border/35 bg-card/80 pt-2.5"
        />
        <DigestFoldPreview
          entry={previousEditions[0]}
          className="left-8 right-5 top-8 h-[152px] border-border/45 bg-card/90 pt-3"
        />
        <div className="absolute inset-x-4 bottom-[-2.25rem] top-[4.625rem] overflow-hidden rounded-xl border border-border/65 bg-card/95 p-4">
          {/* No projection: a plain CTA line, not an edition headline. */}
          {latest ? <h4 className={`${digestDisplay.className} text-sm font-semibold uppercase leading-snug tracking-wide`}>
            {editionPrefix ? (
              <>
                <span className="text-teal-700 dark:text-teal-400">{editionPrefix}</span>
                {` — ${title}`}
              </>
            ) : (
              title
            )}
          </h4> : <p className="text-sm text-muted-foreground">{title}</p>}
          {text ? (
            <p className={`${digestDisplay.className} mt-2 text-xs leading-relaxed text-muted-foreground`}>
              {text}
            </p>
          ) : null}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-card via-card/85 to-transparent"
          />
        </div>
      </div>
    </div>
  );
}

function DigestFoldPreview({
  entry,
  className,
}: {
  entry: DigestPromoEdition | undefined;
  className: string;
}): React.JSX.Element {
  const title = compactDigestText(entry?.digestTitle);
  const editionPrefix = entry?.editionNumber ? `#${entry.editionNumber}` : null;

  return (
    <div aria-hidden="true" className={cn("absolute overflow-hidden rounded-xl border px-4 py-3", className)}>
      {title && (
        <p
          className={cn(
            digestDisplay.className,
            "max-w-full truncate text-[9px] font-semibold uppercase leading-none tracking-wide text-foreground/50",
          )}
        >
          {editionPrefix && <span className="text-teal-700/75 dark:text-teal-400/75">{editionPrefix}</span>}
          {editionPrefix ? ` — ${title}` : title}
        </p>
      )}
    </div>
  );
}

function DigestCardAction({
  href,
  icon: Icon,
  external = false,
  children,
}: {
  href: string;
  icon: typeof Newspaper;
  external?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const className = cn(
    "pharos-focus-ring inline-flex h-7 items-center gap-1.5 rounded-md border border-border/70",
    "bg-muted/70 px-2.5 text-sm font-medium leading-none text-foreground/90",
    "transition-colors hover:border-border hover:bg-muted hover:text-foreground",
  );

  if (external) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
        <span>{children}</span>
        <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
      </a>
    );
  }

  return (
    <Link prefetch={false} href={href} className={className}>
      <span>{children}</span>
      <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
    </Link>
  );
}
