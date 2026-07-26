import type { CronResult } from "../../lib/cron-logger";
import type { Env } from "../../lib/env";
import {
  enforceDexArchiveFoundationMode,
  enforceDexArchiveMeasuredShadowMode,
  resolveDexArchiveMode,
  type DexArchiveFamily,
} from "./config";
import {
  buildMeasuredArchiveObjectKey,
  listMeasuredArchiveCandidates,
  loadMeasuredArchiveArtifact,
  loadMeasuredArchiveBacklog,
} from "./measured";
import { archiveMeasuredObject } from "./r2";
import {
  recordDexArchiveCandidateError,
  recordDexArchiveFoundationRun,
  recordDexArchiveMeasuredRun,
} from "./store";

const MAX_OBJECTS_PER_INVOCATION = 12;
const MAX_WORK_MS = 6 * 60_000;
const STOP_NEW_OBJECT_WITH_MS_REMAINING = 60_000;

interface DexArchiveFoundationFamilyResult {
  family: DexArchiveFamily;
  configuredMode: string;
  effectiveMode: "off";
  configError: string | null;
  sourceRowsChanged: 0;
  r2ObjectsWritten: 0;
}

export async function runDexArchiveFoundation(
  db: D1Database,
  env: Pick<Env, "DEX_MEASURED_ARCHIVE_MODE" | "DEX_LIQUIDITY_ARCHIVE_MODE">,
  signal?: AbortSignal,
  now = Math.floor(Date.now() / 1000),
): Promise<CronResult> {
  const inputs: Array<[DexArchiveFamily, string | undefined]> = [
    ["measured-execution", env.DEX_MEASURED_ARCHIVE_MODE],
    ["liquidity", env.DEX_LIQUIDITY_ARCHIVE_MODE],
  ];
  const families: DexArchiveFoundationFamilyResult[] = [];
  for (const [family, rawMode] of inputs) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    const mode = enforceDexArchiveFoundationMode(resolveDexArchiveMode(rawMode));
    await recordDexArchiveFoundationRun(db, family, mode, now);
    families.push({
      family,
      configuredMode: mode.configuredMode,
      effectiveMode: "off",
      configError: mode.configError,
      sourceRowsChanged: 0,
      r2ObjectsWritten: 0,
    });
  }
  const configErrors = families.filter((family) => family.configError != null).length;
  return {
    status: configErrors > 0 ? "degraded" : "ok",
    itemCount: 0,
    metadata: JSON.stringify({
      releaseStage: "foundation",
      families,
      sourceRowsChanged: 0,
      r2ObjectsWritten: 0,
      configErrors,
      maxObjectsPerInvocation: MAX_OBJECTS_PER_INVOCATION,
      maxWorkMs: MAX_WORK_MS,
      stopNewObjectWithMsRemaining: STOP_NEW_OBJECT_WITH_MS_REMAINING,
    }),
    productivity: {
      productive: false,
      reason: "archive-foundation-mode-off",
    },
  };
}

