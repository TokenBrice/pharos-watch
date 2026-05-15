import type { Metadata } from "next";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { safeJsonLd } from "@/lib/json-ld";
import { buildPageMetadata } from "@/lib/page-metadata";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { TAPE_CLASSES } from "@/components/tape/tape-classes";
import { TapeClient } from "./client";

const TAPE_DESCRIPTION =
  "Cross-class chronological feed of stablecoin events: depegs, freezes, score changes, and methodology bumps on one timeline. Defaults to notice-and-above severity; drop the floor or filter by class to widen the lens.";

// The /tape/ OG image is intentionally served from the standard static
// /og-card.png. A dynamic /api/og/tape generator lives in worker territory
// alongside the existing /api/og/* routes; this page picks it up via the
// buildPageMetadata default once the worker route ships.
export const metadata: Metadata = buildPageMetadata({
  title: "The Tape: Stablecoin Market Event Feed",
  description: TAPE_DESCRIPTION,
  canonical: "/tape/",
});

const TAPE_URL = `${SITE_URL}/tape/`;

const collectionJsonLd = {
  "@context": "https://schema.org",
  "@type": "CollectionPage",
  "@id": `${TAPE_URL}#collection`,
  name: "The Tape — Stablecoin Market Event Feed",
  description: TAPE_DESCRIPTION,
  url: TAPE_URL,
  isPartOf: { "@id": `${SITE_URL}#website` },
};

const itemListJsonLd = {
  "@context": "https://schema.org",
  "@type": "ItemList",
  "@id": `${TAPE_URL}#class-index`,
  name: "Event classes covered by the Tape",
  itemListOrder: "https://schema.org/ItemListUnordered",
  numberOfItems: TAPE_CLASSES.length,
  itemListElement: TAPE_CLASSES.map((cls, index) => ({
    "@type": "ListItem",
    position: index + 1,
    name: cls.label,
    description: cls.description,
    url: `${TAPE_URL}?type=${encodeURIComponent(cls.slug)}.*`,
  })),
};

export default function TapePage() {
  return (
    <FeaturePageShell
      breadcrumbName="The Tape"
      path="/tape/"
      title="The Tape"
      statusBadge={{ status: "beta" }}
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
        "A cross-class chronological view of stablecoin events: depegs, freezes, score changes, and methodology bumps on one timeline.",
        "Use this when you want everything for one coin, everything in one severity tier, or a unified view across event classes. The dedicated trackers go deeper for any single class.",
      ]}
    >
      <TapeClient />
    </FeaturePageShell>
  );
}
