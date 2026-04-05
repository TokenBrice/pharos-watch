import { Skeleton } from "@/components/ui/skeleton";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import { buildPageMetadata } from "@/lib/page-metadata";

const description =
  "Compare public protocol and DAO treasuries by decentralized stablecoin exposure, treasury share, stable-sleeve mix, and weighted safety grades.";

export const metadata = buildPageMetadata({
  title: "Treasuries: Protocol Stablecoin Exposure",
  description,
  canonical: "/treasuries/",
});

export default createClientFeaturePage({
  loadClient: () => import("./client").then((m) => ({ default: m.TreasuriesClient })),
  loading: <Skeleton className="h-[400px] w-full rounded-xl" />,
  shell: {
    breadcrumbName: "Treasuries",
    path: "/treasuries/",
    title: "Protocol Treasuries",
    statusBadge: { status: "testing-in-prod" },
    leadParagraphs: [
      "Compare public protocol and DAO treasuries by decentralized stablecoin dollars, treasury share, and stable-sleeve mix.",
    ],
  },
});
