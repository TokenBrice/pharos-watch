import Link from "next/link";
import { Bell } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { CalloutBanner } from "@/components/callout-banner";
import { FaqSection } from "@/components/faq-section";
import { ShareButton } from "@/components/share-button";
import { buildPageMetadata } from "@/lib/page-metadata";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import type { FaqItem } from "@/lib/faq";
import {
  SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH,
  SAFETY_SCORE_VERSION_LABEL,
} from "@shared/lib/safety-score-version";

const reportCardsDescription =
  "Transparent stablecoin safety grades and contagion simulation. Five dimensions combined into a single letter grade, plus simulate what happens when a major stablecoin fails.";

export const metadata = buildPageMetadata({
  title: "Safety Scores: Stablecoin Safety Grades",
  description: reportCardsDescription,
  canonical: "/safety-scores/",
  ogImage: "https://api.pharos.watch/api/og/safety-scores",
});

const FAQ_ITEMS = [
  {
    question: "How are stablecoin safety grades calculated?",
    answer:
      "Each stablecoin is scored across five dimensions: peg stability (historical deviation and depeg events), liquidity depth (DEX pool size, volume, and protocol diversity), resilience (collateral quality, custody model, and blacklist capability), decentralization (governance type and chain infrastructure), and dependency risk (exposure to upstream stablecoins). Dimension scores are weighted and combined into a composite 0–100 score, then mapped to a letter grade from A+ to F.",
  },
  {
    question: "What does the contagion simulation show?",
    answer:
      "The contagion simulator models cascading failures in the stablecoin ecosystem. You select a stablecoin to \"fail\" and the simulation traces dependency chains: if stablecoin A uses stablecoin B as collateral, and B fails, A's grade degrades proportionally to its exposure. This reveals hidden systemic risk: which coins look safe in isolation but are fragile under stress.",
  },
] as const satisfies readonly FaqItem[];

export default createClientFeaturePage({
  loadClient: () => import("./client").then((m) => ({ default: m.ReportCardsClient })),
  loading: <Skeleton className="h-[400px] w-full rounded-xl" />,
  shell: {
    breadcrumbName: "Safety Scores",
    path: "/safety-scores/",
    title: "Safety Scores",
    accent: "border-t-emerald-500",
    statusBadge: { status: "mature", version: SAFETY_SCORE_VERSION_LABEL },
    methodology: {
      version: SAFETY_SCORE_VERSION_LABEL,
      changelogPath: SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH,
    },
    headerActions: <ShareButton ogPath="/api/og/safety-scores" />,
    leadParagraphs: [
      "Safety grades and contagion simulation for every tracked stablecoin.",
      "Each stablecoin receives a letter grade from A+ to F based on five dimensions: peg stability, liquidity depth, transparency, resilience, and regulatory standing. The contagion simulator lets you model what happens to the broader market when a major stablecoin fails, revealing hidden dependency chains and systemic risk.",
    ],
  },
  beforeClient: (
    <CalloutBanner icon={<Bell className="h-4 w-4" />} className="border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300">
      Get notified when a safety grade changes.{" "}
      <Link
        href="/telegram#bot"
        className="text-foreground underline underline-offset-4 hover:text-foreground/80 transition-colors"
      >
        Set up alerts&nbsp;&rarr;
      </Link>
    </CalloutBanner>
  ),
  afterClient: <FaqSection items={FAQ_ITEMS} includeJsonLd />,
});
