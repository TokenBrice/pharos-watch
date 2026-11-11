import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import {
  HERO_CHIP_BACKING_LABELS,
  HERO_CHIP_GOVERNANCE_LABELS,
  HERO_CHIP_PEG_LABELS,
  PRE_LAUNCH_ACCENT_CLASSES,
  getHeroPegLabel,
} from "@shared/lib/classification";
import type { StablecoinMeta } from "@shared/types";
import { cn } from "@/lib/utils";
import { IntentLink } from "@/components/intent-link";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { PreLaunchAlertAction } from "@/components/pre-launch-alert-action";
import { InfrastructureBadge } from "@/components/stablecoin-detail/hero-card-identity";
import { linkIconFor } from "@/components/stablecoin-detail/link-icon";
import { STABLECOIN_DETAIL_IDENTITY_LOGO_SIZE } from "@/components/stablecoin-detail/constants";
import { buildPegLandingUrl } from "@/lib/peg-landing";
import { buildBackingTaxonomyUrl, buildGovernanceTaxonomyUrl } from "@/lib/stablecoin-taxonomy-urls";
import { isLaunchedAwaitingData } from "@/lib/pre-launch";

const HEADER_ACTION_CLASS =
  "pharos-focus-ring hidden size-11 items-center justify-center rounded-md border border-border/60 bg-card text-muted-foreground transition-colors hover:border-border hover:bg-muted/60 hover:text-foreground sm:inline-flex lg:size-8";

const HERO_CHIP_CLASS =
  "pharos-focus-ring inline-flex h-5 items-center rounded-full bg-muted/70 px-2.5 text-xs font-medium leading-none text-foreground/80 transition-colors hover:bg-muted";

/** The dossier identity header (`HeroIdentityHeader` grammar); the visible `h1` lives here. */
export function PreLaunchIdentityHeader({ coin, logoSrc }: { coin: StablecoinMeta; logoSrc: string | undefined }) {
  const links = (coin.links ?? []).slice(0, 3);
  // "HKDAP" named "HKDAP": show the ticker once.
  const nameIsSymbol = coin.name.trim().toLowerCase() === coin.symbol.trim().toLowerCase();
  return (
    <header className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between lg:gap-5">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-3">
          <StablecoinLogo src={logoSrc} name={coin.name} size={STABLECOIN_DETAIL_IDENTITY_LOGO_SIZE} />
          <div className="flex min-w-0 flex-col gap-1 lg:flex-row lg:items-center lg:gap-3">
            {nameIsSymbol ? null : <span className="pharos-label shrink-0">{coin.symbol}</span>}
            <h1 className="pharos-page-title min-w-0 break-words text-xl leading-tight tracking-normal sm:text-2xl lg:leading-none">
              {coin.name}
              <span className="sr-only">
                {nameIsSymbol ? "" : ` (${coin.symbol})`}
                {isLaunchedAwaitingData(coin) ? " stablecoin status and tracking" : " pre-launch stablecoin tracker"}
              </span>
            </h1>
          </div>
        </div>
        {coin.oneLiner ? (
          <p className="mt-2 max-w-none text-pretty text-sm leading-relaxed text-muted-foreground">{coin.oneLiner}</p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 lg:shrink-0 lg:flex-nowrap lg:pt-1">
        {links.map((link) => {
          const Icon = linkIconFor(link.label);
          return (
            <a
              key={link.url}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              // Below sm the in-flow Key Links card carries these.
              className={HEADER_ACTION_CLASS}
              aria-label={`${link.label} (opens in new tab)`}
              title={link.label}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
          );
        })}
        {links.length > 0 ? <span aria-hidden="true" className="mx-1 hidden h-4 w-px bg-border/60 sm:block" /> : null}
        <PreLaunchAlertAction description={`Pharos's Telegram channel digest lists ${coin.symbol} once Pharos starts tracking it live`} />
      </div>
    </header>
  );
}

export function PreLaunchChipRail({ coin }: { coin: StablecoinMeta }) {
  const pegLabel =
    (coin.flags.navToken
      ? getHeroPegLabel(
          coin.flags,
          coin.pegReferenceId ? CLIENT_TRACKED_META_BY_ID.get(coin.pegReferenceId)?.symbol : undefined,
        )
      : null) ?? HERO_CHIP_PEG_LABELS[coin.flags.pegCurrency];
  const pegLandingUrl = buildPegLandingUrl(coin.flags.pegCurrency);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 border-b border-border/40 px-4 py-2.5 sm:px-5">
      <span
        className={cn(
          "inline-flex h-5 items-center rounded-full border px-2.5 text-xs font-medium leading-none",
          PRE_LAUNCH_ACCENT_CLASSES.preLaunchCard.border,
          PRE_LAUNCH_ACCENT_CLASSES.preLaunchCard.bg,
          PRE_LAUNCH_ACCENT_CLASSES.preLaunchCard.text,
        )}
      >
        {isLaunchedAwaitingData(coin) ? "Launched · no market data yet" : "Pre-launch · no market data yet"}
      </span>
      {pegLandingUrl ? (
        <IntentLink href={pegLandingUrl} className={HERO_CHIP_CLASS}>
          {pegLabel}
        </IntentLink>
      ) : (
        <span className={HERO_CHIP_CLASS}>{pegLabel}</span>
      )}
      <IntentLink href={buildBackingTaxonomyUrl(coin.flags.backing)} className={HERO_CHIP_CLASS}>
        {HERO_CHIP_BACKING_LABELS[coin.flags.backing]}
      </IntentLink>
      <IntentLink href={buildGovernanceTaxonomyUrl(coin.flags.governance)} className={HERO_CHIP_CLASS}>
        {HERO_CHIP_GOVERNANCE_LABELS[coin.flags.governance]}
      </IntentLink>
      {(coin.infrastructures ?? []).map((value) => (
        <InfrastructureBadge key={value} value={value} />
      ))}
    </div>
  );
}
