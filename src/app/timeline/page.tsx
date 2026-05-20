import type { Metadata } from "next";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { safeJsonLd } from "@/lib/json-ld";
import { buildPageMetadata } from "@/lib/page-metadata";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { TAPE_PROJECTOR_VERSION_LABEL } from "@shared/lib/tape-version";
import { TAPE_CLASSES } from "@/components/tape/tape-classes";
import { TimelineClient } from "./client";

const TIMELINE_DESCRIPTION =
  "Every confirmed stablecoin event in one chronological timeline: depegs, freezes, score changes, and methodology bumps. Defaults to notice-and-above severity; drop the floor or filter by class to widen the lens.";

export const metadata: Metadata = buildPageMetadata({
  title: "Timeline — Stablecoin Market Events",
  description: TIMELINE_DESCRIPTION,
  canonical: "/timeline/",
});

const TIMELINE_URL = `${SITE_URL}/timeline/`;

const collectionJsonLd = {
  "@context": "https://schema.org",
  "@type": "CollectionPage",
  "@id": `${TIMELINE_URL}#collection`,
  name: "Timeline — Stablecoin Market Events",
  description: TIMELINE_DESCRIPTION,
  url: TIMELINE_URL,
  isPartOf: { "@id": `${SITE_URL}#website` },
};

// Only advertise classes that currently have a projector. Reserved chip slots
// return empty feeds today; including them would point crawlers at empty
// search results.
const SHIPPED_TAPE_CLASSES = TAPE_CLASSES.filter((cls) => cls.hasProjector);

const itemListJsonLd = {
  "@context": "https://schema.org",
  "@type": "ItemList",
  "@id": `${TIMELINE_URL}#class-index`,
  name: "Event classes covered by the Timeline",
  itemListOrder: "https://schema.org/ItemListUnordered",
  numberOfItems: SHIPPED_TAPE_CLASSES.length,
  itemListElement: SHIPPED_TAPE_CLASSES.map((cls, index) => ({
    "@type": "ListItem",
    position: index + 1,
    name: cls.label,
    description: cls.description,
    url: `${TIMELINE_URL}?type=${encodeURIComponent(cls.slug)}.*`,
  })),
};

export default function TimelinePage() {
  return (
    <FeaturePageShell
      breadcrumbName="Timeline"
      path="/timeline/"
      title="Timeline"
      statusBadge={{ status: "beta", version: TAPE_PROJECTOR_VERSION_LABEL }}
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
