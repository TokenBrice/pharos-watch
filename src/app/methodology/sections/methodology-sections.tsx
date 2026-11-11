import { PricingPipelineMethodologySection } from "./core-sections-pricing";
import { DefinitionsSection } from "./definitions-section";
import { DependencyExposureMethodologySection } from "./dependency-exposure-section";
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
import { METHODOLOGY_SECTION_ROSTER } from "@/lib/methodology-content";

const SECTION_COMPONENTS = {
  lifecycle: LifecyclePhasesMethodologySection,
  pricing: PricingPipelineMethodologySection,
  stability: StabilityIndexMethodologySection,
  safety: SafetyScoresMethodologySection,
  exposure: DependencyExposureMethodologySection,
  "mint-authority": MintAuthorityScoreMethodologySection,
  infrastructure: InfrastructureMethodologySection,
  liquidity: LiquidityMethodologySection,
  redemption: RedemptionBackstopMethodologySection,
  "mint-burn": MintBurnFlowMethodologySection,
  yield: YieldIntelligenceMethodologySection,
  "peg-dews": PegScoreDewsMethodologySection,
  resolver: DepegResolverMethodologySection,
  blacklist: BlacklistTrackerMethodologySection,
  "chain-health": ChainHealthMethodologySection,
  definitions: DefinitionsSection,
} satisfies Record<(typeof METHODOLOGY_SECTION_ROSTER)[number]["key"], () => React.ReactNode>;

/** Render order is the published reading order of `/methodology/`. */
export function MethodologySections() {
  return (
    <>
      {METHODOLOGY_SECTION_ROSTER.map(({ key }) => {
        const Section = SECTION_COMPONENTS[key];
        return <Section key={key} />;
      })}
    </>
  );
}
