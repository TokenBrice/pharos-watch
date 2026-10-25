import type { Metadata } from "next";
import { buildLiveRouteOgImageUrl, buildPageMetadata } from "@/lib/page-metadata";
import { BLACKLIST_STABLECOINS } from "@shared/types/market";
import FreezeWatchClient from "./client";

const FREEZEWATCH_DESCRIPTION = `Live log of issuer freezes, unfreezes and token wipes across ${BLACKLIST_STABLECOINS.length} stablecoins, including USDT, USDC and PAXG, with frozen value, addresses and transactions.`;

export const metadata: Metadata = buildPageMetadata({
  title: "USDT & USDC Freeze Tracker: Live Blacklist Events",
  description: FREEZEWATCH_DESCRIPTION,
  canonical: "/freezewatch/",
  ogImage: buildLiveRouteOgImageUrl("freezewatch"),
});

export default function FreezeWatchPage() {
  return <FreezeWatchClient />;
}
