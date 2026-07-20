import { Skeleton } from "@/components/ui/skeleton";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import { buildPageMetadata } from "@/lib/page-metadata";

const description =
  "Describe how you intend to use a stablecoin — Treasury, Yield, or Active Trading — and Pharos returns a profile-fit shortlist of tracked coins with a 'what to consider next' companion.";

export const metadata = buildPageMetadata({
  title: "Stablecoin Picker — Match a Profile to a Shortlist",
  description,
  canonical: "/screener/picker/",
  ogImage: "/og-selector-default.png",
  ogWidth: 1200,
  ogHeight: 630,
  robots: {
    index: false,
    follow: true,
  },
});

const LEAD_PARAGRAPH =
  "Pick a profile — Treasury, Yield, or Active Trading — and get the tracked stablecoins that survive Pharos's exclusion filters, ranked by fit and linked to the Screener for verification. This is filter output, not advice.";

export default createClientFeaturePage({
  loadClient: () => import("./client").then((m) => ({ default: m.SelectorClient })),
  loading: <Skeleton className="h-[400px] w-full rounded-xl" />,
  shell: {
    breadcrumbName: "Picker",
    path: "/screener/picker/",
    title: "Stablecoin Picker",
    variant: "longform",
    leadParagraphs: [LEAD_PARAGRAPH],
    breadcrumbItems: [
      { name: "Home", url: "/" },
      { name: "Screener", url: "/screener/" },
      { name: "Picker", url: "/screener/picker/" },
    ],
  },
});
