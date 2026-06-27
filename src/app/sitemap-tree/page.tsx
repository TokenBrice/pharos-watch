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
  PRIMARY_NAV_ITEMS,
  BOTTOM_NAV_ITEMS,
  COMPANION_NAV_ITEMS,
  type NavItem,
} from "@/lib/nav-config";
import { COMMAND_PALETTE_EXTRA_PAGES } from "@/components/command-palette-model";

// WHY: human-readable sitemap-as-content companion to `/sitemap.xml`.
// Single source of truth for IA: `NAV_GROUPS` + `COMMAND_PALETTE_EXTRA_PAGES`.
// Sub-clusters (taxonomies, methodology changelogs, etc.) are surfaced
// alongside their parent tier so power-users see the whole surface area.

export const metadata: Metadata = buildPageMetadata({
  title: "Pharos Sitemap: Stablecoin Dashboard Route Index",
  description:
    "Every public Pharos route grouped by Track, Analyze, Monitor, and Reference. The full surface area of the stablecoin dashboard on a single page.",
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
  return {
    href: item.href,
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
    href: "/freezewatch/",
    label: "FreezeWatch",
    description: "Live address freezes across freezable stablecoins",
  },
  {
    href: "/start/",
    label: "Start Here",
    description: "Shortest route into Pharos for new and returning users",
  },
  {
    href: "/changelog/",
    label: "Changelog",
    description: "Weekly release notes and feature updates",
  },
  {
    href: "/privacy/",
    label: "Privacy",
    description: "Privacy policy for web, API, and alert surfaces",
  },
];

const DISCOVERY_PRIMARY: readonly RouteRow[] = PRIMARY_NAV_ITEMS.map(navToRow);

const TRACK_GROUP = NAV_GROUPS.find((g) => g.key === "data");
const ANALYZE_GROUP = NAV_GROUPS.find((g) => g.key === "tools");
const MONITOR_GROUP = NAV_GROUPS.find((g) => g.key === "monitor");
const REFERENCE_GROUP = NAV_GROUPS.find((g) => g.key === "info");

const TIERS: readonly TierColumn[] = [
  {
    key: "track",
    label: "Track",
    kicker: "Live data",
    intro: "Live surfaces for peg stress, depeg events, liquidity, flows, and the cohort.",
    primary: [
      ...DISCOVERY_PRIMARY,
      ...(TRACK_GROUP?.items.map(navToRow) ?? []),
    ],
    sub: [
      {
        title: "Browse by taxonomy",
        rows: TAXONOMY_ROUTES,
      },
    ],
  },
  {
    key: "analyze",
    label: "Analyze",
    kicker: "Research tools",
    intro: "Power-user surfaces for filtering, peer comparison, and dependency analysis.",
    primary: ANALYZE_GROUP?.items.map(navToRow) ?? [],
  },
  {
    key: "monitor",
    label: "Monitor",
    kicker: "Chronological",
    intro: "Timeline, daily digest, launch watch, and the live pipeline health board.",
    primary: MONITOR_GROUP?.items.map(navToRow) ?? [],
  },
  {
    key: "reference",
    label: "Reference",
    kicker: "Docs and methodology",
    intro: "About, methodology, mechanism explainers, and the supporting documentation cluster.",
    primary: REFERENCE_GROUP?.items.map(navToRow) ?? [],
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

const COMPANION_ROWS: readonly RouteRow[] = COMPANION_NAV_ITEMS.map(navToRow);
const BOTTOM_ROWS: readonly RouteRow[] = BOTTOM_NAV_ITEMS.map(navToRow);

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
        <h2 id={`sitemap-${tier.key}`} className="text-xl font-semibold tracking-tight text-foreground">
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
        "Every public Pharos route, grouped by the same Track / Analyze / Monitor / Reference tiers as the sidebar. Use this when you want to see the whole surface area in one place, or when you remember the section but not the slug.",
      ]}
    >
      <div className="grid gap-10 lg:grid-cols-2 xl:grid-cols-4 xl:gap-8">
        {TIERS.map((tier) => (
          <TierBlock key={tier.key} tier={tier} />
        ))}
      </div>

      {(COMPANION_ROWS.length > 0 || BOTTOM_ROWS.length > 0) && (
        <section
          aria-labelledby="sitemap-companion"
          className="mt-10 space-y-4 border-t border-border/60 pt-8"
        >
          <header className="space-y-1">
            <p className="pharos-kicker">Companion</p>
            <h2
              id="sitemap-companion"
              className="text-xl font-semibold tracking-tight text-foreground"
            >
              Onramps and sibling sites
            </h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Entry points for new readers and sibling experiences that consume the same Pharos data.
            </p>
          </header>
          <ul className="grid gap-0.5 sm:grid-cols-2">
            {[...BOTTOM_ROWS, ...COMPANION_ROWS].map((row) => (
              <li key={row.href}>
                <RouteRowLink row={row} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </FeaturePageShell>
  );
}
