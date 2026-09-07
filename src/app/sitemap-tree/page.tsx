import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { buildPageMetadata } from "@/lib/page-metadata";
import {
  getMethodologyChangelogEntry,
  type MethodologyChangelogRegistryKey,
} from "@shared/lib/methodology-versions/registry";
import {
  NAV_GROUPS,
  NAV_ITEMS,
  BOTTOM_NAV_ITEMS,
  QUICK_NAV_ITEMS,
  normalizeNavPath,
  type NavItem,
} from "@/lib/nav-config";
import { COMMAND_PALETTE_EXTRA_PAGES } from "@/components/command-palette-model";
import { CLIENT_TRACKED_STABLECOINS } from "@shared/lib/stablecoins/client-registry";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { PUBLIC_ROUTE_INVENTORY } from "@/lib/public-route-inventory";

// WHY: human-readable sitemap-as-content companion to `/sitemap.xml`.
// Single source of truth for IA: `NAV_GROUPS` + `COMMAND_PALETTE_EXTRA_PAGES`.
// Sub-clusters (taxonomies, methodology changelogs, etc.) are surfaced
// alongside their parent tier so power-users see the whole surface area.

export const metadata: Metadata = buildPageMetadata({
  title: "Pharos Sitemap: Stablecoin Dashboard Route Index",
  description:
    "Every public Pharos route grouped by Markets, Risk, Tools, Learn, Updates, and Pharos. The full surface area of the stablecoin dashboard on a single page.",
  canonical: "/sitemap-tree/",
});

interface RouteRow {
  href: string;
  label: string;
  description?: string;
  external?: boolean;
}

interface RouteSubGroup {
  title: string;
  rows: readonly RouteRow[];
}

interface TierColumn {
  key: string;
  label: string;
  kicker: string;
  intro: string;
  primary: readonly RouteRow[];
  sub?: readonly RouteSubGroup[];
}

function navToRow(item: NavItem): RouteRow {
  const [pathname, hash] = item.href.split("#", 2);
  const href = item.external || !pathname.startsWith("/") || pathname === "/"
    ? item.href
    : `${pathname.replace(/\/+$/, "")}/${hash ? `#${hash}` : ""}`;
  return {
    href,
    label: item.label,
    description: item.description,
    external: item.external,
  };
}

function findExtraPage(href: string): NavItem | undefined {
  return COMMAND_PALETTE_EXTRA_PAGES.find((p) => p.href === href);
}

const TAXONOMY_ROUTES: readonly RouteRow[] = [
  {
    href: "/stablecoins/",
    label: "All stablecoins",
    description: "Full tracked directory with peg, backing, and risk filters",
  },
  ...["governance", "backing", "infrastructure"]
    .map((slug) => findExtraPage(`/stablecoins/${slug}/`))
    .filter((p): p is NavItem => Boolean(p))
    .map(navToRow),
];

const METHODOLOGY_CHANGELOG_ROUTE_COPY = [
  {
    key: "safety-score",
    label: "Report Card scoring",
    description: "Safety Score weights and grading rules",
  },
  {
    key: "depeg-dews",
    label: "Depeg detection",
    description: "DEWS event criteria and severity thresholds",
  },
  {
    key: "depeg-resolver",
    label: "Depeg Duration Resolver",
    description: "Resolution outlook and duration support rules",
  },
  {
    key: "liquidity-score",
    label: "Liquidity score",
    description: "DEX depth, durability, and market support",
  },
  {
    key: "stability-index",
    label: "Stability Index",
    description: "PSI regime bands and aggregation",
  },
  {
    key: "pricing-pipeline",
    label: "Pricing pipeline",
    description: "Price source consensus rules",
  },
  {
    key: "chain-health",
    label: "Chain Health",
    description: "Chain mix and stablecoin concentration grades",
  },
  {
    key: "mint-burn-flow",
    label: "Mint/burn flow",
    description: "Issuance-chain accounting and reconciliation",
  },
  {
    key: "redemption-backstop",
    label: "Redemption backstop",
    description: "Issuer and protocol redemption-route scoring history",
  },
  {
    key: "yield",
    label: "Yield intelligence",
    description: "Risk-adjusted yield computation",
  },
  {
    key: "blacklist-tracker",
    label: "Blacklist tracker",
    description: "Address-freeze tracking surface",
  },
] as const satisfies readonly {
  key: MethodologyChangelogRegistryKey;
  label: string;
  description: string;
}[];

const METHODOLOGY_CHANGELOGS: readonly RouteRow[] = METHODOLOGY_CHANGELOG_ROUTE_COPY.map((row) => ({
  href: getMethodologyChangelogEntry(row.key).publicPath,
  label: row.label,
  description: row.description,
}));

