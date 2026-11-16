import { IntentLink } from "@/components/intent-link";
import { ArrowLeftRight, ArrowRight, Bell } from "lucide-react";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import { DETAIL_MODULE_TITLE_CLASS } from "@/components/stablecoin-detail/section-title-class";
import { ExploreNextLink } from "@/components/stablecoin-detail/explore-next-link";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import {
  HERO_CHIP_BACKING_LABELS,
  HERO_CHIP_GOVERNANCE_LABELS,
  PEG_LABELS_SHORT,
  getMechanismArchetypeCtaNoun,
  resolveMechanismArchetype,
} from "@shared/lib/classification";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { isActiveStablecoinMeta } from "@shared/lib/stablecoins/status";
import { getInfrastructureLabel } from "@shared/lib/infrastructure";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import type { StablecoinClientListMeta } from "@shared/types/stablecoin-client-meta";
import { buildComparePrefillUrl } from "@/lib/compare-links";
import {
  buildBackingTaxonomyUrl,
  buildGovernanceTaxonomyUrl,
  buildInfrastructureTaxonomyUrl,
} from "@/lib/stablecoin-taxonomy-urls";
import { PEG_SLUGS } from "@/lib/peg-landing";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { getLogoSrc } from "@/lib/logos";

interface StaticComparisonEntry {
  href: string;
  shortTitle: string;
  leftId: string;
  rightId: string;
  counterpartId: string;
  counterpartSymbol: string;
  counterpartName: string;
}

/**
 * Below `lg` only the first cards render; the rest stay in the DOM behind
 * `hidden lg:inline-flex` so the internal links remain crawlable.
 */
const COMPARISON_MOBILE_CARD_CAP = 4;

/**
 * Chip rows are inline boxes in a balanced block, so a wrapped row splits
 * evenly instead of leaving one chip alone on the last line.
 */
const CHIP_ROW_CLASS = "-mt-2 text-balance";
const CHIP_IN_ROW_CLASS = "mt-2 mr-2 align-top";

interface ExploreNextSectionProps {
  coin: StablecoinMeta;
  related: StablecoinClientListMeta[];
  staticComparisonPages: StaticComparisonEntry[];
  /** The coin's newest permanent depeg event pages, newest first. */
  depegEvents?: Array<{ href: string; label: string }>;
  logos: Record<string, string>;
}


