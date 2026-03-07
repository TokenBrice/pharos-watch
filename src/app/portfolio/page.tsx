import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/skeleton";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { buildPageMetadata } from "@/lib/page-metadata";

const PortfolioClient = dynamic(
  () => import("./client").then((m) => ({ default: m.PortfolioClient })),
  { loading: () => <Skeleton className="h-[400px] w-full rounded-xl" /> },
);

const description =
  "Build your stablecoin portfolio, see your weighted safety grade, upstream collateral exposure, and simulate how a major stablecoin failure would affect your holdings.";

export const metadata = buildPageMetadata({
  title: "Portfolio: Personal Stablecoin Risk View",
  description,
  canonical: "/portfolio/",
  ogImage: "https://pharos.watch/og-portfolio.png",
  ogHeight: 664,
  robots: {
    index: false,
    follow: true,
  },
});

export default function PortfolioPage() {
  return (
    <FeaturePageShell
      breadcrumbName="Portfolio"
      path="/portfolio/"
      title="Portfolio"
      statusBadge={{ status: "experimental" }}
      leadParagraphs={["Track your stablecoin holdings and assess your personal risk exposure."]}
    >
      <PortfolioClient />
    </FeaturePageShell>
  );
}
