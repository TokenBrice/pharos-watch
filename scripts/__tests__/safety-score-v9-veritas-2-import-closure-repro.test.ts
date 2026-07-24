import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  V9_EVALUATION_BUILD_SOURCE_PATHS,
  V9_FACT_PRODUCER_SOURCE_PATHS,
  buildV9EvaluationBuildManifest,
} from "../maintenance/generate-safety-score-v9-evaluation-build-manifest";

const OMITTED_SCORE_BEARING_IMPORTS = [
  {
    path: "shared/lib/redemption-backstop-scoring.ts",
    importedBy: "worker/src/lib/redemption-exit-route-observations.ts",
    importSpecifier: "@shared/lib/redemption-backstop-scoring",
  },
  {
    path: "shared/lib/exit-route-identity.ts",
    importedBy: "shared/lib/p4-exit-route-capacity.ts",
    importSpecifier: "./exit-route-identity",
  },
  {
    path: "shared/lib/exit-route-output.ts",
    importedBy: "worker/src/lib/safety-score-v9-fact-set.ts",
    importSpecifier: "@shared/lib/exit-route-output",
  },
  {
    path: "worker/src/lib/safety-score-v9-supply-attribution.ts",
    importedBy: "worker/src/lib/safety-score-v9-fact-set.ts",
    importSpecifier: "./safety-score-v9-supply-attribution",
  },
  {
    path: "worker/src/lib/safety-score-v9-supply-attribution-contract.ts",
    importedBy: "worker/src/lib/safety-score-v9-supply-attribution.ts",
    importSpecifier: "./safety-score-v9-supply-attribution-contract",
  },
  {
    path: "worker/src/lib/safety-score-v9-wm-supply-observer.ts",
    importedBy: "worker/src/lib/safety-score-v9-supply-attribution.ts",
    importSpecifier: "./safety-score-v9-wm-supply-observer",
  },
  {
    path: "worker/src/lib/safety-score-v9-xaut-supply-attribution-contract.ts",
    importedBy: "worker/src/lib/safety-score-v9-supply-attribution.ts",
    importSpecifier:
      "./safety-score-v9-xaut-supply-attribution-contract",
  },
  {
    path: "worker/src/lib/safety-score-v9-xaut-supply-observer.ts",
    importedBy: "worker/src/lib/safety-score-v9-supply-attribution.ts",
    importSpecifier: "./safety-score-v9-xaut-supply-observer",
  },
  {
    path: "worker/src/lib/evm-rpc.ts",
    importedBy: "worker/src/lib/safety-score-v9-xaut-supply-observer.ts",
    importSpecifier: "./evm-rpc",
  },
  {
    path: "worker/src/lib/evm-selectors.ts",
    importedBy: "worker/src/lib/safety-score-v9-xaut-supply-observer.ts",
    importSpecifier: "./evm-selectors",
  },
  {
    path: "worker/src/lib/fetch-retry.ts",
    importedBy: "worker/src/lib/safety-score-v9-xaut-supply-observer.ts",
    importSpecifier: "./fetch-retry",
  },
] as const;

function fixtureRoot(): string {
  const root = mkdtempSync(resolve(tmpdir(), "pharos-v9-veritas-ii-build-manifest-"));
  for (const path of V9_EVALUATION_BUILD_SOURCE_PATHS) {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, path), `${path}\n`);
  }
  return root;
}

describe("Safety Score v9 evaluation-build import closure", () => {
  it.each(OMITTED_SCORE_BEARING_IMPORTS)("binds changes in $path into the evaluation-build digest", (omission) => {
    expect(V9_FACT_PRODUCER_SOURCE_PATHS).toContain(omission.importedBy);
    expect(readFileSync(resolve(omission.importedBy), "utf8")).toContain(omission.importSpecifier);

    const root = fixtureRoot();
    try {
      const omittedPath = resolve(root, omission.path);
      mkdirSync(dirname(omittedPath), { recursive: true });
      writeFileSync(omittedPath, "export const SCORE_BEARING_VALUE = 1;\n");
      const before = buildV9EvaluationBuildManifest(root);

      writeFileSync(omittedPath, "export const SCORE_BEARING_VALUE = 2;\n");
      const after = buildV9EvaluationBuildManifest(root);

      expect.soft(after.files.map((file) => file.path)).toContain(omission.path);
      expect(after.digest).not.toBe(before.digest);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
