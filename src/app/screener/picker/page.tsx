import { Skeleton } from "@/components/ui/skeleton";
import { createClientFeaturePage } from "@/lib/client-feature-page";

const description =
  "Describe how you intend to use a stablecoin for Treasury, Yield, or Active Trading, and Pharos returns a profile-fit shortlist of tracked coins with a 'what to consider next' companion.";

const LEAD_PARAGRAPH =
  "Pick a Treasury, Yield, or Active Trading profile and get the tracked stablecoins that survive Pharos's exclusion filters, ranked by fit and linked to the Screener for verification. This is filter output, not advice.";

const route = createClientFeaturePage({
  path: "/screener/picker/",
  metadata: {
    title: "Stablecoin Picker: Match a Profile to a Shortlist",
    description,
    ogImage: "/og-selector-default.png",
    ogWidth: 1200,
    ogHeight: 630,
    robots: {
      index: false,
      follow: true,
    },
  },
  loadClient: () => import("./client").then((m) => ({ default: m.SelectorClient })),
  loading: <Skeleton className="h-[400px] w-full rounded-xl" />,
  shell: {
    breadcrumbName: "Picker",
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

export const metadata = route.metadata;
export default route.Page;
