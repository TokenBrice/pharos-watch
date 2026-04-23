import type { Metadata } from "next";
import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { MethodologySections } from "./methodology-sections";
import { MethodologyModeToggle } from "@/components/methodology-mode-toggle";
import { LongformScrollspyNav } from "@/components/longform-scrollspy-nav";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { safeJsonLd } from "@/lib/json-ld";
import { buildFaqJsonLd } from "@/lib/faq";
import { buildPageMetadata } from "@/lib/page-metadata";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import {
  METHODOLOGY_READING_STEPS,
  METHODOLOGY_SECTIONS,
  READER_GUIDE_COPY,
} from "./methodology-shared";
import { SAFETY_SCORE_VERSION_LABEL } from "@shared/lib/safety-score-version";

export const metadata: Metadata = buildPageMetadata({
  title: "Methodology: How Pharos Grades Stablecoins",
  description:
    "Full methodology behind Pharos safety grades, peg scores, liquidity scores, and contagion stress tests. Transparent scoring for every stablecoin.",
  canonical: "/methodology/",
  ogImage: `${SITE_URL}/og-methodology.png`,
});

export default function MethodologyPage() {
  return (
    <div className="mx-auto w-full max-w-[76rem] space-y-8">
      <BreadcrumbJsonLd
        items={[
          { name: "Home", url: "/" },
          { name: "Methodology", url: "/methodology/" },
        ]}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: safeJsonLd(buildFaqJsonLd([
            {
              question: "How does Pharos grade stablecoins?",
              answer: `Pharos computes a weighted average of four base dimensions — Liquidity / Exit (30%), Resilience (20%), Decentralization (15%), and Dependency Risk (25%) — then applies (pegScore / 100)^0.40 as a peg stability power-curve multiplier. Redemption backstops can improve Liquidity only when the route is currently usable and the redemption snapshot is fresh; documented issuer exits add only a DEX-gated primary-market bonus, while severe active depegs use the open event peak for final caps and disable static or non-live-direct redemption uplift unless live-open redemption evidence exists. When liquidity data is absent, a 10% penalty is applied to the final score after the peg multiplier (weights are redistributed across available dimensions). Grades range from A+ (87+) to F (0–39), with NR for insufficient data. The methodology is currently at ${SAFETY_SCORE_VERSION_LABEL}.`,
            },
            {
              question: "How is the Pharos peg score calculated?",
              answer: "The peg score is a composite 0–100 measure combining time-at-peg (50%) and event severity (50%), minus penalties for active depegs and erratic behavior. The tracking window spans up to 4 years but is capped at the coin's actual age, using a curated launch date when available and otherwise falling back to the earliest supply snapshot. It requires at least 7 days of tracking data; scores under 30 days are flagged as early.",
            },
            {
              question: "What is the DEWS early-warning system?",
              answer: "The Depeg Early Warning System (DEWS) is a multi-factor composite that signals elevated depeg risk before a full event occurs. It combines peg deviation magnitude, DEX liquidity depth, 24-hour net mint/burn flow intensity versus 30-day baseline, blacklist freeze velocity, and stablecoin-sector contagion correlation. Each factor is scored 0–100 and combined with methodology-defined weights. Scores above 60 trigger cautionary signals; scores above 80 trigger high-risk alerts.",
            },
            {
              question: "How is the liquidity score calculated?",
              answer: "The liquidity score evaluates how easily a stablecoin can be exited to its peg asset on-chain. It combines DEX TVL depth (30%), 24-hour volume activity (25%), pool quality and diversity (20%), pair durability and age (15%), and diversification across protocols and chains (10%). Quality multipliers adjust for pool type (e.g., Curve stableswap vs Uniswap V3 wide tiers). Scores are normalized to 0–100.",
            },
            {
              question: "What does the contagion stress test measure?",
              answer: "The contagion stress test simulates a simultaneous 50% market-cap loss across the top 5 stablecoins and measures the correlated impact on every tracked coin. It uses rolling 90-day return correlations and applies a severity amplifier based on each coin's dependency-risk exposure. The result is a projected grade under stress, shown as a before/after comparison on each coin's detail page.",
            },
            {
              question: "What is the Bank Run Gauge?",
              answer: "The Bank Run Gauge is a market-cap-weighted composite of each tracked stablecoin's issuance-chain net flow versus its own trailing 30-day baseline. It is a signed -100 to +100 pressure signal. Scores below -10 indicate worsening redemption pressure; scores above +10 indicate improving issuance pressure. It returns null when insufficient data is available.",
            },
          ])),
        }}
      />
      <div className="space-y-4">
        <MethodologyModeToggle />
        <div className="flex flex-col lg:flex-row gap-6">
          <aside className="hidden lg:block w-64 shrink-0">
            <div className="sticky top-20">
              <LongformScrollspyNav
                sections={METHODOLOGY_SECTIONS}
                readingSteps={METHODOLOGY_READING_STEPS}
              />
            </div>
          </aside>
          <main className="flex-1 min-w-0">
            <MethodologySections />
          </main>
        </div>
      </div>
    </div>
  );
}
