import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { TRACKED_STABLECOINS, TRACKED_META_BY_ID, ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { getStaticComparisonPagesForCoin } from "@/lib/compare-pages";
import { buildStablecoinDetailMetadata } from "@/lib/page-metadata";
import { safeJsonLd } from "@/lib/json-ld";
import { getRelatedStablecoins } from "@/lib/related-stablecoins";
import { buildStablecoinUrl } from "@/lib/urls";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { GOVERNANCE_LABELS, BACKING_LABELS, PEG_LABELS_SHORT } from "@shared/lib/classification";
import { StablecoinDetailLoadingShell } from "@/components/stablecoin-detail/loading-shell";
import { StaticHeroStrip } from "@/components/stablecoin-detail/static-hero-strip";
import { Skeleton } from "@/components/ui/skeleton";
import StablecoinDetailClient from "./client";
import { ExploreNextSection } from "@/components/stablecoin-detail/explore-next-section";
import { PreLaunchDetail } from "@/components/pre-launch-detail";
import aiSummaries from "../../../../data/ai-summaries.json";
import { logosById } from "@/lib/logos";

const typedSummaries = aiSummaries as Record<string, { title: string; text: string; updatedAt: string }>;

function DetailPageShellFallback({
  coin,
  logoSrc,
}: {
  coin: (typeof TRACKED_STABLECOINS)[number];
  logoSrc?: string;
}) {
  return (
    <div className="space-y-6" aria-hidden="true">
      <StablecoinDetailLoadingShell
        coin={coin}
        logoSrc={logoSrc}
        description="Loading the full research dossier: price, safety, liquidity, flows, and historical context."
        statusLabel="Research dossier loading"
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,0.7fr)]">
        <div className="space-y-6">
          <div className="pharos-card-shell p-4">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="mt-4 h-[320px] w-full rounded-xl" />
          </div>
          <div className="pharos-card-shell p-4">
            <Skeleton className="h-5 w-28" />
            <Skeleton className="mt-4 h-[260px] w-full rounded-xl" />
          </div>
        </div>

        <div className="space-y-6">
          <div className="pharos-card-shell p-4">
            <Skeleton className="h-5 w-24" />
            <Skeleton className="mt-4 h-[220px] w-full rounded-xl" />
          </div>
          <div className="pharos-card-shell p-4">
            <Skeleton className="h-5 w-36" />
            <Skeleton className="mt-4 h-[180px] w-full rounded-xl" />
          </div>
        </div>
      </div>
    </div>
  );
}

export function generateStaticParams() {
  return TRACKED_STABLECOINS.map((coin) => ({ id: coin.id }));
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const coin = TRACKED_META_BY_ID.get(id);

  if (!coin) {
    return { title: "Stablecoin Not Found" };
  }

  return buildStablecoinDetailMetadata(coin);
}

export default async function StablecoinDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const coin = TRACKED_META_BY_ID.get(id);

  if (!coin) {
    return (
      <div className="space-y-4 py-12 text-center">
        <h1 className="text-3xl font-extrabold tracking-tighter">Stablecoin Not Found</h1>
        <p className="text-muted-foreground">No stablecoin found with ID &ldquo;{id}&rdquo;.</p>
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          &larr; Back to Dashboard
        </Link>
      </div>
    );
  }

  if (coin.status === "pre-launch") {
    return (
      <PreLaunchDetail
        coin={coin}
        logoSrc={logosById[coin.id]}
        summary={typedSummaries[id] ?? null}
        logos={logosById}
      />
    );
  }

  const related = getRelatedStablecoins(coin, { candidates: ACTIVE_STABLECOINS });
  const staticComparisonPages = getStaticComparisonPagesForCoin(id);

  return (
    <>
      <StaticHeroStrip coin={coin} logoSrc={logosById[coin.id]} />
      <Suspense fallback={
        <DetailPageShellFallback coin={coin} logoSrc={logosById[coin.id]} />
      }>
        <StablecoinDetailClient id={id} summary={typedSummaries[id] ?? null} coin={coin} logoSrc={logosById[coin.id]} />
      </Suspense>
      <ExploreNextSection
        coin={coin}
        related={related}
        staticComparisonPages={staticComparisonPages.map((page) => ({
          href: page.href,
          shortTitle: page.shortTitle,
          leftId: page.left.id,
          rightId: page.right.id,
        }))}
        logos={logosById}
      />
      <BreadcrumbJsonLd
        items={[
          { name: "Home", url: "/" },
          { name: "Stablecoins", url: "/stablecoins/" },
          { name: `${coin.name} (${coin.symbol})`, url: buildStablecoinUrl(id) },
        ]}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: safeJsonLd({
            "@context": "https://schema.org",
            "@type": "Dataset",
            "@id": `${SITE_URL}${buildStablecoinUrl(id)}#dataset`,
            name: `${coin.name} Stablecoin Analytics`,
            description: `Live analytics for ${coin.name} (${coin.symbol}). ${GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance} stablecoin, ${BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing}, pegged to ${PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency}. Price, market cap, supply trends, chain distribution, peg score, and depeg history.`,
            url: `${SITE_URL}${buildStablecoinUrl(id)}`,
            creator: {
              "@type": "Organization",
              name: "Pharos",
              url: SITE_URL,
            },
            publisher: { "@id": `${SITE_URL}#organization` },
            isAccessibleForFree: true,
            license: "https://creativecommons.org/licenses/by/4.0/",
            keywords: [
              coin.symbol,
              coin.name,
              "stablecoin",
              GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance,
              BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing,
              PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency,
              "analytics",
              "peg tracking",
            ],
            identifier: [
              ...(coin.geckoId ? [{ "@type": "PropertyValue", propertyID: "geckoId", value: coin.geckoId }] : []),
              ...(coin.contracts ?? []).map((contract) => ({
                "@type": "PropertyValue",
                propertyID: `contract:${contract.chain}`,
                value: contract.address,
              })),
            ],
            variableMeasured: [
              { "@type": "PropertyValue", name: "price", unitText: "USD" },
              { "@type": "PropertyValue", name: "marketCap", unitText: "USD" },
              { "@type": "PropertyValue", name: "circulatingSupply", unitText: coin.symbol },
              { "@type": "PropertyValue", name: "pegScore", minValue: 0, maxValue: 100 },
              { "@type": "PropertyValue", name: "dewsScore", minValue: 0, maxValue: 100 },
              { "@type": "PropertyValue", name: "safetyGrade" },
            ],
            dateModified: new Date().toISOString(),
            spatialCoverage: { "@type": "Place", name: "Global" },
            measurementTechnique:
              "Aggregated supply and price from DefiLlama, CoinGecko, GeckoTerminal, Pyth, Chainlink and on-chain RPCs; normalized in a Cloudflare Worker pipeline.",
            distribution: [
              {
                "@type": "DataDownload",
                name: `${coin.name} detail JSON`,
                encodingFormat: "application/json",
                contentUrl: `${SITE_URL}/_site-data/stablecoin/${id}`,
              },
            ],
          }),
        }}
      />
    </>
  );
}
