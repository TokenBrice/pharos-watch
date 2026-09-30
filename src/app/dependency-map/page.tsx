import Link from "next/link";
import { FaqSection } from "@/components/faq-section";
import { Skeleton } from "@/components/ui/skeleton";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import type { FaqItem } from "@/lib/faq";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";

const description =
  "Interactive graph of collateral and wrapper dependencies between stablecoins. Node size reflects market cap; lines show direct dependency links.";

const DEPENDENCY_MAP_FAQ_ITEMS = [
  {
    question: "What does the Dependency Map show?",
    answer:
      "The Dependency Map shows direct collateral and wrapper dependencies between stablecoins with published Safety Scores. Bridges, custodians, and other shared infrastructure are not drawn as separate nodes.",
  },
  {
    question: "Why can dependency risk matter even when a coin holds its peg?",
    answer:
      "An upstream collateral asset, bridge, issuer, or shared contract can transmit changes to a dependent coin before a price depeg appears. Exposure mode traces mapped relationships, not the outcome of a failure.",
  },
  {
    question: "How should I combine this with Safety Scores?",
    answer:
      "Use the map to trace collateral and wrapper relationships, then read each coin's grade and dependency inputs on Safety Scores.",
  },
] as const satisfies readonly FaqItem[];

const DEPENDENCY_MAP_STATIC_SECTION = (
  <section className="pharos-card-shell px-4 py-4">
    <p className="pharos-kicker">Dependency Lens</p>
    <div className="mt-3 grid gap-3 text-sm leading-relaxed text-muted-foreground lg:grid-cols-3">
      <p>
        The graph shows direct collateral and wrapper links between stablecoins. Bridges, custodians, and shared
        issuance frameworks can also create common exposures, but are not drawn as separate nodes here.
      </p>
      <p>
        Start with the graph, then open{" "}
        <Link
          href="/safety-scores/"
          className="pharos-prose-link"
        >
          Safety Scores
        </Link>{" "}
        for each coin&apos;s grade and dependency inputs and{" "}
        <Link
          href="/coverage/"
          className="pharos-prose-link"
        >
          Coverage Matrix
        </Link>{" "}
        for per-coin data availability.
      </p>
      <p>
        Node size reflects market cap, not a forecast of losses. Exposure mode finds mapped downstream dependents
        using supply at publication evaluation. A dependency link identifies a relationship, not an outcome.
      </p>
    </div>
  </section>
);

const route = createClientFeaturePage({
  path: "/dependency-map/",
  metadata: {
    title: "Dependency Map: Stablecoin Collateral Graph",
    description,
    ogImage: `${SITE_URL}/og-dependency-map.png`,
  },
  loadClient: () => import("./client").then((m) => ({ default: m.DependencyMapClient })),
  loading: <Skeleton className="h-[600px] w-full rounded-lg" />,
  shell: {
    breadcrumbName: "Dependency Map",
    title: "Dependency Map",
    leadParagraphs: [
      "See hidden systemic risk: the live graph of who backs whom.",
    ],
    headerSupplement: (
      <p className="pharos-lead hidden sm:block">
        This graph maps direct collateral and wrapper dependencies between stablecoins. Select a coin to inspect
        its upstream assets and direct dependents, or use it as an Exposure root to trace linked coins.
      </p>
    ),
  },
  beforeClient: DEPENDENCY_MAP_STATIC_SECTION,
  afterClient: <FaqSection items={DEPENDENCY_MAP_FAQ_ITEMS} includeJsonLd />,
});

export const metadata = route.metadata;
export default route.Page;
