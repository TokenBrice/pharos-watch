import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import {
  getMechanismArchetypeLabel,
  getMechanismExplainerPath,
} from "@shared/lib/classification";
import { buildArticleJsonLd, safeJsonLd } from "@/lib/json-ld";
import sitemapDates from "@/generated/sitemap-dates.json";
import type { CaseStudy } from "@/lib/case-studies/types";
import {
  caseStudyWordCount,
  estimateCaseStudyReadingMinutes,
} from "./case-study-reading-time";

const HUB_PATH = "/learn/case-studies/";
const SITEMAP_DATES = sitemapDates as Record<string, string>;

function caseStudyUrl(slug: string): string {
  return `${SITE_ORIGIN}${HUB_PATH}${slug}/`;
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
  const timeRequired = `PT${estimateCaseStudyReadingMinutes(study)}M`;
  const archetypeLabel = getMechanismArchetypeLabel(study.archetype);
  return buildArticleJsonLd({
    id: url,
    headline: study.title,
    description: study.metaDescription,
    url,
    mainEntityOfPage: url,
    image: `${SITE_ORIGIN}/og-learn-case-${study.slug}.png`,
    inLanguage: "en",
    keywords: [
      study.eyebrow,
      archetypeLabel,
      study.outcome,
      ...(study.relatedCoins ?? []).map((coin) => coin.coinId),
      study.primaryCoinId,
    ].filter((keyword): keyword is string => Boolean(keyword)),
    datePublished: study.datePublished.includes("T")
      ? study.datePublished
      : `${study.datePublished}T00:00:00Z`,
    dateModified,
    extra: {
      isPartOf: `${SITE_ORIGIN}${HUB_PATH}`,
      articleSection: study.eyebrow,
      about: {
        "@type": "DefinedTerm",
        name: archetypeLabel,
        termCode: study.archetype,
        url: `${SITE_ORIGIN}${getMechanismExplainerPath(study.archetype)}`,
      },
      citation: study.sources.map((source) => ({
        "@type": "CreativeWork",
        name: source.label,
        url: source.href,
      })),
      wordCount,
      timeRequired,
    },
  });
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
    itemListElement: studies.map((study, index) => {
      const url = caseStudyUrl(study.slug);
      return {
        "@type": "ListItem",
        position: index + 1,
        url,
        name: study.title,
        item: {
          "@type": "Article",
          "@id": url,
          name: study.title,
          description: study.subtitle,
          image: `${SITE_ORIGIN}/og-learn-case-${study.slug}.png`,
        },
      };
    }),
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
