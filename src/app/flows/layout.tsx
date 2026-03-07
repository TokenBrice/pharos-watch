import type { Metadata } from "next";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";

export const metadata: Metadata = {
  title: "Mint/Burn Flows",
  description:
    "Real-time minting and redemption flows for tracked stablecoins. Net flow direction, pressure-vs-baseline signals, and the Bank Run Gauge.",
  alternates: {
    canonical: "/flows/",
  },
  openGraph: {
    title: "Mint/Burn Flows",
    description:
      "Real-time minting and redemption flows for tracked stablecoins. Net flow direction, pressure-vs-baseline signals, and the Bank Run Gauge.",
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
                  text: "The Bank Run Gauge is a market-cap-weighted composite of each tracked stablecoin's pressure shift versus its own 30-day baseline. It is a signed -100 to +100 pressure signal, not a literal mint-versus-burn direction meter. Scores below -10 indicate worsening redemption pressure across the market, while scores above +10 indicate improving issuance pressure versus baseline. It returns null only when all tracked coins lack sufficient history or current activity.",
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
                name: "What does Pressure Shift vs 30D mean?",
                acceptedAnswer: {
                  "@type": "Answer",
                  text: "Pressure Shift vs 30D measures how unusual a coin's current 24-hour net flow is relative to its 30-day rolling baseline. It uses the existing Flow Intensity formula: intensity = clamp(-100, 100, z × 50), where z = (currentDailyNet − baselineDailyNet) / max(baselineDailyAbs × 0.3, $1M). A score near 0 means flows match the baseline, negative scores mean pressure is worse than normal, and positive scores mean pressure is improving versus normal. Net flow direction still comes from the raw 24-hour mint-minus-burn value.",
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
