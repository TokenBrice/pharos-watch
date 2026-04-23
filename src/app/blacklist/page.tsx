import type { Metadata } from "next";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import BlacklistClient from "./client";

export const metadata: Metadata = {
  title: "Blacklist Tracker",
  description:
    "Track issuer freezes, unfreezes, blocks, pauses, denylist changes, and token wipes across supported stablecoin contracts and chains.",
  alternates: {
    canonical: "/blacklist/",
  },
  openGraph: {
    title: "Blacklist Tracker",
    description:
      "Track issuer freezes, unfreezes, blocks, pauses, denylist changes, and token wipes across supported stablecoin contracts and chains.",
    url: "/blacklist/",
    images: [{ url: `${SITE_URL}/og-blacklist.png`, width: 1200, height: 628 }],
  },
  twitter: {
    images: [{ url: `${SITE_URL}/og-blacklist.png`, width: 1200, height: 628 }],
  },
};

export default function BlacklistPage() {
  return <BlacklistClient />;
}
