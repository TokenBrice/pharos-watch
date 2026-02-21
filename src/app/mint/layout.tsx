import type { Metadata } from "next";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";

export const metadata: Metadata = {
  title: "Mint & Burn Tracker",
  description:
    "Track USDC and USDT minting and burning events across Ethereum and L2 chains.",
  alternates: {
    canonical: "/mint/",
  },
  openGraph: {
    title: "Mint & Burn Tracker",
    description:
      "Track USDC and USDT minting and burning events across Ethereum and L2 chains.",
    url: "/mint/",
  },
};

export default function MintLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <BreadcrumbJsonLd name="Mint & Burn Tracker" path="/mint/" />
      {children}
    </>
  );
}
