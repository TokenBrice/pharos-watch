import Link from "next/link";
import { FeaturePageShell } from "@/components/feature-page-shell";
import type { BreadcrumbItem } from "@/components/breadcrumb-json-ld";
import { buildCollectionItemListJsonLd, safeJsonLd } from "@/lib/json-ld";
import { buildStablecoinUrl } from "@/lib/urls";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";

type TaxonomyShellCoin = {
  id: string;
  name: string;
  symbol: string;
};

interface StablecoinTaxonomyShellProps {
  title: string;
  href: string;
  description: string;
  intro: string;
  shortLabel: string;
  coins: TaxonomyShellCoin[];
  directoryDescription: string;
  definedTermCode?: string;
  definedTermSetHref?: string;
  breadcrumbItems?: BreadcrumbItem[];
  relatedPages?: ReadonlyArray<{
    href: string;
    title: string;
    coins: readonly TaxonomyShellCoin[];
  }>;
  children: React.ReactNode;
}

const DIRECTORY_PREVIEW_COUNT = 24;
const LINKED_DIRECTORIES = [
  {
    href: "/stablecoins/",
    title: "All stablecoins",
    description: "Return to the full active stablecoin directory.",
  },
  {
    href: "/coverage/",
    title: "Coverage matrix",
    description: "Check which Pharos surfaces are available per asset.",
  },
  {
    href: "/safety-scores/",
    title: "Safety Scores",
    description: "Compare risk grades and dependency exposure.",
  },
  {
    href: "/liquidity/",
    title: "DEX liquidity",
    description: "Review exit depth and venue concentration.",
  },
] as const;

export function StablecoinTaxonomyShell({
  title,
  href,
  description,
  intro,
  shortLabel,
  coins,
  directoryDescription,
  definedTermCode,
  definedTermSetHref,
  breadcrumbItems,
  relatedPages = [],
  children,
}: StablecoinTaxonomyShellProps) {
  const visibleCoins = coins.slice(0, DIRECTORY_PREVIEW_COUNT);
  const overflowCoins = coins.slice(DIRECTORY_PREVIEW_COUNT);

  return (
    <FeaturePageShell
      breadcrumbName={title}
      path={href}
      breadcrumbItems={breadcrumbItems}
      title={title}
      leadParagraphs={[intro]}
      preface={
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: safeJsonLd(
              buildCollectionItemListJsonLd({
                url: `${SITE_URL}${href}`,
                name: title,
                description,
                itemListDescription: description,
                ...(definedTermCode && definedTermSetHref
                  ? {
                      about: {
                        "@type": "DefinedTerm",
                        name: title,
                        termCode: definedTermCode,
                        inDefinedTermSet: `${SITE_URL}${definedTermSetHref}`,
                      },
                    }
                  : {}),
                entries: coins.map((coin) => {
                  const url = `${SITE_URL}${buildStablecoinUrl(coin.id)}`;

                  return {
                    item: {
                      "@type": "WebPage",
                      "@id": url,
                      name: `${coin.name} (${coin.symbol})`,
                      url,
                    },
                  };
                }),
              }),
            ),
          }}
        />
      }
    >
      <section className="space-y-3">
        <div className="space-y-1.5">
          <h2 className="pharos-kicker">Stablecoin Directory</h2>
          <p className="text-sm text-muted-foreground">{directoryDescription}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {visibleCoins.map((coin) => (
            <Link
              key={coin.id}
              href={buildStablecoinUrl(coin.id)}
              className="pharos-focus-ring inline-flex items-center rounded-full border border-border/60 bg-background px-2.5 py-1 text-xs font-medium transition-colors hover:bg-accent"
            >
              {coin.name} ({coin.symbol})
            </Link>
          ))}
        </div>
        {overflowCoins.length > 0 && (
          <details className="rounded-lg border border-border/60 bg-muted/20">
            <summary className="pharos-focus-ring cursor-pointer px-4 py-3 text-sm font-medium">
              Show the remaining {overflowCoins.length} {shortLabel} stablecoins
            </summary>
            <div className="flex flex-wrap gap-2 px-4 pb-4">
              {overflowCoins.map((coin) => (
                <Link
                  key={coin.id}
                  href={buildStablecoinUrl(coin.id)}
                  className="pharos-focus-ring inline-flex items-center rounded-full border border-border/60 bg-background px-2.5 py-1 text-xs font-medium transition-colors hover:bg-accent"
                >
                  {coin.name} ({coin.symbol})
                </Link>
              ))}
            </div>
          </details>
        )}
        <p className="text-xs leading-relaxed text-muted-foreground">
          Source: checked-in StablecoinMeta profile fields in the current Pharos build. Counts and cohort membership are
          static directory context; use the live table below for current market, coverage, and risk data.
        </p>
      </section>

      <section className="space-y-3">
        <div className="space-y-1.5">
          <h2 className="pharos-kicker">
            How To Use This Directory
          </h2>
          <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
            Treat the {shortLabel} cohort as a starting filter, then verify the live risk surfaces that move fastest:
            coverage, peg history, liquidity, reserves, and dependency exposure.
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {LINKED_DIRECTORIES.map((directory) => (
            <Link
              key={directory.href}
              href={directory.href}
              className="pharos-focus-ring rounded-xl border border-border/60 bg-background/60 px-3 py-3 text-sm transition-colors hover:bg-accent"
            >
              <span className="block font-medium text-foreground">{directory.title}</span>
              <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{directory.description}</span>
            </Link>
          ))}
        </div>
      </section>

      {relatedPages.length > 0 && (
        <section className="space-y-3">
          <div className="space-y-1.5">
            <h2 className="pharos-kicker">
              More Stablecoin Hubs
            </h2>
            <p className="text-sm text-muted-foreground">
              Move laterally into related taxonomy pages without going back to the homepage.
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {relatedPages.map((relatedPage) => (
              <Link
                key={relatedPage.href}
                href={relatedPage.href}
                className="pharos-focus-ring rounded-xl border border-border/60 bg-background/60 px-3 py-3 text-sm transition-colors hover:bg-accent"
              >
                <span className="block font-medium text-foreground">{relatedPage.title}</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  <span className="pharos-numeric">{relatedPage.coins.length}</span> tracked coins
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {children}
    </FeaturePageShell>
  );
}
