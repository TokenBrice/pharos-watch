export const PSI_DEPEG_SEVERITY_WEIGHT = 60;
export const PSI_DEPEG_BREADTH_SCALE = 3;

export interface PsiDepegContributionInput {
  bps: number;
  mcapUsd: number;
  totalMcapUsd: number;
  factor?: number;
}

export interface PsiDepegContribution {
  severity: number;
  breadth: number;
  total: number;
}

export function computePsiDepegContribution({
  bps,
  mcapUsd,
  totalMcapUsd,
  factor = 1,
}: PsiDepegContributionInput): PsiDepegContribution {
  const share = totalMcapUsd > 0 ? mcapUsd / totalMcapUsd : 0;
  const amplifier = Math.log2(1 + mcapUsd / 1e9);
  const severity = (Math.abs(bps) / 100) * share * amplifier * PSI_DEPEG_SEVERITY_WEIGHT * factor;
  const breadth = Math.sqrt(mcapUsd / 1e9) * PSI_DEPEG_BREADTH_SCALE * factor;
  return { severity, breadth, total: severity + breadth };
}
