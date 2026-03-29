import { BlacklistTrackerMethodologySection } from "./monitoring/blacklist-tracker-section";
import { ChainHealthMethodologySection } from "./monitoring/chain-health-section";
import { ContagionStressTestMethodologySection } from "./monitoring/contagion-stress-test-section";
import { PegScoreDewsMethodologySection } from "./monitoring/pegscore-dews-section";
import { YieldIntelligenceMethodologySection } from "./monitoring/yield-intelligence-section";

export function MonitoringMethodologySections() {
  return (
    <>
      <YieldIntelligenceMethodologySection />
      <PegScoreDewsMethodologySection />
      <ContagionStressTestMethodologySection />
      <BlacklistTrackerMethodologySection />
      <ChainHealthMethodologySection />
    </>
  );
}