export function ExploreNextSection({ coin, related, staticComparisonPages, depegEvents = [], logos }: ExploreNextSectionProps) {
  const firstInfrastructure = coin.infrastructures?.[0];
  const infrastructureLabel = firstInfrastructure ? getInfrastructureLabel(firstInfrastructure) : null;
  const pegSlug = PEG_SLUGS[coin.flags.pegCurrency];
  const pegLabel = PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency;

  const taxonomyLinks = [
    pegSlug
      ? {
          href: `/stablecoins/${pegSlug}/`,
          label: `All ${pegLabel} stablecoins`,
        }
      : null,
    // The hero chips' names, so a cohort reads the same at both ends of the page.
    {
      href: buildGovernanceTaxonomyUrl(coin.flags.governance),
      label: `${HERO_CHIP_GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance} stablecoins`,
    },
    {
      href: buildBackingTaxonomyUrl(coin.flags.backing),
      label: `${HERO_CHIP_BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing} stablecoins`,
    },
    firstInfrastructure
      ? {
          href: buildInfrastructureTaxonomyUrl(firstInfrastructure),
          label: infrastructureLabel ? `${infrastructureLabel} stablecoins` : "Infrastructure cohort",
        }
      : null,
  ].filter((link): link is { href: string; label: string } => link !== null);

  const trackerLinks: Array<{ href: string; label: string }> = [
    { href: "/safety-scores/", label: "Stablecoin safety scores" },
    { href: "/liquidity/", label: "DEX liquidity rankings" },
    { href: "/depeg/", label: "Depeg tracker" },
  ];
  const resolvedArchetype = resolveMechanismArchetype(coin, CLIENT_TRACKED_META_BY_ID);
  if (resolvedArchetype) {
    // peg-stability-card already has a "Learn how X stablecoins work" CTA on the mechanism diagram.
    // Use this slot for a screener deep-link instead to avoid a duplicate CTA.
    trackerLinks.push({
      href: `/screener/?mechanisms=${resolvedArchetype}&lifecycle=active`,
      label: `All ${getMechanismArchetypeCtaNoun(resolvedArchetype)} stablecoins`,
    });
  }
  // The two coin-specific actions lead the section as buttons; the generic
  // Pharos destinations join the link columns.
  const moreLinks: Array<{ href: string; label: string }> = [
    { href: "/compare/", label: "Browse stablecoin comparisons" },
    { href: "/digest/", label: "Read the daily digest" },
    { href: "/api/", label: "Use the Pharos API" },
  ];
  const linkGroups = [
    { title: "Taxonomy", links: taxonomyLinks },
    { title: "Trackers", links: trackerLinks },
    { title: "More from Pharos", links: moreLinks },
  ];

  // The hero's case-study callout already links this coin's case study, so
  // Explore does not repeat it.
  const hasPeers = related.length > 0 || staticComparisonPages.length > 0;
  const hiddenComparisonCount = Math.max(0, staticComparisonPages.length - COMPARISON_MOBILE_CARD_CAP);

  // The panel sits on the card column's edges like every module above it; a
  // bleed into the gutter made it overhang the column.
  return (
    <section
      id="explore-next"
      className="mt-8 space-y-6 rounded-xl bg-muted/15 px-4 py-6 sm:px-5"
      aria-labelledby="explore-next-heading"
    >
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 space-y-1.5">
          <DetailSectionTitle id="explore-next-heading" className={DETAIL_MODULE_TITLE_CLASS}>Explore next</DetailSectionTitle>
          <p className="text-sm text-muted-foreground">
            Compare {coin.symbol} with its peers, follow it, or browse related cohorts and trackers.
          </p>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap">
          <IntentLink
            href={buildComparePrefillUrl([coin.id])}
            className="pharos-focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-foreground px-4 text-sm font-medium text-background transition-colors hover:bg-foreground/85 sm:min-h-9"
          >
            <ArrowLeftRight aria-hidden="true" className="h-4 w-4 shrink-0" />
            Open {coin.symbol} in live compare
          </IntentLink>
          {isActiveStablecoinMeta(coin) ? (
            <IntentLink
              href="/pharoswatchbot/#getting-started"
              className="pharos-focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-border bg-background/70 px-4 text-sm font-medium text-foreground transition-colors hover:border-foreground/30 hover:bg-accent sm:min-h-9"
            >
              <Bell aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
              Set {coin.symbol} Telegram alerts
            </IntentLink>
          ) : null}
        </div>
      </div>

      {hasPeers ? (
        <div className="space-y-4">
          {/* The peg cohort link lives once, first in Taxonomy below. */}
          <p className="pharos-label">Peers</p>

          {related.length > 0 ? (
            <div className={CHIP_ROW_CLASS}>
              {related.slice(0, 6).map((peer) => (
                <IntentLink
                  key={peer.id}
                  href={buildStablecoinUrl(peer.id)}
                  className={`pharos-focus-ring ${CHIP_IN_ROW_CLASS} inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/50 px-2.5 py-1 text-xs text-foreground transition-colors hover:border-foreground/30 hover:bg-accent`}
                  title={peer.name}
                >
                  <StablecoinLogo src={getLogoSrc(logos, peer.id)} name={peer.name} size={16} />
                  <span className="font-mono tabular-nums font-medium">{peer.symbol}</span>
                </IntentLink>
              ))}
            </div>
          ) : null}

          {staticComparisonPages.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">Head-to-head comparison briefs</p>
              {/* Wrapping pills, not a fixed grid: one or two briefs never leave
                  empty framed cells beside them. The overflow link closes the
                  same row rather than taking a line of its own. */}
              <div className={CHIP_ROW_CLASS}>
                {staticComparisonPages.map((page, index) => (
                  <IntentLink
                    key={page.href}
                    href={page.href}
                    className={`pharos-focus-ring group ${CHIP_IN_ROW_CLASS} ${
                      index < COMPARISON_MOBILE_CARD_CAP ? "inline-flex" : "hidden lg:inline-flex"
                    } min-h-9 items-center gap-2 rounded-full border border-border/60 bg-background/70 py-1 pl-1.5 pr-3 text-sm text-foreground transition-colors hover:border-foreground/30 hover:bg-accent`}
                    aria-label={`Open static comparison brief: ${page.shortTitle}`}
                    title={page.counterpartName}
                  >
                    <StablecoinLogo src={getLogoSrc(logos, page.counterpartId)} name={page.counterpartName} size={18} />
                    <span>
                      <span className="text-muted-foreground">vs </span>
                      <span className="font-mono tabular-nums font-medium">{page.counterpartSymbol}</span>
                    </span>
                    <ArrowRight
                      aria-hidden="true"
                      className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
                    />
                  </IntentLink>
                ))}
                {hiddenComparisonCount > 0 ? (
                  <IntentLink
                    href="/compare/"
                    aria-label={`${hiddenComparisonCount} more comparison briefs`}
                    className={`pharos-focus-ring ${CHIP_IN_ROW_CLASS} inline-flex min-h-9 items-center gap-1 rounded-sm px-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground lg:hidden`}
                  >
                    +{hiddenComparisonCount} more
                    <ArrowRight aria-hidden="true" className="h-3 w-3" />
                  </IntentLink>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {depegEvents.length > 0 ? (
        <div className="space-y-2">
          <p className="pharos-label">Depeg history</p>
          <div className="-my-1 flex flex-wrap gap-x-8">
            {depegEvents.map((event) => (
              <div key={event.href} className="min-w-0 flex-1 basis-56">
                <ExploreNextLink href={event.href} label={event.label} />
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* Columns wrap by their own minimum width (13rem), so three groups sit
          three across from tablet up and stack on phones, never 2 + 1. */}
      <div className="flex flex-wrap gap-x-8 gap-y-5 border-t border-border/40 pt-5">
        {linkGroups.map((group) => (
          <div key={group.title} className="min-w-0 flex-1 basis-52 space-y-2">
            <p className="pharos-label">{group.title}</p>
            <div className="-my-1 flex flex-col">
              {group.links.map((link) => (
                <ExploreNextLink key={link.href} href={link.href} label={link.label} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
