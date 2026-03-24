import type { Metadata } from "next";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";

export const metadata: Metadata = {
  title: "Blacklist Tracker",
  description:
    "Track USDC, USDT, PAXG, and XAUT address freezes and blacklist events across Ethereum, Tron, and L2 chains.",
  alternates: {
    canonical: "/blacklist/",
  },
  openGraph: {
    title: "Blacklist Tracker",
    description:
      "Track USDC, USDT, PAXG, and XAUT address freezes and blacklist events across Ethereum, Tron, and L2 chains.",
    url: "/blacklist/",
    images: [{ url: "https://pharos.watch/og-blacklist.png", width: 1200, height: 628 }],
  },
  twitter: {
    images: [{ url: "https://pharos.watch/og-blacklist.png", width: 1200, height: 628 }],
  },
};

export default function BlacklistLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <BreadcrumbJsonLd name="Blacklist Tracker" path="/blacklist/" />
      {children}
    </>
  );
}
