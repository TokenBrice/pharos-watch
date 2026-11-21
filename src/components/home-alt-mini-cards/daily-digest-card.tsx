"use client";

import Link from "next/link";
import { Newspaper, Send } from "lucide-react";
import { useDigestPromo } from "@/hooks/api-hooks";
import { formatDigestDateLabel } from "@/lib/digest";
import { digestDisplay } from "@/lib/fonts/digest";
import { cn } from "@/lib/utils";
import type { DigestPromoEdition } from "@shared/types/digest";

function compactDigestText(value: string | null | undefined): string | null {
  const compact = value?.replace(/\s+/g, " ").trim();
  return compact ? compact : null;
}

/**
 * Full-width cross-device Daily Digest editorial strip (Q6).
 * Renders cleanly across desktop, tablet, and mobile without fixed-height
 * clipping, using the Newsreader editorial carve-out.
 */
export function DailyDigestCard(): React.JSX.Element {
  const { data } = useDigestPromo();
  const latest = data?.latest;
  const title = latest
    ? compactDigestText(latest.digestTitle) ?? "Daily Digest"
    : "Read the latest edition on Telegram";
  const editionPrefix = latest?.editionNumber ? `#${latest.editionNumber}` : null;
  const latestDate = latest?.slug ? formatDigestDateLabel(latest.slug, "short") : null;
  const latestHref = latest?.slug ? `/digest/${latest.slug}/` : "/digest/";
  const previousEditions = (data?.previousEditions ?? []).slice(0, 2);
  const text = latest?.excerpt;

  return (
    <section aria-labelledby="daily-digest-title" className="pharos-card-shell overflow-hidden">
      <div className="grid grid-cols-1 divide-y divide-border/60 lg:grid-cols-[minmax(0,4fr)_minmax(0,5fr)_minmax(0,3fr)] lg:divide-x lg:divide-y-0">
        {/* Masthead + actions */}
        <div className="flex flex-col justify-between gap-4 p-5 sm:p-6">
          <div className="space-y-1.5">
            <p className="pharos-eyebrow text-muted-foreground">Editorial briefing</p>
            <h2
              id="daily-digest-title"
              className={`${digestDisplay.className} text-3xl font-semibold leading-none tracking-[-0.02em] text-foreground`}
            >
              Daily Digest
            </h2>
            <p className="text-sm leading-snug text-muted-foreground">
              Updates from the world of stablecoins, every single day.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <DigestCardAction href="/digest/" icon={Newspaper}>
              View Digest
            </DigestCardAction>
            <DigestCardAction href="https://t.me/pharoswatch" icon={Send} external>
              Read on Telegram
            </DigestCardAction>
          </div>
        </div>

        {/* Lead edition */}
        <div className="flex flex-col justify-center gap-2 p-5 sm:p-6">
          {latest ? (
            <>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                <span className="pharos-label">Latest edition</span>
                {latestDate ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{latestDate}</span>
                  </>
                ) : null}
              </div>
              <Link
                prefetch={false}
                href={latestHref}
                className="pharos-focus-ring group rounded-sm"
              >
                <h3
                  className={`${digestDisplay.className} text-base font-semibold uppercase leading-snug tracking-wide text-foreground transition-colors group-hover:underline sm:text-lg`}
                >
                  {editionPrefix ? (
                    <>
                      <span className="text-teal-700 dark:text-teal-400">{editionPrefix}</span>
                      {` — ${title}`}
                    </>
                  ) : (
                    title
                  )}
                </h3>
              </Link>
              {text ? (
                <p className={`${digestDisplay.className} line-clamp-3 text-sm leading-relaxed text-muted-foreground`}>
                  {text}
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{title}</p>
          )}
        </div>

        {/* Prior editions */}
        <div className="flex flex-col justify-center gap-2.5 bg-muted/20 p-5 sm:p-6">
          <p className="pharos-label">Recent archive</p>
          {previousEditions.length > 0 ? (
            <ul className="divide-y divide-border/50">
              {previousEditions.map((entry, idx) => (
                <DigestArchiveLeaf key={`${entry.slug || "edition"}-${entry.editionNumber ?? idx}`} entry={entry} />
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">
              Daily editions publish to the archive and Telegram channel.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function DigestArchiveLeaf({ entry }: { entry: DigestPromoEdition }): React.JSX.Element | null {
  const title = compactDigestText(entry.digestTitle);
  if (!title) return null;
  const editionPrefix = entry.editionNumber ? `#${entry.editionNumber}` : null;
  const editionDate = formatDigestDateLabel(entry.slug, "short");
  const href = entry.slug ? `/digest/${entry.slug}/` : "/digest/";

  return (
    <li className="py-2 first:pt-0 last:pb-0">
      <Link
        prefetch={false}
        href={href}
        className="pharos-focus-ring group block rounded-sm py-0.5 transition-colors"
      >
        <p
          className={cn(
            digestDisplay.className,
            "line-clamp-2 text-xs font-semibold uppercase leading-snug tracking-wide text-foreground/85 group-hover:text-foreground group-hover:underline",
          )}
        >
          {editionDate ? `${editionDate} · ` : null}
          {editionPrefix ? <span className="text-teal-700 dark:text-teal-400">{editionPrefix}</span> : null}
          {editionPrefix ? ` — ${title}` : title}
        </p>
      </Link>
    </li>
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
    "pharos-focus-ring inline-flex min-h-11 items-center gap-1.5 rounded-md border border-border/70 sm:min-h-8",
    "bg-muted/70 px-3 text-sm font-medium leading-none text-foreground/90",
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
