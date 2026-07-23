import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  V9_EVALUATION_BUILD_DIGEST_DOMAIN,
  V9_EVALUATION_BUILD_SOURCE_PATHS,
  V9_FACT_PRODUCER_SOURCE_PATHS,
  V9_SCORE_EVALUATOR_SOURCE_PATHS,
  buildV9EvaluationBuildManifest,
  collectV9EvaluationBuildSourcePaths,
  renderV9EvaluationBuildManifest,
} from "../maintenance/generate-safety-score-v9-evaluation-build-manifest";

function fixtureRoot(): string {
  const root = mkdtempSync(resolve(tmpdir(), "pharos-v9-build-manifest-"));
  for (const path of V9_EVALUATION_BUILD_SOURCE_PATHS) {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, path), `${path}\n`);
  }
  return root;
}

describe("Safety Score v9 evaluation-build manifest", () => {
  it("uses an explicit evaluator and fact-producer allowlist", () => {
    const root = fixtureRoot();
    const paths = collectV9EvaluationBuildSourcePaths(root);

    expect(V9_SCORE_EVALUATOR_SOURCE_PATHS).toContain("shared/lib/safety-score-v9/evaluate-set.ts");
    expect(V9_SCORE_EVALUATOR_SOURCE_PATHS).toContain("shared/lib/safety-score-v9/formula.ts");
    expect(V9_SCORE_EVALUATOR_SOURCE_PATHS).toContain("shared/lib/safety-score-v9/aggregation.ts");
    expect(V9_SCORE_EVALUATOR_SOURCE_PATHS).toContain("shared/lib/safety-score-v9/scoped-risk.ts");
    expect(V9_SCORE_EVALUATOR_SOURCE_PATHS).toContain("shared/lib/safety-score-v9/wrapper-risk.ts");
    expect(V9_SCORE_EVALUATOR_SOURCE_PATHS).toContain("shared/lib/safety-score-v9/mechanism-profiles.ts");
    expect(V9_SCORE_EVALUATOR_SOURCE_PATHS).toContain("shared/lib/safety-score-v9/operational-resilience.ts");
    expect(V9_FACT_PRODUCER_SOURCE_PATHS).toContain("worker/src/lib/safety-score-v9-fact-set.ts");
    expect(V9_FACT_PRODUCER_SOURCE_PATHS).toContain("shared/lib/p4-exit-route-capacity.ts");
    expect(V9_FACT_PRODUCER_SOURCE_PATHS).toContain("shared/lib/supply.ts");
    expect(V9_FACT_PRODUCER_SOURCE_PATHS).toContain("shared/lib/redemption-backstop-providers.ts");
    expect(V9_FACT_PRODUCER_SOURCE_PATHS).toContain("shared/lib/redemption-backstops.ts");
    expect(V9_FACT_PRODUCER_SOURCE_PATHS).toContain(
      "shared/lib/redemption-backstop-configs/offchain-issuer/major-issuers.ts",
    );
    expect(V9_FACT_PRODUCER_SOURCE_PATHS).toContain("shared/data/safety-score-v9/mechanism-review-overlays-v1.json");
    expect(V9_FACT_PRODUCER_SOURCE_PATHS).toContain(
      "shared/data/safety-score-v9/operational-resilience-overlays-v1.json",
    );
    expect(V9_FACT_PRODUCER_SOURCE_PATHS).toContain(
      "worker/src/lib/safety-score-v9-extension-operational-resilience.ts",
    );
    expect(V9_FACT_PRODUCER_SOURCE_PATHS).toContain("worker/src/lib/safety-score-v9-extension-transfer.ts");
    expect(V9_FACT_PRODUCER_SOURCE_PATHS).toContain("worker/src/lib/safety-score-v9-extension-shock.ts");
    expect(paths).toContain("shared/lib/safety-score-v9/score.ts");
    expect(paths).toContain("worker/src/lib/safety-score-v9-fact-set.ts");
    expect(paths).not.toContain("shared/lib/safety-score-v9/public.ts");
    expect(paths).not.toContain("shared/lib/safety-score-v9/coverage.ts");
    expect(paths).not.toContain("shared/lib/safety-score-v9/validation.ts");
    expect(paths).not.toContain("shared/lib/safety-score-v9/scenario-evaluator.ts");
    expect(paths).not.toContain("shared/lib/safety-score-v9-compiler.ts");
    expect(paths).not.toContain("shared/lib/safety-score-v9-research.ts");
    expect(paths).not.toContain("shared/data/safety-score-v9/exit-route-calibration-v1.json");
    // Reviewed transfer rows are point-in-time facts. The loader/schema is
    // build-bound above; row contents are bound by the V9 fact-set digest.
    expect(paths).not.toContain("shared/data/safety-score-v9/transfer-review-overlays-v1.json");
    expect(paths).not.toContain("shared/data/safety-score-v9/shock-coverage-measurements-v1.json");
    expect(paths).not.toContain("shared/data/safety-score-v9/shock-coverage-replay-attestations-v1.json");
    expect(paths).not.toContain("shared/data/safety-score-v9/matched-invariants-v1.ts");
    expect(paths).not.toContain("worker/src/lib/safety-score-v9-candidate.ts");
    expect(paths).not.toContain("worker/src/lib/safety-score-v9-release-window.ts");
    expect(paths).not.toContain("worker/src/lib/safety-score-v9-shadow.ts");
    expect(paths).not.toContain("worker/src/lib/safety-score-v9-store.ts");
    expect(paths).not.toContain("worker/src/lib/safety-score-model-publication.ts");
    expect(buildV9EvaluationBuildManifest(root)).toEqual(buildV9EvaluationBuildManifest(root));
  });

  it("does not discover newly added operational files by name", () => {
    const root = fixtureRoot();
    const operational = resolve(root, "worker/src/lib/safety-score-v9-new-publication-step.ts");
    mkdirSync(dirname(operational), { recursive: true });
    writeFileSync(operational, "operational\n");
    const before = buildV9EvaluationBuildManifest(root);
    writeFileSync(operational, "changed operational code\n");
    expect(buildV9EvaluationBuildManifest(root)).toEqual(before);
  });

  it("changes the digest when a score-bearing source changes", () => {
    const root = fixtureRoot();
    const before = buildV9EvaluationBuildManifest(root);
    writeFileSync(resolve(root, "shared/lib/safety-score-v9/score.ts"), "changed\n");
    const after = buildV9EvaluationBuildManifest(root);
    expect(after.domain).toBe(V9_EVALUATION_BUILD_DIGEST_DOMAIN);
    expect(after.digest).not.toBe(before.digest);
    expect(renderV9EvaluationBuildManifest(after)).toContain(after.digest);
  });

  it("changes the digest when a producer methodology source changes", () => {
    const root = fixtureRoot();
    const before = buildV9EvaluationBuildManifest(root);
    writeFileSync(resolve(root, "shared/lib/p4-exit-route-capacity.ts"), "changed capability matrix\n");
    expect(buildV9EvaluationBuildManifest(root).digest).not.toBe(before.digest);
  });

  it.each([
    "shared/lib/supply.ts",
    "shared/lib/redemption-backstop-providers.ts",
    "shared/lib/redemption-backstops.ts",
    "shared/lib/redemption-backstop-configs/offchain-issuer/major-issuers.ts",
  ])("changes the digest when omitted producer closure source %s changes", (path) => {
    const root = fixtureRoot();
    const before = buildV9EvaluationBuildManifest(root);
    writeFileSync(resolve(root, path), `changed ${path}\n`);
    expect(buildV9EvaluationBuildManifest(root).digest).not.toBe(before.digest);
  });

  it("changes the digest when a score-bearing mechanism overlay changes", () => {
    const root = fixtureRoot();
    const before = buildV9EvaluationBuildManifest(root);
    writeFileSync(resolve(root, "shared/data/safety-score-v9/mechanism-review-overlays-v1.json"), '{"changed":true}\n');
    expect(buildV9EvaluationBuildManifest(root).digest).not.toBe(before.digest);
  });

  it("changes the digest when a score-bearing operational-resilience overlay changes", () => {
    const root = fixtureRoot();
    const before = buildV9EvaluationBuildManifest(root);
    writeFileSync(
      resolve(root, "shared/data/safety-score-v9/operational-resilience-overlays-v1.json"),
      '{"changed":true}\n',
    );
    expect(buildV9EvaluationBuildManifest(root).digest).not.toBe(before.digest);
  });

  it("fails when an enumerated contract disappears", () => {
    const root = fixtureRoot();
    rmSync(resolve(root, "shared/types/safety-score-v9.ts"));
    expect(() => buildV9EvaluationBuildManifest(root)).toThrow(/Missing.*safety-score-v9\.ts/);
  });
});
