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
import { comparableDepegs, currentDepegBps, type DigestEvidence } from "./digest-evidence";

export function buildChangeSummary(
  data: DigestInputData,
  previousData: DigestInputData | null,
  evidence?: DigestEvidence,
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
    worsenedSignals: buildWorsenedImprovedSignals(data, previousData, "worsened", evidence),
    improvedSignals: buildWorsenedImprovedSignals(data, previousData, "improved", evidence),
    resolvedSignals: previous
      .filter((candidate) => isResolvedCandidate(candidate, evidence, currentIds, previousData))
      .slice(0, CHANGE_LIMIT)
      .map((candidate) => candidateChange(candidate, "Matching depeg event has a positively classified recovery closure.")),
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
  evidence?: DigestEvidence,
): DigestSignalChange[] {
  if (!previousData) return [];
  const out: DigestSignalChange[] = [];
  // Key by stablecoinId — two tracked coins can share a symbol (usda-avalon vs
  // usda-alpha-partner both print "USDA"), and a symbol-keyed match fabricates
  // cross-coin movement. Symbol keys remain only for archived rows without ids.
  const depegKey = (depeg: DigestInputData["topDepegs"][number]): string =>
    depeg.stablecoinId ?? `symbol:${depeg.symbol.toUpperCase()}`;
  const currentDepegs = new Map((evidence?.activeDepegs ?? data.topDepegs).map((depeg) => [depegKey(depeg), depeg]));
  for (const previous of previousData.topDepegs ?? []) {
    const current = currentDepegs.get(depegKey(previous));
    if (!current || !comparableDepegs(current, previous, data, previousData)) continue;
    const currentBps = currentDepegBps(current, data.dataQuality?.generatedAt)!;
    const previousBps = currentDepegBps(previous, previousData.dataQuality?.generatedAt)!;
    const delta = currentBps - previousBps;
    if (direction === "worsened" && delta >= 25) {
      out.push({
        id: `change:depeg:${(current.stablecoinId ?? current.symbol).toLowerCase()}:worsened`,
        label: `${current.symbol} depeg widened`,
        kind: "depeg",
        symbols: [current.symbol],
        detail: `${previousBps} bps to ${currentBps} bps off peg.`,
      });
    }
    if (direction === "improved" && delta <= -25) {
      out.push({
        id: `change:depeg:${(current.stablecoinId ?? current.symbol).toLowerCase()}:improved`,
        label: `${current.symbol} depeg narrowed`,
        kind: "depeg",
        symbols: [current.symbol],
        detail: `${previousBps} bps to ${currentBps} bps off peg.`,
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
  evidence: DigestEvidence | undefined,
  currentIds: Set<string>,
  previousData: DigestInputData | null,
): boolean {
  if (currentIds.has(candidate.id)) return false;
  if (candidate.kind !== "depeg") return false;
  const stablecoinId = candidate.id.split(":")[1];
  const previous = previousData?.topDepegs.find((row) => row.stablecoinId === stablecoinId);
  if (!previous || evidence?.activeDepegs?.some((row) => row.stablecoinId === stablecoinId)) return false;
  return (evidence?.recoveredDepegs ?? []).some((row) =>
    row.stablecoinId === stablecoinId && row.startedAt === previous.startedAt);
}
