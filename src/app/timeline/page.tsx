import type { Metadata } from "next";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { buildCollectionItemListJsonLd, safeJsonLd } from "@/lib/json-ld";
import { buildPageMetadata } from "@/lib/page-metadata";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { TAPE_CLASSES } from "@/components/tape/tape-classes";
import { TimelineClient } from "./client";
import sitemapDates from "@/generated/sitemap-dates.json";

const TIMELINE_DESCRIPTION =
  "Browse confirmed stablecoin events in one timeline: depegs, freezes, score changes, methodology updates, severity filters, classes, and linked Pharos context.";

export const metadata: Metadata = buildPageMetadata({
  title: "Timeline — Stablecoin Market Events",
  description: TIMELINE_DESCRIPTION,
  canonical: "/timeline/",
  ogImage: `${SITE_URL}/og-timeline.png`,
});

const TIMELINE_URL = `${SITE_URL}/timeline/`;

// First-publish date for the /timeline/ route. The day-to-day "edited"
// timestamp is git-derived (via sitemap-dates.json) so crawlers see a stable
// date rather than the build timestamp, which would inflate crawl budget.
const TIMELINE_DATE_PUBLISHED = "2026-05-15T00:00:00Z";
const TIMELINE_DATE_MODIFIED = (sitemapDates as Record<string, string>)["/timeline/"] ?? TIMELINE_DATE_PUBLISHED;

// `TAPE_CLASSES` only carries classes with a live projector, so every entry
// advertised in the ItemList resolves to a non-empty feed.
const [collectionJsonLd, itemListJsonLd] = buildCollectionItemListJsonLd({
  url: TIMELINE_URL,
  name: "Timeline — Stablecoin Market Events",
  description: TIMELINE_DESCRIPTION,
  datePublished: TIMELINE_DATE_PUBLISHED,
  dateModified: TIMELINE_DATE_MODIFIED,
  itemListId: `${TIMELINE_URL}#class-index`,
  itemListName: "Event classes covered by the Timeline",
  itemListOrder: "https://schema.org/ItemListUnordered",
  entries: TAPE_CLASSES.map((cls) => ({
    name: cls.label,
    description: cls.description,
    url: `${TIMELINE_URL}?type=${encodeURIComponent(cls.slug)}.*`,
  })),
});

export default function TimelinePage() {
  return (
    <FeaturePageShell
      breadcrumbName="Timeline"
      path="/timeline/"
      title="Timeline"
      preface={(
        <>
          <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{ __html: safeJsonLd(collectionJsonLd) }}
          />
          <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{ __html: safeJsonLd(itemListJsonLd) }}
          />
        </>
      )}
      leadParagraphs={[
        "Every confirmed event across tracked stablecoins, newest first. Defaults to notice+ severity; drop the floor or widen the window to see more.",
      ]}
    >
      <TimelineClient />
    </FeaturePageShell>
  );
}
