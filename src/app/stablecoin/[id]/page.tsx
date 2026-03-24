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

function DetailFallbackLogo({ src, name }: { src?: string; name: string }) {
  if (!src) {
    return (
      <span className="inline-flex size-14 shrink-0 items-center justify-center rounded-full border border-border/60 bg-background/80 text-lg font-bold text-muted-foreground shadow-[inset_0_1px_0_oklch(1_0_0_/0.05)]">
        {name.charAt(0).toUpperCase()}
      </span>
    );
  }

  return (
    <span className="inline-flex size-14 shrink-0 items-center justify-center rounded-full border border-border/60 bg-background/80 shadow-[inset_0_1px_0_oklch(1_0_0_/0.05)]">
      <Image
        src={src}
        alt={`${name} logo`}
        width={44}
        height={44}
        className="rounded-full object-contain"
        unoptimized
        priority
      />
    </span>
  );
}

function DetailPageShellFallback({
  coin,
  logoSrc,
}: {
  coin: (typeof TRACKED_STABLECOINS)[number];
  logoSrc?: string;
}) {
  const governanceLabel = GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance;
  const backingLabel = BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing;
  const pegLabel = PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency;

  return (
    <div className="space-y-6" aria-hidden="true">
      <section className="pharos-card-shell overflow-hidden px-4 py-4 sm:px-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 space-y-3">
            <div className="flex items-start gap-3">
              <DetailFallbackLogo src={logoSrc} name={coin.name} />
              <div className="min-w-0 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-2xl font-extrabold tracking-tighter text-foreground">{coin.name}</h2>
                  <span className="text-base font-mono text-muted-foreground">{coin.symbol}</span>
                </div>
                <p className="text-sm text-muted-foreground">
                  {governanceLabel} · {backingLabel} · {pegLabel}
                </p>
                <p className="max-w-2xl text-sm text-muted-foreground">
                  Loading the full research dossier: price, safety, liquidity, flows, and historical context.
                </p>
              </div>
            </div>
          </div>

          <div className="flex shrink-0 gap-2">
            <Skeleton className="h-10 w-28 rounded-full" />
            <Skeleton className="h-10 w-28 rounded-full" />
          </div>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {["Price", "Market Cap", "Supply", "Liquidity"].map((label) => (
            <div key={label} className="rounded-2xl border border-border/60 bg-background/45 px-3.5 py-3">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
              <Skeleton className="h-7 w-24" />
              <Skeleton className="mt-2 h-4 w-28" />
            </div>
          ))}
        </div>
      </section>

      <div className="rounded-2xl border border-border/60 bg-background/90 px-4 py-3 shadow-[0_16px_40px_oklch(0_0_0_/0.12)]">
        <div className="mb-3 flex items-center justify-between gap-3">
          <p className="pharos-kicker">Jump to Section</p>
          <span className="text-[11px] text-muted-foreground">Research dossier loading</span>
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1">
          {["Safety Score", "Overview", "Chart", "Info", "Liquidity"].map((label) => (
            <div
              key={label}
              className="inline-flex min-h-11 shrink-0 items-center rounded-full border border-border/60 bg-background px-4 py-2 text-sm text-muted-foreground"
            >
              {label}
            </div>
          ))}
        </div>
      </div>

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
      <h1 className="sr-only">
        {coin.name} ({coin.symbol}) stablecoin analytics
      </h1>
      <Suspense fallback={
        <DetailPageShellFallback coin={coin} logoSrc={typedLogos[coin.id]} />
      }>
        <StablecoinDetailClient id={id} summary={typedSummaries[id] ?? null} coin={coin} logoSrc={typedLogos[coin.id]} />
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
