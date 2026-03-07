import { notFound } from "next/navigation";
import { StablecoinTaxonomyPage } from "@/components/stablecoin-taxonomy-page";
import { buildPageMetadata } from "@/lib/page-metadata";
import {
  GOVERNANCE_TAXONOMY_PAGE_BY_SLUG,
  GOVERNANCE_TAXONOMY_PAGES,
} from "@/lib/stablecoin-taxonomy";

export function generateStaticParams() {
  return GOVERNANCE_TAXONOMY_PAGES.map((page) => ({ governance: page.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ governance: string }>;
}) {
  const { governance } = await params;
  const page = GOVERNANCE_TAXONOMY_PAGE_BY_SLUG.get(governance);
  if (!page) return {};

  return buildPageMetadata({
    title: page.title,
    description: page.description,
    canonical: page.href,
  });
}

export default async function GovernanceTaxonomyPage({
  params,
}: {
  params: Promise<{ governance: string }>;
}) {
  const { governance } = await params;
  const page = GOVERNANCE_TAXONOMY_PAGE_BY_SLUG.get(governance);
  if (!page) notFound();

  return <StablecoinTaxonomyPage page={page} />;
}
