import { PricingPipelineMethodologySection } from "./core-sections-pricing";
import { InfrastructureMethodologySection } from "./core/infrastructure-section";
import { LifecyclePhasesMethodologySection } from "./core/lifecycle-phases-section";
import { LiquidityMethodologySection } from "./core/liquidity-section";
import { MintAuthorityScoreMethodologySection } from "./core/mint-authority-score-section";
import { MintBurnFlowMethodologySection } from "./core/mint-burn-flow-section";
import { SafetyScoresMethodologySection } from "./core/safety-scores-section";
import { StabilityIndexMethodologySection } from "./core/stability-index-section";

export function CoreMethodologySections() {
  return (
    <>
      <LifecyclePhasesMethodologySection />
      <PricingPipelineMethodologySection />
      <StabilityIndexMethodologySection />
      <SafetyScoresMethodologySection />
      <MintAuthorityScoreMethodologySection />
      <InfrastructureMethodologySection />
      <LiquidityMethodologySection />
      <MintBurnFlowMethodologySection />
    </>
  );
}
