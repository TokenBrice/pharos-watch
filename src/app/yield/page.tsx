import dynamic from "next/dynamic";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { Skeleton } from "@/components/ui/skeleton";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { buildPageMetadata } from "@/lib/page-metadata";
import {
  YIELD_METHODOLOGY_CHANGELOG_PATH,
  YIELD_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/yield-methodology-version";

const YieldClient = dynamic(
  () => import("./client").then((m) => ({ default: m.YieldClient })),
  { loading: () => <Skeleton className="h-[600px] w-full rounded-xl" /> },
);

const yieldBearingCount = TRACKED_STABLECOINS.filter((m) => m.flags.yieldBearing).length;
const desc = `Risk-adjusted yield rankings for ${yieldBearingCount} yield-bearing stablecoins. Compare APY, safety grades, and the Pharos Yield Score.`;

export const metadata = buildPageMetadata({
  title: "Yield Intelligence",
  description: desc,
  canonical: "/yield/",
  ogImage: "https://pharos.watch/og-yield.png",
});

const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: [
    {
      "@type": "Question",
      name: "What is the Pharos Yield Score (PYS)?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "The Pharos Yield Score (PYS) is a risk-adjusted yield metric scored 0–100 that balances yield magnitude against safety and consistency. It divides the 30-day average APY by a risk penalty derived from the stablecoin's safety grade, then applies a sustainability multiplier based on APY volatility over the same period. Higher-safety stablecoins incur a lower risk penalty, so their PYS reflects their yield more faithfully.",
      },
    },
    {
      "@type": "Question",
      name: "How are stablecoin yields sourced?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Yields are resolved through a three-tier priority system updated every 30 minutes. Tier 1 reads on-chain vault exchange rates directly via RPC. Tier 2 pulls pool APY from the DeFiLlama Yields API, matched by a static pool map or symbol search. Tier 3 derives APY from 30-day price appreciation for NAV-appreciation tokens. The displayed APY figures are 30-day trailing averages computed from stored history.",
      },
    },
    {
      "@type": "Question",
      name: "What does 'risk-adjusted' mean for stablecoin yield?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Risk-adjusted yield accounts for the safety of the stablecoin issuing the yield, not just the raw APY. A stablecoin with a high safety grade (A or A+) receives a low risk penalty in the PYS formula, so even a moderate APY can score well. Conversely, a risky stablecoin must offer significantly higher raw yield to achieve the same PYS, reflecting the extra risk borne by the holder.",
      },
    },
  ],
};

export default function YieldPage() {
  return (
    <FeaturePageShell
      breadcrumbName="Yield Intelligence"
      path="/yield/"
      title="Yield Intelligence"
      statusBadge={{ status: "mature", version: YIELD_METHODOLOGY_VERSION_LABEL }}
      methodology={{
        version: YIELD_METHODOLOGY_VERSION_LABEL,
        changelogPath: YIELD_METHODOLOGY_CHANGELOG_PATH,
      }}
      preface={
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
        />
      }
      leadParagraphs={[
        `Risk-adjusted yield rankings for ${yieldBearingCount} yield-bearing stablecoins. Compare APY, safety grades, and the Pharos Yield Score (PYS).`,
      ]}
    >
      <YieldClient />
    </FeaturePageShell>
  );
}
