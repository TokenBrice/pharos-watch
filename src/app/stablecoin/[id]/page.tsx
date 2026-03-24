import { Suspense } from "react";
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { TRACKED_STABLECOINS, TRACKED_META_BY_ID, ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { getStaticComparisonPagesForCoin } from "@/lib/compare-pages";
import { buildStablecoinDetailMetadata } from "@/lib/page-metadata";
import { safeJsonLd } from "@/lib/json-ld";
import { getRelatedStablecoins } from "@/lib/related-stablecoins";
import { buildStablecoinUrl } from "@/lib/urls";
import { GOVERNANCE_LABELS, BACKING_LABELS, PEG_LABELS_SHORT } from "@shared/lib/classification";
import { Skeleton } from "@/components/ui/skeleton";
import StablecoinDetailClient from "./client";
import { ExploreNextSection } from "@/components/stablecoin-detail/explore-next-section";
import { PreLaunchDetail } from "@/components/pre-launch-detail";
import logos from "../../../../data/logos.json";
import aiSummaries from "../../../../data/ai-summaries.json";

const typedSummaries = aiSummaries as Record<string, { title: string; text: string; updatedAt: string }>;

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
  const typedLogos = logos as Record<string, string>;

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
        logoSrc={typedLogos[coin.id]}
        summary={typedSummaries[id] ?? null}
        logos={typedLogos}
      />
    );
  }

  const related = getRelatedStablecoins(coin, { candidates: ACTIVE_STABLECOINS });
  const staticComparisonPages = getStaticComparisonPagesForCoin(id);

  return (
    <>
      <div className="space-y-2">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-xs text-muted-foreground sm:text-sm">
          <Link
            href="/"
            className="pharos-focus-ring inline-flex min-h-11 items-center rounded-full border border-border/60 bg-background/60 px-3 text-foreground hover:text-foreground sm:min-h-0 sm:rounded-sm sm:border-0 sm:bg-transparent sm:px-0 sm:text-inherit"
          >
            Dashboard
          </Link>
          <span>/</span>
          <span className="text-foreground">{coin.name}</span>
        </nav>
        <div className="flex items-center gap-3">
          {typedLogos[coin.id] && (
            <Image src={typedLogos[coin.id]} alt="" width={40} height={40} className="rounded-lg" />
          )}
          <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">
            {coin.name} <span className="text-muted-foreground font-semibold">({coin.symbol})</span>
          </h1>
        </div>
        <p className="text-sm text-muted-foreground">
          {BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing} · {GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance} · Pegged to {PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency}
        </p>
      </div>
      <Suspense fallback={
        <div className="space-y-6" aria-hidden="true">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="pharos-card-shell px-4 py-3">
                <Skeleton className="h-3 w-16 mb-2" />
                <Skeleton className="h-6 w-24" />
              </div>
            ))}
          </div>
          <div className="pharos-card-shell h-[300px]" />
        </div>
      }>
        <StablecoinDetailClient id={id} summary={typedSummaries[id] ?? null} coin={coin} logoSrc={typedLogos[coin.id]} />
      </Suspense>
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
