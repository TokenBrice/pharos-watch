import dynamic from "next/dynamic";
import Link from "next/link";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { Skeleton } from "@/components/ui/skeleton";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { buildPageMetadata } from "@/lib/page-metadata";
import { STATIC_COMPARISON_PAGES } from "@/lib/compare-pages";

const CompareClient = dynamic(
  () => import("./client").then((m) => ({ default: m.CompareClient })),
  { loading: () => <Skeleton className="h-[400px] w-full rounded-xl" /> },
);

const compareDescription = `Side-by-side comparison of stablecoin stats, supply history, and peg stability for ${TRACKED_STABLECOINS.length} tracked stablecoins.`;

export const metadata = buildPageMetadata({
  title: "Compare Stablecoins: Side-by-Side Analysis",
  description: compareDescription,
  canonical: "/compare/",
  ogImage: "https://pharos.watch/og-compare.png",
  robots: {
    index: false,
    follow: true,
  },
});

export default function ComparePage() {
  return (
    <FeaturePageShell
      breadcrumbName="Compare"
      path="/compare/"
      title="Compare Stablecoins"
      statusBadge={{ status: "mature" }}
      leadParagraphs={[
        "Use the live compare tool for custom side-by-side analysis.",
        "For search and discovery, Pharos also publishes a finite set of static comparison pages covering the most common head-to-head stablecoin queries.",
      ]}
    >
      <section className="space-y-3">
        <div className="space-y-1.5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Popular Stablecoin Comparisons
          </h2>
          <p className="text-sm text-muted-foreground">
            These static pages are indexable, link to the underlying detail pages, and summarize the structural tradeoffs
            before you open the full compare tool.
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {STATIC_COMPARISON_PAGES.map((page) => (
            <Link
              key={page.href}
              href={page.href}
              className="rounded-xl border border-border/60 bg-background/60 px-3 py-3 text-sm transition-colors hover:bg-accent"
            >
              <span className="block font-medium text-foreground">{page.shortTitle}</span>
              <span className="mt-1 block text-xs text-muted-foreground">{page.left.name} vs {page.right.name}</span>
            </Link>
          ))}
        </div>
      </section>

      <CompareClient />
    </FeaturePageShell>
  );
}
