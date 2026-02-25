/**
 * Pharos Stability Index — pure compute function.
 * See docs/plans/2026-02-25-stability-index-design.md for algorithm details.
 */

export type ConditionBand = "BEDROCK" | "STEADY" | "TREMOR" | "FRACTURE" | "CRISIS" | "MELTDOWN";

export interface StabilityInput {
  depegs: { bps: number; mcapUsd: number }[];
  totalMcapUsd: number;
  freezeCount24h: number;
  mcap7dChangePct: number;
}

export interface StabilityResult {
  score: number;
  band: ConditionBand;
  components: {
    severity: number;
    breadth: number;
    freezes: number;
    trend: number;
  };
}

const K = 60;

export function computeStabilityIndex(input: StabilityInput): StabilityResult {
  const { depegs, totalMcapUsd, freezeCount24h, mcap7dChangePct } = input;

  const severityRaw = depegs.reduce((sum, d) => {
    const share = totalMcapUsd > 0 ? d.mcapUsd / totalMcapUsd : 0;
    const amplifier = Math.log2(1 + d.mcapUsd / 1e9);
    return sum + (Math.abs(d.bps) / 100) * share * amplifier * K;
  }, 0);
  const severity = Math.min(60, severityRaw);

  const breadthRaw = depegs.reduce((sum, d) => {
    return sum + Math.sqrt(d.mcapUsd / 1e9) * 3;
  }, 0);
  const breadth = Math.min(15, breadthRaw);

  const freezes = Math.min(10, freezeCount24h * 2.5);

  const trend = Math.max(-5, Math.min(5, mcap7dChangePct));

  const raw = 100 - severity - breadth - freezes + trend;
  const score = Math.round(Math.max(0, Math.min(100, raw)) * 10) / 10;

  return {
    score,
    band: getConditionBand(score),
    components: {
      severity: Math.round(severity * 100) / 100,
      breadth: Math.round(breadth * 100) / 100,
      freezes: Math.round(freezes * 100) / 100,
      trend: Math.round(trend * 100) / 100,
    },
  };
}

export function getConditionBand(score: number): ConditionBand {
  if (score >= 90) return "BEDROCK";
  if (score >= 75) return "STEADY";
  if (score >= 60) return "TREMOR";
  if (score >= 40) return "FRACTURE";
  if (score >= 20) return "CRISIS";
  return "MELTDOWN";
}

/** Hex colors for each band — used by API consumers and frontend. */
export const BAND_COLORS: Record<ConditionBand, string> = {
  BEDROCK: "#22c55e",
  STEADY: "#14b8a6",
  TREMOR: "#eab308",
  FRACTURE: "#f97316",
  CRISIS: "#ef4444",
  MELTDOWN: "#991b1b",
};
