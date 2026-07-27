import { BlacklistTrackerMethodologySection } from "./monitoring/blacklist-tracker-section";
import { ChainHealthMethodologySection } from "./monitoring/chain-health-section";
import { DepegResolverMethodologySection } from "./monitoring/depeg-resolver-section";
import { PegScoreDewsMethodologySection } from "./monitoring/pegscore-dews-section";
import { YieldIntelligenceMethodologySection } from "./monitoring/yield-intelligence-section";

export function MonitoringMethodologySections() {
  return (
    <>
      <YieldIntelligenceMethodologySection />
      <PegScoreDewsMethodologySection />
      <DepegResolverMethodologySection />
      <BlacklistTrackerMethodologySection />
      <ChainHealthMethodologySection />
    </>
  );
}
