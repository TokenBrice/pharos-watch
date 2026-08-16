import { Suspense, type ReactNode } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { TRACKED_STABLECOINS, TRACKED_META_BY_ID, ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { getStaticComparisonPagesForCoin } from "@/lib/compare-pages";
import { buildStablecoinDetailMetadata } from "@/lib/page-metadata";
import { safeJsonLd } from "@/lib/json-ld";
import { getRelatedStablecoins } from "@/lib/related-stablecoins";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { StablecoinDetailLoadingShell } from "@/components/stablecoin-detail/loading-shell";
import { Skeleton } from "@/components/ui/skeleton";
import StablecoinDetailClient from "./client";
import { ExploreNextSection } from "@/components/stablecoin-detail/explore-next-section";
import { PreLaunchDetail } from "@/components/pre-launch-detail";
import aiSummaries from "@data/ai-summaries.json";
import { logosById } from "@/lib/logos";
import { buildPreLaunchStablecoinJsonLd, buildStablecoinDatasetJsonLd } from "@/lib/stablecoin-detail-json-ld";
import { buildStablecoinStaticMeta, type StablecoinStaticMeta } from "@/lib/stablecoin-static-meta";
import { deriveDependencies } from "@shared/lib/dependency-derivation";
import { buildStablecoinFaqItems, StablecoinDetailSeoContent } from "@/components/stablecoin-detail/static-seo-content";
import { FaqSection } from "@/components/faq-section";
import type { CollateralUsageEntry } from "@/lib/collateral-usage-model";
import { buildStablecoinDetailClientCoin } from "@/lib/stablecoin-detail-mint-authority-view-model";
import { buildMechanismBackingView } from "@/lib/mechanism-backing";
import { buildMechanismCollateralizationView } from "@/lib/mechanism-collateralization";
import { buildMechanismReviewView } from "@/lib/mechanism-review";
import { buildTransferReviewView } from "@/lib/transfer-review";

const typedSummaries = aiSummaries as Record<string, { title: string; text: string; updatedAt: string }>;

function buildCollateralUsageIndex(): Map<string, CollateralUsageEntry[]> {
  const usageByStablecoinId = new Map<string, CollateralUsageEntry[]>();

  for (const candidate of TRACKED_STABLECOINS) {
    for (const dependency of deriveDependencies(candidate)) {
      if (candidate.id === dependency.id || candidate.variantOf === dependency.id) continue;
      const usage = usageByStablecoinId.get(dependency.id) ?? [];
      usage.push({
        coin: {
          id: candidate.id,
          name: candidate.name,
          symbol: candidate.symbol,
        },
        weight: dependency.weight,
        type: dependency.type ?? "collateral",
      });
      usageByStablecoinId.set(dependency.id, usage);
    }
  }

  for (const usage of usageByStablecoinId.values()) {
    usage.sort((a, b) => b.weight - a.weight);
  }

  return usageByStablecoinId;
}

const COLLATERAL_USAGE_BY_STABLECOIN_ID = buildCollateralUsageIndex();

function buildCollateralUsageEntries(stablecoinId: string): CollateralUsageEntry[] {
  return COLLATERAL_USAGE_BY_STABLECOIN_ID.get(stablecoinId) ?? [];
}

function DetailPageShellFallback({
  coin,
  logoSrc,
  staticProfileContent,
  staticComparisonLinks,
}: {
  coin: StablecoinStaticMeta;
  logoSrc?: string;
  staticProfileContent?: ReactNode;
  staticComparisonLinks?: Array<{ href: string; shortTitle: string }>;
}) {
  return (
    <div className="space-y-6">
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

      {staticProfileContent}

      {staticComparisonLinks && staticComparisonLinks.length > 0 ? (
        <nav aria-label="Peer comparisons" className="pharos-card-shell px-4 py-3 sm:px-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Peer comparisons
          </p>
          <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-2 text-sm">
            {staticComparisonLinks.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className="pharos-focus-ring rounded-sm text-frost-blue underline-offset-2 hover:underline"
                >
                  {link.shortTitle}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
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

  const summary = typedSummaries[id] ?? null;

  if (coin.status === "pre-launch") {
    return (
      <>
        <PreLaunchDetail coin={coin} logoSrc={logosById[coin.id]} summary={summary} logos={logosById} />
        <BreadcrumbJsonLd
          items={[
            { name: "Home", url: "/" },
            { name: "Upcoming", url: "/upcoming/" },
            { name: `${coin.name} (${coin.symbol})`, url: buildStablecoinUrl(id) },
          ]}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: safeJsonLd(buildPreLaunchStablecoinJsonLd(coin)),
          }}
        />
      </>
    );
  }

  if (coin.status === "quarantined" || coin.status === "delisted") {
    const faqItems = buildStablecoinFaqItems(coin);
    return (
      <>
        <div className="space-y-6">
          <StablecoinDetailSeoContent coin={coin} summary={summary} />
          <FaqSection items={faqItems} title={`${coin.symbol} quick answers`} includeJsonLd />
        </div>
        <BreadcrumbJsonLd
          items={[
            { name: "Home", url: "/" },
            { name: `${coin.name} (${coin.symbol})`, url: buildStablecoinUrl(id) },
          ]}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: safeJsonLd(buildStablecoinDatasetJsonLd(coin, { dateModified: summary?.updatedAt })),
          }}
        />
      </>
    );
  }

  const related = getRelatedStablecoins(coin, { candidates: ACTIVE_STABLECOINS });
  const staticComparisonPages = getStaticComparisonPagesForCoin(id);
  const collateralUsageEntries = buildCollateralUsageEntries(id);
  const staticCoin = buildStablecoinStaticMeta(coin, {
    hasCollateralUsage: collateralUsageEntries.length > 0,
  });
  const clientCoin = buildStablecoinDetailClientCoin(coin, { parentById: TRACKED_META_BY_ID });
  const structuredDataDateModified = summary?.updatedAt ?? coin.frozenAt;
  // Server-rendered in both the crawl-state fallback and the hydrated dossier
  // so the FAQPage JSON-LD content stays visible in every render state.
  const faqContent = (
    <FaqSection items={buildStablecoinFaqItems(coin)} title={`${coin.symbol} quick answers`} includeJsonLd />
  );

  return (
    <>
      <Suspense
        fallback={
          <DetailPageShellFallback
            coin={staticCoin}
            logoSrc={logosById[coin.id]}
            staticProfileContent={
              <>
                <StablecoinDetailSeoContent coin={coin} summary={summary} />
                {faqContent}
              </>
            }
            staticComparisonLinks={staticComparisonPages.map((page) => ({
              href: page.href,
              shortTitle: page.shortTitle,
            }))}
          />
        }
      >
        <StablecoinDetailClient
          id={id}
          coin={clientCoin}
          summary={summary}
          staticCoin={staticCoin}
          logoSrc={logosById[coin.id]}
          collateralUsageEntries={collateralUsageEntries}
          mechanismBacking={buildMechanismBackingView(id)}
          mechanismCollateralization={buildMechanismCollateralizationView(id)}
          mechanismReview={buildMechanismReviewView(id)}
          transferReview={buildTransferReviewView(id)}
          exploreNextContent={
            <ExploreNextSection
              coin={coin}
              related={related}
              staticComparisonPages={staticComparisonPages.map((page) => {
                const counterpart = page.left.id === coin.id ? page.right : page.left;
                return {
                  href: page.href,
                  shortTitle: page.shortTitle,
                  leftId: page.left.id,
                  rightId: page.right.id,
                  counterpartId: counterpart.id,
                  counterpartSymbol: counterpart.symbol,
                  counterpartName: counterpart.name,
                };
              })}
              logos={logosById}
            />
          }
          faqContent={faqContent}
        />
      </Suspense>
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
          __html: safeJsonLd(
            buildStablecoinDatasetJsonLd(coin, {
              dateModified: structuredDataDateModified,
              logoPath: logosById[coin.id],
            }),
          ),
        }}
      />
    </>
  );
}
