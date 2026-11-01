import { getCache, setCache } from "./db-cache";
import { BLACKLIST_SUMMARY_SNAPSHOT_CACHE_KEY, BLACKLIST_SUMMARY_SNAPSHOT_CACHE_VERSION } from "./blacklist-cache-keys";
import { aggregateFlowCacheKey } from "./mint-burn-flow-cache-keys";
import { MINT_BURN_WATERMARK_MAX_AGE_SEC } from "./mint-burn-flows-service";

const DAY_SECONDS = 24 * 3600;
const BASELINE_MAX_AGE_SEC = 7 * DAY_SECONDS;
/** A 20% roster drop is far beyond a normal rotation or a single quarantine. */
export const MINT_BURN_ROSTER_REGRESSION_RATIO = 0.8;
/** Event history only grows; a 10% drop means rows disappeared. */
export const BLACKLIST_EVENT_REGRESSION_RATIO = 0.9;
export const MINT_BURN_PUBLICATION_BASELINE_KEY = "canary:mint-burn-publication-baseline:v1";
export const BLACKLIST_ROSTER_BASELINE_KEY = "canary:blacklist-roster-baseline:v1";

type CanaryResult = {
  status: "ok" | "degraded" | "error";
  severity: "info" | "warning" | "error";
  executionStatus: "completed" | "failed";
  executionFailureReason: string | null;
  error?: string;
  metadata?: Record<string, unknown>;
};

function okResult(metadata: Record<string, unknown>): CanaryResult {
  return { status: "ok", severity: "info", executionStatus: "completed", executionFailureReason: null, metadata };
}

function degradedResult(error: string, metadata: Record<string, unknown>): CanaryResult {
  return { status: "degraded", severity: "warning", executionStatus: "completed", executionFailureReason: null, error, metadata };
}

function errorResult(error: string, metadata: Record<string, unknown>): CanaryResult {
  return { status: "error", severity: "error", executionStatus: "completed", executionFailureReason: null, error, metadata };
}

