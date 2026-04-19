import Link from "next/link";
import { notFound } from "next/navigation";
import { BACKING_LABELS_SHORT, GOVERNANCE_LABELS_SHORT } from "@shared/lib/classification";
import { FeaturePageShell } from "@/components/feature-page-shell";
import {
  buildComparisonAtAGlanceRows,
  buildComparisonResearchLinks,
  STATIC_COMPARISON_PAGE_BY_SLUG,
  STATIC_COMPARISON_PAGES,
} from "@/lib/compare-pages";
import { PEG_SLUGS } from "@/lib/peg-landing";
import { buildSlugPageMetadata, buildSlugStaticParams, resolveSlugPage } from "@/lib/static-slug-page";
import { buildBackingTaxonomyUrl, buildGovernanceTaxonomyUrl } from "@/lib/stablecoin-taxonomy";

export function generateStaticParams() {
  return buildSlugStaticParams("slug", STATIC_COMPARISON_PAGES);
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  return buildSlugPageMetadata(params, "slug", STATIC_COMPARISON_PAGE_BY_SLUG, "Comparison Not Found");
}

export default async function StaticComparisonPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const page = await resolveSlugPage(params, "slug", STATIC_COMPARISON_PAGE_BY_SLUG);
  if (!page) notFound();

  const comparisonRows = buildComparisonAtAGlanceRows(page);
  const researchLinks = buildComparisonResearchLinks(page);
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
    >
      <section className="grid gap-4 lg:grid-cols-2">
        {[page.left, page.right].map((coin) => (
          <article key={coin.id} className="rounded-2xl border border-border/60 bg-card/60 px-4 py-4">
            <p className="pharos-kicker">{coin.symbol}</p>
            <h2 className="mt-1 text-lg font-semibold tracking-tight text-foreground">{coin.name}</h2>
            <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
              <li>{coin.flags.yieldBearing ? "Yield-bearing design" : "Non-yield-bearing design"}</li>
              <li>{coin.contracts?.length ?? 0} tracked chain deployments</li>
              <li>{coin.proofOfReserves?.provider ? `${coin.proofOfReserves.provider} reserve attestations` : "No linked proof-of-reserves provider"}</li>
            </ul>
            <Link
              href={researchLinks.find((link) => link.href.includes(coin.id))?.href ?? "/"}
              className="pharos-focus-ring mt-4 inline-flex text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              Open {coin.symbol} detail page &rarr;
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
        <div className="overflow-hidden rounded-2xl border border-border/60">
          <table className="w-full text-sm">
            <caption className="sr-only">{page.shortTitle} comparison summary</caption>
            <thead className="bg-muted/35 text-left">
              <tr>
                <th className="px-4 py-3 font-medium text-muted-foreground">Metric</th>
                <th className="px-4 py-3 font-medium text-foreground">{page.left.symbol}</th>
                <th className="px-4 py-3 font-medium text-foreground">{page.right.symbol}</th>
              </tr>
            </thead>
            <tbody>
              {comparisonRows.map((row) => (
                <tr key={row.label} className="border-t border-border/50 align-top">
                  <th scope="row" className="px-4 py-3 font-medium text-foreground">
                    {row.label}
                  </th>
                  <td className="px-4 py-3 text-muted-foreground">{row.left}</td>
                  <td className="px-4 py-3 text-muted-foreground">{row.right}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-3 rounded-2xl border border-border/60 bg-card/60 px-4 py-4">
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

        <div className="space-y-3 rounded-2xl border border-border/60 bg-card/60 px-4 py-4">
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
    </FeaturePageShell>
  );
}
