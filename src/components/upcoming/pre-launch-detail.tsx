import Link from "next/link";
import { AiSummary } from "@/components/ai-summary/ai-summary";
import { PreLaunchReadiness } from "@/components/upcoming/pre-launch-readiness";
import { PreLaunchIdentityHeader, PreLaunchChipRail } from "@/components/upcoming/pre-launch-identity";
import { LaunchPathModule, LaunchQuickAnswers, ActivityModule } from "@/components/upcoming/pre-launch-evidence";
import { FeaturedCoverage } from "@/components/upcoming/pre-launch-featured-coverage";
import { PlannedProfileCard, RelatedCard } from "@/components/upcoming/pre-launch-profile";
import { EvidenceStateStrip } from "@/components/stablecoin-detail/evidence-module";
import { KeyLinksCard } from "@/components/stablecoin-detail/key-links-card";
import { StablecoinDetailIdentityProvider } from "@/components/stablecoin-detail/module-title";
import { SameTickerStablecoins } from "@/components/stablecoin-detail/same-ticker-stablecoins";
import { isLaunchedAwaitingData } from "@/lib/pre-launch";
import type { StablecoinAiSummary } from "@shared/types/editorial";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";

/** Live surfaces a pre-launch dossier gains at its first post-launch data sync. */
const LIVE_SURFACES = "Price & peg · Supply & flows · Liquidity · Safety Score · DEWS";

interface PreLaunchDetailProps {
  coin: StablecoinMeta;
  logoSrc: string | undefined;
  summary: StablecoinAiSummary | null;
}

/**
 * The pre-launch variant of the stablecoin dossier (server component): the
 * live dossier's identity header, hero, summary, evidence modules and rail,
 * filled with registry launch facts only. Live surfaces are named once in an
 * explicit "Activates at launch" strip, never drawn as empty cards.
 */
export function PreLaunchDetail({ coin, logoSrc, summary }: PreLaunchDetailProps) {
  const launched = isLaunchedAwaitingData(coin);
  return (
    <StablecoinDetailIdentityProvider symbol={coin.symbol} logoSrc={logoSrc}>
      <Link
        href="/upcoming/"
        className="pharos-focus-ring mb-2 inline-flex items-center gap-1.5 rounded-sm text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <span aria-hidden="true">←</span> All upcoming stablecoins
      </Link>
      <PreLaunchIdentityHeader coin={coin} logoSrc={logoSrc} />
      <div className="mt-4 xl:grid xl:grid-cols-[minmax(0,1fr)_22rem] xl:items-start xl:gap-6">
        <div className="min-w-0 space-y-4">
          <div className="pharos-card-shell gap-0 overflow-hidden py-0">
            <PreLaunchChipRail coin={coin} />
            <PreLaunchReadiness coin={coin} />
          </div>
          <EvidenceStateStrip
            id="live-surfaces"
            title="Live surfaces"
            // Launched: the coin is live and the review names the missing lane.
            state={launched ? "awaiting-data" : "pending-launch"}
            reason={launched ? (coin.listingStatusReview?.reason ?? LIVE_SURFACES) : LIVE_SURFACES}
            density="main"
            headingLevel="h2"
          />
          {summary ? <AiSummary {...summary} /> : null}
          <LaunchPathModule coin={coin} />
          <LaunchQuickAnswers coin={coin} />
          <ActivityModule coin={coin} />
          {coin.featuredContent && coin.featuredContent.length > 0 ? (
            <FeaturedCoverage items={coin.featuredContent} />
          ) : null}
          <SameTickerStablecoins coin={coin} />
        </div>
        <aside aria-label={`${coin.symbol} profile`} className="mt-4 grid gap-4 md:grid-cols-2 xl:mt-0 xl:grid-cols-1">
          <PlannedProfileCard coin={coin} />
          <KeyLinksCard meta={coin} anchors />
          <RelatedCard coin={coin} />
        </aside>
      </div>
    </StablecoinDetailIdentityProvider>
  );
}
