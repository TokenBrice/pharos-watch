import type { Metadata } from "next";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { buildPageMetadata } from "@/lib/page-metadata";
import FreezeWatchClient from "./client";

const FREEZEWATCH_DESCRIPTION =
  "Live view of issuer control over your stablecoin balance from the Pharos blacklist-sync lane: freezes, unfreezes, blocks, pauses, denylist changes, and token wipes across supported contracts and chains.";

export const metadata: Metadata = buildPageMetadata({
  title: "FreezeWatch",
  description: FREEZEWATCH_DESCRIPTION,
  canonical: "/freezewatch/",
  ogImage: `${SITE_URL}/og-blacklist.png`,
});

export default function FreezeWatchPage() {
  return <FreezeWatchClient />;
}
