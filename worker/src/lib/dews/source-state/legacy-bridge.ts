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
import {
  normalizeYieldRankChangeAttribution,
  normalizeYieldSourceRisk,
} from "@shared/types/yield";
import type { PersistedJsonDecodeReason } from "../contracts";

export function getObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function getString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
export function getNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function getBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}


export type LegacyDecodeResult<T> =
  | { ok: true; payload: T }
  | { ok: false; reason: PersistedJsonDecodeReason };

/**
 * Decodes a `stress_signals.signals_json` blob and unwraps the envelope if
 * present. Pre-envelope rows pass through unchanged; envelope rows surface as
 * `parsed.signals` for back-compat with the smoothing read path.
 */
export function decodeLegacyStressSignals(
  signalsJson: string | null,
  computedAt: number,
): LegacyDecodeResult<Record<string, { value: number }>> {
  const decoded = decodeJsonString<Record<string, { value: number }>, PersistedJsonDecodeReason>(signalsJson, {
    updatedAt: computedAt,
    missingReason: "missing",
    parseErrorReason: "json-parse-failed",
    normalize: (parsed) => {
      const unwrapped = unwrapStressSignalsEnvelope(parsed);
      if (unwrapped == null) {
        return { ok: false, reason: "invalid-shape" as const };
      }
      const signals: Record<string, { value: number }> = {};
      for (const [key, signal] of Object.entries(unwrapped.signals)) {
        const row = getObject(signal);
        if (row != null && typeof row.value === "number" && Number.isFinite(row.value)) {
          signals[key] = { ...row, value: row.value };
        }
      }
      return { ok: true, payload: signals };
    },
  });
  if (!decoded.ok) return { ok: false, reason: decoded.reason };
  return { ok: true, payload: decoded.payload };
}

export {
  normalizeYieldRankChangeAttribution,
  normalizeYieldSourceRisk,
};
