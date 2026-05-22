export interface DiscoveryCandidate {
  id: number;
  geckoId: string | null;
  llamaId: number | null;
  name: string;
  symbol: string;
  marketCap: number | null;
  source: "defillama" | "coingecko" | "both";
  firstSeen: number;
  lastSeen: number;
  daysSeen: number;
  dismissed: boolean;
}

export interface DiscoveryCandidatesResponse {
  candidates: DiscoveryCandidate[];
  total: number;
}
