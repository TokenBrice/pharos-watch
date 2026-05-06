import type { DigestCalmNarrativeFrame, DigestInputData } from "@shared/types/digest";
import { signedCurrency } from "./digest-intelligence-utils";

export function buildCalmNarrativeFrame(data: DigestInputData): DigestCalmNarrativeFrame {
  const chronic = (data.editorialCandidates ?? []).find((candidate) => candidate.suppressReason && candidate.novelty === "chronic");
  const supplyMover = data.biggestSupplyChange;
  if (supplyMover && Math.abs(supplyMover.changeUsd) >= 10_000_000) {
    return {
      label: "Supply rotation",
      detail: `${supplyMover.symbol} is the largest weekly mover at ${signedCurrency(supplyMover.changeUsd)}, enough to make a calm day about allocation rather than alarm.`,
      candidateId: (data.editorialCandidates ?? []).find((candidate) => candidate.symbols.includes(supplyMover.symbol))?.id,
    };
  }

  const dewsChange = data.dewsStress?.bandChanges[0];
  if (dewsChange) {
    return {
      label: "Quiet DEWS divergence",
      detail: `${dewsChange.symbol} moved ${dewsChange.from} to ${dewsChange.to} while the headline regime stayed orderly.`,
      candidateId: (data.editorialCandidates ?? []).find((candidate) => candidate.symbols.includes(dewsChange.symbol))?.id,
    };
  }

  const liquidityShift = data.liquidityShifts?.[0];
  if (liquidityShift) {
    return {
      label: "Liquidity divergence",
      detail: `${liquidityShift.symbol} liquidity moved ${liquidityShift.previousScore} to ${liquidityShift.currentScore}, a useful secondary story when peg stress is quiet.`,
      candidateId: (data.editorialCandidates ?? []).find((candidate) => candidate.symbols.includes(liquidityShift.symbol))?.id,
    };
  }

  if (chronic) {
    return {
      label: "Chronic risk boundary",
      detail: `${chronic.title} remains background risk, but the candidate is suppressed because it lacks fresh market evidence.`,
      candidateId: chronic.id,
    };
  }

  return {
    label: "Documented quiet",
    detail: "No active depeg, flow, DEWS, or liquidity signal displaced the regime frame; the story is what did not break.",
  };
}
