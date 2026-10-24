import { FormerPegCoinsSection, PegAtAGlanceSection, UpcomingPegCoinsSection } from "@/components/peg-hub-sections";
import { StablecoinTaxonomyShell } from "@/components/stablecoin-taxonomy-shell";
import { TaxonomyHeaderActions } from "@/components/taxonomy-header-actions";
import { buildFormerPegCoinEntries, buildPegAtAGlanceRows, buildUpcomingPegCoinEntries } from "@/lib/peg-hub-content";
import { PEG_HUB_PAGES, PEG_TAXONOMY_PAGE_BY_SLUG } from "@/lib/peg-taxonomy";
import { ALL_STABLECOIN_TAXONOMY_PAGES } from "@/lib/stablecoin-taxonomy";
import { createStaticSlugRoute } from "@/lib/static-slug-page";
import { PegLandingClient } from "./client";

const route = createStaticSlugRoute({
  paramKey: "peg",
  pages: PEG_HUB_PAGES,
  pageBySlug: PEG_TAXONOMY_PAGE_BY_SLUG,
  missingTitle: "Peg Currency Not Found",
  ogImage: "/og-stablecoins.png",
  render: (page) => {
    const atAGlance = buildPegAtAGlanceRows(page.value, page.coins);
    const upcoming = (
      <UpcomingPegCoinsSection shortLabel={page.shortLabel} entries={buildUpcomingPegCoinEntries(page.upcomingCoins)} />
    );
    const former = <FormerPegCoinsSection shortLabel={page.shortLabel} entries={buildFormerPegCoinEntries(page.value)} />;

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
        aboutParagraphs={[page.intro, page.riskSummary]}
        shortLabel={page.shortLabel}
        coins={page.coins}
        directoryDescription={
          page.preLaunchOnly
            ? `Browse all ${page.coins.length} upcoming ${page.shortLabel} stablecoins by profile.`
            : `Browse all ${page.coins.length} tracked ${page.shortLabel} stablecoins by profile.`
        }
        directoryNote={
          page.preLaunchOnly
            ? "Membership comes from the Pharos stablecoin registry in this build. None of these coins has launched, so no market, coverage or risk data exists yet."
            : undefined
        }
        definedTermCode={String(page.value)}
        definedTermSetHref="/stablecoins/"
        relatedPages={ALL_STABLECOIN_TAXONOMY_PAGES.slice(0, 6)}
        headerActions={
          page.preLaunchOnly ? undefined : (
            <TaxonomyHeaderActions
              shortLabel={page.shortLabel}
              topCoinIds={page.topCoins.map((coin) => coin.id)}
              bucketNoun="currency bucket"
            />
          )
        }
        staticSections={
          page.preLaunchOnly ? (
            former
          ) : (
            <>
              <PegAtAGlanceSection shortLabel={page.shortLabel} {...atAGlance} />
              {upcoming}
              {former}
            </>
          )
        }
      >
        {/* A pre-launch-only hub has no live market rows to filter: its upcoming list is the main content. */}
        {page.preLaunchOnly ? upcoming : <PegLandingClient pegCurrency={page.value} />}
      </StablecoinTaxonomyShell>
    );
  },
});

export const generateStaticParams = route.generateStaticParams;
export const generateMetadata = route.generateMetadata;
export default route.Page;
