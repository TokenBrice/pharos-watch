import { ArrowRight, Ban, PauseCircle } from "lucide-react";
import { IntentLink } from "@/components/intent-link";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import { buildPegLandingUrl } from "@/lib/peg-landing";
import { getLogoSrc } from "@/lib/logos";
import { buildStablecoinUrl } from "@shared/lib/urls";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";

type ListingStateCoin = Pick<StablecoinMeta, "status" | "listingStatusReview" | "symbol" | "flags">;

export interface ActivePeerOfframp {
  id: string;
  symbol: string;
  name: string;
}

export function ListingStateBanner({
  coin,
  activePeers = [],
  logos,
}: {
  coin: ListingStateCoin;
  /** Active same-cohort peers offered as an off-ramp on quarantined profiles. */
  activePeers?: readonly ActivePeerOfframp[];
  logos?: Record<string, string>;
}) {
  if ((coin.status !== "quarantined" && coin.status !== "delisted") || !coin.listingStatusReview) {
    return null;
  }

  const quarantined = coin.status === "quarantined";
  const Icon = quarantined ? PauseCircle : Ban;
  const title = quarantined ? "Live tracking temporarily paused" : "No longer listed by Pharos";
  const pegLandingHref = quarantined && coin.flags?.pegCurrency ? buildPegLandingUrl(coin.flags.pegCurrency) : null;
  const showOfframp = quarantined && (activePeers.length > 0 || pegLandingHref !== null);

  return (
    <section
      aria-label={`${coin.symbol} listing status`}
      className={`rounded-lg border ${SEVERITY_TONE_CLASS.caution.banner} px-4 py-3 text-sm`}
    >
      <div className="flex items-start gap-3">
        <Icon aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-state-warn" />
        <div className="min-w-0 space-y-1">
          <p className="font-semibold text-foreground">{title}</p>
          <p className="leading-relaxed text-muted-foreground">{coin.listingStatusReview.reason}</p>
          <p className="text-xs text-muted-foreground">
            Effective {coin.listingStatusReview.changedAt}
            {quarantined && coin.listingStatusReview.reviewBy
              ? `; review due ${coin.listingStatusReview.reviewBy}`
              : ""}
            {coin.listingStatusReview.source ? (
              <>
                {"; "}
                <a
                  href={coin.listingStatusReview.source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="pharos-focus-ring rounded-sm underline underline-offset-2 hover:text-foreground"
                >
                  {coin.listingStatusReview.source.label}
                </a>
              </>
            ) : null}
          </p>
          {showOfframp ? (
            <div className="mt-3 border-t border-border/50 pt-2.5">
              <p className="pharos-label">Active peers</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {activePeers.slice(0, 5).map((peer) => (
                  <IntentLink
                    key={peer.id}
                    href={buildStablecoinUrl(peer.id)}
                    title={peer.name}
                    className="pharos-focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-full border border-border/70 bg-card px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:border-foreground/30 hover:bg-muted/60 sm:min-h-7"
                  >
                    {logos ? <StablecoinLogo src={getLogoSrc(logos, peer.id)} name={peer.name} size={16} /> : null}
                    <span className="font-mono tabular-nums">{peer.symbol}</span>
                  </IntentLink>
                ))}
                {pegLandingHref ? (
                  <IntentLink
                    href={pegLandingHref}
                    className="pharos-focus-ring inline-flex min-h-9 items-center gap-1 rounded-sm px-1.5 text-xs font-medium text-brand-accent-text underline-offset-4 hover:underline sm:min-h-7"
                  >
                    Browse active peers
                    <ArrowRight className="h-3 w-3" aria-hidden="true" />
                  </IntentLink>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
