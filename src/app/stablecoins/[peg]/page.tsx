import Link from "next/link";
import { StablecoinTaxonomyShell } from "@/components/stablecoin-taxonomy-shell";
import { buildLiveCompareUrl } from "@/lib/compare-links";
import { PEG_TAXONOMY_PAGES, PEG_TAXONOMY_PAGE_BY_SLUG } from "@/lib/peg-taxonomy";
import { ALL_STABLECOIN_TAXONOMY_PAGES } from "@/lib/stablecoin-taxonomy";
import { createStaticSlugRoute } from "@/lib/static-slug-page";
import { PegLandingClient } from "./client";

function PegRouteCta({
  shortLabel,
  topCoinIds,
}: {
  shortLabel: string;
  topCoinIds: readonly string[];
}) {
  return (
    <section className="rounded-xl border border-border/60 bg-muted/20 px-4 py-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <p className="pharos-kicker">Next Check</p>
          <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
            Compare the leading {shortLabel} stablecoins, then use alerts for peg stress and safety-grade changes
            before you depend on one currency bucket.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {topCoinIds.length >= 2 ? (
            <Link
              href={buildLiveCompareUrl(topCoinIds)}
              className="pharos-focus-ring inline-flex min-h-11 items-center rounded-full border border-border/60 bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent sm:min-h-9"
            >
              Compare leaders
            </Link>
          ) : null}
          <Link
            href="/pharoswatchbot/#bot"
            className="pharos-focus-ring inline-flex min-h-11 items-center rounded-full bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 sm:min-h-9"
          >
            Set up alerts
          </Link>
        </div>
      </div>
    </section>
  );
}

const route = createStaticSlugRoute({
  paramKey: "peg",
  pages: PEG_TAXONOMY_PAGES,
  pageBySlug: PEG_TAXONOMY_PAGE_BY_SLUG,
  missingTitle: "Peg Currency Not Found",
  render: (page) => (
    <StablecoinTaxonomyShell
      title={page.title}
      href={page.href}
      breadcrumbItems={[
        { name: "Home", url: "/" },
        { name: "Stablecoins", url: "/stablecoins/" },
        { name: page.title, url: page.href },
      ]}
      description={page.description}
      intro={page.intro}
      shortLabel={page.shortLabel}
      coins={page.coins}
      directoryDescription={`Browse all ${page.coins.length} tracked ${page.shortLabel} stablecoins before opening the live table. ${page.contextSummary} ${page.riskSummary}`}
      definedTermCode={String(page.value)}
      definedTermSetHref="/stablecoins/"
      relatedPages={ALL_STABLECOIN_TAXONOMY_PAGES.slice(0, 6)}
    >
      <PegRouteCta
        shortLabel={page.shortLabel}
        topCoinIds={page.topCoins.map((coin) => coin.id)}
      />
      <PegLandingClient pegCurrency={page.value} />
    </StablecoinTaxonomyShell>
  ),
});

export const generateStaticParams = route.generateStaticParams;
export const generateMetadata = route.generateMetadata;
export default route.Page;
