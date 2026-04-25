import type { ChainsResponse, ChainSummary, ChainTopStablecoin } from "@shared/types/chains";
import type { StablecoinData, StablecoinListResponse, StressSignalsAllResponse } from "@shared/types/market";
import type { StabilityIndexResponse } from "@shared/types/stability";
import { PSI_HEX_COLORS, psiSweepDuration } from "@shared/lib/psi-colors";
import { THREAT_BAND_HEX } from "@shared/lib/classification";
import { getChainResilienceTier } from "@shared/lib/chains";
import { boatStyleFor, type BoatStyle } from "./classification-to-boat";
import { buildPegDiversityHero } from "@/lib/alt-peg-hero";

const NEUTRAL_PENNANT = "#5a7099"; // fog_pale

export interface SceneBoat {
  coinId: string;
  symbol: string;
  style: BoatStyle;
  hullSize: "S" | "L";
  pennantHex: string;
  homeChainId: string;
  supplyUsd: number;
}

export interface SceneHarbor {
  id: string;
  name: string;
  totalUsd: number;
  stablecoinCount: number;
  change7dPct: number | null;
  resilienceTier: 1 | 2 | 3;
  boats: SceneBoat[];
}

export interface SceneBeam {
  color: string;
  sweepSeconds: number;
  band: string;
  score: number;
}

export interface SceneSea {
  amplitudePx: number;
  highestBand: string;
  tintHex: string;
}

export interface SceneHorizonCohort {
  id: string;
  label: string;
  pegType: string;
  coinCount: number;
}

export interface SceneData {
  harbors: SceneHarbor[];
  beam: SceneBeam;
  sea: SceneSea;
  horizon: { cohorts: SceneHorizonCohort[] };
}

interface Inputs {
  chains: ChainsResponse | null | undefined;
  stability: StabilityIndexResponse | null | undefined;
  stress: StressSignalsAllResponse | null | undefined;
  stablecoins: StablecoinListResponse | null | undefined;
}

const SEA_AMPLITUDE: Record<string, number> = {
  CALM: 1.5,
  WATCH: 2.0,
  ALERT: 2.6,
  WARNING: 3.3,
  DANGER: 4.0,
};

export function buildSceneData({ chains, stability, stress, stablecoins }: Inputs): SceneData {
  const chainList = (chains?.chains ?? []).slice().sort((a, b) => b.totalUsd - a.totalUsd);
  const stablecoinByIdMap = new Map(
    (stablecoins?.peggedAssets ?? []).map((c) => [c.id, c]),
  );
  const stressById = stress?.signals ?? {};

  const harbors: SceneHarbor[] = chainList.map((chain) =>
    buildHarbor(chain, stablecoinByIdMap, stressById),
  );

  const band = stability?.current?.band ?? "BEDROCK";
  const score = stability?.current?.score ?? 0;
  const beam: SceneBeam = {
    color: PSI_HEX_COLORS[band as keyof typeof PSI_HEX_COLORS] ?? PSI_HEX_COLORS.BEDROCK,
    sweepSeconds: psiSweepDuration(band),
    band,
    score,
  };

  const seaBand = highestStressBand(stressById);
  const sea: SceneSea = {
    highestBand: seaBand,
    amplitudePx: SEA_AMPLITUDE[seaBand] ?? SEA_AMPLITUDE.CALM,
    tintHex: THREAT_BAND_HEX[seaBand as keyof typeof THREAT_BAND_HEX] ?? "#3a4f7a",
  };

  const cohorts: SceneHorizonCohort[] = (() => {
    if (!stablecoins?.peggedAssets) return [];
    const hero = buildPegDiversityHero(stablecoins.peggedAssets);
    return hero.pegClusters.map((c) => ({
      id: c.peg,
      label: c.peg,
      pegType: c.peg,
      coinCount: c.coins.length,
    }));
  })();

  return { harbors, beam, sea, horizon: { cohorts } };
}

function highestStressBand(signals: Record<string, { band: string }>): string {
  const order = ["CALM", "WATCH", "ALERT", "WARNING", "DANGER"];
  let max = "CALM";
  for (const sig of Object.values(signals)) {
    if (order.indexOf(sig.band) > order.indexOf(max)) max = sig.band;
  }
  return max;
}

function buildHarbor(
  chain: ChainSummary,
  coinsById: Map<string, StablecoinData>,
  stressById: Record<string, { band: string }>,
): SceneHarbor {
  const top = chain.topStablecoins ?? [];
  const maxSupply = top.reduce((m, c) => Math.max(m, c.supplyUsd), 1);
  const boats: SceneBoat[] = top.map((c) =>
    buildBoat(c, chain.id, coinsById, stressById, maxSupply),
  );
  return {
    id: chain.id,
    name: chain.name,
    totalUsd: chain.totalUsd,
    stablecoinCount: chain.stablecoinCount,
    change7dPct: chain.change7dPct ?? null,
    resilienceTier: clampTier(getChainResilienceTier(chain.id)),
    boats,
  };
}

function clampTier(tier: number | undefined): 1 | 2 | 3 {
  if (tier === 1 || tier === 2 || tier === 3) return tier;
  return 2;
}

function buildBoat(
  c: ChainTopStablecoin,
  chainId: string,
  coinsById: Map<string, StablecoinData>,
  stressById: Record<string, { band: string }>,
  maxSupply: number,
): SceneBoat {
  const coin = coinsById.get(c.id);
  const flags = (coin as { flags?: { governance?: string; backing?: string } } | undefined)?.flags;
  const style = boatStyleFor({
    governance: flags?.governance as never,
    backing: flags?.backing as never,
  });
  const sig = stressById[c.id];
  const pennantHex =
    sig && sig.band in THREAT_BAND_HEX
      ? THREAT_BAND_HEX[sig.band as keyof typeof THREAT_BAND_HEX]
      : NEUTRAL_PENNANT;
  return {
    coinId: c.id,
    symbol: c.symbol,
    style,
    hullSize: c.supplyUsd / maxSupply > 0.5 ? "L" : "S",
    pennantHex,
    homeChainId: chainId,
    supplyUsd: c.supplyUsd,
  };
}
