const DEFAULT_DEWS_AMPLIFIERS = { psi: 1, contagion: 1 } as const;

export interface StressSignalsEnvelope {
  signals: Record<string, unknown>;
  amplifiers: { psi: number; contagion: number };
}

import { isRecord } from "./type-guards";

/**
 * v5.95+ rows persist `{ signals, amplifiers }`; legacy rows persist the flat
 * signals map at the root. Fall back to default amplifiers when absent.
 */
export function unwrapStressSignalsEnvelope(
  parsed: unknown,
): StressSignalsEnvelope | null {
  if (!isRecord(parsed)) return null;
  const wrapped = parsed.signals;
  const signals = isRecord(wrapped) ? wrapped : parsed;
  const rawAmplifiers = isRecord(parsed.signals) ? parsed.amplifiers : null;
  const amp = isRecord(rawAmplifiers) ? rawAmplifiers : null;
  return {
    signals,
    amplifiers: {
      psi: typeof amp?.psi === "number" ? amp.psi : DEFAULT_DEWS_AMPLIFIERS.psi,
      contagion: typeof amp?.contagion === "number" ? amp.contagion : DEFAULT_DEWS_AMPLIFIERS.contagion,
    },
  };
}
