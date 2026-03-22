import { notFound } from "next/navigation";
import { StablecoinTaxonomyPage } from "@/components/stablecoin-taxonomy-page";
import {
  BACKING_TAXONOMY_PAGE_BY_SLUG,
  BACKING_TAXONOMY_PAGES,
} from "@/lib/stablecoin-taxonomy";
import { buildSlugPageMetadata, buildSlugStaticParams, resolveSlugPage } from "@/lib/static-slug-page";

export function generateStaticParams() {
  return buildSlugStaticParams("backing", BACKING_TAXONOMY_PAGES);
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ backing: string }>;
}) {
  return buildSlugPageMetadata(params, "backing", BACKING_TAXONOMY_PAGE_BY_SLUG, "Backing Type Not Found | Pharos");
}

export default async function BackingTaxonomyPage({
  params,
}: {
  params: Promise<{ backing: string }>;
}) {
  const page = await resolveSlugPage(params, "backing", BACKING_TAXONOMY_PAGE_BY_SLUG);
  if (!page) notFound();

  return <StablecoinTaxonomyPage page={page} />;
}
