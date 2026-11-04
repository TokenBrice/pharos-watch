import { Skeleton } from "@/components/ui/skeleton";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";

const description =
  "Build your stablecoin portfolio and review your holdings' safety grades and upstream collateral exposure.";

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
  // The selector must run before the workspace is parsed to avoid an empty-state flash.
  // eslint-disable-next-line @next/next/no-sync-scripts
  beforeClient: <script src="/portfolio-bootstrap.js" />,
  loading: <Skeleton className="h-[400px] w-full rounded-xl" />,
  shell: {
    breadcrumbName: "Portfolio",
    title: "Portfolio",
    leadParagraphs: ["Track your stablecoin holdings and assess your personal risk exposure."],
  },
});

export const metadata = route.metadata;
export default route.Page;
