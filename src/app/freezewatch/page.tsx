import type { Metadata } from "next";
import { buildLiveRouteOgImageUrl, buildPageMetadata } from "@/lib/page-metadata";
import FreezeWatchClient from "./client";

const FREEZEWATCH_DESCRIPTION =
  "Track stablecoin blacklist and freeze events across supported contracts: issuer freezes, unfreezes, blocks, pauses, denylist changes, token wipes, and chain context.";

export const metadata: Metadata = buildPageMetadata({
  title: "FreezeWatch: Stablecoin Blacklist & Freeze Events",
  description: FREEZEWATCH_DESCRIPTION,
  canonical: "/freezewatch/",
  ogImage: buildLiveRouteOgImageUrl("freezewatch"),
});

export default function FreezeWatchPage() {
  return <FreezeWatchClient />;
}
