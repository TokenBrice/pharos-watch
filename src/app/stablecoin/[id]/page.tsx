import type { Metadata } from "next";
import Link from "next/link";
import { TRACKED_STABLECOINS, TRACKED_META_BY_ID, ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { getStaticComparisonPagesForCoin } from "@/lib/compare-pages";
import { buildStablecoinDetailMetadata } from "@/lib/page-metadata";
import { safeJsonLd } from "@/lib/json-ld";
import { buildStablecoinUrl } from "@/lib/urls";
import { GOVERNANCE_LABELS, BACKING_LABELS, PEG_LABELS_SHORT } from "@shared/lib/classification";
import StablecoinDetailClient from "./client";
import { ExploreNextSection } from "@/components/stablecoin-detail/explore-next-section";
import { PreLaunchDetail } from "@/components/pre-launch-detail";
import logos from "../../../../data/logos.json";
import aiSummaries from "../../../../data/ai-summaries.json";

const typedSummaries = aiSummaries as Record<string, { title: string; text: string; updatedAt: string }>;

export function generateStaticParams() {
  return TRACKED_STABLECOINS.map((coin) => ({ id: coin.id }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const coin = TRACKED_META_BY_ID.get(id);

  if (!coin) {
    return { title: "Stablecoin Not Found" };
  }

  return buildStablecoinDetailMetadata(coin);
}

function getRelatedStablecoins(coinId: string, limit = 6) {
  const coin = TRACKED_META_BY_ID.get(coinId);
  if (!coin) return [];

  const others = ACTIVE_STABLECOINS.filter((s) => s.id !== coinId);

  // Score by similarity: same governance (3pts), same backing (2pts), same peg (1pt)
  const scored = others.map((s) => {
    let score = 0;
    if (s.flags.governance === coin.flags.governance) score += 3;
    if (s.flags.backing === coin.flags.backing) score += 2;
    if (s.flags.pegCurrency === coin.flags.pegCurrency) score += 1;
    return { coin: s, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.coin);
}

export default async function StablecoinDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const coin = TRACKED_META_BY_ID.get(id);
  const typedLogos = logos as Record<string, string>;

  if (!coin) {
    return (
      <div className="space-y-4 py-12 text-center">
        <h1 className="text-3xl font-extrabold tracking-tighter">Stablecoin Not Found</h1>
        <p className="text-muted-foreground">No stablecoin found with ID &ldquo;{id}&rdquo;.</p>
        <Link href="/" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
          &larr; Back to Dashboard
        </Link>
      </div>
    );
  }

  if (coin.status === "pre-launch") {
    return (
      <PreLaunchDetail
        coin={coin}
        logoSrc={typedLogos[coin.id]}
        summary={typedSummaries[id] ?? null}
        logos={typedLogos}
      />
    );
  }

  const related = getRelatedStablecoins(id);
  const staticComparisonPages = getStaticComparisonPagesForCoin(id);

  return (
    <>
      <div className="sr-only">
        <h1>{`${coin.name} (${coin.symbol}) Stablecoin Analytics`}</h1>
        <p>
          {`Live price, market cap, supply trends, chain distribution, peg score, and depeg history for ${coin.name}.`}
        </p>
      </div>
      <StablecoinDetailClient
        id={id}
        summary={typedSummaries[id] ?? null}
        coin={coin}
        logoSrc={typedLogos[coin.id]}
      />
      <ExploreNextSection
        coin={coin}
        related={related}
        staticComparisonPages={staticComparisonPages}
        logos={typedLogos}
      />
      <BreadcrumbJsonLd name={`${coin.name} (${coin.symbol})`} path={buildStablecoinUrl(id)} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: safeJsonLd({
            "@context": "https://schema.org",
            "@type": "Dataset",
            name: `${coin.name} Stablecoin Analytics`,
            description: `Live analytics for ${coin.name} (${coin.symbol}). ${GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance} stablecoin, ${BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing}, pegged to ${PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency}. Price, market cap, supply trends, chain distribution, peg score, and depeg history.`,
            url: `https://pharos.watch${buildStablecoinUrl(id)}`,
            creator: {
              "@type": "Organization",
              name: "Pharos",
              url: "https://pharos.watch",
            },
            isAccessibleForFree: true,
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
          }),
        }}
      />
    </>
  );
}
