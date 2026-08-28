import Link from "next/link";
import { FaqSection } from "@/components/faq-section";
import { Skeleton } from "@/components/ui/skeleton";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import type { FaqItem } from "@/lib/faq";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";

const description =
  "Interactive graph of collateral dependencies between up to 200 dependency-linked stablecoins by market cap. Node size reflects market cap; lines show collateral links.";

const DEPENDENCY_MAP_FAQ_ITEMS = [
  {
    question: "What does the Dependency Map show?",
    answer:
      "The Dependency Map shows stablecoins that depend on other stablecoins, collateral assets, wrappers, or shared infrastructure. It is designed to reveal correlated risk that is easy to miss when each asset is reviewed in isolation.",
  },
  {
    question: "Why can dependency risk matter even when a coin holds its peg?",
    answer:
      "A stablecoin can look calm until an upstream collateral asset, bridge, issuer, or shared contract fails. Dependency mapping helps identify where a shock can travel before it appears as a direct price depeg.",
  },
  {
    question: "How should I combine this with Safety Scores?",
    answer:
      "Use the map to trace exposure paths, then use Safety Scores and the contagion simulator to see how those paths affect grades. The map explains the relationship; Safety Scores quantify the likely impact.",
  },
] as const satisfies readonly FaqItem[];

const DEPENDENCY_MAP_STATIC_SECTION = (
  <section className="pharos-card-shell px-4 py-4">
    <p className="pharos-kicker">Dependency Lens</p>
    <div className="mt-3 grid gap-3 text-sm leading-relaxed text-muted-foreground lg:grid-cols-3">
      <p>
        The most important stablecoin risk is often one step upstream: collateral, wrappers, bridges, custodians, and
        shared issuance frameworks can create common-mode exposure.
      </p>
      <p>
        Start with the graph, then open{" "}
        <Link
          href="/safety-scores/"
          className="pharos-prose-link"
        >
          Safety Scores
        </Link>{" "}
        for the grade impact and{" "}
        <Link
          href="/coverage/"
          className="pharos-prose-link"
        >
          Coverage Matrix
        </Link>{" "}
        for per-coin data availability.
      </p>
      <p>
        Large nodes are not automatically safer. They are larger sources or receivers of exposure, so their failure can
        matter more across the rest of the stablecoin network.
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
        Stablecoins that look safe in isolation can collapse when their collateral fails. This graph maps transitive
        collateral dependencies across the ecosystem. Drag nodes to trace exposure chains — then take the insight to
        the Safety Scores contagion simulator to model the cascade.
      </p>
    ),
  },
  beforeClient: DEPENDENCY_MAP_STATIC_SECTION,
  afterClient: <FaqSection items={DEPENDENCY_MAP_FAQ_ITEMS} includeJsonLd />,
});

export const metadata = route.metadata;
export default route.Page;
