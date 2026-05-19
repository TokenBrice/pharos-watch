import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { TRACKED_STABLECOINS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { Skeleton } from "@/components/ui/skeleton";
import { buildPageMetadata } from "@/lib/page-metadata";
import { buildStablecoinUrl } from "@/lib/urls";
import { logosById } from "@/lib/logos";
import { buildStablecoinStaticMeta } from "@/lib/stablecoin-static-meta";
import YieldAnalysisClient from "./client";

// WHY: lending-opportunity rows can appear for any tracked stablecoin (per yield methodology),
// so the yield deep-link must be reachable for every active coin — not just those flagged
// `yieldBearing`. The client renders an empty-state card when no live yield row exists.
export function generateStaticParams() {
  return TRACKED_STABLECOINS.filter((coin) => coin.status !== "pre-launch").map((coin) => ({ id: coin.id }));
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
