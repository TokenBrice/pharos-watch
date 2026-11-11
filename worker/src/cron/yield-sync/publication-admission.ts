import {
  YieldRankingsResponseSchema,
} from "@shared/types/yield";
import {
  getCache,
} from "../../lib/db-cache";
import {
  logWorkerEventArgs,
} from "../../lib/structured-log";
import {
  readCachedJson,
} from "../../lib/api-cache-read";
import {
  validatePayloadWithSchema,
} from "../../lib/api-schema";

export interface PreviousYieldPublicationRanking {
  id?: unknown;
  dataSource?: unknown;
  provenance?: unknown;
}

export type PreviousYieldPublicationSnapshotStatus =
  | "missing"
  | "malformed-json"
  | "malformed-payload"
  | "ok";

export interface PreviousYieldPublicationSnapshot {
  status: PreviousYieldPublicationSnapshotStatus;
  rankings: readonly PreviousYieldPublicationRanking[];
  malformed: boolean;
  /**
   * B7/B31: `methodology.version` of the cached payload. Publish-time rank
   * attribution needs it to tell a genuine move from a methodology re-base.
   * Null when the cache predates the envelope or cannot be read.
   */
  methodologyVersion?: string | null;
}

/** `methodology.version` off a cached payload, when it is a usable string. */
function readCachedMethodologyVersion(methodology: unknown): string | null {
  if (methodology == null || typeof methodology !== "object" || Array.isArray(methodology)) return null;
  if (!("version" in methodology)) return null;
  const version = methodology.version;
  return typeof version === "string" && version.length > 0 ? version : null;
}

export async function loadPreviousYieldPublicationSnapshot(
  db: D1Database,
): Promise<PreviousYieldPublicationSnapshot> {
  const previousCache = await getCache(db, "yield-rankings");
  const previousRankings = readCachedJson<{ rankings?: unknown; methodology?: unknown }>(
    "yield-sync",
    "yield-rankings",
    previousCache,
  );
  if (previousRankings.status === "missing") {
    return { status: "missing", rankings: [], malformed: false, methodologyVersion: null };
  }
  if (previousRankings.status === "malformed") {
    return { status: "malformed-json", rankings: [], malformed: true, methodologyVersion: null };
  }
  const data = previousRankings.data;
  if (data == null || typeof data !== "object" || Array.isArray(data) || !Array.isArray(data.rankings)) {
    return { status: "malformed-payload", rankings: [], malformed: true, methodologyVersion: null };
  }
  if (data.rankings.some((ranking) => ranking == null || typeof ranking !== "object" || Array.isArray(ranking))) {
    return { status: "malformed-payload", rankings: [], malformed: true, methodologyVersion: null };
  }
  return {
    status: "ok",
    rankings: data.rankings as PreviousYieldPublicationRanking[],
    malformed: false,
    methodologyVersion: readCachedMethodologyVersion(data.methodology),
  };
}

function countYieldRankings(
  rankings: readonly PreviousYieldPublicationRanking[],
  options?: { allowedIds?: Set<string> },
): { count: number; malformed: boolean } {
  const countedRankings = options?.allowedIds
    ? rankings.filter(
        (ranking) => typeof ranking.id === "string" && options.allowedIds?.has(ranking.id),
      )
    : rankings.filter((ranking) => typeof ranking.id === "string");
  return { count: countedRankings.length, malformed: false };
}

export function derivePreviousYieldRankingsCount(
  snapshot: PreviousYieldPublicationSnapshot,
  options?: { allowedIds?: Set<string>; allowMalformedRecovery?: boolean },
): { count: number; malformed: boolean } {
  if (snapshot.status === "missing") {
    return { count: 0, malformed: false };
  }
  if (snapshot.status === "malformed-json" || snapshot.status === "malformed-payload") {
    if (options?.allowedIds || options?.allowMalformedRecovery) {
      // Let the later schema and absolute-coverage publish guards decide whether
      // a valid replacement can recover a malformed public cache.
      return { count: 0, malformed: false };
    }
    return { count: 0, malformed: true };
  }
  return countYieldRankings(snapshot.rankings, options);
}

function hasDuplicateRankingIds(rankings: Array<{ id: string }>): boolean {
  const seen = new Set<string>();
  for (const ranking of rankings) {
    if (seen.has(ranking.id)) return true;
    seen.add(ranking.id);
  }
  return false;
}

export async function validateYieldRankingsPayloadForPublish(
  rankingsPayload: unknown,
  previousYieldPublicationSnapshot: PreviousYieldPublicationSnapshot,
): Promise<{ ok: boolean; validationFailures: number; reason?: string }> {
  const validation = validatePayloadWithSchema(
    YieldRankingsResponseSchema,
    rankingsPayload,
    "sync-yield-data:yield-rankings",
  );

  if (!validation.ok) {
    logWorkerEventArgs("handler", "warn", "[sync-yield-data] Skipped yield-rankings cache write due to schema validation failure");
    return { ok: false, validationFailures: 1, reason: "schema-validation-failed" };
  }

  const currentRankings = validation.data.rankings.length;
  if (hasDuplicateRankingIds(validation.data.rankings)) {
    logWorkerEventArgs("handler", "warn", "[sync-yield-data] Skipped yield-rankings cache write due to duplicate ranking IDs");
    return { ok: false, validationFailures: 1, reason: "duplicate-ranking-ids" };
  }

  const previousRankingsState = derivePreviousYieldRankingsCount(previousYieldPublicationSnapshot);
  if (previousRankingsState.malformed && currentRankings === 0) {
    logWorkerEventArgs("handler", "warn",
      "[sync-yield-data] Skipped yield-rankings cache write because malformed previous cache recovery payload is empty",
    );
    return {
      ok: false,
      validationFailures: 1,
      reason: "empty-rankings-payload",
    };
  }

  return { ok: true, validationFailures: 0 };
}
