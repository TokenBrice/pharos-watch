import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { PHAROS_ORG_NODE, safeJsonLd } from "@/lib/json-ld";
import type { CaseStudy } from "./content/types";

const HUB_PATH = "/learn/case-studies/";
const BUILD_DATE_MODIFIED = new Date().toISOString();

function caseStudyUrl(slug: string): string {
  return `${SITE_ORIGIN}${HUB_PATH}${slug}/`;
}

/** `Article` document for a single case study detail page. */
function buildCaseStudyArticleJsonLd(study: CaseStudy): Record<string, unknown> {
  const url = caseStudyUrl(study.slug);
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    "@id": url,
    headline: study.title,
    description: study.metaDescription,
    url,
    mainEntityOfPage: url,
    image: `${SITE_ORIGIN}/og-learn-case-${study.slug}.png`,
    author: { "@id": PHAROS_ORG_NODE["@id"] },
    publisher: { "@id": PHAROS_ORG_NODE["@id"] },
    inLanguage: "en",
    isPartOf: `${SITE_ORIGIN}${HUB_PATH}`,
    datePublished: study.datePublished,
    dateModified: BUILD_DATE_MODIFIED,
  };
}

/** `ItemList` document for the case-studies hub. */
function buildCaseStudyListJsonLd(
  studies: readonly CaseStudy[],
): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "@id": `${SITE_ORIGIN}${HUB_PATH}`,
    name: "Stablecoin Depeg Case Studies",
    description:
      "Long-form retrospectives of major stablecoin depeg and failure events, sourced from Pharos data.",
    url: `${SITE_ORIGIN}${HUB_PATH}`,
    numberOfItems: studies.length,
    itemListElement: studies.map((study, index) => ({
      "@type": "ListItem",
      position: index + 1,
      url: caseStudyUrl(study.slug),
      name: study.title,
    })),
  };
}

export function CaseStudyArticleJsonLd({ study }: { study: CaseStudy }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: safeJsonLd(buildCaseStudyArticleJsonLd(study)),
      }}
    />
  );
}

export function CaseStudyListJsonLd({
  studies,
}: {
  studies: readonly CaseStudy[];
}) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: safeJsonLd(buildCaseStudyListJsonLd(studies)),
      }}
    />
  );
}
