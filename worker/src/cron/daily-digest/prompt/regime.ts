import type { DigestInputData } from "@shared/types/digest";

export function classifyRegime(data: DigestInputData): "CRISIS" | "TENSION" | "WATCHFUL" | "CALM" {
  const band = data.stabilityIndex?.band ?? "BEDROCK";
  // Chronic standing conditions must not pin the regime: a depeg older than a
  // week only contributes tension when it actually worsened since yesterday.
  // Before this gate, four never-closing critical events held the classifier
  // at TENSION for weeks and the CALM storytelling machinery was dead code.
  const worsenedDepegSymbols = new Set(
    (data.changeSummary?.worsenedSignals ?? [])
      .filter((change) => change.kind === "depeg")
      .flatMap((change) => change.symbols.map((symbol) => symbol.toUpperCase())),
  );
  const activeDepegImpact = data.topDepegs.reduce((sum, depeg) => {
    const impact = depeg.impactScore ?? Math.abs(depeg.currentBps ?? depeg.bps) * depeg.mcapUsd / 1_000_000_000;
    const suppressedButMaterial = depeg.suppressReason && impact < 5_000;
    if (suppressedButMaterial) return sum;
    const chronicUnchanged =
      (depeg.ageHours ?? 0) >= 168 && !worsenedDepegSymbols.has(depeg.symbol.toUpperCase());
    return chronicUnchanged ? sum : sum + impact;
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
