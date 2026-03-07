import { notFound } from "next/navigation";
import { StablecoinTaxonomyPage } from "@/components/stablecoin-taxonomy-page";
import { buildPageMetadata } from "@/lib/page-metadata";
import {
  BACKING_TAXONOMY_PAGE_BY_SLUG,
  BACKING_TAXONOMY_PAGES,
} from "@/lib/stablecoin-taxonomy";

export function generateStaticParams() {
  return BACKING_TAXONOMY_PAGES.map((page) => ({ backing: page.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ backing: string }>;
}) {
  const { backing } = await params;
  const page = BACKING_TAXONOMY_PAGE_BY_SLUG.get(backing);
  if (!page) return {};

  return buildPageMetadata({
    title: page.title,
    description: page.description,
    canonical: page.href,
  });
}

export default async function BackingTaxonomyPage({
  params,
}: {
  params: Promise<{ backing: string }>;
}) {
  const { backing } = await params;
  const page = BACKING_TAXONOMY_PAGE_BY_SLUG.get(backing);
  if (!page) notFound();

  return <StablecoinTaxonomyPage page={page} />;
}
