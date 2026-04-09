import { PricingPipelineMethodologySection } from "./core-sections-pricing";
import { InfrastructureMethodologySection } from "./core/infrastructure-section";
import { LiquidityMethodologySection } from "./core/liquidity-section";
import { MintBurnFlowMethodologySection } from "./core/mint-burn-flow-section";
import { SafetyScoresMethodologySection } from "./core/safety-scores-section";
import { StabilityIndexMethodologySection } from "./core/stability-index-section";

export function CoreMethodologySections() {
  return (
    <>
      <PricingPipelineMethodologySection />
      <StabilityIndexMethodologySection />
      <SafetyScoresMethodologySection />
      <InfrastructureMethodologySection />
      <LiquidityMethodologySection />
      <MintBurnFlowMethodologySection />
    </>
  );
}
