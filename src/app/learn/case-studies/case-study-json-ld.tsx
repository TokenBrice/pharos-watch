import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import {
  getMechanismArchetypeLabel,
  getMechanismExplainerPath,
} from "@shared/lib/classification";
import { PHAROS_ORG_NODE, safeJsonLd } from "@/lib/json-ld";
import sitemapDates from "@/generated/sitemap-dates.json";
import type { CaseStudy } from "./content/types";

const HUB_PATH = "/learn/case-studies/";
const SITEMAP_DATES = sitemapDates as Record<string, string>;
const WORDS_PER_MINUTE = 200;

function caseStudyUrl(slug: string): string {
  return `${SITE_ORIGIN}${HUB_PATH}${slug}/`;
}

/** Body word count, used for `wordCount` + `timeRequired` (reading time). */
function caseStudyWordCount(study: CaseStudy): number {
  const text = [
    ...study.lead,
    ...(study.takeaways ?? []),
    ...study.sections.flatMap((section) => section.paragraphs),
    ...study.timeline.map((entry) => `${entry.headline} ${entry.body}`),
    ...study.watchpoints,
  ].join(" ");
  return text.split(/\s+/).filter(Boolean).length;
}

/** `Article` document for a single case study detail page. */
function buildCaseStudyArticleJsonLd(study: CaseStudy): Record<string, unknown> {
  const url = caseStudyUrl(study.slug);
  // Git-derived per-study modified date (falls back to publish date) so the
  // markup never claims every study changed on every build — matches the
  // mechanism-explainer and sitemap date handling.
  const dateModified =
    SITEMAP_DATES[`${HUB_PATH}${study.slug}/`] ?? study.datePublished;
  const wordCount = caseStudyWordCount(study);
  const timeRequired = `PT${Math.max(1, Math.round(wordCount / WORDS_PER_MINUTE))}M`;
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
    articleSection: study.eyebrow,
    about: {
      "@type": "DefinedTerm",
      name: getMechanismArchetypeLabel(study.archetype),
      termCode: study.archetype,
      url: `${SITE_ORIGIN}${getMechanismExplainerPath(study.archetype)}`,
    },
    wordCount,
    timeRequired,
    datePublished: study.datePublished,
    dateModified,
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
