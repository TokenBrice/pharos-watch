import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { TRACKED_STABLECOINS } from "@/lib/stablecoins";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { LiquidityClient } from "./client";

const liquidityDescription = `DEX liquidity scores, pool depth analysis, and protocol breakdowns for ${TRACKED_STABLECOINS.length} stablecoins across Curve, Uniswap, Fluid, and more.`;

export const metadata: Metadata = {
  title: "DEX Liquidity — Stablecoin Pool Depth & Volume",
  description: liquidityDescription,
  alternates: {
    canonical: "/liquidity/",
  },
  openGraph: {
    title: "DEX Liquidity — Stablecoin Pool Depth & Volume",
    description: liquidityDescription,
    url: "/liquidity/",
  },
};

export default function LiquidityPage() {
  return (
    <div className="space-y-6">
      <BreadcrumbJsonLd name="DEX Liquidity" path="/liquidity/" />
      <div className="space-y-2">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link href="/" className="hover:text-foreground transition-colors">Dashboard</Link>
          <span>/</span>
          <span className="text-foreground">DEX Liquidity</span>
        </nav>
        <h1 className="text-4xl font-extrabold tracking-tighter">DEX Liquidity</h1>
        <p className="text-sm text-muted-foreground">
          Liquidity scores, pool depth, and protocol breakdowns for {TRACKED_STABLECOINS.length} stablecoins
          across decentralized exchanges.
        </p>
        <p className="text-sm text-muted-foreground max-w-2xl">
          The liquidity score is a 0–100 composite that measures on-chain pool depth, 24h trading volume,
          and protocol diversity across DEXes like Curve, Uniswap, and Fluid. Higher scores mean a stablecoin
          can absorb larger trades with less slippage — critical for both everyday swaps and stress scenarios.
        </p>
      </div>
      <Suspense>
        <LiquidityClient />
      </Suspense>
    </div>
  );
}
