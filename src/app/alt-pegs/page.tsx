import { Skeleton } from "@/components/ui/skeleton";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";

const description =
  "Non-USD stablecoin market structure across euro, gold, CPI-linked, and other alternative peg cohorts tracked by Pharos.";

const route = createClientFeaturePage({
  path: "/alt-pegs/",
  metadata: {
    title: "Non-USD Stablecoins: Market Structure",
    description,
    ogImage: `${SITE_URL}/og-alt-pegs.png`,
  },
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
    title: "Non-USD Market Structure",
    leadParagraphs: [
      "See where stablecoin growth is broadening beyond the dollar.",
    ],
  },
});

export const metadata = route.metadata;
export default route.Page;
