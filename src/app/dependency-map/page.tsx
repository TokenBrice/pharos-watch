import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/skeleton";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { buildPageMetadata } from "@/lib/page-metadata";

const DependencyMapClient = dynamic(
  () => import("./client").then((m) => ({ default: m.DependencyMapClient })),
  { loading: () => <Skeleton className="h-[600px] w-full rounded-lg" /> },
);

const description =
  "Interactive graph of collateral dependencies between up to 50 dependency-linked stablecoins by market cap. Node size reflects market cap; lines show collateral links.";

export const metadata = buildPageMetadata({
  title: "Dependency Map: Stablecoin Collateral Graph",
  description,
  canonical: "/dependency-map/",
  ogImage: "https://pharos.watch/og-dependency-map.png",
});

export default function DependencyMapPage() {
  return (
    <FeaturePageShell
      breadcrumbName="Dependency Map"
      path="/dependency-map/"
      title="Dependency Map"
      statusBadge={{ status: "experimental" }}
      leadParagraphs={[
        "Collateral dependencies between up to 50 dependency-linked stablecoins by market cap. Node size reflects market cap; lines show how one stablecoin relies on another as collateral. Drag nodes to explore.",
      ]}
    >
      <DependencyMapClient />
    </FeaturePageShell>
  );
}
