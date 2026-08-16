import type { Metadata } from "next";
import Link from "next/link";
import { Send } from "lucide-react";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { DigestArchiveClient } from "@/components/digest-archive-client";
import { DigestNameplate } from "@/components/digest-nameplate";
import { DigestColophon } from "@/components/digest-colophon";
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
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <BreadcrumbJsonLd
        items={[
          { name: "Home", url: "/" },
          { name: "Daily Digest Archive", url: "/digest/" },
        ]}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: safeJsonLd(
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
          ),
        }}
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

      {/* Server-rendered digest links for SEO crawlability (client component loads the interactive list) */}
      <nav aria-label="Digest archive index" className="sr-only">
        {DIGEST_ENTRIES.map((d) => (
          <Link key={`${d.date}-${d.digestType ?? "daily"}-${d.generatedAt}`} href={`/digest/${d.date}/`}>
            {d.title} — {d.date}
          </Link>
        ))}
      </nav>

      <DigestColophon />
    </div>
  );
}
