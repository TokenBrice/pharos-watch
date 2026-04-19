import type { Metadata } from "next";
import Link from "next/link";
import { Send } from "lucide-react";
import { DigestArchiveClient } from "@/components/digest-archive-client";
import { CalloutBanner } from "@/components/callout-banner";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { safeJsonLd } from "@/lib/json-ld";
import { buildPageMetadata } from "@/lib/page-metadata";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import digests from "../../../data/digests.json";

export const metadata: Metadata = buildPageMetadata({
  title: "Daily Digest Archive: Stablecoin Recaps",
  description:
    "Browse the full Pharos archive of daily stablecoin recaps, from major depegs and supply shifts to slower structural risk changes across the market.",
  canonical: "/digest/",
  ogImage: `${SITE_URL}/og-digest.png`,
});

const digestEntries = digests as { date: string; title: string; text: string }[];

export default function DigestArchivePage() {
  return (
    <FeaturePageShell
      breadcrumbName="Daily Digest Archive"
      path="/digest/"
      title="Daily Digest Archive"
      containerClassName="mx-auto max-w-4xl"
      preface={(
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: safeJsonLd([
              {
                "@context": "https://schema.org",
                "@type": "CollectionPage",
                "@id": `${SITE_URL}/digest/#collection`,
                name: "Daily Digest Archive",
                description: "Every Pharos stablecoin recap, newest first.",
                url: `${SITE_URL}/digest/`,
                mainEntity: { "@id": `${SITE_URL}/digest/#itemlist` },
                isPartOf: { "@id": `${SITE_URL}#website` },
              },
              {
                "@context": "https://schema.org",
                "@type": "ItemList",
                "@id": `${SITE_URL}/digest/#itemlist`,
                name: "Pharos Digest Archive",
                numberOfItems: digestEntries.length,
                itemListElement: digestEntries.map((entry, index) => ({
                  "@type": "ListItem",
                  position: index + 1,
                  item: {
                    "@type": "WebPage",
                    "@id": `${SITE_URL}/digest/${entry.date}/`,
                    name: entry.title,
                    url: `${SITE_URL}/digest/${entry.date}/`,
                    description: entry.text,
                  },
                })),
              },
            ]),
          }}
        />
      )}
      leadParagraphs={[
        "Every Pharos stablecoin recap, newest first.",
      ]}
    >
      <CalloutBanner icon={<Send className="h-4 w-4" />} className="border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300">
        Wake up to the Pharos daily digest, straight in your feed.{" "}
        <Link
          href="/telegram#channel"
          className="text-foreground underline underline-offset-4 hover:text-foreground/80 transition-colors"
        >
          Join the Pharos Telegram channel&nbsp;&rarr;
        </Link>
      </CalloutBanner>

      <DigestArchiveClient />

      {/* Server-rendered digest links for SEO crawlability (client component loads the interactive list) */}
      <nav aria-label="Digest archive index" className="sr-only">
        {digestEntries.map((d) => (
          <Link key={d.date} href={`/digest/${d.date}/`}>
            {d.title} — {d.date}
          </Link>
        ))}
      </nav>

    </FeaturePageShell>
  );
}
