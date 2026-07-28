import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { syncGeneratedArtifacts } from "../lib/generated-artifacts";

export const V9_EVALUATION_BUILD_DIGEST_DOMAIN = "safety-score-v9.evaluation-build.v1";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUTPUT_PATH = "shared/data/safety-score-v9/evaluation-build-manifest-v1.ts";

/**
 * The pure, production-shaped evaluator and the narrow contracts it consumes.
 * Research harnesses, readiness/coverage gates, public response projection,
 * and operational publication code do not change score construction.
 */
export const V9_SCORE_EVALUATOR_SOURCE_PATHS = [
  "shared/data/safety-score-v9/methodology-policy-candidate-v1.json",
  "shared/lib/dependency-graph.ts",
  "shared/lib/sha256.ts",
  "shared/lib/stable-json.ts",
  "shared/lib/safety-score-v9/access-posture.ts",
  "shared/lib/safety-score-v9/aggregation.ts",
  "shared/lib/safety-score-v9/archetypes/algorithmic.ts",
  "shared/lib/safety-score-v9/archetypes/cdp.ts",
  "shared/lib/safety-score-v9/archetypes/fiat-cash.ts",
  "shared/lib/safety-score-v9/archetypes/index.ts",
  "shared/lib/safety-score-v9/archetypes/rwa-credit-fund.ts",
  "shared/lib/safety-score-v9/archetypes/synthetic-delta-neutral.ts",
  "shared/lib/safety-score-v9/archetypes/tbill.ts",
  "shared/lib/safety-score-v9/backing.ts",
  "shared/lib/safety-score-v9/compile.ts",
  "shared/lib/safety-score-v9/control.ts",
  "shared/lib/safety-score-v9/dependencies.ts",
  "shared/lib/safety-score-v9/evaluate-set.ts",
  "shared/lib/safety-score-v9/evidence.ts",
  "shared/lib/safety-score-v9/exit.ts",
  "shared/lib/safety-score-v9/facts.ts",
  "shared/lib/safety-score-v9/formula.ts",
  "shared/lib/safety-score-v9/mechanism-profiles.ts",
  "shared/lib/safety-score-v9/operational-resilience.ts",
  "shared/lib/safety-score-v9/policy.ts",
  "shared/lib/safety-score-v9/primitives.ts",
  "shared/lib/safety-score-v9/reasons.ts",
  "shared/lib/safety-score-v9/scoped-risk.ts",
  "shared/lib/safety-score-v9/score.ts",
  "shared/lib/safety-score-v9/stress.ts",
  "shared/lib/safety-score-v9/trace.ts",
  "shared/lib/safety-score-v9/wrapper-risk.ts",
  "shared/types/safety-score-v9-backing.ts",
  "shared/types/safety-score-v9-fact-primitives.ts",
  "shared/types/safety-score-v9-facts.ts",
  "shared/types/safety-score-v9-operational-resilience.ts",
  "shared/types/safety-score-v9-wrapper.ts",
  "shared/types/safety-score-v9.ts",
] as const;

/**
 * Exact-input normalization, V2 fact compilation, and stable methodology or
 * capability declarations that can change the facts presented to the pure
 * evaluator. Point-in-time registry/source data remains in the fact digest.
 *
 * IMPORT CLOSURE (VER-010): every score-bearing module imported by a listed
 * producer must itself be listed — an omitted import can change fact output
 * without changing the build identity. When adding an import to any listed
 * file, add its score-bearing transitive sources here too.
 */
