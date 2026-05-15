import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { BACKING_LABELS, GOVERNANCE_LABELS, PEG_LABELS_SHORT } from "@shared/lib/classification";
import { getInfrastructureLabel } from "@shared/lib/infrastructure";
import type { StablecoinMeta } from "@shared/types";
import { buildLiveCompareUrl } from "@/lib/compare-pages";
import { buildBackingTaxonomyUrl, buildGovernanceTaxonomyUrl, buildInfrastructureTaxonomyUrl } from "@/lib/stablecoin-taxonomy";
import { PEG_SLUGS } from "@/lib/peg-landing";
import { buildStablecoinUrl } from "@/lib/urls";

interface ExploreNextSectionProps {
  coin: StablecoinMeta;
  related: StablecoinMeta[];
  staticComparisonPages: Array<{
    href: string;
    shortTitle: string;
    leftId: string;
    rightId: string;
  }>;
  logos: Record<string, string>;
}

function ExploreLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="group pharos-focus-ring inline-flex min-h-11 items-center justify-between gap-3 rounded-xl border border-border/60 bg-background/45 px-3 py-2 text-sm text-foreground transition-colors hover:border-foreground/20 hover:bg-accent"
    >
      <span>{label}</span>
      <ArrowRight className="h-3.5 w-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}

export function ExploreNextSection({
  coin,
  related,
  staticComparisonPages,
  logos,
}: ExploreNextSectionProps) {
  const firstInfrastructure = coin.infrastructures?.[0];
  const infrastructureLabel = firstInfrastructure ? getInfrastructureLabel(firstInfrastructure) : null;
  const taxonomyLinks = [
    PEG_SLUGS[coin.flags.pegCurrency]
      ? {
          href: `/stablecoins/${PEG_SLUGS[coin.flags.pegCurrency]}/`,
          label: `Browse all ${PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency} stablecoins`,
        }
      : null,
    {
      href: buildGovernanceTaxonomyUrl(coin.flags.governance),
      label: `Browse ${GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance} stablecoins`,
    },
    {
      href: buildBackingTaxonomyUrl(coin.flags.backing),
      label: `Browse ${BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing} stablecoins`,
    },
    firstInfrastructure
      ? {
          href: buildInfrastructureTaxonomyUrl(firstInfrastructure),
          label: infrastructureLabel ? `Browse ${infrastructureLabel} stablecoins` : "Browse infrastructure stablecoins",
        }
      : null,
  ].filter((link): link is { href: string; label: string } => link !== null);

  const trackerLinks = [
    { href: "/safety-scores/", label: "Review all stablecoin safety scores" },
    { href: "/liquidity/", label: "Review DEX liquidity rankings" },
    { href: "/depeg/", label: "Review the depeg tracker" },
  ];

  if (taxonomyLinks.length === 0 && trackerLinks.length === 0 && staticComparisonPages.length === 0 && related.length === 0) {
    return null;
  }

  return (
    <section id="explore-next" className="mt-8 -mx-4 rounded-2xl bg-muted/15 px-4 py-6 sm:-mx-6 sm:px-6 space-y-4" aria-labelledby="explore-next-heading">
      <div className="space-y-1.5">
        <DetailSectionTitle>
          Explore Next
        </DetailSectionTitle>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Move from this coin into the next useful surface: peer benchmarks, taxonomy cohorts, or live trackers that add context to what you just read.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,0.55fr)_minmax(0,0.45fr)] xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]">
        {/* Compare leads on narrow screens (highest-value peer path). */}
        <div className="pharos-card-shell space-y-3 p-4 order-1 lg:order-2 xl:order-3">
          {staticComparisonPages.length > 0 ? (
            <>
              <p className="pharos-kicker">Compare From Here</p>
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
                {staticComparisonPages.map((page) => (
                  <div
                    key={page.href}
                    className="rounded-2xl border border-border/60 bg-background/50 px-3 py-3"
                  >
                    <p className="text-sm font-medium text-foreground">{page.shortTitle}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
                      <Link
                        href={buildLiveCompareUrl([page.leftId, page.rightId])}
                        className="pharos-focus-ring inline-flex min-h-11 items-center gap-1 rounded-full bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
                      >
                        Open comparison
                        <ArrowRight className="h-3 w-3" />
                      </Link>
                      <Link
                        href={page.href}
                        className="pharos-focus-ring text-xs font-medium text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
                      >
                        Read the one-page brief
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : null}

          {related.length > 0 ? (
            <div className={staticComparisonPages.length > 0 ? "mt-4 border-t border-border/40 pt-3" : undefined}>
              <p className="pharos-kicker">Related Stablecoins</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {related.slice(0, 4).map((coinMeta) => (
                  <Link
                    key={coinMeta.id}
                    href={buildStablecoinUrl(coinMeta.id)}
                    className="pharos-focus-ring inline-flex min-h-11 items-center gap-2 rounded-full border border-border/60 bg-background/50 px-3 py-2 text-sm text-foreground transition-colors hover:border-foreground/20 hover:bg-accent"
                  >
                    <StablecoinLogo src={logos[coinMeta.id]} name={coinMeta.name} size={20} />
                    <span className="font-mono text-xs font-medium">{coinMeta.symbol}</span>
                  </Link>
                ))}
                {related.length > 4 ? (
                  <Link
                    href={PEG_SLUGS[coin.flags.pegCurrency] ? `/stablecoins/${PEG_SLUGS[coin.flags.pegCurrency]}/` : "/"}
                    className="pharos-focus-ring inline-flex min-h-11 items-center gap-1 rounded-full border border-dashed border-border/60 px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground"
                  >
                    See all peers
                    <ArrowRight className="h-3 w-3" />
                  </Link>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>

        <div className="pharos-card-shell space-y-3 p-4 order-2 lg:order-1 xl:order-1">
          <p className="pharos-kicker">Taxonomy</p>
          <div className="grid gap-2">
            {taxonomyLinks.map((link) => (
              <ExploreLink key={link.href} href={link.href} label={link.label} />
            ))}
          </div>
        </div>

        <div className="pharos-card-shell space-y-3 p-4 order-3 lg:order-1 xl:order-2">
          <p className="pharos-kicker">Trackers</p>
          <div className="grid gap-2">
            {trackerLinks.map((link) => (
              <ExploreLink key={link.href} href={link.href} label={link.label} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
