import type { Metadata } from "next";
import Link from "next/link";
import { Send } from "lucide-react";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { JsonLdScript } from "@/components/json-ld-script";
import { DigestArchiveClient } from "@/components/digest-archive-client";
import { DigestNameplate } from "@/components/digest-nameplate";
import { DigestColophon } from "@/components/digest-colophon";
import { PreferredSourcePrompt } from "@/components/preferred-source-prompt";
import { buildCollectionItemListJsonLd, safeJsonLd } from "@/lib/json-ld";
import { buildPageMetadata } from "@/lib/page-metadata";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { DIGEST_ENTRIES, LATEST_DAILY_DIGEST } from "@/lib/digest-registry";

export const metadata: Metadata = buildPageMetadata({
  title: "Daily Digest Archive: Stablecoin Recaps",
  description:
    "Browse the full Pharos archive of daily stablecoin recaps, from major depegs and supply shifts to slower structural risk changes across the market.",
  canonical: "/digest/",
  ogImage: `${SITE_URL}/og-editorial-digest.png`,
});

export default function DigestArchivePage() {
  const months = new Map<string, (typeof DIGEST_ENTRIES)[number][]>();
  for (const entry of DIGEST_ENTRIES) {
    const month = entry.date.slice(0, 7);
    const entries = months.get(month) ?? [];
    entries.push(entry);
    months.set(month, entries);
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <BreadcrumbJsonLd
        items={[
          { name: "Home", url: "/" },
          { name: "Daily Digest Archive", url: "/digest/" },
        ]}
      />
      <JsonLdScript
        json={safeJsonLd(
            buildCollectionItemListJsonLd({
              url: `${SITE_URL}/digest/`,
              name: "Daily Digest Archive",
              description: "Every Pharos stablecoin recap, newest first.",
              itemListName: "Pharos Digest Archive",
              entries: DIGEST_ENTRIES.map((entry) => ({
                item: {
                  "@type": "WebPage",
                  "@id": `${SITE_URL}/digest/${entry.date}/`,
                  name: entry.title,
                  url: `${SITE_URL}/digest/${entry.date}/`,
                  description: entry.text,
                },
              })),
            }),
          )}
      />

      <DigestNameplate issueNumber={LATEST_DAILY_DIGEST?.editionNumber} date={LATEST_DAILY_DIGEST?.date} />

      <p className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center text-sm text-muted-foreground">
        <Send className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" aria-hidden="true" />
        <span>Wake up to the daily digest in your feed.</span>
        <Link
          href="/pharoswatchbot/#channel"
          className="pharos-focus-ring rounded-sm font-medium text-foreground underline underline-offset-4 transition-colors hover:text-foreground/80"
        >
          Join the Telegram channel&nbsp;&rarr;
        </Link>
      </p>

      <DigestArchiveClient />

      <nav aria-labelledby="digest-month-index" className="space-y-3 border-t border-border pt-6">
        <h2 id="digest-month-index" className="text-lg font-semibold">Browse every edition by month</h2>
        {Array.from(months, ([month, entries]) => (
          <details key={month} className="rounded-lg border border-border px-4">
            <summary className="pharos-focus-ring cursor-pointer py-3 text-sm font-medium">
              {new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })}
              <span className="ml-2 text-muted-foreground">({entries.length} editions)</span>
            </summary>
            <ul className="space-y-3 pb-4 text-sm">
              {entries.map((entry) => (
                <li key={entry.date}>
                  <Link href={`/digest/${entry.date}/`} prefetch={false} className="pharos-focus-ring rounded-sm underline underline-offset-4 hover:text-foreground/80">
                    {entry.title}
                  </Link>
                  <span className="ml-2 text-xs text-muted-foreground">{entry.date.slice(0, 10)}{entry.digestType === "weekly" ? " · Weekly recap" : ""}</span>
                </li>
              ))}
            </ul>
          </details>
        ))}
      </nav>

      <PreferredSourcePrompt />

      <DigestColophon />
    </div>
  );
}