export const V9_FACT_PRODUCER_SOURCE_PATHS = [
  "shared/data/safety-score-v9/mechanism-review-overlays-v1.json",
  "shared/data/safety-score-v9/operational-resilience-overlays-v1.json",
  "shared/lib/classification/resolve-mechanism-archetype.ts",
  "shared/lib/cron-jobs.ts",
  "shared/lib/dependency-derivation.ts",
  "shared/lib/exit-route-identity.ts",
  "shared/lib/exit-route-output.ts",
  "shared/lib/liquidity-score-version.ts",
  "shared/lib/p4-exit-route-capacity.ts",
  "shared/lib/redemption-backstop-capacity.ts",
  "shared/lib/redemption-backstop-configs/collateral-redeem.ts",
  "shared/lib/redemption-backstop-configs/factory.ts",
  "shared/lib/redemption-backstop-configs/index.ts",
  "shared/lib/redemption-backstop-configs/manifest.ts",
  "shared/lib/redemption-backstop-configs/offchain-issuer/base-batches.ts",
  "shared/lib/redemption-backstop-configs/offchain-issuer/commodity.ts",
  "shared/lib/redemption-backstop-configs/offchain-issuer/coverage-and-stablecoin-audit.ts",
  "shared/lib/redemption-backstop-configs/offchain-issuer/index.ts",
  "shared/lib/redemption-backstop-configs/offchain-issuer/major-issuers.ts",
  "shared/lib/redemption-backstop-configs/offchain-issuer/non-usd-and-tokenized.ts",
  "shared/lib/redemption-backstop-configs/offchain-issuer/remediation-and-late-audit.ts",
  "shared/lib/redemption-backstop-configs/offchain-issuer/shared.ts",
  "shared/lib/redemption-backstop-configs/policies.ts",
  "shared/lib/redemption-backstop-configs/psm-and-basket.ts",
  "shared/lib/redemption-backstop-configs/queue-redeem.ts",
  "shared/lib/redemption-backstop-configs/review-dates.ts",
  "shared/lib/redemption-backstop-configs/schema.ts",
  "shared/lib/redemption-backstop-configs/shared.ts",
  "shared/lib/redemption-backstop-configs/stablecoin-redeem/configs.ts",
  "shared/lib/redemption-backstop-configs/stablecoin-redeem/shared.ts",
  "shared/lib/redemption-backstop-docs.ts",
  "shared/lib/redemption-backstop-providers.ts",
  "shared/lib/redemption-backstop-scoring.ts",
  "shared/lib/redemption-backstop-version.ts",
  "shared/lib/redemption-backstops.ts",
  "shared/lib/report-cards-base-input-identity.ts",
  "shared/lib/report-cards-fixed-input-identity.ts",
  "shared/lib/supply.ts",
  "shared/lib/type-guards.ts",
  "shared/types/core.ts",
  "shared/types/dependency-types.ts",
  "shared/types/exit-route.ts",
  "shared/types/market.ts",
  "shared/types/measured-execution.ts",
  "shared/types/redemption.ts",
  "shared/types/report-cards-base-input.ts",
  "shared/types/report-cards.ts",
  "shared/types/reserves.ts",
  "shared/types/stablecoin-taxonomy.ts",
  "shared/lib/chains/index.ts",
  "worker/src/lib/redemption-exit-route-observations.ts",
  "worker/src/lib/report-cards-fixed-input.ts",
  "worker/src/lib/safety-score-v9-extension.ts",
  "worker/src/lib/safety-score-v9-extension-mechanism.ts",
  "worker/src/lib/safety-score-v9-extension-operational-resilience.ts",
  "worker/src/lib/safety-score-v9-extension-reserves.ts",
  "worker/src/lib/safety-score-v9-extension-routes.ts",
  "worker/src/lib/safety-score-v9-extension-shock.ts",
  "worker/src/lib/safety-score-v9-extension-supply.ts",
  "worker/src/lib/safety-score-v9-extension-transfer.ts",
  "worker/src/lib/safety-score-v9-fact-set.ts",
  "worker/src/lib/safety-score-v9-fact-set-boundary.ts",
  "worker/src/lib/evm-rpc.ts",
  "worker/src/lib/evm-selectors.ts",
  "worker/src/lib/fetch-retry.ts",
  "worker/src/lib/safety-score-v9-centrifuge-supply-observer.ts",
  "worker/src/lib/safety-score-v9-supply-attribution.ts",
  "worker/src/lib/safety-score-v9-supply-attribution-contract.ts",
  "worker/src/lib/safety-score-v9-wm-supply-observer.ts",
  "worker/src/lib/safety-score-v9-xaut-supply-attribution-contract.ts",
  "worker/src/lib/safety-score-v9-xaut-supply-observer.ts",
] as const;

export const V9_EVALUATION_BUILD_SOURCE_PATHS = [
  ...V9_SCORE_EVALUATOR_SOURCE_PATHS,
  ...V9_FACT_PRODUCER_SOURCE_PATHS,
] as const;

export interface V9EvaluationBuildManifestFile {
  path: string;
  sha256: string;
}

export interface V9EvaluationBuildManifest {
  schemaVersion: 1;
  domain: typeof V9_EVALUATION_BUILD_DIGEST_DOMAIN;
  files: V9EvaluationBuildManifestFile[];
  digest: string;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function collectV9EvaluationBuildSourcePaths(root = REPO_ROOT): string[] {
  const sorted = [...V9_EVALUATION_BUILD_SOURCE_PATHS].sort();
  const missing = sorted.filter((path) => !existsSync(resolve(root, path)));
  if (missing.length > 0) {
    throw new Error(`Missing Safety Score v9 evaluation-build sources: ${missing.join(", ")}`);
  }
  return sorted;
}

export function buildV9EvaluationBuildManifest(root = REPO_ROOT): V9EvaluationBuildManifest {
  const files = collectV9EvaluationBuildSourcePaths(root).map((path) => ({
    path,
    sha256: sha256(readFileSync(resolve(root, path))),
  }));
  const payload: Omit<V9EvaluationBuildManifest, "digest"> = {
    schemaVersion: 1,
    domain: V9_EVALUATION_BUILD_DIGEST_DOMAIN,
    files,
  };
  return { ...payload, digest: sha256(JSON.stringify(payload)) };
}

export function renderV9EvaluationBuildManifest(manifest: V9EvaluationBuildManifest): string {
  return [
    "// Generated by scripts/maintenance/generate-safety-score-v9-evaluation-build-manifest.ts.",
    "// Do not edit manually.",
    `export const SAFETY_SCORE_V9_EVALUATION_BUILD_MANIFEST = ${JSON.stringify(manifest, null, 2)} as const;`,
    "",
    "export const SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST =",
    "  SAFETY_SCORE_V9_EVALUATION_BUILD_MANIFEST.digest;",
    "",
  ].join("\n");
}

export function runV9EvaluationBuildManifestGenerator(args = process.argv.slice(2), root = REPO_ROOT): void {
  const unknown = args.filter((arg) => arg !== "--check");
  if (unknown.length > 0) throw new Error(`Unknown arguments: ${unknown.join(", ")}`);
  const check = args.includes("--check");
  const manifest = buildV9EvaluationBuildManifest(root);
  syncGeneratedArtifacts({
    artifacts: [{ path: resolve(root, OUTPUT_PATH), contents: renderV9EvaluationBuildManifest(manifest) }],
    check,
    staleMessage:
      "Safety Score v9 evaluation-build manifest is stale. Run npm run generate:safety-score-v9-evaluation-build.",
    currentMessage: `Safety Score v9 evaluation-build manifest is current (${manifest.digest}).`,
    writtenMessage: `Generated Safety Score v9 evaluation-build manifest (${manifest.digest}).`,
  });
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  runV9EvaluationBuildManifestGenerator();
}
