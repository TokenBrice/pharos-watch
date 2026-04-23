import { Skeleton } from "@/components/ui/skeleton";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import { buildPageMetadata } from "@/lib/page-metadata";
import { StaticAltPegLinkHub } from "./static-link-hub";

const description =
  "Non-USD stablecoin market structure across euro, gold, CPI-linked, and other alternative peg cohorts tracked by Pharos.";

export const metadata = buildPageMetadata({
  title: "Non-USD Stablecoins: Market Structure",
  description,
  canonical: "/alt-pegs/",
});

export default createClientFeaturePage({
  loadClient: () => import("./client").then((mod) => ({ default: mod.AltPegsClient })),
  loading: (
    <div className="space-y-6">
      <Skeleton className="h-[280px] w-full rounded-xl" />
      <Skeleton className="h-[520px] w-full rounded-xl" />
      <Skeleton className="h-[360px] w-full rounded-xl" />
      <Skeleton className="h-[260px] w-full rounded-xl" />
    </div>
  ),
  shell: {
    breadcrumbName: "Non-USD Market Structure",
    path: "/alt-pegs/",
    title: "Non-USD Market Structure",
    leadParagraphs: [
      "See where stablecoin growth is broadening beyond the dollar.",
      "This route tracks the non-USD segment as a market-structure surface: current cohort share, historical non-USD growth, and direct links into each peg family Pharos already covers.",
    ],
  },
  beforeClient: <StaticAltPegLinkHub />,
});