export async function runDexArchive(
  db: D1Database,
  bucket: R2Bucket,
  env: Pick<Env, "DEX_MEASURED_ARCHIVE_MODE" | "DEX_LIQUIDITY_ARCHIVE_MODE">,
  signal?: AbortSignal,
  now = Math.floor(Date.now() / 1000),
): Promise<CronResult> {
  const measuredMode = enforceDexArchiveMeasuredShadowMode(
    resolveDexArchiveMode(env.DEX_MEASURED_ARCHIVE_MODE),
  );
  const liquidityMode = enforceDexArchiveFoundationMode(
    resolveDexArchiveMode(env.DEX_LIQUIDITY_ARCHIVE_MODE),
  );
  await recordDexArchiveFoundationRun(db, "liquidity", liquidityMode, now);

  if (measuredMode.effectiveMode === "off") {
    await recordDexArchiveFoundationRun(db, "measured-execution", measuredMode, now);
    const configErrors = Number(measuredMode.configError != null) + Number(liquidityMode.configError != null);
    return {
      status: configErrors > 0 ? "degraded" : "ok",
      itemCount: 0,
      metadata: JSON.stringify({
        releaseStage: "measured-shadow",
        families: [
          {
            family: "measured-execution",
            configuredMode: measuredMode.configuredMode,
            effectiveMode: measuredMode.effectiveMode,
            configError: measuredMode.configError,
            sourceRowsChanged: 0,
            r2ObjectsWritten: 0,
          },
          {
            family: "liquidity",
            configuredMode: liquidityMode.configuredMode,
            effectiveMode: liquidityMode.effectiveMode,
            configError: liquidityMode.configError,
            sourceRowsChanged: 0,
            r2ObjectsWritten: 0,
          },
        ],
        sourceRowsChanged: 0,
        r2ObjectsWritten: 0,
        verifiedObjects: 0,
        configErrors,
        maxObjectsPerInvocation: MAX_OBJECTS_PER_INVOCATION,
        maxWorkMs: MAX_WORK_MS,
        stopNewObjectWithMsRemaining: STOP_NEW_OBJECT_WITH_MS_REMAINING,
      }),
      productivity: {
        productive: false,
        reason: "archive-measured-shadow-mode-off",
      },
    };
  }

  const startedAtMs = Date.now();
  const stopAtMs = startedAtMs + MAX_WORK_MS;
  const backlogBefore = await loadMeasuredArchiveBacklog(db, now);
  const candidates = await listMeasuredArchiveCandidates(
    db,
    now,
    MAX_OBJECTS_PER_INVOCATION,
  );
  const errors: Array<{ generationId: string; error: string }> = [];
  let r2ObjectsWritten = 0;
  let verifiedObjects = 0;
  let storedBytes = 0;
  let uncompressedBytes = 0;
  let attemptedObjects = 0;
  let stoppedForTailBudget = false;

  for (const candidate of candidates) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    if (stopAtMs - Date.now() < STOP_NEW_OBJECT_WITH_MS_REMAINING) {
      stoppedForTailBudget = true;
      break;
    }
    attemptedObjects += 1;
    let loaded: Awaited<ReturnType<typeof loadMeasuredArchiveArtifact>> | null = null;
    try {
      loaded = await loadMeasuredArchiveArtifact(db, candidate, now, signal);
      const archived = await archiveMeasuredObject({ db, bucket, loaded, now });
      r2ObjectsWritten += Number(archived.created);
      verifiedObjects += 1;
      storedBytes += archived.storedBytes;
      uncompressedBytes += archived.uncompressedBytes;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!loaded) {
        await recordDexArchiveCandidateError({
          db,
          family: candidate.kind === "quote"
            ? "measured-quote-generation"
            : "measured-target-generation",
          generationId: candidate.generationId,
          sourceSlotStartedAt: candidate.sourceSlotStartedAt,
          objectKey: buildMeasuredArchiveObjectKey(
            candidate.kind,
            candidate.generationId,
            candidate.sourceSlotStartedAt,
          ),
          now,
          error: message,
        });
      }
      if (errors.length < 8) {
        errors.push({ generationId: candidate.generationId, error: message.slice(0, 300) });
      }
    }
  }

  const backlogAfter = await loadMeasuredArchiveBacklog(db, now);
  const runError = errors.length > 0 ? errors[0]!.error : measuredMode.configError;
  await recordDexArchiveMeasuredRun({
    db,
    mode: measuredMode,
    now,
    eligibleGenerationCount: backlogAfter.generationCount,
    eligibleRowCount: backlogAfter.sourceRowCount,
    eligibleLogicalBytes: backlogAfter.logicalBytes,
    oldestEligibleAt: backlogAfter.oldestEligibleAt,
    runError,
  });
  const configErrors = Number(measuredMode.configError != null) + Number(liquidityMode.configError != null);
  return {
    status: errors.length > 0 || configErrors > 0 ? "degraded" : "ok",
    itemCount: verifiedObjects,
    metadata: JSON.stringify({
      releaseStage: "measured-shadow",
      families: [
        {
          family: "measured-execution",
          configuredMode: measuredMode.configuredMode,
          effectiveMode: measuredMode.effectiveMode,
          configError: measuredMode.configError,
          sourceRowsChanged: 0,
          r2ObjectsWritten,
          verifiedObjects,
          attemptedObjects,
          eligibleBefore: backlogBefore.generationCount,
          eligibleAfter: backlogAfter.generationCount,
          eligibleRowsAfter: backlogAfter.sourceRowCount,
          eligibleLogicalBytesAfter: backlogAfter.logicalBytes,
          oldestEligibleAt: backlogAfter.oldestEligibleAt,
          stoppedForTailBudget,
        },
        {
          family: "liquidity",
          configuredMode: liquidityMode.configuredMode,
          effectiveMode: liquidityMode.effectiveMode,
          configError: liquidityMode.configError,
          sourceRowsChanged: 0,
          r2ObjectsWritten: 0,
        },
      ],
      sourceRowsChanged: 0,
      r2ObjectsWritten,
      verifiedObjects,
      storedBytes,
      uncompressedBytes,
      errors,
      configErrors,
      durationMs: Date.now() - startedAtMs,
      maxObjectsPerInvocation: MAX_OBJECTS_PER_INVOCATION,
      maxWorkMs: MAX_WORK_MS,
      stopNewObjectWithMsRemaining: STOP_NEW_OBJECT_WITH_MS_REMAINING,
    }),
    productivity: {
      productive: verifiedObjects > 0,
      reason: verifiedObjects > 0 ? "verified-measured-archive-objects" : "no-measured-archive-work",
    },
  };
}
