import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";
import { SeeAlsoFooter } from "@/components/see-also-footer";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import { SEE_ALSO_GRAPH } from "@/lib/see-also-graph";
import { buildCoverageDatasetJsonLd } from "@/lib/analytics-dataset-json-ld";
import { buildPageMetadata } from "@/lib/page-metadata";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { safeJsonLd } from "@/lib/json-ld";
import { buildFaqJsonLd } from "@/lib/faq";
import {
  ACTIVE_STABLECOIN_COUNT,
  PRE_LAUNCH_STABLECOIN_COUNT,
  TRACKED_STABLECOIN_COUNT,
} from "@/lib/stablecoin-static-data";

const coverageDescription =
  "See per-coin Pharos coverage for depeg tracking, DEX liquidity, reserves, redemption backstops, yield, mint/burn flows, blacklist events, and dependency maps.";

import { COVERAGE_FAQ_ITEMS } from "./coverage-faq";

const COVERAGE_FAQ_JSON_LD = buildFaqJsonLd(COVERAGE_FAQ_ITEMS.map((item) => ({ question: item.q, answer: item.a })));
const COVERAGE_DATASET_JSON_LD = buildCoverageDatasetJsonLd();

const COVERAGE_STATIC_SECTION = (
  <section className="pharos-card-shell px-4 py-4">
    <p className="pharos-kicker">How To Read Coverage</p>
    <div className="mt-3 grid gap-3 text-sm leading-relaxed text-muted-foreground lg:grid-cols-3">
      <p>
        Coverage answers whether Pharos can show a feature for a specific asset today. A blank or unavailable state is a
        data boundary, not an implied risk grade.
      </p>
      <p>
        Use the matrix before comparing{" "}
        <Link
          href="/depeg/"
          className="pharos-prose-link"
        >
          depegs
        </Link>
        ,{" "}
        <Link
          href="/liquidity/"
          className="pharos-prose-link"
        >
          liquidity
        </Link>
        ,{" "}
        <Link
          href="/yield/"
          className="pharos-prose-link"
        >
          yield
        </Link>
        , or{" "}
        <Link
          href="/flows/"
          className="pharos-prose-link"
        >
          mint/burn flows
        </Link>{" "}
        across long-tail assets.
      </p>
      <p>
        Market-cap coverage shows how much of the stablecoin economy each feature reaches; coin-count coverage shows how
        broad the underlying asset support is.
      </p>
    </div>
  </section>
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
    leadParagraphs: [
      `Use this page to answer two questions fast across ${ACTIVE_STABLECOIN_COUNT} active stablecoins from the ${TRACKED_STABLECOIN_COUNT}-asset tracked universe: what Pharos can show for a coin right now, and how much of the tracked market each surface actually reaches.`,
      "Start with the feature snapshot for breadth by coin count and market-cap share, then drop into the matrix when you need the asset-level truth.",
      <>
        {PRE_LAUNCH_STABLECOIN_COUNT}{" "}
        <a href="/upcoming/" className="underline underline-offset-2 hover:text-foreground transition-colors">
          upcoming stablecoins
        </a>{" "}
        are excluded until they enter active tracking.
      </>,
    ],
    preface: (
      <>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: safeJsonLd(COVERAGE_DATASET_JSON_LD) }}
        />
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(COVERAGE_FAQ_JSON_LD) }} />
      </>
    ),
  },
  beforeClient: COVERAGE_STATIC_SECTION,
  afterClient: <SeeAlsoFooter links={SEE_ALSO_GRAPH["/coverage/"]} />,
});
