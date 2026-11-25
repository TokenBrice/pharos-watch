import Link from "next/link";
import { FaqSection } from "@/components/faq-section";
import { ShareButton } from "@/components/share-button";
import { Skeleton } from "@/components/ui/skeleton";
import { JsonLdScript } from "@/components/json-ld-script";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import { COVERAGE_FAQ_ITEMS } from "./coverage-faq";
import { RemovedStablecoinsSection } from "./removed-stablecoins-section";
import { buildCoverageDatasetJsonLd } from "@/lib/analytics-dataset-json-ld";
import { safeJsonLd } from "@/lib/json-ld";
import {
  ACTIVE_STABLECOIN_COUNT,
  PRE_LAUNCH_STABLECOIN_COUNT,
  TRACKED_STABLECOIN_COUNT,
} from "@/lib/stablecoin-static-data";

const coverageDescription =
  "See per-coin Pharos coverage for depeg tracking, DEX liquidity, reserves, redemption, yield, flows, FreezeWatch, compliance, dependency maps, and mint authority.";

const COVERAGE_DATASET_JSON_LD = buildCoverageDatasetJsonLd();

const route = createClientFeaturePage({
  path: "/coverage/",
  metadata: {
    title: "Coverage Matrix: Stablecoin Feature Coverage",
    description: coverageDescription,
  },
  loadClient: () => import("./client").then((m) => ({ default: m.default })),
  loading: <Skeleton className="h-[560px] w-full rounded-xl" />,
  shell: {
    header: "instrument",
    leadDisclosureLabel: "How to read coverage",
    breadcrumbName: "Coverage",
    title: "Coverage Matrix",
    headerActions: <ShareButton label="Share" />,
    leadParagraphs: [
      `What Pharos can show for each of the ${ACTIVE_STABLECOIN_COUNT} active stablecoins, and how much of the ${TRACKED_STABLECOIN_COUNT}-asset tracked market each feature reaches.`,
      "Coverage answers whether Pharos can show a feature for a specific asset today. A blank or unavailable state is a data boundary, not an implied risk grade.",
      <>
        Use the matrix before comparing{" "}
        <Link href="/depeg/" className="pharos-prose-link">
          depegs
        </Link>
        ,{" "}
        <Link href="/liquidity/" className="pharos-prose-link">
          liquidity
        </Link>
        ,{" "}
        <Link href="/yield/" className="pharos-prose-link">
          yield
        </Link>
        , or{" "}
        <Link href="/flows/" className="pharos-prose-link">
          mint/burn flows
        </Link>{" "}
        across long-tail assets. Market-cap coverage shows how much of the stablecoin economy each feature reaches;
        coin-count coverage shows how broad the underlying asset support is.
      </>,
      <>
        {PRE_LAUNCH_STABLECOIN_COUNT}{" "}
        <Link href="/upcoming/" className="pharos-prose-link">
          pre-launch stablecoins
        </Link>{" "}
        (upcoming, or launched and awaiting data) are excluded until they enter active tracking.
      </>,
    ],
    preface: <JsonLdScript json={safeJsonLd(COVERAGE_DATASET_JSON_LD)} />,
  },
  afterClient: (
    <>
      <RemovedStablecoinsSection />
      <FaqSection items={COVERAGE_FAQ_ITEMS} title="Coverage FAQ" includeJsonLd />
    </>
  ),
});

export const metadata = route.metadata;
export default route.Page;
