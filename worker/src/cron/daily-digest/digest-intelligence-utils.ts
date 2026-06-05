import type { DigestEditorialCandidate, DigestInputData, DigestSignalChange } from "@shared/types/digest";
import { formatCurrency } from "@shared/lib/format";
import { THREAT_BAND_ORDER } from "@shared/lib/classification";

export { formatScoreTrimmed as formatScore } from "@shared/lib/format";

export const CHANGE_LIMIT = 3;
export const TRIGGER_LIMIT = 3;

export const DEWS_BAND_RANK: Record<string, number> = THREAT_BAND_ORDER;

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function usableCandidates(data: DigestInputData | null | undefined): DigestEditorialCandidate[] {
  return (data?.editorialCandidates ?? []).filter((candidate) => !candidate.suppressReason);
}

export function toDateString(ts: number | null | undefined): string | null {
  return typeof ts === "number" && Number.isFinite(ts)
    ? new Date(ts * 1000).toISOString().slice(0, 10)
    : null;
}

export function candidateChange(candidate: DigestEditorialCandidate, detail?: string): DigestSignalChange {
  return {
    id: candidate.id,
    label: candidate.title,
    kind: candidate.kind,
    symbols: candidate.symbols,
    detail: detail ?? candidate.headlineFacts[0] ?? candidate.whyItMatters,
  };
}

export function signedCurrency(value: number): string {
  return `${value >= 0 ? "+" : ""}${formatCurrency(value, 0)}`;
}

export function roundToStep(value: number, step: number, direction: "up" | "down"): number {
  const scaled = value / step;
  return (direction === "up" ? Math.ceil(scaled) : Math.floor(scaled)) * step;
}