function failedResult(reason: string, metadata?: Record<string, unknown>): CanaryResult {
  return {
    status: "error",
    severity: "error",
    executionStatus: "failed",
    executionFailureReason: reason,
    error: reason,
    ...(metadata ? { metadata } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asNonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

interface RosterBaseline {
  count: number;
  observedAt: number;
}

async function readBaseline(
  db: D1Database,
  key: string,
  countField: "admittedCount" | "totalEvents",
  observedAt: number,
): Promise<{ baseline: RosterBaseline | null; readFailed: boolean }> {
  try {
    const cached = await getCache(db, key);
    if (!cached) return { baseline: null, readFailed: false };
    const parsed = asRecord(parseJson(cached.value));
    const count = asNonNegativeInt(parsed?.[countField]);
    const storedAt = asNonNegativeInt(parsed?.observedAt);
    if (count == null || storedAt == null || storedAt > observedAt
      || observedAt - storedAt > BASELINE_MAX_AGE_SEC) {
      return { baseline: null, readFailed: false };
    }
    return { baseline: { count, observedAt: storedAt }, readFailed: false };
  } catch {
    return { baseline: null, readFailed: true };
  }
}

async function writeBaseline(
  db: D1Database,
  key: string,
  countField: "admittedCount" | "totalEvents",
  count: number,
  observedAt: number,
): Promise<boolean> {
  try {
    await setCache(db, key, JSON.stringify({ [countField]: count, observedAt }));
    return true;
  } catch {
    return false;
  }
}

/**
 * The published aggregate must carry the admission scope it claims: no empty
 * roster, no count mismatch, no null gauge, and no stale common watermark. A
 * quiet range remains valid; only missing or contradictory publication evidence
 * fails.
 */
export async function checkMintBurnPublicationCoverage(
  db: D1Database,
  observedAt: number,
) {
  try {
    const cacheKey = aggregateFlowCacheKey(24);
    const cached = await getCache(db, cacheKey);
    if (!cached) return degradedResult("mint-burn-publication-cache-missing", { cacheKey });

    const body = asRecord(parseJson(cached.value));
    if (!body) return failedResult("mint-burn-publication-payload-unusable", { cacheKey });
    const publication = asRecord(body.publication);
    const gauge = asRecord(body.gauge);
    const coins = Array.isArray(body.coins) ? body.coins : null;
    if (!publication || !gauge || !coins) {
      return failedResult("mint-burn-publication-payload-unusable", {
        cacheKey,
        hasPublication: publication != null,
        hasGauge: gauge != null,
      });
    }

    const legCount = asNonNegativeInt(publication.legCount);
    const admittedCount = asNonNegativeInt(publication.admittedCount);
    const pendingAdmissionCount = asNonNegativeInt(publication.pendingAdmissionCount);
    const disabledCount = asNonNegativeInt(publication.disabledCount);
    const admittedPairs = Array.isArray(publication.admittedPairs) ? publication.admittedPairs : null;
    const window = asRecord(body.window);
    if (legCount == null || admittedCount == null || pendingAdmissionCount == null
      || disabledCount == null || admittedPairs == null) {
      return degradedResult("mint-burn-publication-contract-unusable", {
        cacheKey,
        legCount,
        admittedCount,
        pendingAdmissionCount,
        disabledCount,
        admittedPairs: admittedPairs != null,
      });
    }

    const metadata: Record<string, unknown> = {
      cacheKey,
      legCount,
      admittedCount,
      pendingAdmissionCount,
      disabledCount,
      coinCount: coins.length,
      watermark: window?.watermark ?? null,
      quarantinedConfigs: [] as string[],
      watermarkMaxAgeSec: MINT_BURN_WATERMARK_MAX_AGE_SEC,
    };
    const errors: string[] = [];
    const warnings: string[] = [];

    if (admittedCount + pendingAdmissionCount + disabledCount !== legCount) {
      errors.push(
        `admission counts ${admittedCount}+${pendingAdmissionCount}+${disabledCount} do not equal legCount ${legCount}`,
      );
    }
    if (admittedCount === 0 && legCount > 0) {
      errors.push("published aggregate has no admitted mint/burn legs");
    }

    const admittedCoinIds = new Set<string>();
    let admittedPairShapeInvalid = false;
    for (const pair of admittedPairs) {
      if (!Array.isArray(pair) || typeof pair[0] !== "string" || typeof pair[1] !== "string") {
        admittedPairShapeInvalid = true;
        break;
      }
      admittedCoinIds.add(pair[0]);
    }
    if (admittedPairShapeInvalid) {
      errors.push("published admittedPairs contains an invalid tuple");
    } else {
      const coinIds = new Set(coins.flatMap((coin) => {
        const id = asRecord(coin)?.stablecoinId;
        return typeof id === "string" ? [id] : [];
      }));
      if (coinIds.size !== admittedCoinIds.size) {
        errors.push(
          `published coins ${coinIds.size} do not match admitted coin scope ${admittedCoinIds.size}`,
        );
      }
      metadata.admittedCoinCount = admittedCoinIds.size;
    }

    if (gauge.score == null && admittedCount > 0) {
      warnings.push("published gauge score is unavailable for admitted coins");
    }

    const watermark = asRecord(window?.watermark);
    const watermarkAgeSec = asFiniteNumber(watermark?.ageSec);
    const watermarkTimestamp = asFiniteNumber(watermark?.timestamp);
    const effectiveWatermarkAgeSec = watermarkAgeSec == null
      ? watermarkTimestamp == null ? null : Math.max(0, observedAt - watermarkTimestamp)
      : Math.max(watermarkAgeSec, watermarkTimestamp == null ? 0 : observedAt - watermarkTimestamp);
    metadata.watermarkAgeSec = effectiveWatermarkAgeSec;
    if (!watermark || effectiveWatermarkAgeSec == null) {
      warnings.push("published watermark is unavailable");
    } else if (effectiveWatermarkAgeSec > MINT_BURN_WATERMARK_MAX_AGE_SEC) {
      errors.push(`published watermark is ${effectiveWatermarkAgeSec}s old`);
    } else if (typeof watermark.unavailableReason === "string") {
      errors.push(`published watermark reports ${watermark.unavailableReason}`);
    }

    const legs = Array.isArray(publication.legs) ? publication.legs : [];
    const quarantinedConfigs: string[] = [];
    for (const leg of legs) {
      const record = asRecord(leg);
      if (record?.status !== "pending-admission") continue;
      if (record.reason !== "frontier-stale" && record.reason !== "reactivation-pending") continue;
      if (typeof record.configKey === "string") quarantinedConfigs.push(record.configKey);
    }
    if (quarantinedConfigs.length > 0) {
      metadata.quarantinedConfigs = quarantinedConfigs.slice(0, 8);
      warnings.push(`${quarantinedConfigs.length} admitted leg(s) quarantined from the watermark`);
    }

    const baselineResult = await readBaseline(db, MINT_BURN_PUBLICATION_BASELINE_KEY, "admittedCount", observedAt);
    if (baselineResult.readFailed) {
      return failedResult("mint-burn-publication-baseline-unavailable", metadata);
    }
    const baseline = baselineResult.baseline;
    if (baseline && disabledCount === 0
      && admittedCount < Math.floor(baseline.count * MINT_BURN_ROSTER_REGRESSION_RATIO)) {
      errors.push(
        `admitted roster fell from ${baseline.count} to ${admittedCount} (baseline ${Math.floor((observedAt - baseline.observedAt) / 3600)}h old)`,
      );
    }
    const nextHighWater = Math.max(baseline?.count ?? 0, admittedCount);
    if (!await writeBaseline(db, MINT_BURN_PUBLICATION_BASELINE_KEY, "admittedCount", nextHighWater, observedAt)) {
      return failedResult("mint-burn-publication-baseline-persist-failed", metadata);
    }

    if (errors.length > 0) return errorResult(errors.join("; "), metadata);
    if (warnings.length > 0) return degradedResult(warnings.join("; "), metadata);
    return okResult(metadata);
  } catch {
    return failedResult("mint-burn-publication-canary-unavailable");
  }
}

/**
 * The published blacklist summary must retain an immutable event population and
 * a nonempty current-balance ledger. Event history is append-only, so a
 * persisted high-water baseline turns silent row loss into a stable finding.
 */
export async function checkBlacklistRosterCoverage(
  db: D1Database,
  observedAt: number,
) {
  try {
    const cached = await getCache(db, BLACKLIST_SUMMARY_SNAPSHOT_CACHE_KEY);
    if (!cached) return failedResult("blacklist-summary-snapshot-unavailable");

    const snapshot = asRecord(parseJson(cached.value));
    if (snapshot?.version !== BLACKLIST_SUMMARY_SNAPSHOT_CACHE_VERSION) {
      return failedResult("blacklist-summary-snapshot-unusable", {
        version: snapshot?.version ?? null,
        expectedVersion: BLACKLIST_SUMMARY_SNAPSHOT_CACHE_VERSION,
      });
    }
    const payload = asRecord(snapshot.payload);
    const freezeLedger = asRecord(payload?.freezeLedgerMeta);
    const coverage = asRecord(payload?.coverage);
    const coverageCounts = asRecord(coverage?.counts);
    const totalEvents = asNonNegativeInt(payload?.totalEvents);
    const balanceRows = asNonNegativeInt(freezeLedger?.totalRows);
    const supportedConfigs = asNonNegativeInt(coverageCounts?.supportedConfigs);
    if (!payload || totalEvents == null || balanceRows == null || supportedConfigs == null) {
      return failedResult("blacklist-summary-contract-unusable");
    }

    const refresh = asRecord(payload.refresh);
    const behindConfigs = Array.isArray(refresh?.behindConfigs) ? refresh.behindConfigs.length : null;
    const metadata: Record<string, unknown> = {
      totalEvents,
      balanceRows,
      supportedConfigs,
      behindConfigs,
    };
    const problems: string[] = [];
    if (totalEvents === 0) problems.push("published blacklist event population is empty");
    if (balanceRows === 0) problems.push("published freeze ledger has no current-balance rows");
    if (supportedConfigs === 0) problems.push("blacklist coverage roster is empty");

    const baselineResult = await readBaseline(db, BLACKLIST_ROSTER_BASELINE_KEY, "totalEvents", observedAt);
    if (baselineResult.readFailed) {
      return failedResult("blacklist-roster-baseline-unavailable", metadata);
    }
    const baseline = baselineResult.baseline;
    if (baseline && totalEvents < Math.floor(baseline.count * BLACKLIST_EVENT_REGRESSION_RATIO)) {
      problems.push(
        `blacklist event population fell from ${baseline.count} to ${totalEvents} (baseline ${Math.floor((observedAt - baseline.observedAt) / 3600)}h old)`,
      );
    }
    const nextHighWater = Math.max(baseline?.count ?? 0, totalEvents);
    if (!await writeBaseline(db, BLACKLIST_ROSTER_BASELINE_KEY, "totalEvents", nextHighWater, observedAt)) {
      return failedResult("blacklist-roster-baseline-persist-failed", metadata);
    }

    return problems.length > 0
      ? errorResult(problems.join("; "), metadata)
      : okResult(metadata);
  } catch {
    return failedResult("blacklist-roster-canary-unavailable");
  }
}
