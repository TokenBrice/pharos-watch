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
  "Compare active Safety Score V9 stablecoin ratings across backing, exit, economic control, evidence quality, dependencies, and structural caps.";

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
      "Safety Score V9 combines three pillars: Backing, Exit, and Economic Control. Evidence quality, dependencies, access posture, binding caps, and peg behavior can limit the published score. The resulting 0–100 score maps to a letter grade from A+ to F, while insufficient evidence is shown as NR.",
  },
  {
    question: "What do the three V9 pillars measure?",
    answer:
      "Backing measures the quality and reliability of the assets supporting a stablecoin. Exit measures whether holders can leave at meaningful size through independent routes. Economic Control measures governance, issuance, transfer, and intervention powers that can affect holders.",
  },
  {
    question: "How often do safety grades change?",
    answer:
      "Safety Score V9 is evaluated on the report-card producer cadence. If a transient infrastructure failure would create an unsupported downgrade, Pharos holds the last verified V9 ratings and shows the accepted and attempted times separately instead of publishing the failed attempt or falling back to V8.",
  },
  {
    question: "What should I do with this information?",
    answer:
      "Safety grades are one input into your own risk assessment, not financial advice. Review the three pillars, binding caps, evidence level, and dependency information before relying on an overall grade.",
  },
  {
    question: "Why do most stablecoins receive a C grade?",
    answer:
      "A C grade means the asset has meaningful weaknesses or evidence gaps in at least one V9 pillar. Strong backing alone cannot offset a weak exit route, concentrated economic control, or a binding structural cap.",
  },
] as const satisfies readonly FaqItem[];

export default createClientFeaturePage({
  loadClient: () => import("./v9-client").then((m) => ({ default: m.ReportCardsV9Client })),
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
      "Every tracked stablecoin assessed across three dimensions: Backing, Exit, and Economic Control, distilled into a single comprehensive safety grade.",
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
