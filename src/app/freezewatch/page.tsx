import type { Metadata } from "next";
import { buildPageMetadata } from "@/lib/page-metadata";
import FreezeWatchClient from "./client";
import { FreezeWatchRegistryBlock } from "./registry-block";

const FREEZEWATCH_DESCRIPTION =
  "Live log of issuer freezes, unfreezes and token wipes across tracked stablecoins, including USDT, USDC and PAXG, with frozen value, addresses and transactions.";

export const metadata: Metadata = buildPageMetadata({
  title: "USDT & USDC Freeze Tracker: Live Blacklist Events",
  description: FREEZEWATCH_DESCRIPTION,
  canonical: "/freezewatch/",
});

export default function FreezeWatchPage() {
  return <FreezeWatchClient>
      <FreezeWatchRegistryBlock />
    </FreezeWatchClient>;
}
