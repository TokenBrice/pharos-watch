import Link from "next/link";
import { Bell } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { CalloutBanner } from "@/components/callout-banner";
import { FaqSection } from "@/components/faq-section";
import { ShareButton } from "@/components/share-button";
import { buildApiOgImageUrl, buildPageMetadata } from "@/lib/page-metadata";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import type { FaqItem } from "@/lib/faq";
import {
  SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH,
  SAFETY_SCORE_VERSION_LABEL,
} from "@shared/lib/safety-score-version";

const reportCardsDescription =
  "Transparent stablecoin safety grades and contagion simulation. Four weighted base dimensions plus a peg-stability multiplier map into one letter grade, with stress tests for major stablecoin failures.";

export const metadata = buildPageMetadata({
  title: "Safety Scores: Stablecoin Safety Grades",
  description: reportCardsDescription,
  canonical: "/safety-scores/",
  ogImage: buildApiOgImageUrl("/api/og/safety-scores"),
});

const FAQ_ITEMS = [
  {
    question: "How are stablecoin safety grades calculated?",
    answer:
      "Each stablecoin is scored across five weighted base dimensions: liquidity depth (DEX pool size, volume, protocol diversity, and redemption backstops), resilience (collateral quality, custody model, and blacklist capability), decentralization (governance type and chain infrastructure), dependency risk (exposure to upstream stablecoins), and peg stability. The four structural dimensions are combined first, then peg stability acts as a multiplier on the result. The resulting 0–100 score maps to a letter grade from A+ to F.",
  },
  {
    question: "What does the contagion simulation show?",
    answer:
      "The contagion simulator models cascading failures in the stablecoin ecosystem. You select a stablecoin to \"fail\" and the simulation traces dependency chains: if stablecoin A uses stablecoin B as collateral, and B fails, A's grade degrades proportionally to its exposure. This reveals hidden systemic risk: which coins look safe in isolation but are fragile under stress.",
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
    statusBadge: { status: "mature", version: SAFETY_SCORE_VERSION_LABEL },
    methodology: {
      version: SAFETY_SCORE_VERSION_LABEL,
      changelogPath: SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH,
    },
    headerActions: <ShareButton ogPath="/api/og/safety-scores" />,
    leadParagraphs: [
      "Letter grades from A+ to F computed from live reserve feeds, transitive dependency scoring, and redemption-backstop blending — not just market-cap rankings.",
      "Each grade weights five dimensions — liquidity depth, resilience, decentralization, dependency risk, and peg stability — then caps the result based on upstream exposure. A coin backed by USDC cannot score higher than USDC. The contagion simulator shows exactly how a major failure cascades through collateral chains.",
    ],
  },
  afterClient: (
    <>
      <CalloutBanner icon={<Bell className="h-4 w-4" />} className="border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300">
        Get notified when a safety grade changes.{" "}
        <Link
          href="/telegram#bot"
          className="text-foreground underline underline-offset-4 hover:text-foreground/80 transition-colors"
        >
          Set up alerts&nbsp;&rarr;
        </Link>
      </CalloutBanner>
      <FaqSection items={FAQ_ITEMS} includeJsonLd />
    </>
  ),
});
