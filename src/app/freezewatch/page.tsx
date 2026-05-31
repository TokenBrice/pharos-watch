import type { Metadata } from "next";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { buildPageMetadata } from "@/lib/page-metadata";
import FreezeWatchClient from "./client";

const FREEZEWATCH_DESCRIPTION =
  "Track stablecoin blacklist and freeze events across supported contracts: issuer freezes, unfreezes, blocks, pauses, denylist changes, token wipes, and chain context.";

export const metadata: Metadata = buildPageMetadata({
  title: "FreezeWatch: Stablecoin Blacklist & Freeze Events",
  description: FREEZEWATCH_DESCRIPTION,
  canonical: "/freezewatch/",
  ogImage: `${SITE_URL}/og-blacklist.png`,
});

export default function FreezeWatchPage() {
  return <FreezeWatchClient />;
}
