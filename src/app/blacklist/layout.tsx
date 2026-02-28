import type { Metadata } from "next";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";

export const metadata: Metadata = {
  title: "Blacklist Tracker",
  description:
    "Track USDC, USDT, EURC, PAXG, and XAUT address freezes and blacklist events across Ethereum, Tron, and L2 chains.",
  alternates: {
    canonical: "/blacklist/",
  },
  openGraph: {
    title: "Blacklist Tracker",
    description:
      "Track USDC, USDT, EURC, PAXG, and XAUT address freezes and blacklist events across Ethereum, Tron, and L2 chains.",
    url: "/blacklist/",
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
