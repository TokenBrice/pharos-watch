import { Skeleton } from "@/components/ui/skeleton";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";

const description =
  "Build your stablecoin portfolio, see your weighted safety grade, upstream collateral exposure, and simulate how a major stablecoin failure would affect your holdings.";

const route = createClientFeaturePage({
  path: "/portfolio/",
  metadata: {
    title: "Portfolio: Personal Stablecoin Risk View",
    description,
    ogImage: `${SITE_URL}/og-portfolio.png`,
    robots: {
      index: false,
      follow: true,
    },
  },
  loadClient: () => import("./client").then((m) => ({ default: m.PortfolioClient })),
  loading: <Skeleton className="h-[400px] w-full rounded-xl" />,
  shell: {
    breadcrumbName: "Portfolio",
    title: "Portfolio",
    leadParagraphs: ["Track your stablecoin holdings and assess your personal risk exposure."],
  },
});

export const metadata = route.metadata;
export default route.Page;
