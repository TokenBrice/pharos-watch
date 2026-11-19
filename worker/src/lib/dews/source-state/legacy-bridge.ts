/**
 * DEWS source-state legacy compatibility bridge.
 *
 * Two distinct shape-migration concerns live here:
 *
 *   1. `stress_signals.signals_json` — older rows are flat
 *      `{ supply: { value, available }, pool: { ... } }` blobs without the
 *      `{ signals, amplifiers }` envelope introduced alongside contagion
 *      amplifier persistence. `decodeLegacyStressSignals` accepts either
 *      shape and returns the unwrapped signals map for the downstream
 *      smoothing read path.
 *
 *   2. `cache.yield-rankings` — the yield-rankings cron may emit
 *      forward-compatible fields that this consumer must coerce defensively.
 *      `normalizeYieldSourceRisk` / `normalizeYieldRankChangeAttribution`
 *      validate enum membership and discard unknown variants so future
 *      additions don't crash the DEWS run.
 *
 * Keep this bridge functional until all production rows have rolled forward
 * to the wrapped stress-signals envelope. Status today: both legacy and
 * wrapped shapes are still observed in production (see
 * `source-state-legacy.test.ts`), so this module is load-bearing.
 */

import { decodeJsonString } from "../../cache-json";
import { unwrapStressSignalsEnvelope } from "@shared/lib/stress-signals-envelope";
import { booleanValue, numberValue, readRecord } from "@shared/lib/type-guards";
import type { PersistedJsonDecodeReason } from "../contracts";
import type { DewsReferenceDivergence } from "../types";



export type LegacyDecodeResult<T> =
  | { ok: true; payload: T }
  | { ok: false; reason: PersistedJsonDecodeReason };


type DecodedStressSignal = {
  value: number;
  available?: boolean;
  componentCoverage?: number | null;
  referenceDivergence?: unknown;
  referenceCarried?: unknown;
};

export function readReferenceDivergence(value: unknown, computedAt: number): DewsReferenceDivergence | undefined {
  const row = readRecord(value);
  const observedAtSec = numberValue(row?.observedAtSec);
  const stress = numberValue(row?.value);
  if (observedAtSec == null || !Number.isSafeInteger(observedAtSec) || observedAtSec <= 0 || observedAtSec > computedAt
    || stress == null || stress < 0 || stress > 100) return undefined;
  return { value: stress, observedAtSec };
}
/**
 * Decodes a `stress_signals.signals_json` blob and unwraps the envelope if
 * present. Pre-envelope rows pass through unchanged; envelope rows surface as
 * `parsed.signals` for back-compat with the smoothing read path.
 */
export function decodeLegacyStressSignals(
  signalsJson: string | null,
  computedAt: number,
): LegacyDecodeResult<Record<string, DecodedStressSignal>> {
  const decoded = decodeJsonString<Record<string, DecodedStressSignal>, PersistedJsonDecodeReason>(signalsJson, {
    updatedAt: computedAt,
    missingReason: "missing",
    parseErrorReason: "json-parse-failed",
    normalize: (parsed) => {
      const unwrapped = unwrapStressSignalsEnvelope(parsed);
      if (unwrapped == null) {
        return { ok: false, reason: "invalid-shape" as const };
      }
      const signals: Record<string, DecodedStressSignal> = {};
      for (const [key, signal] of Object.entries(unwrapped.signals)) {
        const row = readRecord(signal);
        if (row != null && typeof row.value === "number" && Number.isFinite(row.value)) {
          const available = booleanValue(row.available);
          // Coverage is source-owned: absent legacy metadata remains unknown,
          // never inferred as full coverage (or zero from available:false).
          const coverage = row.componentCoverage;
          const componentCoverage = typeof coverage === "number" && Number.isFinite(coverage)
            && coverage >= 0 && coverage <= 1 ? coverage : null;
          signals[key] = {
            ...row, value: row.value, ...(available === null ? {} : { available }),
            ...("componentCoverage" in row ? { componentCoverage } : {}),
          };
        }
      }
      return { ok: true, payload: signals };
    },
  });
  if (!decoded.ok) return { ok: false, reason: decoded.reason };
  return { ok: true, payload: decoded.payload };
}
