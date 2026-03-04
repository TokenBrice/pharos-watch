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
    images: [{ url: "https://pharos.watch/og-flows.png", width: 1200, height: 630 }],
  },
  twitter: {
    images: [{ url: "https://pharos.watch/og-flows.png", width: 1200, height: 630 }],
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
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "FAQPage",
            "mainEntity": [
              {
                "@type": "Question",
                name: "What is the Bank Run Gauge?",
                acceptedAnswer: {
                  "@type": "Answer",
                  text: "The Bank Run Gauge is a market-cap-weighted composite of individual Flow Intensity Scores across all tracked stablecoins, aggregated into a signed -100 to +100 score. A score below -10 indicates elevated redemption pressure across the market, while a score above +10 reflects net minting demand. It returns null only when all tracked coins lack sufficient flow history.",
                },
              },
              {
                "@type": "Question",
                name: "What do mint and burn events indicate?",
                acceptedAnswer: {
                  "@type": "Answer",
                  text: "Minting events signal new demand or capital inflow — tokens are created when users deposit collateral or purchase the stablecoin. Burn events signal redemption or outflow — tokens are destroyed when users exit. Sustained net burn pressure above baseline levels can indicate early bank-run dynamics and is factored into the Bank Run Gauge and DEWS early warning signals.",
                },
              },
              {
                "@type": "Question",
                name: "How is the Flow Intensity Score calculated?",
                acceptedAnswer: {
                  "@type": "Answer",
                  text: "The Flow Intensity Score (FIS) measures how unusual a coin's current 24-hour net flow is relative to its 30-day rolling baseline. It is computed as: intensity = clamp(-100, 100, z × 50), where z = (currentDailyNet − baselineDailyNet) / max(baselineDailyAbs × 0.3, $1M). A score of 0 means flows match the baseline; negative scores indicate above-baseline burns and positive scores indicate above-baseline mints. A minimum of 7 days of history is required before a score is returned.",
                },
              },
            ],
          }),
        }}
      />
      {children}
    </>
  );
}
