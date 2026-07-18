import type { DigestInputData, DigestRiskTapeItem } from "@shared/types/digest";
import { formatCurrency } from "@shared/lib/format";
import { isCriticalDepegRisk } from "@shared/lib/digest-risk";
import { formatScore, signedCurrency } from "./digest-intelligence-utils";

export function buildRiskTape(data: DigestInputData): DigestRiskTapeItem[] {
  const items: DigestRiskTapeItem[] = [];

  if (data.stabilityIndex) {
    const band = data.stabilityIndex.band;
    items.push({
      id: "risk-tape:psi",
      label: "PSI",
      value: `${formatScore(data.stabilityIndex.score)} ${band}`,
      tone: psiTone(band),
      detail: `Severity ${formatScore(data.stabilityIndex.components.severity)}, breadth ${formatScore(data.stabilityIndex.components.breadth)}.`,
    });
  }

  const topDepeg = data.topDepegs.find((depeg) => !depeg.suppressReason) ?? data.topDepegs[0];
  const topDepegBps = topDepeg ? topDepeg.currentBps ?? topDepeg.bps : null;
  items.push({
    id: "risk-tape:depegs",
    label: "Depegs",
    value: topDepeg && topDepegBps != null ? `${topDepeg.symbol} ${Math.abs(topDepegBps)}bps` : "None active",
    tone: topDepeg && topDepegBps != null
      ? (isCriticalDepegRisk({ bps: topDepegBps, mcapUsd: topDepeg.mcapUsd }) ? "critical" : "warning")
      : "positive",
    detail: topDepeg
      ? `${data.activeDepegCount} active; ${formatCurrency(topDepeg.mcapUsd, 0)} mcap on top signal.`
      : "No active peg breaks in the digest input.",
  });

  if (data.mintBurnFlows) {
    const { classificationReason, classificationSource, flightToQuality, gaugeBand, gaugeScore } = data.mintBurnFlows;
    items.push({
      id: "risk-tape:gauge",
      label: "Gauge",
      value: `${formatScore(gaugeScore)} ${gaugeBand}`,
      tone: gaugeScore < -20 ? "warning" : gaugeScore > 20 ? "positive" : "neutral",
      detail:
        classificationSource === "unavailable"
          ? `Flight-to-quality classification unavailable${classificationReason ? ` (${classificationReason})` : ""}.`
          : flightToQuality.active
            ? "Flight-to-quality is active."
            : "No flight-to-quality flag.",
    });
  }

  if (data.dewsStress) {
    const alertPlus =
      data.dewsStress.bandCounts.alert + data.dewsStress.bandCounts.warning + data.dewsStress.bandCounts.danger;
    items.push({
      id: "risk-tape:dews",
      label: "DEWS",
      value: `${alertPlus} ALERT+`,
      tone: data.dewsStress.bandCounts.danger > 0 ? "critical" : alertPlus > 0 ? "warning" : "positive",
      detail: `${data.dewsStress.bandChanges.length} band change${data.dewsStress.bandChanges.length === 1 ? "" : "s"} in the last 24h.`,
    });
  }

  if (data.biggestSupplyChange) {
    items.push({
      id: "risk-tape:supply",
      label: "Supply",
      value: `${data.biggestSupplyChange.symbol} ${signedCurrency(data.biggestSupplyChange.changeUsd)}`,
      tone: Math.abs(data.biggestSupplyChange.changeUsd) >= 100_000_000 ? "neutral" : "positive",
      detail: "Largest 7d supply mover.",
    });
  }

  return items.slice(0, 5);
}

function psiTone(band: string): DigestRiskTapeItem["tone"] {
  if (band === "CRISIS" || band === "FRACTURE") return "critical";
  if (band === "TREMOR" || band === "STRAIN") return "warning";
  if (band === "BEDROCK") return "positive";
  return "neutral";
}
