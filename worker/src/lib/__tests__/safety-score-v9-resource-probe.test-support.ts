import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { computeSafetyScoreV9 } from "../../cron/compute-safety-score-v9";
import { offlineTransferMaterialityDependencies } from "./safety-score-v9-resource-offline.test-support";

// No fixture/migration imports: this graph is the measured application closure.
const output = process.env.PHAROS_RESOURCE_OUTPUT!;
function emit(value: unknown) { appendFileSync(output, `${JSON.stringify(value)}\n`); }
const observer = (globalThis as typeof globalThis & { __pharosResourcePhase?: (phase: string) => void }).__pharosResourcePhase;
observer?.("module-initialized");
const sqlite = new DatabaseSync(process.env.PHAROS_RESOURCE_DATABASE!);
const db = createSqliteD1(sqlite);
let cycle = 0;
const archiveEvidence: Array<{ cycle: number; key: string; bytes: number; sha256: string }> = [];
const bucket = {
  async put(key: string, body: unknown) {
    if (typeof body !== "string") throw new Error("archive-body-not-string");
    archiveEvidence.push({ cycle, key, bytes: Buffer.byteLength(body), sha256: createHash("sha256").update(body).digest("hex") });
    return {};
  },
} as R2Bucket;

// SQL copies release fixture transports before entering the production frame.
function install(nextCycle: number) {
  sqlite.exec(`INSERT OR REPLACE INTO cache (key, value, updated_at)
    SELECT key, value, updated_at FROM resource_fixture_cache WHERE cycle = ${nextCycle};`);
  for (const row of sqlite.prepare("SELECT sql FROM resource_fixture_sql WHERE cycle = ? ORDER BY ordinal").all(nextCycle)) {
    sqlite.exec(String(row.sql));
  }
  const clock = Number((sqlite.prepare("SELECT clock FROM resource_fixture_clocks WHERE cycle = ?").get(nextCycle))!.clock);
  Date.now = () => clock * 1_000;
  (globalThis as typeof globalThis & { __pharosResourceCycle?: number }).__pharosResourceCycle = nextCycle;
  return clock;
}

emit({ type: "start", node: process.version, v8: process.versions.v8, execArgv: process.execArgv, nativeCoverageEnabled: Boolean(process.env.NODE_V8_COVERAGE) });
try {
  if (process.env.PHAROS_RESOURCE_PROFILE === "heavy-warm") {
    install(1);
    // Deliberately exercise the heavy module-loading boundary only in this profile.
    const { buildNativeSafetyScoreV9Capture } = await import("../safety-score-v9/capture");
    const { observeSafetyScoreV9TransferMaterialityGeneration } = await import("../safety-score-v9/transfer-materiality-observer");
    const { input } = await buildNativeSafetyScoreV9Capture(db);
    await observeSafetyScoreV9TransferMaterialityGeneration({
      activeAssetIds: input.activeAssetIds, baseInputGenerationId: input.baseInputGenerationId,
      registryFingerprint: input.registryFingerprint, scoringClockSec: input.clockSec,
      providerSupplyInput: input, chainRpcs: new Map(),
    }, offlineTransferMaterialityDependencies);
    observer?.("prep-complete");
  }
  for (cycle = 1; cycle <= 2; cycle += 1) {
    const clockSec = install(cycle);
    emit({ type: "cycle-start", cycle, clockSec });
    const result = await computeSafetyScoreV9(db, undefined, async (progress) => {
      emit({ type: "progress", cycle, stage: progress.stage });
    }, { captureArchiveBucket: bucket });
    const metadata = typeof result.metadata === "string" ? JSON.parse(result.metadata) : result.metadata;
    emit({ type: "cycle-result", cycle, clockSec, status: result.status, itemCount: result.itemCount, metadata });
    if (metadata?.publication?.status !== "published" || metadata?.publication?.outcome !== "clean") throw new Error("publication-held-or-partial");
    if (metadata?.captureArchive?.status !== "written") throw new Error(`archive-not-written:${JSON.stringify(metadata?.captureArchive)}`);
    observer?.("publication-settled");
  }
  emit({ type: "complete", archives: archiveEvidence });
} catch (error) {
  emit({ type: "failure", reason: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  sqlite.close();
}
