import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  V9_EVALUATION_BUILD_SOURCE_PATHS,
  buildV9EvaluationBuildManifest,
} from "../maintenance/generate-safety-score-v9-evaluation-build-manifest";

const OMITTED_SCORE_BEARING_SOURCE = "worker/src/lib/safety-score-v9-extension-supply.ts";

function fixtureRoot(): string {
  const root = mkdtempSync(resolve(tmpdir(), "pharos-ver-010-"));
  for (const path of V9_EVALUATION_BUILD_SOURCE_PATHS) {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, path), `${path}\n`);
  }
  mkdirSync(dirname(resolve(root, OMITTED_SCORE_BEARING_SOURCE)), { recursive: true });
  writeFileSync(resolve(root, OMITTED_SCORE_BEARING_SOURCE), "return supplyUsd / totalUsd;\n");
  return root;
}

// VER-010: an imported fact producer can change without changing the build manifest.
describe.skip("VERITAS finding VER-010: evaluation build identity binds imported fact producers", () => {
  it("changes when the imported supply-share producer changes", () => {
    const root = fixtureRoot();
    try {
      const before = buildV9EvaluationBuildManifest(root);
      writeFileSync(resolve(root, OMITTED_SCORE_BEARING_SOURCE), "return 0;\n");
      const after = buildV9EvaluationBuildManifest(root);

      expect(after.digest).not.toBe(before.digest);
      expect(after.files).toContainEqual(expect.objectContaining({ path: OMITTED_SCORE_BEARING_SOURCE }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
