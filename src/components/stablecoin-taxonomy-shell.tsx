import Link from "next/link";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { safeJsonLd } from "@/lib/json-ld";
import { buildStablecoinUrl } from "@/lib/urls";
import type { StablecoinMeta } from "@shared/types";

interface StablecoinTaxonomyShellProps {
  title: string;
  href: string;
  description: string;
  intro: string;
  shortLabel: string;
  coins: StablecoinMeta[];
  directoryDescription: string;
  relatedPages?: ReadonlyArray<{
    href: string;
    title: string;
    coins: StablecoinMeta[];
  }>;
  children: React.ReactNode;
}

const DIRECTORY_PREVIEW_COUNT = 24;

export function StablecoinTaxonomyShell({
  title,
  href,
  description,
  intro,
  shortLabel,
  coins,
  directoryDescription,
  relatedPages = [],
  children,
}: StablecoinTaxonomyShellProps) {
  const visibleCoins = coins.slice(0, DIRECTORY_PREVIEW_COUNT);
  const overflowCoins = coins.slice(DIRECTORY_PREVIEW_COUNT);

  return (
    <FeaturePageShell
      breadcrumbName={title}
      path={href}
      title={title}
      leadParagraphs={[intro]}
      preface={(
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: safeJsonLd({
              "@context": "https://schema.org",
              "@type": "ItemList",
              name: title,
              description,
              numberOfItems: coins.length,
              itemListElement: coins.map((coin, index) => ({
                "@type": "ListItem",
                position: index + 1,
                name: `${coin.name} (${coin.symbol})`,
                url: `https://pharos.watch${buildStablecoinUrl(coin.id)}`,
              })),
            }),
          }}
        />
      )}
    >
      <section className="space-y-3">
        <div className="space-y-1.5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Stablecoin Directory</h2>
          <p className="text-sm text-muted-foreground">{directoryDescription}</p>
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
              Show the remaining {overflowCoins.length} {shortLabel} stablecoins
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

      {relatedPages.length > 0 && (
        <section className="space-y-3">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">More Stablecoin Hubs</h2>
            <p className="text-sm text-muted-foreground">
              Move laterally into related taxonomy pages without going back to the homepage.
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
      )}

      {children}
    </FeaturePageShell>
  );
}
