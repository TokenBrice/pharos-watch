import { Skeleton } from "@/components/ui/skeleton";
import { FaqSection } from "@/components/faq-section";
import { buildApiOgImageUrl } from "@/lib/page-metadata";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import type { FaqItem } from "@/lib/faq";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import {
  PSI_METHODOLOGY_CHANGELOG_PATH,
  PSI_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/constants";

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
      "PSI scores map to six condition bands: BEDROCK (90–100), STEADY (75–89), TREMOR (60–74), FRACTURE (40–59), CRISIS (20–39), and MELTDOWN (0–19). Each lower band reflects broader and deeper stablecoin stress.",
  },
] as const satisfies readonly FaqItem[];

const route = createClientFeaturePage({
  path: "/stability-index/",
  metadata: {
    title: "Stability Index: Pharos Stablecoin Market Health",
    description,
    ogImage: buildApiOgImageUrl(API_PATHS.ogStabilityIndex()),
  },
  loadClient: () => import("./client").then((m) => ({ default: m.StabilityIndexClient })),
  loading: (
    <div className="space-y-6">
      <Skeleton className="h-48 w-full rounded-xl" />
      <Skeleton className="h-[350px] w-full rounded-xl" />
      <Skeleton className="h-[350px] w-full rounded-xl" />
    </div>
  ),
  shell: {
    breadcrumbName: "Stability Index",
    title: "Pharos Stability Index",
    methodology: {
      version: PSI_METHODOLOGY_VERSION_LABEL,
      changelogPath: PSI_METHODOLOGY_CHANGELOG_PATH,
    },
    leadParagraphs: [
      "A VIX for stablecoins: read the market regime before you trade.",
    ],
  },
  afterClient: <FaqSection items={FAQ_ITEMS} includeJsonLd />,
});

export const metadata = route.metadata;
export default route.Page;
