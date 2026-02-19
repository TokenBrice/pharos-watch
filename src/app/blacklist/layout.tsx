import type { Metadata } from "next";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";

export const metadata: Metadata = {
  title: "Freeze & Blacklist Tracker",
  description:
    "Track USDC, USDT, EURC, PAXG, and XAUT address freezes and blacklist events across Ethereum, Tron, and L2 chains.",
  alternates: {
    canonical: "/blacklist/",
  },
  openGraph: {
    title: "Freeze & Blacklist Tracker",
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
      <BreadcrumbJsonLd name="Freeze & Blacklist Tracker" path="/blacklist/" />
      {children}
    </>
  );
}
