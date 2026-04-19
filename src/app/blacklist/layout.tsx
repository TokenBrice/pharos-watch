import type { Metadata } from "next";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";

export const metadata: Metadata = {
  title: "Blacklist Tracker",
  description:
    "Track issuer freezes, blocks, pauses, blacklist events, and token wipes across supported stablecoin contracts.",
  alternates: {
    canonical: "/blacklist/",
  },
  openGraph: {
    title: "Blacklist Tracker",
    description:
      "Track issuer freezes, blocks, pauses, blacklist events, and token wipes across supported stablecoin contracts.",
    url: "/blacklist/",
    images: [{ url: `${SITE_URL}/og-blacklist.png`, width: 1200, height: 628 }],
  },
  twitter: {
    images: [{ url: `${SITE_URL}/og-blacklist.png`, width: 1200, height: 628 }],
  },
};

export default function BlacklistLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <BreadcrumbJsonLd
        items={[
          { name: "Home", url: "/" },
          { name: "Blacklist Tracker", url: "/blacklist/" },
        ]}
      />
      {children}
    </>
  );
}
