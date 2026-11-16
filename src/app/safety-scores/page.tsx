import Link from "next/link";
import { Bell, Map as MapIcon } from "lucide-react";
import { AlertsHeaderLink } from "@/components/alerts-header-link";
import { Button } from "@/components/ui/button";
import { CalloutBanner } from "@/components/callout-banner";
import { FaqSection } from "@/components/faq-section";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { JsonLdScript } from "@/components/json-ld-script";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { ShareButton } from "@/components/share-button";
import { buildPageMetadata } from "@/lib/page-metadata";
import { SafetyScoresContentLoadingState } from "@/app/safety-scores/loading-state";
import { SafetyScoresLiveIsland } from "@/app/safety-scores/live-island";
import { getSafetyScoresPreview } from "@/lib/safety-grade-snapshot";
import { buildPublicDatasetMirrorJsonLd } from "@/lib/analytics-dataset-json-ld";
import { safeJsonLd } from "@/lib/json-ld";
import type { FaqItem } from "@/lib/faq";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import {
  SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH,
  SAFETY_SCORE_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/constants";

const reportCardsDescription =
  "Compare stablecoin safety ratings across backing, exit, economic control, evidence quality, dependencies, and structural caps.";

const SAFETY_REFRESH_HOURS = CRON_INTERVALS["compute-safety-score-v9"] / 3600;

const FAQ_ITEMS = [
  {
    question: "How are stablecoin safety grades calculated?",
    answer:
      "Safety Score V10 combines three pillars: Backing, Exit, and Economic Control. Proven pipeline or public-curation gaps do not score: partial ratings use available evidence, while fewer than two available pillars shows Pipeline gap with no score or grade. Genuine rating withholds are shown as NR. Rated 0–100 scores map to A+ through F.",
  },
  {
    question: "What do the three V10 pillars measure?",
    answer:
      "Backing measures the quality and reliability of the assets supporting a stablecoin. Exit measures whether holders can leave at meaningful size through independent routes. Economic Control measures governance, issuance, transfer, and intervention powers that can affect holders.",
  },
  {
    question: "How often do safety grades change?",
    answer:
      `Pharos evaluates safety grades every ${SAFETY_REFRESH_HOURS === 1 ? "hour" : `${SAFETY_REFRESH_HOURS} hours`}. If an update cannot be verified, the last verified ratings remain visible with their publication time and an update notice.`,
  },
  {
    question: "What should I do with this information?",
    answer:
      "Safety grades are one input into your own risk assessment, not financial advice. Review the three pillars, binding caps, evidence level, and dependency information before relying on an overall grade.",
  },
  {
    question: "Why do most stablecoins receive a C grade?",
    answer:
      "A C grade means the asset has meaningful weaknesses or evidence gaps in at least one V10 pillar. Strong backing alone cannot offset a weak exit route, concentrated economic control, or a binding structural cap.",
  },
] as const satisfies readonly FaqItem[];

const initialPreview = getSafetyScoresPreview();

export const metadata = buildPageMetadata({
  canonical: "/safety-scores/",
  title: "Safety Scores: Stablecoin Safety Grades",
  description: reportCardsDescription,
});

export default function SafetyScoresPage() {
  return (
    <FeaturePageShell
      path="/safety-scores/"
      breadcrumbName="Safety Scores"
      title="Safety Scores"
      methodology={{
        version: SAFETY_SCORE_METHODOLOGY_VERSION_LABEL,
        changelogPath: SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH,
      }}
      header="instrument"
      headerActions={
        <>
          {/* Server-rendered so the map stays crawlable from the homepage. */}
          <Button asChild variant="outline" size="sm" className="min-h-11 rounded-full px-4 lg:min-h-9 lg:rounded-md">
            <Link href="/safety-scores/map/" aria-label="Map: every grade band as a single image">
              <MapIcon aria-hidden="true" />
              <span>Map</span>
            </Link>
          </Button>
          <AlertsHeaderLink
            href="/pharoswatchbot/#getting-started"
            description="Get notified when a safety grade changes"
          />
          <ShareButton stablecoinId="safety-scores" />
        </>
      }
      preface={<JsonLdScript json={safeJsonLd(buildPublicDatasetMirrorJsonLd("scores-latest"))} />}
      leadParagraphs={[
        "Every active stablecoin graded on Backing, Exit, and Economic Control, distilled into one safety grade.",
      ]}
    >
      <SectionErrorBoundary name="Safety Scores" supportingText="This section failed to load. Try refreshing the page.">
        {/* First flush, outside Suspense: a server-side dynamic() would outline
            the hero, LCP image and dated preview into a hidden segment and
            still load the live chunk eagerly. */}
        <SafetyScoresLiveIsland initialPreview={initialPreview}>
          <SafetyScoresContentLoadingState preview={initialPreview} />
        </SafetyScoresLiveIsland>
      </SectionErrorBoundary>
      <CalloutBanner
        icon={<Bell className="h-4 w-4" />}
        className="border-state-info bg-state-info-subtle text-state-info-bright"
      >
        Get notified when a safety grade changes.{" "}
        <Link
          href="/pharoswatchbot/#getting-started"
          className="text-foreground underline underline-offset-4 hover:text-foreground/80 transition-colors"
        >
          Set up alerts&nbsp;&rarr;
        </Link>
      </CalloutBanner>
      <FaqSection items={FAQ_ITEMS} includeJsonLd />
    </FeaturePageShell>
  );
}
