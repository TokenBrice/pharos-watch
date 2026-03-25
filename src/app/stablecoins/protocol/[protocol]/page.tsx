import { notFound } from "next/navigation";
import { StablecoinTaxonomyPage } from "@/components/stablecoin-taxonomy-page";
import {
  PROTOCOL_TAXONOMY_PAGE_BY_SLUG,
  PROTOCOL_TAXONOMY_PAGES,
} from "@/lib/stablecoin-taxonomy";
import { buildSlugPageMetadata, buildSlugStaticParams, resolveSlugPage } from "@/lib/static-slug-page";

export function generateStaticParams() {
  return buildSlugStaticParams("protocol", PROTOCOL_TAXONOMY_PAGES);
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ protocol: string }>;
}) {
  return buildSlugPageMetadata(params, "protocol", PROTOCOL_TAXONOMY_PAGE_BY_SLUG, "Protocol Cohort Not Found | Pharos");
}

export default async function ProtocolTaxonomyPage({
  params,
}: {
  params: Promise<{ protocol: string }>;
}) {
  const page = await resolveSlugPage(params, "protocol", PROTOCOL_TAXONOMY_PAGE_BY_SLUG);
  if (!page) notFound();

  return <StablecoinTaxonomyPage page={page} />;
}
