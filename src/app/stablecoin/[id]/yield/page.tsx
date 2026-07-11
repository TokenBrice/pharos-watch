import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { TRACKED_STABLECOINS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { hasStaticYieldWorkbench } from "@shared/lib/yield-auto-lending";
import { Skeleton } from "@/components/ui/skeleton";
import { buildPageMetadata } from "@/lib/page-metadata";
import { buildStablecoinUrl } from "@/lib/urls";
import { logosById } from "@/lib/logos";
import { buildStablecoinStaticMeta } from "@/lib/stablecoin-static-meta";
import YieldAnalysisClient from "./client";

export function generateStaticParams() {
  return TRACKED_STABLECOINS.filter(hasStaticYieldWorkbench).map((coin) => ({ id: coin.id }));
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const coin = TRACKED_META_BY_ID.get(id);

  if (!coin) {
    return { title: "Stablecoin Not Found", robots: { index: false } };
  }

  return buildPageMetadata({
    title: `${coin.name} (${coin.symbol}) — Yield Analysis`,
    description: `Per-source APY history, warning signals timeline, and source-switch history for ${coin.name} (${coin.symbol}).`,
    canonical: `${buildStablecoinUrl(coin.id)}yield/`,
    robots: { index: false, follow: true },
  });
}

export default async function StablecoinYieldDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const coin = TRACKED_META_BY_ID.get(id);

  if (!coin) {
    notFound();
  }

  const staticCoin = buildStablecoinStaticMeta(coin);

  return (
    <Suspense fallback={<Skeleton className="h-[600px] w-full rounded-xl" />}>
      <YieldAnalysisClient id={id} staticCoin={staticCoin} logoSrc={logosById[coin.id]} />
    </Suspense>
  );
}