const ABOUT_ROUTES: readonly RouteRow[] = [
  {
    href: "/about/api/",
    label: "API access",
    description: "Endpoint reference and key requests",
  },
  {
    href: "/about/bluechip/",
    label: "Bluechip",
    description: "Bluechip tier definition and criteria",
  },
  {
    href: "/learn/glossary/",
    label: "Glossary",
    description: "Defined terms used across the dashboard",
  },
];

const MORE_REFERENCE_ROUTES: readonly RouteRow[] = [
  {
    href: "/docs/",
    label: "Docs archive",
    description: "Public documentation for methods and data contracts",
  },
  {
    href: "/start/",
    label: "Start Here",
    description: "Shortest route into Pharos for new and returning users",
  },
  {
    href: "/privacy/",
    label: "Privacy",
    description: "Privacy policy for web, API, and alert surfaces",
  },
];

const MARKETS_GROUP = NAV_GROUPS.find((g) => g.key === "markets");
const RISK_GROUP = NAV_GROUPS.find((g) => g.key === "risk");
const TOOLS_GROUP = NAV_GROUPS.find((g) => g.key === "tools");
const MORE_GROUP = NAV_GROUPS.find((g) => g.key === "more");
const moreColumnRows = (key: string): readonly RouteRow[] =>
  MORE_GROUP?.columns?.find((column) => column.key === key)?.items.map(navToRow) ?? [];

const STABLECOIN_PROFILE_ROWS: readonly RouteRow[] = CLIENT_TRACKED_STABLECOINS.map((coin) => ({
  href: buildStablecoinUrl(coin.id),
  label: `${coin.name} (${coin.symbol})`,
  description:
    coin.status === "pre-launch"
      ? "Pre-launch stablecoin profile"
      : coin.status === "frozen"
        ? "Frozen stablecoin archive"
        : coin.status === "quarantined"
          ? "Quarantined stablecoin research record"
          : coin.status === "delisted"
            ? "Delisted asset research record"
            : "Stablecoin risk, peg, liquidity, and dependency profile",
}));

const TIERS: readonly TierColumn[] = [
  {
    key: "markets",
    label: "Markets",
    kicker: "Market structure",
    intro: "Liquidity, flows, chain distribution, peg cohorts, and launch watch.",
    primary: MARKETS_GROUP?.items.map(navToRow) ?? [],
    sub: [
      {
        title: "Browse by taxonomy",
        rows: TAXONOMY_ROUTES,
      },
      {
        title: "Stablecoin profiles",
        rows: STABLECOIN_PROFILE_ROWS,
      },
    ],
  },
  {
    key: "risk",
    label: "Risk",
    kicker: "Failure modes",
    intro: "Freeze authority, compliance, dependency, and failure-history surfaces.",
    primary: RISK_GROUP?.items.map(navToRow) ?? [],
  },
  {
    key: "tools",
    label: "Tools",
    kicker: "Research tools",
    intro: "Power-user surfaces for filtering, peer comparison, portfolio review, and directory browsing.",
    primary: TOOLS_GROUP?.items.map(navToRow) ?? [],
  },
  {
    key: "research",
    label: "Research",
    kicker: "Reference",
    intro: "Mechanism explainers, case studies, the vocabulary, and the scoring methodology.",
    primary: moreColumnRows("research"),
  },
  {
    key: "watch",
    label: "Watch",
    kicker: "What changed",
    intro: "Daily digest, the unified event timeline, and push alerts.",
    primary: moreColumnRows("watch"),
  },
  {
    key: "pharos",
    label: "Pharos",
    kicker: "The product",
    intro: "Product context, release notes, long-form posts, API access, and pipeline health.",
    primary: moreColumnRows("pharos"),
    sub: [
      {
        title: "About Pharos",
        rows: ABOUT_ROUTES,
      },
      {
        title: "Methodology changelogs",
        rows: METHODOLOGY_CHANGELOGS,
      },
      {
        title: "More reference",
        rows: MORE_REFERENCE_ROUTES,
      },
    ],
  },
];

const CANONICAL_NAV_LABELS = new Map(NAV_ITEMS.map((item) => [normalizeNavPath(item.href), item.label]));
const QUICK_ROWS: readonly RouteRow[] = QUICK_NAV_ITEMS.map((item) =>
  navToRow({ ...item, label: CANONICAL_NAV_LABELS.get(normalizeNavPath(item.href)) ?? item.label }),
);
const BOTTOM_ROWS: readonly RouteRow[] = BOTTOM_NAV_ITEMS.map(navToRow);

const HUMAN_SITEMAP_LISTED_PATHS = new Set([
  ...TIERS.flatMap((tier) => [
    ...tier.primary.map((row) => row.href),
    ...(tier.sub?.flatMap((group) => group.rows.map((row) => row.href)) ?? []),
  ]),
  ...QUICK_ROWS.map((row) => row.href),
  ...BOTTOM_ROWS.map((row) => row.href),
]);

