import Link from "next/link";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { PEG_CURRENCY_COUNT } from "@shared/lib/classification";
import { CHAIN_META } from "@shared/lib/chains";
import { HomepageClient } from "@/components/homepage-client";
import { KpiBar } from "@/components/kpi-bar";
import { SiteHeader } from "@/components/site-header";
import { STATIC_COMPARISON_PAGES } from "@/lib/compare-pages";
import { STABLECOIN_TAXONOMY_PAGES } from "@/lib/stablecoin-taxonomy";
import { buildStablecoinUrl } from "@/lib/urls";

export default function HomePage() {
  const total = TRACKED_STABLECOINS.length;
  const featuredCoins = TRACKED_STABLECOINS.slice(0, 24);

  // Top 20 stablecoins for ItemList schema
  const itemListElements = TRACKED_STABLECOINS.slice(0, 20).map((coin, i) => ({
    "@type": "ListItem" as const,
    position: i + 1,
    name: `${coin.name} (${coin.symbol})`,
    url: `https://pharos.watch${buildStablecoinUrl(coin.id)}`,
  }));
  const itemListCount = itemListElements.length;

  return (
    <div className="space-y-6">
      <h1 className="sr-only">Pharos — Stablecoin Analytics Dashboard</h1>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "ItemList",
            name: "Top Tracked Stablecoins",
            description: `${total} stablecoins tracked by Pharos across every major chain.`,
            numberOfItems: itemListCount,
            itemListElement: itemListElements,
          }),
        }}
      />
      <div className="space-y-3">
        <SiteHeader total={total} pegCount={PEG_CURRENCY_COUNT} chainCount={Object.keys(CHAIN_META).length} />
        <KpiBar />
      </div>
      <section className="space-y-4 rounded-[1.75rem] border border-border/60 bg-card/60 px-4 py-5 shadow-[0_18px_40px_oklch(0_0_0_/0.08)]">
        <div className="space-y-2">
          <h2 className="text-xl font-semibold tracking-tight text-foreground">Stablecoin Hubs</h2>
          <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
            Start with the largest tracked stablecoins, then pivot into static taxonomy hubs and curated comparison
            pages. These blocks are intentionally server-rendered so important entities stay discoverable without waiting
            on client data.
          </p>
        </div>
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                Top Stablecoin Directory
              </h3>
              <span className="text-xs text-muted-foreground">Top {featuredCoins.length} by tracked market cap order</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {featuredCoins.map((coin) => (
                <Link
                  key={coin.id}
                  href={buildStablecoinUrl(coin.id)}
                  className="inline-flex items-center rounded-full border border-border/60 bg-background px-2.5 py-1 text-xs font-medium transition-colors hover:bg-accent"
                >
                  {coin.name} ({coin.symbol})
                </Link>
              ))}
            </div>
          </section>
          <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-1">
            <section className="space-y-3">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Browse By Structure</h3>
              <div className="grid gap-2 sm:grid-cols-2">
                {STABLECOIN_TAXONOMY_PAGES.map((page) => (
                  <Link
                    key={page.href}
                    href={page.href}
                    className="rounded-xl border border-border/60 bg-background/70 px-3 py-3 text-sm transition-colors hover:bg-accent"
                  >
                    <span className="block font-medium text-foreground">{page.title}</span>
                    <span className="mt-1 block text-xs text-muted-foreground">{page.coins.length} tracked coins</span>
                  </Link>
                ))}
              </div>
            </section>
            <section className="space-y-3">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                Popular Stablecoin Comparisons
              </h3>
              <div className="grid gap-2 sm:grid-cols-2">
                {STATIC_COMPARISON_PAGES.map((page) => (
                  <Link
                    key={page.href}
                    href={page.href}
                    className="rounded-xl border border-border/60 bg-background/70 px-3 py-3 text-sm transition-colors hover:bg-accent"
                  >
                    <span className="block font-medium text-foreground">{page.shortTitle}</span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {page.left.name} vs {page.right.name}
                    </span>
                  </Link>
                ))}
              </div>
            </section>
          </div>
        </div>
      </section>
      <HomepageClient />
    </div>
  );
}
