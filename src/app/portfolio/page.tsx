import { Skeleton } from "@/components/ui/skeleton";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import { buildPageMetadata } from "@/lib/page-metadata";
import { SITE_URL } from "@/lib/site-config";

const description =
  "Build your stablecoin portfolio, see your weighted safety grade, upstream collateral exposure, and simulate how a major stablecoin failure would affect your holdings.";

export const metadata = buildPageMetadata({
  title: "Portfolio: Personal Stablecoin Risk View",
  description,
  canonical: "/portfolio/",
  ogImage: `${SITE_URL}/og-portfolio.png`,
  ogHeight: 664,
  robots: {
    index: false,
    follow: true,
  },
});

export default createClientFeaturePage({
  loadClient: () => import("./client").then((m) => ({ default: m.PortfolioClient })),
  loading: <Skeleton className="h-[400px] w-full rounded-xl" />,
  shell: {
    breadcrumbName: "Portfolio",
    path: "/portfolio/",
    title: "Portfolio",
    statusBadge: { status: "beta" },
    leadParagraphs: ["Track your stablecoin holdings and assess your personal risk exposure."],
  },
});
