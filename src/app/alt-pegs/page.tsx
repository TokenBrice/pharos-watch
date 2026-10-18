import { ShareButton } from "@/components/share-button";
import { Skeleton } from "@/components/ui/skeleton";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import { buildLiveRouteOgImageUrl } from "@/lib/page-metadata";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";

const description =
  "Non-USD stablecoin market structure across euro, gold, CPI-linked, and other alternative peg cohorts tracked by Pharos.";

const route = createClientFeaturePage({
  path: "/alt-pegs/",
  metadata: {
    title: "Non-USD Pegs: Stablecoins Beyond the Dollar",
    description,
    ogImage: buildLiveRouteOgImageUrl("alt-pegs"),
  },
  loadClient: () => import("./client").then((mod) => ({ default: mod.AltPegsClient })),
  loading: (
    <div className="space-y-6">
      <Skeleton className="h-[300px] w-full rounded-xl" />
      <Skeleton className="h-[420px] w-full rounded-xl" />
      <Skeleton className="h-[520px] w-full rounded-xl" />
    </div>
  ),
  shell: {
    breadcrumbName: "Non-USD Pegs",
    title: "Non-USD Pegs",
    header: "instrument",
    headerActions: <ShareButton ogPath={API_PATHS.ogPage("alt-pegs")} />,
    leadParagraphs: [
      "See where stablecoin growth is broadening beyond the dollar.",
    ],
  },
});

export const metadata = route.metadata;
export default route.Page;
