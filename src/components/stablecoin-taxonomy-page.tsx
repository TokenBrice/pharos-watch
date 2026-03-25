import Link from "next/link";
import type { BackingType, GovernanceType } from "@shared/types";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { StablecoinFilteredTable } from "@/components/stablecoin-filtered-table";
import type { ProtocolTaxonomyValue, StablecoinTaxonomyPage as StablecoinTaxonomyPageConfig } from "@/lib/stablecoin-taxonomy";
import { ALL_STABLECOIN_TAXONOMY_PAGES } from "@/lib/stablecoin-taxonomy";
import { buildStablecoinUrl } from "@/lib/urls";

interface StablecoinTaxonomyPageProps {
  page: StablecoinTaxonomyPageConfig<BackingType | GovernanceType | ProtocolTaxonomyValue>;
}

const DIRECTORY_PREVIEW_COUNT = 24;

export function StablecoinTaxonomyPage({ page }: StablecoinTaxonomyPageProps) {
  const visibleCoins = page.coins.slice(0, DIRECTORY_PREVIEW_COUNT);
  const overflowCoins = page.coins.slice(DIRECTORY_PREVIEW_COUNT);
  const relatedPages = ALL_STABLECOIN_TAXONOMY_PAGES.filter((candidate) => candidate.href !== page.href).slice(0, 6);

  return (
    <FeaturePageShell
      breadcrumbName={page.title}
      path={page.href}
      title={page.title}
      leadParagraphs={[page.intro]}
      preface={
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "ItemList",
              name: page.title,
              description: page.description,
              numberOfItems: page.coins.length,
              itemListElement: page.coins.map((coin, index) => ({
                "@type": "ListItem",
                position: index + 1,
                name: `${coin.name} (${coin.symbol})`,
                url: `https://pharos.watch${buildStablecoinUrl(coin.id)}`,
              })),
            }),
          }}
        />
      }
    >
      <section className="space-y-3">
        <div className="space-y-1.5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Stablecoin Directory</h2>
          <p className="text-sm text-muted-foreground">
            Browse the current {page.coins.length} tracked stablecoin{page.coins.length !== 1 ? "s" : ""} in this
            taxonomy before opening the live table.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {visibleCoins.map((coin) => (
            <Link
              key={coin.id}
              href={buildStablecoinUrl(coin.id)}
              className="inline-flex items-center rounded-full border border-border/60 bg-background px-2.5 py-1 text-xs font-medium transition-colors hover:bg-accent"
            >
              {coin.name} ({coin.symbol})
            </Link>
          ))}
        </div>
        {overflowCoins.length > 0 && (
          <details className="rounded-lg border border-border/60 bg-muted/20">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
              Show the remaining {overflowCoins.length} {page.shortLabel} stablecoins
            </summary>
            <div className="flex flex-wrap gap-2 px-4 pb-4">
              {overflowCoins.map((coin) => (
                <Link
                  key={coin.id}
                  href={buildStablecoinUrl(coin.id)}
                  className="inline-flex items-center rounded-full border border-border/60 bg-background px-2.5 py-1 text-xs font-medium transition-colors hover:bg-accent"
                >
                  {coin.name} ({coin.symbol})
                </Link>
              ))}
            </div>
          </details>
        )}
      </section>

      <section className="space-y-3">
        <div className="space-y-1.5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">More Stablecoin Hubs</h2>
          <p className="text-sm text-muted-foreground">
            Move laterally into other governance, backing, and protocol taxonomies without going back to the homepage.
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {relatedPages.map((relatedPage) => (
            <Link
              key={relatedPage.href}
              href={relatedPage.href}
              className="rounded-xl border border-border/60 bg-background/60 px-3 py-3 text-sm transition-colors hover:bg-accent"
            >
              <span className="block font-medium text-foreground">{relatedPage.title}</span>
              <span className="mt-1 block text-xs text-muted-foreground">{relatedPage.coins.length} tracked coins</span>
            </Link>
          ))}
        </div>
      </section>

      <StablecoinFilteredTable activeFilters={[page.filterTag]} />
    </FeaturePageShell>
  );
}
