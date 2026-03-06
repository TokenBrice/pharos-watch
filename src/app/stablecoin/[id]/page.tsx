import type { Metadata } from "next";
import Link from "next/link";
import { TRACKED_STABLECOINS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { buildStablecoinUrl } from "@/lib/urls";
import { GOVERNANCE_LABELS, BACKING_LABELS, PEG_LABELS_SHORT } from "@shared/lib/classification";
import StablecoinDetailClient from "./client";
import { StablecoinLogo } from "@/components/stablecoin-logo";
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

  const govLabel = GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance;
  const backingLabel = BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing;
  const pegLabel = PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency;
  const desc = `Live analytics for ${coin.name} (${coin.symbol}). ${govLabel} stablecoin backed by ${backingLabel.toLowerCase()}, pegged to ${pegLabel}. Price, market cap, supply trends, chain distribution, peg score, and depeg history on Pharos.`;

  return {
    title: `${coin.name} (${coin.symbol}): Stablecoin Analytics`,
    description: desc,
    alternates: {
      canonical: buildStablecoinUrl(id),
    },
    openGraph: {
      title: `${coin.name} (${coin.symbol}): Stablecoin Analytics`,
      description: desc,
      url: buildStablecoinUrl(id),
    },
  };
}


function getRelatedStablecoins(coinId: string, limit = 6) {
  const coin = TRACKED_META_BY_ID.get(coinId);
  if (!coin) return [];

  const others = TRACKED_STABLECOINS.filter((s) => s.id !== coinId);

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
  const related = getRelatedStablecoins(id);
  const typedLogos = logos as Record<string, string>;

  return (
    <>
      {!coin ? (
        <div className="space-y-4 py-12 text-center">
          <h1 className="text-3xl font-extrabold tracking-tighter">Stablecoin Not Found</h1>
          <p className="text-muted-foreground">No stablecoin found with ID &ldquo;{id}&rdquo;.</p>
          <Link href="/" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
            &larr; Back to Dashboard
          </Link>
        </div>
      ) : (
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
          {related.length > 0 && (
            <section className="mt-8 space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Related Stablecoins</h2>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-6">
                {related.map((r) => (
                  <Link
                    key={r.id}
                    href={buildStablecoinUrl(r.id)}
                    className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm hover:bg-accent transition-colors"
                  >
                    <StablecoinLogo src={typedLogos[r.id]} name={r.name} size={20} />
                    <span className="font-mono text-xs font-medium">{r.symbol}</span>
                  </Link>
                ))}
              </div>
            </section>
          )}
          <BreadcrumbJsonLd name={`${coin.name} (${coin.symbol})`} path={buildStablecoinUrl(id)} />
          <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{
              __html: JSON.stringify({
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
      )}
    </>
  );
}
