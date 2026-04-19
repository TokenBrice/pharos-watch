import { notFound } from "next/navigation";
import { StablecoinTaxonomyShell } from "@/components/stablecoin-taxonomy-shell";
import { PEG_TAXONOMY_PAGES, PEG_TAXONOMY_PAGE_BY_SLUG } from "@/lib/peg-taxonomy";
import { ALL_STABLECOIN_TAXONOMY_PAGES } from "@/lib/stablecoin-taxonomy";
import { buildSlugPageMetadata, buildSlugStaticParams, resolveSlugPage } from "@/lib/static-slug-page";
import { PegLandingClient } from "./client";

export function generateStaticParams() {
  return buildSlugStaticParams("peg", PEG_TAXONOMY_PAGES);
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ peg: string }>;
}) {
  return buildSlugPageMetadata(params, "peg", PEG_TAXONOMY_PAGE_BY_SLUG, "Peg Currency Not Found");
}

export default async function PegLandingPage({
  params,
}: {
  params: Promise<{ peg: string }>;
}) {
  const page = await resolveSlugPage(params, "peg", PEG_TAXONOMY_PAGE_BY_SLUG);
  if (!page) notFound();

  return (
    <StablecoinTaxonomyShell
      title={page.title}
      href={page.href}
      breadcrumbItems={[
        { name: "Home", url: "/" },
        { name: "Stablecoins", url: "/stablecoins/" },
        { name: page.title, url: page.href },
      ]}
      description={page.description}
      intro={page.intro}
      shortLabel={page.shortLabel}
      coins={page.coins}
      directoryDescription={`Browse all ${page.coins.length} tracked ${page.shortLabel} stablecoins before opening the live table.`}
      relatedPages={ALL_STABLECOIN_TAXONOMY_PAGES.slice(0, 6)}
    >
      <PegLandingClient pegCurrency={page.value} />
    </StablecoinTaxonomyShell>
  );
}
