import { Skeleton } from "@/components/ui/skeleton";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import { buildPageMetadata } from "@/lib/page-metadata";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";

const description =
  "Interactive graph of collateral dependencies between up to 50 dependency-linked stablecoins by market cap. Node size reflects market cap; lines show collateral links.";

export const metadata = buildPageMetadata({
  title: "Dependency Map: Stablecoin Collateral Graph",
  description,
  canonical: "/dependency-map/",
  ogImage: `${SITE_URL}/og-dependency-map.png`,
});

export default createClientFeaturePage({
  loadClient: () => import("./client").then((m) => ({ default: m.DependencyMapClient })),
  loading: <Skeleton className="h-[600px] w-full rounded-lg" />,
  shell: {
    breadcrumbName: "Dependency Map",
    path: "/dependency-map/",
    title: "Dependency Map",
    statusBadge: { status: "experimental" },
    leadParagraphs: [
      "See hidden systemic risk: the live graph of who backs whom.",
      "Stablecoins that look safe in isolation can collapse when their collateral fails. This graph maps transitive collateral dependencies across the ecosystem. Drag nodes to trace exposure chains — then take the insight to the Safety Scores contagion simulator to model the cascade.",
    ],
  },
});
