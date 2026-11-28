import { recordJsonParseFailure } from "./api-cache-read";
import { assessFreshnessTimestamp } from "./api-freshness-age";
import { validatePayloadWithSchema } from "./api-schema";
import { decodeCachedJson } from "./cache-json";
import { bucketUnixSecondsToUtcDay } from "@shared/lib/time-buckets";
import { DepegTimestampSchema, PegSummaryCoinSchema, type PegSummaryCoin } from "@shared/types/peg";
import { z } from "zod";

// Pure row admission for the `peg-analytics` cache, kept apart from the
// publisher so request-path readers can reuse it without the full registry.

export const PEG_ANALYTICS_CACHE_KEY = "peg-analytics";

// Published every 30 minutes on the charts lane: by V9 input preparation at
// :16 and standalone at :46.
export const PEG_ANALYTICS_CACHE_MAX_AGE_MS = 30 * 60 * 1000;

export const PegAnalyticsOpenIncidentSchema = z.object({
  eventId: z.number().int().positive(),
  startedAt: DepegTimestampSchema,
  escalatedAt: DepegTimestampSchema.nullable(),
});
export type PegAnalyticsOpenIncident = z.infer<typeof PegAnalyticsOpenIncidentSchema>;

export interface PegAnalyticsCachePayload {
  computedAtSec: number;
  depegEventsToday: number;
  depegEventsYesterday: number;
  /** Nav-token-inclusive; consumers filter as needed. */
  pegData: PegSummaryCoin[];
  /** Optional open-incident sidecar keyed by stablecoin ID (absent on pre-deploy rows). */
  openIncidents?: Record<string, PegAnalyticsOpenIncident>;
  /**
   * Optional open-incident candidates per coin retained whenever a coin has multiple
   * scored open rows so cached `/api/peg-summary` reads can re-apply the representative
   * tie-break (`reconcileOpenIncidents`) across all candidates at request time.
   */
  openIncidentCandidates?: Record<string, PegAnalyticsOpenIncident[]>;
}

export type PegAnalyticsCacheFailureReason =
  | "missing-cache"
  | "stale-cache"
  | "stale-day"
  | "future-timestamp"
  | "json-parse-failed"
  | "invalid-payload";

export type PegAnalyticsCacheLoadResult =
  | { kind: "ok"; payload: PegAnalyticsCachePayload; pegDataById: Map<string, PegSummaryCoin>; updatedAt: number }
  | { kind: "miss"; reason: PegAnalyticsCacheFailureReason };

const PEG_DATA_SCHEMA = z.array(PegSummaryCoinSchema);
const OPEN_INCIDENTS_SCHEMA = z.record(z.string(), PegAnalyticsOpenIncidentSchema);
const OPEN_INCIDENT_CANDIDATES_SCHEMA = z.record(z.string(), z.array(PegAnalyticsOpenIncidentSchema).min(1));

function parsePayload(value: unknown): PegAnalyticsCachePayload | null {
  if (!value || typeof value !== "object") return null;
  const parsed = value as Partial<PegAnalyticsCachePayload>;
  if (
    !(typeof parsed.computedAtSec === "number" &&
      Number.isFinite(parsed.computedAtSec) &&
      typeof parsed.depegEventsToday === "number" &&
      typeof parsed.depegEventsYesterday === "number" &&
      Array.isArray(parsed.pegData))
  ) {
    return null;
  }
  // A row written by another deploy must still satisfy every published field
  // the route copies verbatim, not merely carry an id.
  const rows = validatePayloadWithSchema(
    PEG_DATA_SCHEMA,
    parsed.pegData,
    "peg-analytics:pegData",
  );
  if (!rows.ok) return null;
  let openIncidents: Record<string, PegAnalyticsOpenIncident> | undefined;
  let openIncidentCandidates: Record<string, PegAnalyticsOpenIncident[]> | undefined;
  if (parsed.openIncidents !== undefined) {
    const validatedOpenIncidents = validatePayloadWithSchema(
      OPEN_INCIDENTS_SCHEMA,
      parsed.openIncidents,
      "peg-analytics:openIncidents",
    );
    if (validatedOpenIncidents.ok) {
      if (parsed.openIncidentCandidates !== undefined) {
        const validatedCandidates = validatePayloadWithSchema(
          OPEN_INCIDENT_CANDIDATES_SCHEMA,
          parsed.openIncidentCandidates,
          "peg-analytics:openIncidentCandidates",
        );
        if (validatedCandidates.ok) {
          openIncidents = validatedOpenIncidents.data;
          openIncidentCandidates = validatedCandidates.data;
        }
      } else {
        openIncidents = validatedOpenIncidents.data;
      }
    }
  }
  return {
    computedAtSec: parsed.computedAtSec,
    depegEventsToday: parsed.depegEventsToday,
    depegEventsYesterday: parsed.depegEventsYesterday,
    pegData: rows.data,
    ...(openIncidents !== undefined ? { openIncidents } : {}),
    ...(openIncidentCandidates !== undefined ? { openIncidentCandidates } : {}),
  };
}

/**
 * The stale-cache gate and payload parser for one `peg-analytics` cache row.
 * A future-dated row is reported, never deleted: that repair is the loader's.
 */
export function decodePegAnalyticsCacheRow(
  row: { value: string; updatedAt: number } | null,
  nowMs: number,
  { maxAgeMs = PEG_ANALYTICS_CACHE_MAX_AGE_MS, requireCurrentUtcDay = false }: {
    maxAgeMs?: number;
    /** Reject day-scoped counters published on a previous UTC day. */
    requireCurrentUtcDay?: boolean;
  } = {},
): PegAnalyticsCacheLoadResult {
  if (!row) return { kind: "miss", reason: "missing-cache" };
  const nowSec = Math.floor(nowMs / 1000);
  if (assessFreshnessTimestamp(nowSec, row.updatedAt).reason === "future-timestamp") {
    return { kind: "miss", reason: "future-timestamp" };
  }
  if (nowMs - row.updatedAt * 1000 > maxAgeMs) return { kind: "miss", reason: "stale-cache" };
  const decoded = decodeCachedJson<PegAnalyticsCachePayload, PegAnalyticsCacheFailureReason>(
    row,
    {
      missingReason: "missing-cache",
      parseErrorReason: "json-parse-failed",
      normalize: (parsed) => {
        const payload = parsePayload(parsed);
        return payload ? { ok: true, payload } : { ok: false, reason: "invalid-payload" };
      },
      onParseFailure: ({ message }) => recordJsonParseFailure("peg-analytics:peg-analytics", message),
    },
  );
  if (!decoded.ok) {
    return { kind: "miss", reason: decoded.reason };
  }
  if (
    requireCurrentUtcDay
    && bucketUnixSecondsToUtcDay(decoded.payload.computedAtSec) !== bucketUnixSecondsToUtcDay(nowSec)
  ) {
    // depegEventsToday/Yesterday were bucketed against the publish-time UTC
    // day; republishing them after midnight would describe the wrong day.
    return { kind: "miss", reason: "stale-day" };
  }

  return {
    kind: "ok",
    payload: decoded.payload,
    pegDataById: new Map(decoded.payload.pegData.map((entry) => [entry.id, entry])),
    updatedAt: decoded.updatedAt ?? row.updatedAt,
  };
}
