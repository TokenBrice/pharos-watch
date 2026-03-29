import { DAY_SECONDS } from "@shared/lib/time-constants";
import type { DiscoveryCandidate } from "@shared/types/status";

export const DISCOVERY_CANDIDATE_SELECT_COLUMNS = [
  "id",
  "gecko_id",
  "llama_id",
  "name",
  "symbol",
  "market_cap",
  "source",
  "first_seen",
  "last_seen",
  "dismissed",
].join(", ");

export interface DiscoveryCandidateRow {
  id: number;
  gecko_id: string | null;
  llama_id: number | null;
  name: string;
  symbol: string;
  market_cap: number | null;
  source: "defillama" | "coingecko" | "both";
  first_seen: number;
  last_seen: number;
  dismissed: number;
}

export function mapDiscoveryCandidateRow(
  row: DiscoveryCandidateRow,
  nowSec: number,
): DiscoveryCandidate {
  return {
    id: row.id,
    geckoId: row.gecko_id,
    llamaId: row.llama_id,
    name: row.name,
    symbol: row.symbol,
    marketCap: row.market_cap,
    source: row.source,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    daysSeen: Math.max(1, Math.floor((nowSec - row.first_seen) / DAY_SECONDS)),
    dismissed: row.dismissed === 1,
  };
}
