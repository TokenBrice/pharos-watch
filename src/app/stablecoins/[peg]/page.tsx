import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { safeJsonLd } from "@/lib/json-ld";
import {
  ACTIVE_PEGS,
  PEG_SLUGS,
  SLUG_TO_PEG,
  PEG_INTRO,
  PEG_LABELS,
  PEG_LABELS_SHORT,
  pegCoinCount,
} from "@/lib/peg-landing";
import { buildStablecoinUrl } from "@/lib/urls";
import { PegLandingClient } from "./client";

export function generateStaticParams() {
  return ACTIVE_PEGS.map((peg) => ({ peg: PEG_SLUGS[peg]! }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ peg: string }>;
}): Promise<Metadata> {
  const { peg } = await params;
  const pegCurrency = SLUG_TO_PEG[peg];
  if (!pegCurrency) return {};
  const count = pegCoinCount(pegCurrency);
  const label = PEG_LABELS_SHORT[pegCurrency];
  const slug = PEG_SLUGS[pegCurrency]!;
  const description = `${count} stablecoin${count !== 1 ? "s" : ""} pegged to ${PEG_LABELS[pegCurrency]}. Compare prices, market caps, peg stability, and DEX liquidity on Pharos.`;
  return {
    title: `${label} Stablecoins`,
    description,
    alternates: { canonical: `/stablecoins/${slug}/` },
    openGraph: {
      title: `${label} Stablecoins | Pharos`,
      description,
      url: `/stablecoins/${slug}/`,
      type: "website",
      images: [{ url: "/og-card.png", width: 1200, height: 628 }],
    },
    twitter: {
      images: [{ url: "/og-card.png", width: 1200, height: 628 }],
    },
  };
}

export default async function PegLandingPage({
  params,
}: {
  params: Promise<{ peg: string }>;
}) {
  const { peg } = await params;
  const pegCurrency = SLUG_TO_PEG[peg];
  if (!pegCurrency) notFound();

  const label = PEG_LABELS_SHORT[pegCurrency];
  const slug = PEG_SLUGS[pegCurrency]!;
  const intro = PEG_INTRO[pegCurrency];

  // Build ItemList schema for all coins in this peg
  const coins = TRACKED_STABLECOINS.filter(
    (c) => c.flags.pegCurrency === pegCurrency,
  );

  return (
    <FeaturePageShell
      breadcrumbName={`${label} Stablecoins`}
      path={`/stablecoins/${slug}/`}
      title={`${label} Stablecoins`}
      leadParagraphs={intro ? [intro] : []}
      preface={(
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: safeJsonLd({
              "@context": "https://schema.org",
              "@type": "ItemList",
              name: `${label} Stablecoins`,
              description: `${coins.length} stablecoin${coins.length !== 1 ? "s" : ""} pegged to ${PEG_LABELS[pegCurrency]}, tracked by Pharos.`,
              numberOfItems: coins.length,
              itemListElement: coins.map((coin, i) => ({
                "@type": "ListItem",
                position: i + 1,
                name: `${coin.name} (${coin.symbol})`,
                url: `https://pharos.watch${buildStablecoinUrl(coin.id)}`,
              })),
            }),
          }}
        />
      )}
    >

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Stablecoin Directory
        </h2>
        <details className="rounded-lg border border-border/60 bg-muted/20">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
            Browse all {coins.length} {label} stablecoins
          </summary>
          <div className="flex flex-wrap gap-2 px-4 pb-4">
            {coins.map((coin) => (
              <Link
                key={coin.id}
                href={buildStablecoinUrl(coin.id)}
                className="inline-flex items-center rounded-full border bg-background px-2.5 py-1 text-xs font-medium hover:bg-accent transition-colors"
              >
                {coin.name} ({coin.symbol})
              </Link>
            ))}
          </div>
        </details>
      </section>

      <PegLandingClient pegCurrency={pegCurrency} />
    </FeaturePageShell>
  );
}
