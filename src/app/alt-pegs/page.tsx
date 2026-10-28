import Link from "next/link";
import { ShareButton } from "@/components/share-button";
import { Skeleton } from "@/components/ui/skeleton";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import { buildLiveRouteOgImageUrl } from "@/lib/page-metadata";
import { PEG_HUB_PAGES } from "@/lib/peg-taxonomy";
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
  afterClient: <PegDirectory />,
});

export const metadata = route.metadata;
export default route.Page;

/**
 * Every non-USD peg hub as a static chip directory, server-rendered outside the
 * client's loading/error branches so navigation survives a failed API read.
 * The live ranking below is the measured view; this is complete registry navigation.
 */
function PegDirectory() {
  const pages = PEG_HUB_PAGES.filter((page) => page.value !== "USD");
  if (pages.length === 0) return null;

  return (
    <section aria-labelledby="alt-peg-directories-heading" className="space-y-3">
      <h2 id="alt-peg-directories-heading" className="pharos-label">
        Peg directories
      </h2>
      <ul className="flex flex-wrap gap-2">
        {pages.map((page) => (
          <li key={page.href}>
            <Link
              href={page.href}
              prefetch={false}
              className="pharos-focus-ring inline-flex items-center rounded-full border border-border/60 bg-background px-2.5 py-1 text-xs font-medium transition-colors hover:bg-accent"
            >
              <span>
                {page.shortLabel} stablecoins
                {page.preLaunchOnly ? <span className="text-muted-foreground">{" · Upcoming"}</span> : null}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
