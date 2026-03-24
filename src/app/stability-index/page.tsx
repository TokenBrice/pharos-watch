import { Skeleton } from "@/components/ui/skeleton";
import { FaqSection } from "@/components/faq-section";
import { buildPageMetadata } from "@/lib/page-metadata";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import type { FaqItem } from "@/lib/faq";
import {
  PSI_METHODOLOGY_CHANGELOG_PATH,
  PSI_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/stability-index-version";

const description = "Historical Pharos Stability Index scores, component breakdowns, and condition band analysis for the stablecoin market.";

export const metadata = buildPageMetadata({
  title: "Stability Index: Pharos Stablecoin Market Health",
  description,
  canonical: "/stability-index/",
  ogImage: "https://api.pharos.watch/api/og/stability-index",
});

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

export default createClientFeaturePage({
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
    path: "/stability-index/",
    title: "Pharos Stability Index",
    statusBadge: { status: "mature", version: PSI_METHODOLOGY_VERSION_LABEL },
    methodology: {
      version: PSI_METHODOLOGY_VERSION_LABEL,
      changelogPath: PSI_METHODOLOGY_CHANGELOG_PATH,
    },
    leadParagraphs: [
      "Read the market regime first, then drill into the component drivers and historical shock points that pushed the stablecoin market there.",
      "PSI is a composite 0–100 market-health score built from peg deviation severity, depeg breadth, DEWS stress breadth, and 7-day market-cap trend. The six condition bands turn that composite into a usable regime read rather than a raw number.",
    ],
  },
  afterClient: <FaqSection items={FAQ_ITEMS} includeJsonLd />,
});
