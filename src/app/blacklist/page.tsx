import type { Metadata } from "next";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import FreezeWatchClient from "../freezewatch/client";

export const metadata: Metadata = {
  title: "FreezeWatch",
  description:
    "Live view of issuer control over your stablecoin balance: freezes, unfreezes, blocks, pauses, denylist changes, and token wipes across supported contracts and chains.",
  alternates: {
    canonical: "/freezewatch/",
  },
  openGraph: {
    title: "FreezeWatch",
    description:
      "Live view of issuer control over your stablecoin balance: freezes, unfreezes, blocks, pauses, denylist changes, and token wipes across supported contracts and chains.",
    url: "/freezewatch/",
    images: [{ url: `${SITE_URL}/og-blacklist.png`, width: 1200, height: 628 }],
  },
  robots: {
    index: false,
    follow: true,
  },
  twitter: {
    card: "summary_large_image",
  },
};

export default function LegacyBlacklistPage() {
  return <FreezeWatchClient />;
}
