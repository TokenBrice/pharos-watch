import dynamic from "next/dynamic";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { Skeleton } from "@/components/ui/skeleton";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { buildPageMetadata } from "@/lib/page-metadata";

const CompareClient = dynamic(
  () => import("./client").then((m) => ({ default: m.CompareClient })),
  { loading: () => <Skeleton className="h-[400px] w-full rounded-xl" /> },
);

const compareDescription = `Side-by-side comparison of stablecoin stats, supply history, and peg stability for ${TRACKED_STABLECOINS.length} tracked stablecoins.`;

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

export default function ComparePage() {
  return (
    <FeaturePageShell
      breadcrumbName="Compare"
      path="/compare/"
      title="Compare Stablecoins"
      statusBadge={{ status: "mature" }}
      leadParagraphs={[
        "Use the live compare tool for custom side-by-side analysis.",
        "Select up to five tracked assets to compare supply, peg stability, liquidity, safety scores, and structural differences in one view.",
      ]}
    >
      <CompareClient />
    </FeaturePageShell>
  );
}
