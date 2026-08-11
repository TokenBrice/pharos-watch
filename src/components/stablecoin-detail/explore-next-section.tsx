import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import { DETAIL_MODULE_TITLE_CLASS } from "@/components/stablecoin-detail/section-title-class";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import {
  BACKING_LABELS,
  GOVERNANCE_LABELS,
  PEG_LABELS_SHORT,
  getMechanismArchetypeCtaNoun,
  resolveMechanismArchetype,
} from "@shared/lib/classification";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { isActiveStablecoinMeta } from "@shared/lib/stablecoins/status";
import { getInfrastructureLabel } from "@shared/lib/infrastructure";
import type { StablecoinMeta } from "@shared/types";
import { buildLiveCompareUrl } from "@/lib/compare-links";
import {
  buildBackingTaxonomyUrl,
  buildGovernanceTaxonomyUrl,
  buildInfrastructureTaxonomyUrl,
} from "@/lib/stablecoin-taxonomy-urls";
import { PEG_SLUGS } from "@/lib/peg-landing";
import { buildStablecoinUrl } from "@/lib/urls";
import { CASE_STUDY_BY_COIN_ID } from "@/app/learn/case-studies/content";

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
 * `hidden lg:flex` so the internal links remain crawlable.
 */
const COMPARISON_MOBILE_CARD_CAP = 4;

interface ExploreNextSectionProps {
  coin: StablecoinMeta;
  related: StablecoinMeta[];
  staticComparisonPages: StaticComparisonEntry[];
  logos: Record<string, string>;
}

function CompactLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="pharos-focus-ring group flex min-h-9 items-center justify-between gap-3 rounded-sm py-1.5 text-sm text-foreground/85 transition-colors hover:text-foreground"
    >
      <span className="min-w-0 truncate">{label}</span>
      <ArrowRight
        aria-hidden="true"
        className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70 transition-all group-hover:translate-x-0.5 group-hover:text-foreground"
      />
    </Link>
  );
}

