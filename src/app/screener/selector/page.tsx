import { Skeleton } from "@/components/ui/skeleton";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import { buildPageMetadata } from "@/lib/page-metadata";

const description =
  "Describe how you intend to use a stablecoin — Treasury, Yield, or Active Trading — and Pharos returns a profile-fit shortlist of tracked coins with a 'what to consider next' companion.";

export const metadata = buildPageMetadata({
  title: "Stablecoin Selector — Match a Profile to a Shortlist",
  description,
  canonical: "/screener/selector/",
  ogImage: "/og-selector-default.png",
  ogWidth: 1200,
  ogHeight: 630,
  robots: {
    index: false,
    follow: true,
  },
});

const LEAD_PARAGRAPH =
  "The Selector applies Pharos's per-profile exclusion filters and shows you the tracked stablecoins that survive, sorted by how well they fit the profile you describe. You give it a profile — Treasury, Yield, or Active Trading. It returns up to 3 candidates ranked under that profile's weights, plus up to 2 profile mismatches for the same use case. Every entry anchors to a live data point and links to the Screener for verification. This is filter output, not advice.";

export default createClientFeaturePage({
  loadClient: () => import("./client").then((m) => ({ default: m.SelectorClient })),
  loading: <Skeleton className="h-[400px] w-full rounded-xl" />,
  shell: {
    breadcrumbName: "Selector",
    path: "/screener/selector/",
    title: "Stablecoin Selector",
    variant: "longform",
    statusBadge: { status: "beta" },
    leadParagraphs: [LEAD_PARAGRAPH],
    breadcrumbItems: [
      { name: "Home", url: "/" },
      { name: "Screener", url: "/screener/" },
      { name: "Selector", url: "/screener/selector/" },
    ],
  },
});
