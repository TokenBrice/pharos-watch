import Link from "next/link";
import {
  BACKING_LABELS,
  GOVERNANCE_LABELS,
  PEG_LABELS_SHORT,
} from "@shared/lib/classification";
import type { StablecoinMeta } from "@shared/types";
import { buildPegLandingUrl } from "@/lib/peg-landing";
import { buildStablecoinDetailDescription } from "@/lib/page-metadata";
import { buildBackingTaxonomyUrl, buildGovernanceTaxonomyUrl } from "@/lib/stablecoin-taxonomy";

const pillClass =
  "pharos-focus-ring inline-flex items-center rounded-full border border-border/50 bg-background/60 px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-border hover:text-foreground";

export function StaticHeroStrip({ coin }: { coin: StablecoinMeta }) {
  const governanceLabel = GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance;
  const backingLabel = BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing;
  const pegLabel = PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency;
  const description = buildStablecoinDetailDescription(coin);

  return (
    <div className="space-y-2">
      <h1 className="text-2xl font-extrabold tracking-tighter text-foreground">
        {coin.name} ({coin.symbol}) stablecoin analytics
      </h1>
      <p className="flex flex-wrap items-center gap-1.5">
        <Link
          href={buildGovernanceTaxonomyUrl(coin.flags.governance)}
          className={pillClass}
          aria-label={`Browse ${governanceLabel} stablecoins`}
        >
          {governanceLabel}
        </Link>
        <Link
          href={buildBackingTaxonomyUrl(coin.flags.backing)}
          className={pillClass}
          aria-label={`Browse ${backingLabel} stablecoins`}
        >
          {backingLabel}
        </Link>
        <Link
          href={buildPegLandingUrl(coin.flags.pegCurrency) ?? "/stablecoins/"}
          className={pillClass}
          aria-label={`Browse ${pegLabel} stablecoins`}
        >
          {pegLabel}
        </Link>
      </p>
      <p className="max-w-3xl text-sm text-muted-foreground">{description}</p>
    </div>
  );
}
