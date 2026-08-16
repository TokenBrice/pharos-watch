import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, Bell, Code2, Rss, Star } from "lucide-react";
import { BACKING_LABELS_SHORT, GOVERNANCE_LABELS_SHORT } from "@shared/lib/classification";
import { FaqSection } from "@/components/faq-section";
import { FeaturePageShell } from "@/components/feature-page-shell";
import {
  TableBody,
  TableCaption,
  TableCell,
  TableFrame,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/table";
import {
  buildComparisonAtAGlanceRows,
  buildComparisonFaqItems,
  buildComparisonResearchLinks,
  buildComparisonSnippetAnswer,
  buildStaticComparisonJsonLd,
  STATIC_COMPARISON_PAGE_BY_SLUG,
  STATIC_COMPARISON_PAGES,
} from "@/lib/compare-pages";
import { buildLiveCompareUrl } from "@/lib/compare-links";
import { safeJsonLd } from "@/lib/json-ld";
import { PEG_SLUGS } from "@/lib/peg-landing";
import { buildSlugPageMetadata, buildSlugStaticParams, resolveSlugPage } from "@/lib/static-slug-page";
import { buildBackingTaxonomyUrl, buildGovernanceTaxonomyUrl } from "@/lib/stablecoin-taxonomy-urls";
import { buildStablecoinUrl } from "@shared/lib/urls";

export function generateStaticParams() {
  return buildSlugStaticParams("slug", STATIC_COMPARISON_PAGES);
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  return buildSlugPageMetadata(params, "slug", STATIC_COMPARISON_PAGE_BY_SLUG, "Comparison Not Found", "/og-compare.png");
}

export default async function StaticComparisonPage({ params }: { params: Promise<{ slug: string }> }) {
  const page = await resolveSlugPage(params, "slug", STATIC_COMPARISON_PAGE_BY_SLUG);
  if (!page) notFound();

  const comparisonRows = buildComparisonAtAGlanceRows(page);
  const faqItems = buildComparisonFaqItems(page);
  const researchLinks = buildComparisonResearchLinks(page);
  const snippetAnswer = buildComparisonSnippetAnswer(page);
  const liveCompareHref = buildLiveCompareUrl([page.left.id, page.right.id]);
  const detailHrefByCoinId = new Map(
    [page.left, page.right].map((coin) => [coin.id, buildStablecoinUrl(coin.id)]),
  );
  const pegSlug = PEG_SLUGS[page.left.flags.pegCurrency];
  const taxonomyLinks = [
    {
      href: buildGovernanceTaxonomyUrl(page.left.flags.governance),
      label: `${GOVERNANCE_LABELS_SHORT[page.left.flags.governance]} stablecoins`,
    },
    {
      href: buildGovernanceTaxonomyUrl(page.right.flags.governance),
      label: `${GOVERNANCE_LABELS_SHORT[page.right.flags.governance]} stablecoins`,
    },
    {
      href: buildBackingTaxonomyUrl(page.left.flags.backing),
      label: `${BACKING_LABELS_SHORT[page.left.flags.backing]} stablecoins`,
    },
    {
      href: buildBackingTaxonomyUrl(page.right.flags.backing),
      label: `${BACKING_LABELS_SHORT[page.right.flags.backing]} stablecoins`,
    },
  ].filter((link, index, links) => links.findIndex((candidate) => candidate.href === link.href) === index);

  return (
    <FeaturePageShell
      breadcrumbName={page.shortTitle}
      path={page.href}
      breadcrumbItems={[
        { name: "Home", url: "/" },
        { name: "Compare", url: "/compare/" },
        { name: page.shortTitle, url: page.href },
      ]}
      title={`${page.left.name} (${page.left.symbol}) vs ${page.right.name} (${page.right.symbol})`}
      leadParagraphs={[page.intro]}
      preface={
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: safeJsonLd(buildStaticComparisonJsonLd(page)) }}
        />
      }
    >
      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.58fr)]">
        <div className="pharos-card-shell px-4 py-4">
          <p className="pharos-kicker">Comparison Brief</p>
          <p className="mt-3 max-w-4xl text-sm leading-relaxed text-muted-foreground">{page.summary}</p>
          <div className="mt-4 flex flex-wrap gap-2 text-sm">
            <Link
              href={liveCompareHref}
              className="pharos-focus-ring inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/70 px-3 py-1.5 font-medium text-foreground transition-colors hover:bg-accent"
            >
              <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
              Open live compare
            </Link>
            <Link
              href="/pharoswatchbot/#getting-started"
              className="pharos-focus-ring inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/70 px-3 py-1.5 font-medium text-foreground transition-colors hover:bg-accent"
            >
              <Bell aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
              Telegram alerts
            </Link>
            <Link
              href="/feed/digest.xml"
              className="pharos-focus-ring inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/70 px-3 py-1.5 font-medium text-foreground transition-colors hover:bg-accent"
            >
              <Rss aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
              Digest RSS
            </Link>
            <Link
              href="/api/"
              className="pharos-focus-ring inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/70 px-3 py-1.5 font-medium text-foreground transition-colors hover:bg-accent"
            >
              <Code2 aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
              API access
            </Link>
            <Link
              href="/compare/"
              className="pharos-focus-ring inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/70 px-3 py-1.5 font-medium text-foreground transition-colors hover:bg-accent"
            >
              <Star aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
              Watchlist preset
            </Link>
          </div>
        </div>

        <aside
          className="pharos-card-shell px-4 py-4"
          aria-labelledby="comparison-short-answer-title"
        >
          <p className="pharos-kicker">Short Answer</p>
          <h2 id="comparison-short-answer-title" className="mt-1 text-lg font-semibold tracking-tight text-foreground">
            {snippetAnswer.question}
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{snippetAnswer.answer}</p>
          <p className="mt-3 border-t border-border/50 pt-3 text-xs leading-relaxed text-muted-foreground">
            {snippetAnswer.caveat}
          </p>
        </aside>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        {[page.left, page.right].map((coin) => (
          <article key={coin.id} className="pharos-card-shell px-4 py-4">
            <p className="pharos-kicker">{coin.symbol}</p>
            <h2 className="mt-1 text-lg font-semibold tracking-tight text-foreground">{coin.name}</h2>
            <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
              <li>{coin.flags.yieldBearing ? "Yield-bearing design" : "Non-yield-bearing design"}</li>
              <li>{coin.contracts?.length ?? 0} tracked chain deployments</li>
              <li>
                {coin.proofOfReserves?.provider
                  ? `${coin.proofOfReserves.provider} reserve attestations`
                  : "No linked proof-of-reserves provider"}
              </li>
            </ul>
            <Link
              href={detailHrefByCoinId.get(coin.id) ?? buildStablecoinUrl(coin.id)}
              className="pharos-focus-ring mt-4 inline-flex text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              {/* Single span: inline-flex containers drop the whitespace between
                  SSR text nodes, collapsing "Open USDT detail page". */}
              <span>Open {coin.symbol} detail page &rarr;</span>
            </Link>
          </article>
        ))}
      </section>

      <section className="space-y-3">
        <div className="space-y-1.5">
          <h2 className="pharos-kicker">At A Glance</h2>
          <p className="text-sm text-muted-foreground">
            Static structural differences between the two stablecoins before you switch to the live comparison tool.
          </p>
        </div>
        <TableFrame
          tableId="static-compare-at-a-glance"
          testId="static-compare-at-a-glance-table"
          chrome="bare"
          className="overflow-hidden rounded-xl border border-border/60"
          viewportProps={{ mobileScrollHint: false, scrollShadow: false, compactBottomPadding: false }}
        >
          <TableCaption className="sr-only">{page.shortTitle} comparison summary</TableCaption>
          <TableHeader className="bg-muted/35 text-left [&_tr]:border-0">
            <TableRow className="border-0 hover:bg-transparent">
              <TableHead className="px-4 py-3 font-medium text-muted-foreground">Metric</TableHead>
              <TableHead className="px-4 py-3 font-medium text-foreground">{page.left.symbol}</TableHead>
              <TableHead className="px-4 py-3 font-medium text-foreground">{page.right.symbol}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {comparisonRows.map((row) => (
              <TableRow key={row.label} className="border-t border-border/50 align-top">
                <TableHead scope="row" className="whitespace-normal px-4 py-3 font-medium text-foreground">
                  {row.label}
                </TableHead>
                <TableCell
                  className={
                    row.label === "Tracked chains"
                      ? "pharos-numeric whitespace-normal px-4 py-3 text-muted-foreground"
                      : "whitespace-normal px-4 py-3 text-muted-foreground"
                  }
                >
                  {row.left}
                </TableCell>
                <TableCell
                  className={
                    row.label === "Tracked chains"
                      ? "pharos-numeric whitespace-normal px-4 py-3 text-muted-foreground"
                      : "whitespace-normal px-4 py-3 text-muted-foreground"
                  }
                >
                  {row.right}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </TableFrame>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Source: checked-in StablecoinMeta profile fields in the current Pharos build. Static deployment counts and
          reserve-provider labels are structural context; open the live detail and compare tools for current market,
          peg, liquidity, and reserve freshness.
        </p>
      </section>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="pharos-card-shell space-y-3 px-4 py-4">
          <h2 className="pharos-kicker">Research Links</h2>
          <div className="flex flex-col gap-2">
            {researchLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="pharos-focus-ring rounded-xl border border-border/60 bg-background/70 px-3 py-2 text-sm transition-colors hover:bg-accent"
              >
                {link.label}
              </Link>
            ))}
          </div>
        </div>

        <div className="pharos-card-shell space-y-3 px-4 py-4">
          <h2 className="pharos-kicker">Related Taxonomies</h2>
          <div className="flex flex-col gap-2">
            {taxonomyLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="pharos-focus-ring rounded-xl border border-border/60 bg-background/70 px-3 py-2 text-sm transition-colors hover:bg-accent"
              >
                {link.label}
              </Link>
            ))}
            {pegSlug && (
              <Link
                href={`/stablecoins/${pegSlug}/`}
                className="pharos-focus-ring rounded-xl border border-border/60 bg-background/70 px-3 py-2 text-sm transition-colors hover:bg-accent"
              >
                Explore all {page.left.flags.pegCurrency} stablecoins
              </Link>
            )}
          </div>
        </div>
      </section>

      <FaqSection items={faqItems} title={`${page.shortTitle} FAQ`} includeJsonLd />
    </FeaturePageShell>
  );
}
