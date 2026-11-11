import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types/core";
import type { MechanismArchetype } from "@shared/types";
import {
  getMechanismArchetypeLabel,
  getMechanismExplainerPath,
} from "@shared/lib/classification";
import { buildPageMetadata } from "@/lib/page-metadata";
import { createStaticSlugRoute } from "@/lib/static-slug-page";
import { ArchetypeArticleJsonLd } from "@/lib/mechanism-json-ld";
import { MECHANISM_EXPLAINER_METADATA } from "@/lib/mechanism-explainer-registry";
import { LearnPageShell } from "../../_shared/learn-page-shell";
import { ARCHETYPE_CONTENT } from "@/lib/mechanism-explainers";
import { ArchetypeExplainerBody } from "../explainer-shell";

const ARCHETYPE_BY_SLUG = new Map<string, MechanismArchetype>(
  MECHANISM_ARCHETYPE_VALUES.map((archetype) => [archetype, archetype]),
);

function renderArchetypeExplainer(slug: MechanismArchetype) {
  const content = ARCHETYPE_CONTENT[slug];
  const label = getMechanismArchetypeLabel(slug);
  const explainerPath = getMechanismExplainerPath(slug);

  return (
    <LearnPageShell
      breadcrumbItems={[
        { name: "Home", url: "/" },
        { name: "Mechanisms", url: "/learn/mechanisms/" },
        { name: label, url: explainerPath },
      ]}
      title={content.headline}
      subtitle={content.subtitle}
      leadParagraphs={content.lead}
      titleClassName="max-w-[22ch]"
    >
      <ArchetypeArticleJsonLd archetype={slug} />
      <ArchetypeExplainerBody content={content} />
    </LearnPageShell>
  );
}

const route = createStaticSlugRoute({
  paramKey: "archetype",
  pages: MECHANISM_ARCHETYPE_VALUES,
  pageBySlug: ARCHETYPE_BY_SLUG,
  getSlug: (archetype) => archetype,
  metadata: (slug) => buildPageMetadata({
    title: MECHANISM_EXPLAINER_METADATA[slug].title,
    description: MECHANISM_EXPLAINER_METADATA[slug].description,
    canonical: getMechanismExplainerPath(slug),
    ogImage: "/og-editorial-learn.png",
  }),
  missingMetadata: { title: "Not Found", robots: { index: false } },
  render: renderArchetypeExplainer,
});

export const generateStaticParams = route.generateStaticParams;
export const generateMetadata = route.generateMetadata;
export default route.Page;
