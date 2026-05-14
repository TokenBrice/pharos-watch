const DEFAULT_DEWS_AMPLIFIERS = { psi: 1, contagion: 1 } as const;

export interface StressSignalTopContributor {
  key: string;
  label?: string;
  value: number;
  effectiveWeight: number;
  contribution: number;
}

export interface StressSignalsEnvelope {
  signals: Record<string, unknown>;
  amplifiers: { psi: number; contagion: number };
  baseScore?: number;
  finalScore?: number;
  availableWeight?: number;
  effectiveWeights?: Record<string, number>;
  evidenceKinds?: string[];
  insufficientEvidenceReason?: string | null;
  dataQualityScore?: number;
  sourceAges?: Record<string, number | null>;
  staleFlags?: Record<string, boolean>;
  topContributors?: StressSignalTopContributor[];
}

import { isRecord } from "./type-guards";

/**
 * v5.95+ rows persist `{ signals, amplifiers }`; legacy rows persist the flat
 * signals map at the root. Fall back to default amplifiers when absent.
 */
export function unwrapStressSignalsEnvelope(parsed: unknown): StressSignalsEnvelope | null {
  if (!isRecord(parsed)) return null;
  const wrapped = parsed.signals;
  const signals = isRecord(wrapped) ? wrapped : parsed;
  const rawAmplifiers = isRecord(parsed.signals) ? parsed.amplifiers : null;
  const amp = isRecord(rawAmplifiers) ? rawAmplifiers : null;
  const envelope: StressSignalsEnvelope = {
    signals,
    amplifiers: {
      psi: typeof amp?.psi === "number" ? amp.psi : DEFAULT_DEWS_AMPLIFIERS.psi,
      contagion: typeof amp?.contagion === "number" ? amp.contagion : DEFAULT_DEWS_AMPLIFIERS.contagion,
    },
  };

  if (!isRecord(wrapped)) return envelope;

  if (typeof parsed.baseScore === "number") envelope.baseScore = parsed.baseScore;
  if (typeof parsed.finalScore === "number") envelope.finalScore = parsed.finalScore;
  if (typeof parsed.availableWeight === "number") envelope.availableWeight = parsed.availableWeight;
  if (typeof parsed.dataQualityScore === "number") envelope.dataQualityScore = parsed.dataQualityScore;
  if (typeof parsed.insufficientEvidenceReason === "string" || parsed.insufficientEvidenceReason === null) {
    envelope.insufficientEvidenceReason = parsed.insufficientEvidenceReason;
  }
  if (Array.isArray(parsed.evidenceKinds) && parsed.evidenceKinds.every((kind) => typeof kind === "string")) {
    envelope.evidenceKinds = parsed.evidenceKinds;
  }
  if (isRecord(parsed.effectiveWeights)) {
    const weights = Object.fromEntries(
      Object.entries(parsed.effectiveWeights).filter(
        (entry): entry is [string, number] => typeof entry[1] === "number",
      ),
    );
    envelope.effectiveWeights = weights;
  }
  if (isRecord(parsed.sourceAges)) {
    const sourceAges = Object.fromEntries(
      Object.entries(parsed.sourceAges).filter(
        (entry): entry is [string, number | null] => typeof entry[1] === "number" || entry[1] === null,
      ),
    );
    envelope.sourceAges = sourceAges;
  }
  if (isRecord(parsed.staleFlags)) {
    const staleFlags = Object.fromEntries(
      Object.entries(parsed.staleFlags).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"),
    );
    envelope.staleFlags = staleFlags;
  }
  if (Array.isArray(parsed.topContributors)) {
    const topContributors = parsed.topContributors.filter((item): item is StressSignalTopContributor => {
      if (!isRecord(item)) return false;
      return (
        typeof item.key === "string" &&
        (typeof item.label === "string" || item.label == null) &&
        typeof item.value === "number" &&
        typeof item.effectiveWeight === "number" &&
        typeof item.contribution === "number"
      );
    });
    envelope.topContributors = topContributors;
  }

  return envelope;
}
