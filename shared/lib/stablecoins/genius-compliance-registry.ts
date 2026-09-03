import type { GeniusComplianceProfile } from "../../types/stablecoin-client-meta";
import perCoinComplianceAsset from "../../data/stablecoins/coins.compliance.generated.json";

interface GeniusComplianceEntry {
  id: string;
  genius: GeniusComplianceProfile;
}

export const GENIUS_COMPLIANCE_PROFILE_BY_ID = new Map(
  (perCoinComplianceAsset as GeniusComplianceEntry[])
    .filter((entry) => entry.genius != null)
    .map((entry) => [entry.id, entry.genius] as const),
);
