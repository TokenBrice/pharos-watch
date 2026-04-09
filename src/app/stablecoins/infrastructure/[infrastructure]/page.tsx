import { notFound } from "next/navigation";
import { StablecoinTaxonomyPage } from "@/components/stablecoin-taxonomy-page";
import {
  INFRASTRUCTURE_TAXONOMY_PAGE_BY_SLUG,
  INFRASTRUCTURE_TAXONOMY_PAGES,
} from "@/lib/stablecoin-taxonomy";
import { buildSlugPageMetadata, buildSlugStaticParams, resolveSlugPage } from "@/lib/static-slug-page";

export function generateStaticParams() {
  return buildSlugStaticParams("infrastructure", INFRASTRUCTURE_TAXONOMY_PAGES);
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ infrastructure: string }>;
}) {
  return buildSlugPageMetadata(params, "infrastructure", INFRASTRUCTURE_TAXONOMY_PAGE_BY_SLUG, "Infrastructure Cohort Not Found | Pharos");
}

export default async function InfrastructureTaxonomyRoute({
  params,
}: {
  params: Promise<{ infrastructure: string }>;
}) {
  const page = await resolveSlugPage(params, "infrastructure", INFRASTRUCTURE_TAXONOMY_PAGE_BY_SLUG);
  if (!page) notFound();

  return <StablecoinTaxonomyPage page={page} />;
}
