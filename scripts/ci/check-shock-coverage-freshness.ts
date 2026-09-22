/**
 * Fails when the CDP shock-coverage registry does not carry a fresh, complete,
 * replay-attested measurement for every automated target.
 *
 * The Shock Coverage Refresh workflow runs this independently on a daily
 * cadence and after regenerating the registry, so stale, partial, or non-scoring
 * refreshes fail loudly. The V9 engine rejects any measurement that misses one
 * of these conditions and falls back to legacy LCR.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectRun } from "../lib/smoke-runtime.mjs";
import { SHOCK_COVERAGE_TARGET_IDS } from "../lib/mechanism-measurement/shock-targets";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REGISTRY_PATH = "shared/data/safety-score-v9/shock-coverage-measurements-v1.json";
const POLICY_PATH = "shared/data/safety-score-v9/methodology-policy-candidate-v1.json";
const TARGETS_PATH = "shared/data/safety-score-v9/shock-coverage-targets.json";

// The refresh runs every 48h. Require the newest measurement to be comfortably
// inside the policy bound so a single failed run still leaves usable slack.
const MAX_AGE_FRACTION = 0.5;

interface ShockMeasurement {
  assetId: string;
  block: {
    number: number;
    timestampIso: string;
    timestampUnix: number;
  };
  applicability: string;
  failureReason?: string | null;
  complete: boolean;
  blockers: string[];
  exactReplayPassed: boolean;
  replayVerification: unknown;
}

interface ShockCoverageRegistry {
  measurements?: ShockMeasurement[];
}

interface ShockCoverageTargetCatalog {
  targets?: unknown;
}

interface ShockCoveragePolicy {
  semantic?: {
    backing?: {
      structural?: {
        cdp?: {
          stressMeasurementFreshness?: {
            maxAgeSec?: number;
          };
        };
      };
    };
  };
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(resolve(ROOT, relativePath), "utf8")) as T;
}

export function readRequiredAssetIds(
  catalog: ShockCoverageTargetCatalog,
  expectedAssetIds: readonly string[] = SHOCK_COVERAGE_TARGET_IDS,
): string[] {
  const targets = catalog.targets;
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error(`${TARGETS_PATH} must declare a non-empty targets array`);
  }
  const assetIds = targets.map((target) =>
    target && typeof target === "object" && "assetId" in target ? target.assetId : undefined,
  );
  if (
    assetIds.some(
      (assetId) =>
        typeof assetId !== "string" ||
        assetId.length === 0 ||
        assetId.trim() !== assetId ||
        !/^[a-z0-9][a-z0-9-]*$/.test(assetId),
    )
  ) {
    throw new Error(`${TARGETS_PATH} target assetIds must be non-empty slugs`);
  }
  const normalizedAssetIds = assetIds as string[];
  if (new Set(normalizedAssetIds).size !== normalizedAssetIds.length) {
    throw new Error(`${TARGETS_PATH} target assetIds must not contain duplicates`);
  }
  if (
    normalizedAssetIds.length !== expectedAssetIds.length ||
    normalizedAssetIds.some((assetId, index) => assetId !== expectedAssetIds[index])
  ) {
    throw new Error(`${TARGETS_PATH} target assetIds must match the derived shock target IDs`);
  }
  return normalizedAssetIds;
}

function readPolicyMaxAgeSec() {
  const policy = readJson<ShockCoveragePolicy>(POLICY_PATH);
  const maxAgeSec = policy?.semantic?.backing?.structural?.cdp?.stressMeasurementFreshness?.maxAgeSec;
  if (typeof maxAgeSec !== "number" || !Number.isFinite(maxAgeSec) || maxAgeSec <= 0) {
    throw new Error(`Could not read cdp.stressMeasurementFreshness.maxAgeSec from ${POLICY_PATH}`);
  }
  return maxAgeSec;
}

export function evaluateShockCoverageFreshness({
  registry,
  maxAgeSec,
  nowSec,
  requiredAssetIds,
}: {
  registry: ShockCoverageRegistry;
  maxAgeSec: number;
  nowSec: number;
  requiredAssetIds: readonly string[];
}) {
  const failures: string[] = [];
  const successes: string[] = [];

  for (const assetId of requiredAssetIds) {
    const measurements = (registry.measurements ?? []).filter((entry) => entry.assetId === assetId);
    if (measurements.length === 0) {
      failures.push(`${assetId}: no measurement in ${REGISTRY_PATH}`);
      continue;
    }

    const newest = measurements.reduce((left, right) =>
      right.block.timestampUnix > left.block.timestampUnix ? right : left,
    );
    const ageSec = nowSec - newest.block.timestampUnix;
    const context = `block ${newest.block.number} (${newest.block.timestampIso}, age ${Math.round(ageSec / 3600)}h)`;

    if (newest.applicability !== "measured") {
      failures.push(`${assetId}: newest measurement is ${newest.applicability} (${newest.failureReason ?? "no reason"})`);
      continue;
    }
    if (!newest.complete) {
      failures.push(`${assetId}: newest measurement incomplete [${newest.blockers.join(", ")}] at ${context}`);
      continue;
    }
    if (!newest.exactReplayPassed || newest.replayVerification === null) {
      failures.push(`${assetId}: newest measurement is not replay-attested at ${context}`);
      continue;
    }
    if (ageSec < 0) {
      failures.push(`${assetId}: newest measurement is future-dated at ${context}`);
      continue;
    }
    if (ageSec > maxAgeSec * MAX_AGE_FRACTION) {
      failures.push(
        `${assetId}: newest measurement is ${Math.round(ageSec / 3600)}h old, over the ` +
          `${Math.round((maxAgeSec * MAX_AGE_FRACTION) / 3600)}h refresh budget (policy bound ${Math.round(maxAgeSec / 3600)}h) at ${context}`,
      );
      continue;
    }

    successes.push(`[shock-coverage-freshness] ${assetId}: OK - ${context}`);
  }

  return { failures, successes };
}

function main() {
  const requiredAssetIds = readRequiredAssetIds(readJson<ShockCoverageTargetCatalog>(TARGETS_PATH));
  const result = evaluateShockCoverageFreshness({
    registry: readJson<ShockCoverageRegistry>(REGISTRY_PATH),
    maxAgeSec: readPolicyMaxAgeSec(),
    nowSec: Math.floor(Date.now() / 1000),
    requiredAssetIds,
  });
  for (const success of result.successes) console.log(success);

  if (result.failures.length > 0) {
    console.error(`[shock-coverage-freshness] FAILED\n  - ${result.failures.join("\n  - ")}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[shock-coverage-freshness] All ${requiredAssetIds.length} targets are fresh, complete and attested.`);
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  main();
}