export function ExploreNextSection({ coin, related, staticComparisonPages, logos }: ExploreNextSectionProps) {
  const firstInfrastructure = coin.infrastructures?.[0];
  const infrastructureLabel = firstInfrastructure ? getInfrastructureLabel(firstInfrastructure) : null;
  const pegSlug = PEG_SLUGS[coin.flags.pegCurrency];

  const taxonomyLinks = [
    pegSlug
      ? {
          href: `/stablecoins/${pegSlug}/`,
          label: `All ${PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency} stablecoins`,
        }
      : null,
    {
      href: buildGovernanceTaxonomyUrl(coin.flags.governance),
      label: `${GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance} stablecoins`,
    },
    {
      href: buildBackingTaxonomyUrl(coin.flags.backing),
      label: `${BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing} stablecoins`,
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
  const resolvedArchetype = resolveMechanismArchetype(coin, TRACKED_META_BY_ID);
  if (resolvedArchetype) {
    // key-info-card already has a "Learn how X stablecoins work" CTA adjacent to the diagram.
    // Use this slot for a screener deep-link instead to avoid a duplicate CTA.
    trackerLinks.push({
      href: `/screener/?mechanisms=${resolvedArchetype}&lifecycle=active`,
      label: `See all ${getMechanismArchetypeCtaNoun(resolvedArchetype)} stablecoins`,
    });
  }
  const actionLinks: Array<{ href: string; label: string }> = [
    { href: buildLiveCompareUrl([coin.id]), label: `Open ${coin.symbol} in live compare` },
    { href: "/compare/", label: "Use the My Watchlist compare preset" },
    { href: "/digest/", label: "Read the daily digest" },
    { href: "/api/", label: "Use the Pharos API" },
  ];
  if (isActiveStablecoinMeta(coin)) {
    actionLinks.splice(1, 0, {
      href: "/pharoswatchbot/#getting-started",
      label: `Set ${coin.symbol} Telegram alerts`,
    });
  }

  const caseStudy = CASE_STUDY_BY_COIN_ID[coin.id];
  const hasPeers = related.length > 0 || staticComparisonPages.length > 0;
  const peersHref = pegSlug ? `/stablecoins/${pegSlug}/` : "/screener/";
  const hiddenComparisonCount = Math.max(0, staticComparisonPages.length - COMPARISON_MOBILE_CARD_CAP);

  return (
    <section
      id="explore-next"
      className="mt-8 -mx-4 space-y-6 rounded-xl bg-muted/15 px-4 py-6 sm:-mx-6 sm:px-6"
      aria-labelledby="explore-next-heading"
    >
      <div className="space-y-1.5">
        <DetailSectionTitle id="explore-next-heading" className={DETAIL_MODULE_TITLE_CLASS}>Explore Next</DetailSectionTitle>
        <p className="text-sm text-muted-foreground">
          Move from this coin into the next useful surface: peer benchmarks, taxonomy cohorts, or live trackers that add
          context to what you just read.
        </p>
      </div>

      {caseStudy ? (
        <Link
          href={`/learn/case-studies/${caseStudy.slug}/`}
          className="pharos-focus-ring group flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/50 px-4 py-3 transition-colors hover:border-foreground/30 hover:bg-accent"
        >
          <span className="min-w-0">
            <span className="pharos-kicker block text-frost-blue">Case study</span>
            <span className="mt-0.5 block text-sm font-medium text-foreground">{caseStudy.title}</span>
          </span>
          <ArrowRight
            aria-hidden="true"
            className="h-4 w-4 shrink-0 text-muted-foreground/70 transition-all group-hover:translate-x-0.5 group-hover:text-foreground"
          />
        </Link>
      ) : null}

      {hasPeers ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <p className="pharos-kicker">Peers</p>
            {pegSlug ? (
              <Link
                href={`/stablecoins/${pegSlug}/`}
                className="pharos-focus-ring inline-flex items-center gap-1 rounded-sm text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                See all peers
                <ArrowRight aria-hidden="true" className="h-3 w-3" />
              </Link>
            ) : null}
          </div>

          {related.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {related.slice(0, 6).map((peer) => (
                <Link
                  key={peer.id}
                  href={buildStablecoinUrl(peer.id)}
                  className="pharos-focus-ring inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/50 px-2.5 py-1 text-xs text-foreground transition-colors hover:border-foreground/30 hover:bg-accent"
                  title={peer.name}
                >
                  <StablecoinLogo src={logos[peer.id]} name={peer.name} size={16} />
                  <span className="font-mono tabular-nums font-medium">{peer.symbol}</span>
                </Link>
              ))}
            </div>
          ) : null}

          {staticComparisonPages.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">Static comparison briefs with structural context.</p>
              <div className="grid gap-px overflow-hidden rounded-xl border border-border/60 bg-border/60 sm:grid-cols-2 xl:grid-cols-3">
                {staticComparisonPages.map((page, index) => (
                  <Link
                    key={page.href}
                    href={page.href}
                    className={`pharos-focus-ring group ${
                      index < COMPARISON_MOBILE_CARD_CAP ? "flex" : "hidden lg:flex"
                    } min-h-12 items-center gap-2.5 bg-background/70 px-3 py-2.5 text-sm text-foreground transition-colors hover:bg-accent`}
                    aria-label={`Open static comparison brief: ${page.shortTitle}`}
                    title={page.counterpartName}
                  >
                    <StablecoinLogo src={logos[page.counterpartId]} name={page.counterpartName} size={18} />
                    <span className="min-w-0 flex-1">
                      <span className="text-muted-foreground">vs </span>
                      <span className="font-mono tabular-nums font-medium">{page.counterpartSymbol}</span>
                    </span>
                    <ArrowRight
                      aria-hidden="true"
                      className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70 transition-all group-hover:translate-x-0.5 group-hover:text-foreground"
                    />
                  </Link>
                ))}
              </div>
              {hiddenComparisonCount > 0 ? (
                <Link
                  href={peersHref}
                  className="pharos-focus-ring inline-flex min-h-9 items-center gap-1 rounded-sm text-xs font-medium text-muted-foreground transition-colors hover:text-foreground lg:hidden"
                >
                  +{hiddenComparisonCount} more comparison briefs
                  <ArrowRight aria-hidden="true" className="h-3 w-3" />
                </Link>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-x-8 gap-y-5 border-t border-border/40 pt-5 sm:grid-cols-2 xl:grid-cols-3">
        <div className="space-y-2">
          <p className="pharos-kicker">Taxonomy</p>
          <div className="-my-1 flex flex-col">
            {taxonomyLinks.map((link) => (
              <CompactLink key={link.href} href={link.href} label={link.label} />
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <p className="pharos-kicker">Trackers</p>
          <div className="-my-1 flex flex-col">
            {trackerLinks.map((link) => (
              <CompactLink key={link.href} href={link.href} label={link.label} />
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <p className="pharos-kicker">Actions</p>
          <div className="-my-1 flex flex-col">
            {actionLinks.map((link) => (
              <CompactLink key={link.href} href={link.href} label={link.label} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
