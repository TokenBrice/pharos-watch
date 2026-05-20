import type { DigestInputData } from "@shared/types/digest";

export function classifyRegime(data: DigestInputData): "CRISIS" | "TENSION" | "WATCHFUL" | "CALM" {
  const band = data.stabilityIndex?.band ?? "BEDROCK";
  const activeDepegImpact = data.topDepegs.reduce((sum, depeg) => {
    const impact = depeg.impactScore ?? Math.abs(depeg.bps) * depeg.mcapUsd / 1_000_000_000;
    const suppressedButMaterial = depeg.suppressReason && impact < 5_000;
    return suppressedButMaterial ? sum : sum + impact;
  }, 0);
  const unsuppressedActiveDepegs = data.topDepegs.filter((depeg) => !depeg.suppressReason).length;
  const gaugeScore = data.mintBurnFlows?.gaugeScore ?? 0;
  const ftqActive = data.mintBurnFlows?.flightToQuality.active ?? false;
  const alertPlus = (data.dewsStress?.bandCounts.alert ?? 0)
    + (data.dewsStress?.bandCounts.warning ?? 0)
    + (data.dewsStress?.bandCounts.danger ?? 0);
  const alertPlusMcap = (data.dewsStress?.elevatedCoins ?? [])
    .reduce((sum, coin) => sum + coin.mcapUsd, 0);

  if (band === "TREMOR" || band === "FRACTURE" || band === "CRISIS" || ftqActive || gaugeScore < -50 || activeDepegImpact >= 50_000) {
    return "CRISIS";
  }
  if (activeDepegImpact >= 1_000 || gaugeScore < -20 || alertPlusMcap > 1_000_000_000 || (alertPlus >= 3 && alertPlusMcap > 100_000_000)) {
    return "TENSION";
  }
  if ((data.dewsStress?.bandChanges?.length ?? 0) > 0 || unsuppressedActiveDepegs >= 1 || gaugeScore < -10) {
    return "WATCHFUL";
  }
  return "CALM";
}
