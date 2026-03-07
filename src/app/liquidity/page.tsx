import dynamic from "next/dynamic";
import Link from "next/link";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { Skeleton } from "@/components/ui/skeleton";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { buildPageMetadata } from "@/lib/page-metadata";
import { buildStablecoinUrl } from "@/lib/urls";
import {
  LIQUIDITY_METHODOLOGY_CHANGELOG_PATH,
  LIQUIDITY_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/liquidity-score-version";

const LiquidityClient = dynamic(
  () => import("./client").then((m) => ({ default: m.LiquidityClient })),
  { loading: () => <Skeleton className="h-[400px] w-full rounded-xl" /> },
);

const liquidityDescription = `DEX liquidity scores, pool depth analysis, and protocol breakdowns for ${TRACKED_STABLECOINS.length} stablecoins across Curve, Uniswap, Fluid, and more.`;
const LIQUIDITY_DIRECTORY_COINS = TRACKED_STABLECOINS.slice(0, 12);

export const metadata = buildPageMetadata({
  title: "DEX Liquidity: Stablecoin Pool Depth & Volume",
  description: liquidityDescription,
  canonical: "/liquidity/",
  ogImage: "https://pharos.watch/og-liquidity.png",
});

export default function LiquidityPage() {
  return (
    <FeaturePageShell
      breadcrumbName="DEX Liquidity"
      path="/liquidity/"
      title="DEX Liquidity"
      statusBadge={{ status: "mature", version: LIQUIDITY_METHODOLOGY_VERSION_LABEL }}
      methodology={{
        version: LIQUIDITY_METHODOLOGY_VERSION_LABEL,
        changelogPath: LIQUIDITY_METHODOLOGY_CHANGELOG_PATH,
      }}
      leadParagraphs={[
        `Liquidity scores, pool depth, and protocol breakdowns for ${TRACKED_STABLECOINS.length} stablecoins across decentralized exchanges.`,
        "The liquidity score is a 0–100 composite that measures on-chain pool depth, 24h trading volume, and protocol diversity across DEXes like Curve, Uniswap, and Fluid. Higher scores mean a stablecoin can absorb larger trades with less slippage, critical for both everyday swaps and stress scenarios.",
      ]}
    >
      <section className="space-y-3 rounded-2xl border border-border/60 bg-card/60 px-4 py-4">
        <div className="space-y-1.5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            High-Liquidity Reference Set
          </h2>
          <p className="text-sm text-muted-foreground">
            These are the most-followed liquidity pages on the site and give search crawlers a direct path into the main
            trading pairs before the live table hydrates.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {LIQUIDITY_DIRECTORY_COINS.map((coin) => (
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
      <LiquidityClient />
    </FeaturePageShell>
  );
}
