import { Skeleton } from "@/components/ui/skeleton";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import { buildPageMetadata } from "@/lib/page-metadata";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";

const coverageDescription =
  "Per-coin feature coverage across Pharos. See which stablecoins have depeg tracking, DEX price verification, reserve views, yield intelligence, mint/burn flows, blacklist tracking, and dependency-map visibility.";

export const metadata = buildPageMetadata({
  title: "Coverage Matrix: Stablecoin Feature Coverage",
  description: coverageDescription,
  canonical: "/coverage/",
});

export default createClientFeaturePage({
  loadClient: () => import("./client").then((m) => ({ default: m.default })),
  loading: <Skeleton className="h-[560px] w-full rounded-xl" />,
  shell: {
    breadcrumbName: "Coverage",
    path: "/coverage/",
    title: "Coverage",
    statusBadge: { status: "mature" },
    leadParagraphs: [
      `Feature breadth across ${ACTIVE_STABLECOINS.length} tracked stablecoins.`,
      "Start with the feature snapshot to see how wide each Pharos surface reaches by coin count and market-cap share. Then drop into the matrix to inspect what is available on a specific asset.",
    ],
  },
});
