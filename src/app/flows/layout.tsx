import type { Metadata } from "next";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";

export const metadata: Metadata = {
  title: "Mint/Burn Flows",
  description:
    "Real-time minting and redemption flows for tracked stablecoins. Bank Run Gauge, per-coin flow table, and aggregate flow charts.",
  alternates: {
    canonical: "/flows/",
  },
  openGraph: {
    title: "Mint/Burn Flows",
    description:
      "Real-time minting and redemption flows for tracked stablecoins. Bank Run Gauge, per-coin flow table, and aggregate flow charts.",
    url: "/flows/",
  },
};

export default function FlowsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <BreadcrumbJsonLd name="Mint/Burn Flows" path="/flows/" />
      {children}
    </>
  );
}
