import { notFound } from "next/navigation";
import { StablecoinTaxonomyPage } from "@/components/stablecoin-taxonomy-page";
import {
  GOVERNANCE_TAXONOMY_PAGE_BY_SLUG,
  GOVERNANCE_TAXONOMY_PAGES,
} from "@/lib/stablecoin-taxonomy";
import { buildSlugPageMetadata, buildSlugStaticParams, resolveSlugPage } from "@/lib/static-slug-page";

export function generateStaticParams() {
  return buildSlugStaticParams("governance", GOVERNANCE_TAXONOMY_PAGES);
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ governance: string }>;
}) {
  return buildSlugPageMetadata(
    params,
    "governance",
    GOVERNANCE_TAXONOMY_PAGE_BY_SLUG,
    "Governance Type Not Found",
  );
}

export default async function GovernanceTaxonomyPage({
  params,
}: {
  params: Promise<{ governance: string }>;
}) {
  const page = await resolveSlugPage(params, "governance", GOVERNANCE_TAXONOMY_PAGE_BY_SLUG);
  if (!page) notFound();

  return <StablecoinTaxonomyPage page={page} />;
}
