import type {
  DigestChangeSummary,
  DigestEditorialCandidate,
  DigestInputData,
  DigestSignalChange,
} from "@shared/types/digest";
import {
  candidateChange,
  CHANGE_LIMIT,
  formatScore,
  toDateString,
  usableCandidates,
} from "./digest-intelligence-utils";

export function buildChangeSummary(
  data: DigestInputData,
  previousData: DigestInputData | null,
): DigestChangeSummary {
  const current = usableCandidates(data).slice(0, 12);
  const previous = usableCandidates(previousData).slice(0, 20);
  const previousIds = new Set(previous.map((candidate) => candidate.id));
  const currentIds = new Set(current.map((candidate) => candidate.id));

  return {
    previousDate: toDateString(previousData?.dataQuality?.generatedAt),
    newSignals: current
      .filter((candidate) => !previousIds.has(candidate.id))
      .slice(0, CHANGE_LIMIT)
      .map((candidate) => candidateChange(candidate, "New to the top digest candidate set.")),
    worsenedSignals: buildWorsenedImprovedSignals(data, previousData, "worsened"),
    improvedSignals: buildWorsenedImprovedSignals(data, previousData, "improved"),
    resolvedSignals: previous
      .filter((candidate) => isResolvedCandidate(candidate, data, currentIds))
      .slice(0, CHANGE_LIMIT)
      .map((candidate) => candidateChange(candidate, "Signal cleared or fell out of the current top set.")),
    repeatedSignals: current
      .filter((candidate) => previousIds.has(candidate.id))
      .slice(0, CHANGE_LIMIT)
      .map((candidate) => candidateChange(candidate, "Still present in the top digest candidate set.")),
  };
}

function buildWorsenedImprovedSignals(
  data: DigestInputData,
  previousData: DigestInputData | null,
  direction: "worsened" | "improved",
): DigestSignalChange[] {
  if (!previousData) return [];
  const out: DigestSignalChange[] = [];
  // Key by stablecoinId — two tracked coins can share a symbol (usda-avalon vs
  // usda-alpha-partner both print "USDA"), and a symbol-keyed match fabricates
  // cross-coin movement. Symbol keys remain only for archived rows without ids.
  const depegKey = (depeg: DigestInputData["topDepegs"][number]): string =>
    depeg.stablecoinId ?? `symbol:${depeg.symbol.toUpperCase()}`;
  const depegBps = (depeg: DigestInputData["topDepegs"][number]): number =>
    Math.abs(depeg.currentBps ?? depeg.bps);
  const currentDepegs = new Map(data.topDepegs.map((depeg) => [depegKey(depeg), depeg]));
  for (const previous of previousData.topDepegs ?? []) {
    const current = currentDepegs.get(depegKey(previous));
    if (!current) continue;
    const delta = depegBps(current) - depegBps(previous);
    if (direction === "worsened" && delta >= 25) {
      out.push({
        id: `change:depeg:${(current.stablecoinId ?? current.symbol).toLowerCase()}:worsened`,
        label: `${current.symbol} depeg widened`,
        kind: "depeg",
        symbols: [current.symbol],
        detail: `${depegBps(previous)} bps to ${depegBps(current)} bps off peg.`,
      });
    }
    if (direction === "improved" && delta <= -25) {
      out.push({
        id: `change:depeg:${(current.stablecoinId ?? current.symbol).toLowerCase()}:improved`,
        label: `${current.symbol} depeg narrowed`,
        kind: "depeg",
        symbols: [current.symbol],
        detail: `${depegBps(previous)} bps to ${depegBps(current)} bps off peg.`,
      });
    }
  }

  pushPsiSignal(out, data, previousData, direction);
  pushGaugeSignal(out, data, previousData, direction);
  return out.slice(0, CHANGE_LIMIT);
}

function pushPsiSignal(
  out: DigestSignalChange[],
  data: DigestInputData,
  previousData: DigestInputData,
  direction: "worsened" | "improved",
): void {
  if (!data.stabilityIndex || !previousData.stabilityIndex) return;
  const delta = data.stabilityIndex.score - previousData.stabilityIndex.score;
  if (Math.abs(delta) < 1) return;
  if ((direction === "worsened" && delta >= 0) || (direction === "improved" && delta <= 0)) return;
  out.push({
    id: `change:psi:${delta < 0 ? "worsened" : "improved"}`,
    label: delta < 0 ? "PSI moved lower" : "PSI improved",
    kind: "psi",
    symbols: [],
    detail: `${formatScore(previousData.stabilityIndex.score)} to ${formatScore(data.stabilityIndex.score)} [${data.stabilityIndex.band}].`,
  });
}

function pushGaugeSignal(
  out: DigestSignalChange[],
  data: DigestInputData,
  previousData: DigestInputData,
  direction: "worsened" | "improved",
): void {
  if (!data.mintBurnFlows || !previousData.mintBurnFlows) return;
  const delta = data.mintBurnFlows.gaugeScore - previousData.mintBurnFlows.gaugeScore;
  if (Math.abs(delta) < 5) return;
  if ((direction === "worsened" && delta >= 0) || (direction === "improved" && delta <= 0)) return;
  out.push({
    id: `change:gauge:${delta < 0 ? "worsened" : "improved"}`,
    label: delta < 0 ? "Bank Run Gauge weakened" : "Bank Run Gauge improved",
    kind: "gauge",
    symbols: [],
    detail: `${formatScore(previousData.mintBurnFlows.gaugeScore)} to ${formatScore(data.mintBurnFlows.gaugeScore)} [${data.mintBurnFlows.gaugeBand}].`,
  });
}

function isResolvedCandidate(
  candidate: DigestEditorialCandidate,
  data: DigestInputData,
  currentIds: Set<string>,
): boolean {
  if (currentIds.has(candidate.id)) return false;
  const symbols = new Set(candidate.symbols.map((symbol) => symbol.toUpperCase()));
  if (candidate.kind !== "depeg") return false;
  const stillActive = data.topDepegs.some((depeg) => symbols.has(depeg.symbol.toUpperCase()));
  const resolved = (data.resolvedDepegs ?? []).some((depeg) => symbols.has(depeg.symbol.toUpperCase()));
  return resolved || !stillActive;
}
