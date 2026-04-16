import { Skeleton } from "@/components/ui/skeleton";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import { buildPageMetadata } from "@/lib/page-metadata";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { safeJsonLd } from "@/lib/json-ld";
import { buildFaqJsonLd } from "@/lib/faq";
import { ACTIVE_STABLECOINS, PRE_LAUNCH_STABLECOINS } from "@shared/lib/stablecoins";

const coverageDescription =
  "Per-coin feature coverage across Pharos. See which stablecoins have depeg tracking, DEX price verification, reserve views, redemption backstop coverage, yield intelligence, mint/burn flows, blacklist tracking, and dependency-map visibility.";

import { COVERAGE_FAQ_ITEMS } from "./coverage-faq";

const COVERAGE_FAQ_JSON_LD = buildFaqJsonLd(
  COVERAGE_FAQ_ITEMS.map((item) => ({ question: item.q, answer: item.a })),
);

export const metadata = buildPageMetadata({
  title: "Coverage Matrix: Stablecoin Feature Coverage",
  description: coverageDescription,
  canonical: "/coverage/",
  ogImage: `${SITE_URL}/og-coverage.png`,
});

export default createClientFeaturePage({
  loadClient: () => import("./client").then((m) => ({ default: m.default })),
  loading: <Skeleton className="h-[560px] w-full rounded-xl" />,
  shell: {
    breadcrumbName: "Coverage",
    path: "/coverage/",
    title: "Coverage Matrix",
    statusBadge: { status: "mature" },
    leadParagraphs: [
      `Use this page to answer two questions fast across ${ACTIVE_STABLECOINS.length} active tracked stablecoins: what Pharos can show for a coin right now, and how much of the tracked market each surface actually reaches.`,
      "Start with the feature snapshot for breadth by coin count and market-cap share, then drop into the matrix when you need the asset-level truth.",
      <>
        {PRE_LAUNCH_STABLECOINS.length}{" "}
        <a href="/upcoming" className="underline underline-offset-2 hover:text-foreground transition-colors">
          upcoming stablecoins
        </a>{" "}
        are excluded until they enter active tracking.
      </>,
    ],
    preface: (
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(COVERAGE_FAQ_JSON_LD) }} />
    ),
  },
});
