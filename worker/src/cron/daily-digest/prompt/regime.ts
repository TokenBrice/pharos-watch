import type { DigestInputData } from "@shared/types/digest";
import { REGIME_CRITICAL_DEGRADED_SOURCES } from "../degraded-sources";

/** Shared numeric gauge decisions used by classification and partial admission. */
export function classifyGaugeRegime(score: number): "CRISIS" | "TENSION" | "WATCHFUL" | "CALM" {
  if (score < -50) return "CRISIS";
  if (score < -20) return "TENSION";
  if (score < -10) return "WATCHFUL";
  return "CALM";
}

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
    const rawImpact = depeg.impactScore ?? Math.abs(depeg.currentBps ?? depeg.bps) * depeg.mcapUsd / 1_000_000_000;
    // A non-finite impact silently defuses every threshold below, making
    // CRISIS/TENSION unreachable: drop it instead of comparing against NaN.
    const impact = Number.isFinite(rawImpact) ? rawImpact : 0;
    const suppressedButMaterial = depeg.suppressReason && impact < 5_000;
    if (suppressedButMaterial) return sum;
    const chronicUnchanged =
      (depeg.ageHours ?? 0) >= 168 && !worsenedDepegSymbols.has(depeg.symbol.toUpperCase());
    return chronicUnchanged ? sum : sum + impact;
  }, 0);
  const unsuppressedActiveDepegs = data.topDepegs.filter((depeg) => !depeg.suppressReason).length;
  const gaugeScore = data.mintBurnFlows?.gaugeScore ?? 0;
  const gaugeRegime = classifyGaugeRegime(gaugeScore);
  const ftqActive = data.mintBurnFlows?.flightToQuality.active ?? false;
  const alertPlus = (data.dewsStress?.bandCounts.alert ?? 0)
    + (data.dewsStress?.bandCounts.warning ?? 0)
    + (data.dewsStress?.bandCounts.danger ?? 0);
  const alertPlusMcap = (data.dewsStress?.elevatedCoins ?? [])
    .reduce((sum, coin) => sum + coin.mcapUsd, 0);

  if (band === "TREMOR" || band === "FRACTURE" || band === "CRISIS" || ftqActive || gaugeRegime === "CRISIS" || activeDepegImpact >= 50_000) {
    return "CRISIS";
  }
  if (activeDepegImpact >= 1_000 || gaugeRegime === "TENSION" || alertPlusMcap > 1_000_000_000 || (alertPlus >= 3 && alertPlusMcap > 100_000_000)) {
    return "TENSION";
  }
  if ((data.dewsStress?.bandChanges?.length ?? 0) > 0 || unsuppressedActiveDepegs >= 1 || gaugeRegime === "WATCHFUL") {
    return "WATCHFUL";
  }
  // A regime-critical collector that could not read did not observe calm:
  // an unavailable input never publishes the optimistic end of the scale.
  const inputsUnavailable = REGIME_CRITICAL_DEGRADED_SOURCES.some(
    (source) => data.degradedSources?.includes(source) ?? false,
  );
  return inputsUnavailable ? "WATCHFUL" : "CALM";
}
