import { AlertsHeaderLink } from "@/components/alerts-header-link";
import { ChartSkeleton } from "@/components/chart-skeleton";
import { FaqSection } from "@/components/faq-section";
import { PageLoadingSplitHero } from "@/components/page-loading-skeleton";
import { ShareButton } from "@/components/share-button";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import type { FaqItem } from "@/lib/faq";
import {
  PSI_METHODOLOGY_CHANGELOG_PATH,
  PSI_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/constants";
import { PSI_CONDITION_BANDS } from "@shared/lib/psi-policy";

const description = "Historical Pharos Stability Index scores, component breakdowns, and condition band analysis for the stablecoin market.";

const FAQ_ITEMS = [
  {
    question: "What is the Pharos Stability Index?",
    answer:
      "The Pharos Stability Index (PSI) is a composite 0–100 score that measures the overall health of the stablecoin market. It combines four signals: peg deviation severity (how far coins are from their target price), depeg breadth (what fraction of coins are actively depegged), DEWS stress breadth (coins under elevated stress before full depegs), and 7-day market-cap trend. A higher score means calmer markets.",
  },
  {
    question: "What do the condition bands mean?",
    answer:
      `PSI scores map to ${PSI_CONDITION_BANDS.length} condition bands: ${PSI_CONDITION_BANDS.map(({ band, min }, index) =>
        `${band} [${min}, ${index === 0 ? "100]" : `${PSI_CONDITION_BANDS[index - 1].min})`}`).join(", ")}. Each lower band reflects broader and deeper stablecoin stress.`,
  },
] as const satisfies readonly FaqItem[];

const route = createClientFeaturePage({
  path: "/stability-index/",
  metadata: {
    title: "Stablecoin Stability Index: Live Market Stress Score",
    description,
  },
  loadClient: () => import("./client").then((m) => ({ default: m.StabilityIndexClient })),
  loading: (
    <div className="space-y-6">
      <PageLoadingSplitHero visualClassName="min-h-[260px]" visualVariant="area" />
      <div className="pharos-card-shell p-5 sm:p-6">
        <ChartSkeleton variant="area" className="h-[250px] w-full sm:h-[350px]" />
      </div>
    </div>
  ),
  shell: {
    breadcrumbName: "Stability Index",
    title: "Pharos Stability Index",
    methodology: {
      version: PSI_METHODOLOGY_VERSION_LABEL,
      changelogPath: PSI_METHODOLOGY_CHANGELOG_PATH,
      docsPath: "/docs/stability-index/",
    },
    header: "instrument",
    headerActions: (
      <>
        <AlertsHeaderLink
          href="/pharoswatchbot/#getting-started"
          description="Get Telegram alerts when PSI crosses condition bands"
        />
        <ShareButton />
      </>
    ),
    leadParagraphs: [
      "A 0-100 market-regime gauge for stablecoins: 100 is calm Bedrock, 0 is Meltdown.",
    ],
  },
  afterClient: <FaqSection items={FAQ_ITEMS} includeJsonLd />,
});

export const metadata = route.metadata;
export default route.Page;
