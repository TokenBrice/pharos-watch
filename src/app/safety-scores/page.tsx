import Link from "next/link";
import { Bell } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { CalloutBanner } from "@/components/callout-banner";
import { FaqSection } from "@/components/faq-section";
import { ShareButton } from "@/components/share-button";
import { buildApiOgImageUrl, buildPageMetadata } from "@/lib/page-metadata";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import { buildPublicDatasetMirrorJsonLd } from "@/lib/analytics-dataset-json-ld";
import { safeJsonLd } from "@/lib/json-ld";
import type { FaqItem } from "@/lib/faq";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import {
  SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH,
  SAFETY_SCORE_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/constants";

const reportCardsDescription =
  "Compare stablecoin safety grades by peg stability, liquidity, resilience, decentralization, CDP oracle setup, bridge-route risk, dependency risk, and contagion stress-test impact.";

export const metadata = buildPageMetadata({
  title: "Safety Scores: Stablecoin Safety Grades",
  description: reportCardsDescription,
  canonical: "/safety-scores/",
  ogImage: buildApiOgImageUrl(API_PATHS.ogSafetyScores()),
});

const FAQ_ITEMS = [
  {
    question: "How are stablecoin safety grades calculated?",
    answer:
      "Each stablecoin is scored across four weighted base dimensions: liquidity / exit capacity, resilience, decentralization, and dependency risk. Decentralization can include branch-aware CDP oracle setup, bridge-route, and mint-authority penalties when reviewed metadata exists. Peg stability is then applied as a multiplier on the result. The resulting 0–100 score maps to a letter grade from A+ to F.",
  },
  {
    question: "What does the contagion simulation show?",
    answer:
      'The contagion simulator models cascading failures in the stablecoin ecosystem. You select a stablecoin to "fail" and the simulation traces dependency chains: if stablecoin A uses stablecoin B as collateral, and B fails, A\'s grade degrades proportionally to its exposure. This reveals hidden systemic risk: which coins look safe in isolation but are fragile under stress.',
  },
  {
    question: "How often do safety grades change?",
    answer:
      "Visible Safety Scores data is built by /api/report-cards with a 15-minute freshness/cache budget. In practice, most grades are stable day-to-day. Significant shifts happen when peg deviations spike, liquidity pools drain, or governance changes are enacted. A separate report-card cache lane publishes every 15 minutes for downstream read paths, while Telegram safety-change alerts are driven by the daily safety-grade history snapshot.",
  },
  {
    question: "What should I do with this information?",
    answer:
      "Safety grades are one input into your own risk assessment, not financial advice. Use them to identify which stablecoins carry hidden dependency risk, compare liquidity depth before choosing an exit route, and stress-test your portfolio assumptions with the contagion simulator. The grade breakdown on each coin's detail page explains exactly what drove the score.",
  },
  {
    question: "Why do most stablecoins receive a C grade?",
    answer:
      "A C grade (score 50\u201364) is the statistical center of the grading distribution. It means the coin meets baseline requirements but has meaningful weaknesses in at least one area \u2014 typically limited liquidity, moderate dependency risk, or weaker decentralization. Only coins that excel across the weighted base dimensions and maintain strong peg behavior reach A or B territory.",
  },
] as const satisfies readonly FaqItem[];

export default createClientFeaturePage({
  loadClient: () => import("./client").then((m) => ({ default: m.ReportCardsClient })),
  loading: <Skeleton className="h-[400px] w-full rounded-xl" />,
  shell: {
    breadcrumbName: "Safety Scores",
    path: "/safety-scores/",
    title: "Safety Scores",
    methodology: {
      version: SAFETY_SCORE_METHODOLOGY_VERSION_LABEL,
      changelogPath: SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH,
    },
    headerActions: <ShareButton ogPath="/api/og/safety-scores" />,
    preface: (
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(buildPublicDatasetMirrorJsonLd("scores-latest")) }}
      />
    ),
    leadParagraphs: [
      "Letter grades from A+ to F computed from live reserve feeds, transitive dependency scoring, and redemption-backstop blending — not just market-cap rankings.",
    ],
  },
  afterClient: (
    <>
      <CalloutBanner
        icon={<Bell className="h-4 w-4" />}
        className="border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300"
      >
        Get notified when a safety grade changes.{" "}
        <Link
          href="/pharoswatchbot/#bot"
          className="text-foreground underline underline-offset-4 hover:text-foreground/80 transition-colors"
        >
          Set up alerts&nbsp;&rarr;
        </Link>
      </CalloutBanner>
      <FaqSection items={FAQ_ITEMS} includeJsonLd />
    </>
  ),
});
