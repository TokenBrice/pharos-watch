import type { CronResult } from "../../lib/cron-logger";
import type { Env } from "../../lib/env";
import {
  enforceDexArchiveFoundationMode,
  resolveDexArchiveMode,
  type DexArchiveFamily,
} from "./config";
import { recordDexArchiveFoundationRun } from "./store";

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
      maxObjectsPerInvocation: 12,
      maxWorkMs: 6 * 60_000,
      stopNewObjectWithMsRemaining: 60_000,
    }),
    productivity: {
      productive: false,
      reason: "archive-foundation-mode-off",
    },
  };
}
