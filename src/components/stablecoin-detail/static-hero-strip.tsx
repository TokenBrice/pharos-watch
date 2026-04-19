import Link from "next/link";
import { buildStablecoinDetailDescription } from "@/lib/page-metadata";
import {
  BACKING_LABELS,
  GOVERNANCE_LABELS,
  PEG_LABELS_SHORT,
} from "@shared/lib/classification";
import {
  buildBackingTaxonomyUrl,
  buildGovernanceTaxonomyUrl,
} from "@/lib/stablecoin-taxonomy";
import { buildPegLandingUrl } from "@/lib/peg-landing";
import type { StablecoinMeta } from "@shared/types";

/**
 * Server-rendered identity strip shown before the Suspense boundary on active
 * detail pages so crawlers get substantive coin identity in initial HTML.
 * Live metrics still stream in through the client HeroCard.
 */
export function StaticHeroStrip({
  coin,
  logoSrc,
}: {
  coin: StablecoinMeta;
  logoSrc?: string;
}) {
  const governanceLabel = GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance;
  const backingLabel = BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing;
  const pegLabel = PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency;
  const pegHref = buildPegLandingUrl(coin.flags.pegCurrency);
  const governanceHref = buildGovernanceTaxonomyUrl(coin.flags.governance);
  const backingHref = buildBackingTaxonomyUrl(coin.flags.backing);
  const description = buildStablecoinDetailDescription(coin);

  const pillClass =
    "pharos-focus-ring inline-flex items-center rounded-full border border-border/50 bg-background/60 px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-border hover:text-foreground";
  const logoShellClass =
    "inline-flex shrink-0 items-center justify-center rounded-full border border-border/60 bg-background/80 text-xs font-bold text-muted-foreground shadow-[inset_0_1px_0_oklch(1_0_0_/0.05)]";

  return (
    <section className="pharos-card-shell overflow-hidden px-4 py-4 sm:px-5">
      <div className="flex items-start gap-3">
        <span className={logoShellClass} style={{ width: 56, height: 56 }}>
          {logoSrc ? (
            <img
              src={logoSrc}
              alt={`${coin.name} logo`}
              width={50}
              height={50}
              className="rounded-full object-contain"
              loading="lazy"
            />
          ) : (
            <span role="img" aria-label={`${coin.name} logo`}>
              {coin.name.charAt(0).toUpperCase()}
            </span>
          )}
        </span>
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-extrabold tracking-tighter text-foreground">
              {coin.name} ({coin.symbol})
            </h1>
          </div>
          <p className="flex flex-wrap items-center gap-1.5">
            <Link href={governanceHref} className={pillClass} aria-label={`Browse ${governanceLabel} stablecoins`}>
              {governanceLabel}
            </Link>
            <Link href={backingHref} className={pillClass} aria-label={`Browse ${backingLabel} stablecoins`}>
              {backingLabel}
            </Link>
            {pegHref ? (
              <Link href={pegHref} className={pillClass} aria-label={`Browse ${pegLabel} stablecoins`}>
                {pegLabel}
              </Link>
            ) : (
              <span className={pillClass}>{pegLabel}</span>
            )}
          </p>
          <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
    </section>
  );
}
