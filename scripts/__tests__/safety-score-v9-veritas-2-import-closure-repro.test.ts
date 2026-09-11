import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  V9_EVALUATION_BUILD_SOURCE_PATHS,
  buildV9EvaluationBuildManifest,
} from "../maintenance/generate-safety-score-v9-evaluation-build-manifest";

const SCORE_BEARING_PATHS = [
  "shared/lib/redemption-backstop-scoring.ts",
  "shared/lib/exit-route-identity.ts",
  "shared/lib/exit-route-output.ts",
  "worker/src/lib/safety-score-v9/supply-attribution.ts",
  "worker/src/lib/safety-score-v9/supply-attribution-contract.ts",
  "worker/src/lib/safety-score-v9/wm-supply-observer.ts",
  "worker/src/lib/safety-score-v9/supply-observation-primitives.ts",
  "worker/src/lib/safety-score-v9/xaut-supply-attribution-contract.ts",
  "worker/src/lib/safety-score-v9/xaut-supply-observer.ts",
  "worker/src/lib/evm-rpc.ts",
  "worker/src/lib/evm-selectors.ts",
  "worker/src/lib/fetch-retry.ts",
];

describe("Safety Score v9 evaluation-build import closure", () => {
  let root: string;
  let baselineDigest: string;
  beforeAll(() => {
    root = mkdtempSync(resolve(tmpdir(), "pharos-v9-veritas-ii-build-manifest-"));
    for (const path of V9_EVALUATION_BUILD_SOURCE_PATHS) {
      mkdirSync(dirname(resolve(root, path)), { recursive: true });
      writeFileSync(resolve(root, path), `${path}\n`);
    }
    baselineDigest = buildV9EvaluationBuildManifest(root).digest;
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it.each(SCORE_BEARING_PATHS)("binds changes in %s into the evaluation-build digest", (path) => {
    const target = resolve(root, path);
    const original = readFileSync(target);
    try {
      writeFileSync(target, "export const SCORE_BEARING_VALUE = 2;\n");
      const after = buildV9EvaluationBuildManifest(root);
      expect(after.files.map((file) => file.path)).toContain(path);
      expect(after.digest).not.toBe(baselineDigest);
    } finally {
      writeFileSync(target, original);
    }
  });
});
