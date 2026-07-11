import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import { isRecord } from "@shared/lib/type-guards";
import type { StablecoinPublicationHealth } from "@shared/types/status";
import { tryParseJson } from "./json-parse";

export function unknownStablecoinPublicationHealth(
  observedAt: number | null = null,
): StablecoinPublicationHealth {
  return {
    status: "unknown",
    expectedActiveCount: ACTIVE_IDS.size,
    presentActiveCount: 0,
    waivedActiveCount: 0,
    missingActiveIds: [],
    waivedActiveIds: [],
    expiredWaiverIds: [],
    observedAt,
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function parseStablecoinPublicationHealth(
  metadataJson: string,
  observedAt: number,
): StablecoinPublicationHealth {
  const metadata = tryParseJson(metadataJson);
  const coverage = isRecord(metadata) && isRecord(metadata.activePublicationCoverage)
    ? metadata.activePublicationCoverage
    : null;
  if (!coverage) return unknownStablecoinPublicationHealth(observedAt);
  const expectedActiveCount = typeof coverage.expectedActiveCount === "number"
    ? coverage.expectedActiveCount
    : 0;
  const presentActiveCount = typeof coverage.presentActiveCount === "number"
    ? coverage.presentActiveCount
    : 0;
  const waivedActiveCount = typeof coverage.waivedActiveCount === "number"
    ? coverage.waivedActiveCount
    : 0;
  const missingActiveIds = stringArray(coverage.missingActiveIds);
  const complete = coverage.complete === true
    && expectedActiveCount === ACTIVE_IDS.size
    && missingActiveIds.length === 0;
  return {
    status: complete ? "complete" : "incomplete",
    expectedActiveCount,
    presentActiveCount,
    waivedActiveCount,
    missingActiveIds,
    waivedActiveIds: stringArray(coverage.waivedActiveIds),
    expiredWaiverIds: stringArray(coverage.expiredWaiverIds),
    observedAt,
  };
}

export async function loadStablecoinPublicationHealth(
  db: D1Database,
): Promise<StablecoinPublicationHealth> {
  const row = await db
    .prepare(
      `SELECT started_at, metadata
         FROM cron_runs
        WHERE job = 'sync-stablecoins' AND metadata IS NOT NULL
        ORDER BY started_at DESC, id DESC
        LIMIT 1`,
    )
    .first<{ started_at: number; metadata: string }>();
  return row?.metadata
    ? parseStablecoinPublicationHealth(row.metadata, row.started_at)
    : unknownStablecoinPublicationHealth();
}
