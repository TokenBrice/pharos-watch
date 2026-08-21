/**
 * Fails when the CDP shock-coverage registry does not carry a fresh, complete,
 * replay-attested measurement for every automated target.
 *
 * The Shock Coverage Refresh workflow runs this after regenerating the
 * registry so a partial or non-scoring refresh fails loudly instead of being
 * committed. The V9 engine rejects any measurement that misses one of these
 * conditions and falls back to legacy LCR.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REGISTRY_PATH = "shared/data/safety-score-v9/shock-coverage-measurements-v1.json";
const POLICY_PATH = "shared/data/safety-score-v9/methodology-policy-candidate-v1.json";
const REQUIRED_ASSET_IDS = ["bd-basedollar", "lusd-liquity", "bold-liquity"];

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

function readPolicyMaxAgeSec() {
  const policy = readJson<ShockCoveragePolicy>(POLICY_PATH);
  const maxAgeSec = policy?.semantic?.backing?.structural?.cdp?.stressMeasurementFreshness?.maxAgeSec;
  if (typeof maxAgeSec !== "number" || !Number.isFinite(maxAgeSec) || maxAgeSec <= 0) {
    throw new Error(`Could not read cdp.stressMeasurementFreshness.maxAgeSec from ${POLICY_PATH}`);
  }
  return maxAgeSec;
}

function main() {
  const registry = readJson<ShockCoverageRegistry>(REGISTRY_PATH);
  const maxAgeSec = readPolicyMaxAgeSec();
  const nowSec = Math.floor(Date.now() / 1000);
  const failures = [];

  for (const assetId of REQUIRED_ASSET_IDS) {
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

    console.log(`[shock-coverage-freshness] ${assetId}: OK - ${context}`);
  }

  if (failures.length > 0) {
    console.error(`[shock-coverage-freshness] FAILED\n  - ${failures.join("\n  - ")}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[shock-coverage-freshness] All ${REQUIRED_ASSET_IDS.length} targets are fresh, complete and attested.`);
}

main();