const INDEXED_ARCHIVE_ROWS: readonly RouteRow[] = PUBLIC_ROUTE_INVENTORY
  .filter((route) => !HUMAN_SITEMAP_LISTED_PATHS.has(route.href))
  .map((route) => ({
    href: route.href,
    label: route.href === "/" ? "Home" : route.href.split("/").filter(Boolean).at(-1)!.replaceAll("-", " "),
    description: `${route.kind.replaceAll("-", " ")} route`,
  }));

const ROW_LINK_CLASS =
  "pharos-focus-ring -mx-2 flex flex-col gap-0.5 rounded-md px-2 py-2 transition-colors hover:bg-muted/40";

function RouteRowLink({ row }: { row: RouteRow }) {
  const labelNode = (
    <span className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground">
      {row.label}
      {row.external ? <ArrowUpRight className="h-3 w-3 text-muted-foreground/70" aria-hidden="true" /> : null}
    </span>
  );

  const content = (
    <>
      {labelNode}
      {row.description ? (
        <span className="text-xs leading-relaxed text-muted-foreground">{row.description}</span>
      ) : null}
    </>
  );

  if (row.external) {
    return (
      <a href={row.href} target="_blank" rel="noopener noreferrer" className={ROW_LINK_CLASS}>
        {content}
      </a>
    );
  }

  return (
    <Link href={row.href} className={ROW_LINK_CLASS}>
      {content}
    </Link>
  );
}

function SubGroup({ group }: { group: RouteSubGroup }) {
  return (
    <div className="space-y-2 border-t border-border/60 pt-4">
      <p className="pharos-kicker text-muted-foreground/80">{group.title}</p>
      <ul className="space-y-0.5">
        {group.rows.map((row) => (
          <li key={row.href}>
            <RouteRowLink row={row} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function TierBlock({ tier }: { tier: TierColumn }) {
  return (
    <section aria-labelledby={`sitemap-${tier.key}`} className="space-y-4">
      <header className="space-y-1">
        <p className="pharos-kicker">{tier.kicker}</p>
        <h2 id={`sitemap-${tier.key}`} className="pharos-display text-xl font-bold tracking-tight text-foreground">
          {tier.label}
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">{tier.intro}</p>
      </header>
      <ul className="space-y-0.5">
        {tier.primary.map((row) => (
          <li key={row.href}>
            <RouteRowLink row={row} />
          </li>
        ))}
      </ul>
      {tier.sub?.map((group) => (
        <SubGroup key={group.title} group={group} />
      ))}
    </section>
  );
}

export default function SitemapTreePage() {
  return (
    <FeaturePageShell
      breadcrumbName="Sitemap"
      path="/sitemap-tree/"
      title="All pages"
      leadParagraphs={[
        "Every public Pharos route, grouped by the same Markets / Risk / Tools sections as the top nav, plus the Learn, Updates, and Pharos columns behind its More menu. Use this when you want to see the whole surface area in one place, or when you remember the section but not the slug.",
      ]}
    >
      <div className="grid gap-10 lg:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6 xl:gap-8">
        {TIERS.map((tier) => (
          <TierBlock key={tier.key} tier={tier} />
        ))}
      </div>

      {(QUICK_ROWS.length > 0 || BOTTOM_ROWS.length > 0) && (
        <section
          aria-labelledby="sitemap-quick-access"
          className="mt-10 space-y-4 border-t border-border/60 pt-8"
        >
          <header className="space-y-1">
            <p className="pharos-kicker">Quick access</p>
            <h2
              id="sitemap-quick-access"
              className="pharos-display text-xl font-bold tracking-tight text-foreground"
            >
              Daily entry points
            </h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              The routes promoted to the masthead quick rail, plus the guided entry point for new readers.
            </p>
          </header>
          <ul className="grid gap-0.5 sm:grid-cols-2">
            {[...QUICK_ROWS, ...BOTTOM_ROWS].map((row) => (
              <li key={row.href}>
                <RouteRowLink row={row} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {INDEXED_ARCHIVE_ROWS.length > 0 ? (
        <section aria-labelledby="sitemap-indexed-archive" className="mt-10 space-y-4 border-t border-border/60 pt-8">
          <header className="space-y-1">
            <p className="pharos-kicker">Indexed archive</p>
            <h2 id="sitemap-indexed-archive" className="pharos-display text-xl font-bold tracking-tight text-foreground">
              Every remaining public route
            </h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Derived from the same public route inventory as the XML sitemap, including dated research and archive pages.
            </p>
          </header>
          <ul className="grid gap-x-8 sm:grid-cols-2 lg:grid-cols-3">
            {INDEXED_ARCHIVE_ROWS.map((row) => (
              <li key={row.href}><RouteRowLink row={row} /></li>
            ))}
          </ul>
        </section>
      ) : null}
    </FeaturePageShell>
  );
}
