import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import { Skeleton } from "@/components/ui/skeleton";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import { buildPageMetadata } from "@/lib/page-metadata";

const compareDescription = `Side-by-side comparison of stablecoin stats, supply history, and peg stability for ${ACTIVE_STABLECOINS.length} tracked stablecoins.`;

export const metadata = buildPageMetadata({
  title: "Compare Stablecoins: Side-by-Side Analysis",
  description: compareDescription,
  canonical: "/compare/",
  ogImage: "https://pharos.watch/og-compare.png",
  robots: {
    index: false,
    follow: true,
  },
});

export default createClientFeaturePage({
  loadClient: () => import("./client").then((m) => ({ default: m.CompareClient })),
  loading: <Skeleton className="h-[400px] w-full rounded-xl" />,
  shell: {
    breadcrumbName: "Compare",
    path: "/compare/",
    title: "Compare Stablecoins",
    statusBadge: { status: "mature" },
    leadParagraphs: [
      "Build a live peer set, then read peg behavior, liquidity, safety scores, and structural differences without bouncing between detail pages.",
      "Select two to five tracked assets. Presets are starting angles, not canned answers: the useful work starts once the comparison is on screen.",
    ],
  },
});
