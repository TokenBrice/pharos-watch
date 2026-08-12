import { PricingPipelineMethodologySection } from "./core-sections-pricing";
import { InfrastructureMethodologySection } from "./core/infrastructure-section";
import { LifecyclePhasesMethodologySection } from "./core/lifecycle-phases-section";
import { LiquidityMethodologySection } from "./core/liquidity-section";
import { MintAuthorityScoreMethodologySection } from "./core/mint-authority-score-section";
import { MintBurnFlowMethodologySection } from "./core/mint-burn-flow-section";
import { RedemptionBackstopMethodologySection } from "./core/redemption-backstop-section";
import { SafetyScoresMethodologySection } from "./core/safety-scores-section";
import { StabilityIndexMethodologySection } from "./core/stability-index-section";
import { BlacklistTrackerMethodologySection } from "./monitoring/blacklist-tracker-section";
import { ChainHealthMethodologySection } from "./monitoring/chain-health-section";
import { DepegResolverMethodologySection } from "./monitoring/depeg-resolver-section";
import { PegScoreDewsMethodologySection } from "./monitoring/pegscore-dews-section";
import { YieldIntelligenceMethodologySection } from "./monitoring/yield-intelligence-section";

/** Render order is the published reading order of `/methodology/`. */
export function MethodologySections() {
  return (
    <>
      <LifecyclePhasesMethodologySection />
      <PricingPipelineMethodologySection />
      <StabilityIndexMethodologySection />
      <SafetyScoresMethodologySection />
      <MintAuthorityScoreMethodologySection />
      <InfrastructureMethodologySection />
      <LiquidityMethodologySection />
      <RedemptionBackstopMethodologySection />
      <MintBurnFlowMethodologySection />
      <YieldIntelligenceMethodologySection />
      <PegScoreDewsMethodologySection />
      <DepegResolverMethodologySection />
      <BlacklistTrackerMethodologySection />
      <ChainHealthMethodologySection />
    </>
  );
}
