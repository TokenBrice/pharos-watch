import type { Metadata } from "next";
import Link from "next/link";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { buildPageMetadata } from "@/lib/page-metadata";
import { buildCollectionItemListJsonLd, safeJsonLd } from "@/lib/json-ld";
import { buildPublicDatasetMirrorJsonLd } from "@/lib/analytics-dataset-json-ld";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { ACTIVE_STABLECOIN_COUNT } from "@/lib/stablecoin-static-data";
import {
  BACKING_TAXONOMY_PAGES,
  GOVERNANCE_TAXONOMY_PAGES,
  INFRASTRUCTURE_TAXONOMY_PAGES,
} from "@/lib/stablecoin-taxonomy";
import { PEG_TAXONOMY_PAGES } from "@/lib/peg-taxonomy";

const TOTAL = ACTIVE_STABLECOIN_COUNT;

interface TaxonomyLinkPage {
  href: string;
  title: string;
  coins: readonly unknown[];
}

const AXES: ReadonlyArray<{
  href: string;
  label: string;
  children: readonly TaxonomyLinkPage[];
}> = [
  { href: "/stablecoins/", label: "By Peg Currency", children: PEG_TAXONOMY_PAGES },
  { href: "/stablecoins/backing/", label: "By Backing Type", children: BACKING_TAXONOMY_PAGES },
  { href: "/stablecoins/governance/", label: "By Governance Model", children: GOVERNANCE_TAXONOMY_PAGES },
  { href: "/stablecoins/infrastructure/", label: "By Shared Infrastructure", children: INFRASTRUCTURE_TAXONOMY_PAGES },
] as const;

const taxonomyItems = AXES.flatMap((axis) => axis.children);

const PROFILE_GROUPS = Array.from(
  TRACKED_STABLECOINS.reduce((groups, coin) => {
    const initial = coin.name.trim().charAt(0).toUpperCase();
    const label = /^[A-Z]$/.test(initial) ? initial : "0–9";
    const group = groups.get(label) ?? [];
    group.push(coin);
    groups.set(label, group);
    return groups;
  }, new Map<string, Array<(typeof TRACKED_STABLECOINS)[number]>>()),
)
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([label, coins]) => ({
    label,
    coins: coins.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)),
  }));

export const metadata: Metadata = buildPageMetadata({
  title: "Stablecoins by Peg, Backing, Governance & Infrastructure",
  description: `Browse ${TOTAL} active stablecoins sorted by peg currency, collateral backing, governance model, and shared infrastructure.`,
  canonical: "/stablecoins/",
  ogImage: `${SITE_URL}/og-stablecoins.png`,
});

export default function StablecoinsHubPage() {
  return (
    <FeaturePageShell
      breadcrumbName="Stablecoins"
      path="/stablecoins/"
      breadcrumbItems={[
        { name: "Home", url: "/" },
        { name: "Stablecoins", url: "/stablecoins/" },
      ]}
      title="Stablecoins"
      leadParagraphs={[
        <>
          {`Browse every stablecoin profile Pharos tracks, or narrow the ${TOTAL} active stablecoins by peg currency, backing type, governance model, and shared infrastructure. For the design-family view (how each coin keeps its peg), see the `}
          <Link
            href="/learn/mechanisms/"
            className="pharos-prose-link"
          >
            mechanism explainer
          </Link>
          {"."}
        </>,
      ]}
      preface={
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: safeJsonLd([
              ...buildCollectionItemListJsonLd({
                url: `${SITE_URL}/stablecoins/`,
                name: "Stablecoin Taxonomies",
                itemListName: "Stablecoin taxonomy hubs",
                entries: taxonomyItems.map((page) => ({
                  name: page.title,
                  url: `${SITE_URL}${page.href}`,
                })),
              }),
              buildPublicDatasetMirrorJsonLd("top-stablecoins"),
            ]),
          }}
        />
      }
    >
      <div className="space-y-10">
        <section className="space-y-3" aria-labelledby="stablecoin-profile-directory-heading">
          <div className="space-y-1.5">
            <h2 id="stablecoin-profile-directory-heading" className="pharos-kicker">
              All Tracked Stablecoin Profiles
            </h2>
            <p className="text-sm text-muted-foreground">
              Open any tracked profile for its static identity, risk research, peg history, liquidity, and dependencies.
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {PROFILE_GROUPS.map((group) => (
              <details key={group.label} className="rounded-lg border border-border/60 bg-muted/20">
                <summary className="pharos-focus-ring cursor-pointer px-4 py-3 text-sm font-medium">
                  {group.label} · <span className="pharos-numeric">{group.coins.length}</span> profiles
                </summary>
                <ul className="border-t border-border/40 px-4 py-2">
                  {group.coins.map((coin) => (
                    <li key={coin.id}>
                      <Link
                        href={buildStablecoinUrl(coin.id)}
                        className="pharos-focus-ring flex items-baseline justify-between gap-3 rounded-sm py-1.5 text-sm underline-offset-4 hover:underline"
                      >
                        <span className="font-medium text-foreground">{coin.name}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">{coin.symbol}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </div>
        </section>

        {AXES.map((axis) => (
          <section key={axis.href} aria-label={axis.label} className="space-y-3">
            <h2 className="text-lg font-semibold tracking-tight text-foreground">
              <Link href={axis.href} className="pharos-focus-ring rounded-sm underline-offset-4 hover:underline">
                {axis.label}
              </Link>
            </h2>
            <ul className="grid gap-x-10 sm:grid-cols-2 lg:grid-cols-3">
              {axis.children.map((page) => (
                <li key={page.href}>
                  <Link
                    href={page.href}
                    className="pharos-focus-ring flex items-baseline justify-between gap-4 border-t border-border/40 py-3 text-sm transition-colors hover:bg-muted/30"
                  >
                    <span className="font-medium text-foreground">{page.title}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      <span className="pharos-numeric">{page.coins.length}</span> active
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </FeaturePageShell>
  );
}
