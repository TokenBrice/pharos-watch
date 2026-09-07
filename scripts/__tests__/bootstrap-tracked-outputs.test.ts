import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { assertBootstrapTrackedOutputsUnchanged } from "../lib/bootstrap-tracked-outputs.mts";
import { collectStagedFiles } from "../lib/changed-files.mts";
import { selectChangedGeneratedArtifactIds } from "../ci/select-generated-artifacts.mts";
import {
  V9_EVALUATION_BUILD_SOURCE_PATHS,
  buildV9EvaluationBuildManifest,
  renderV9EvaluationBuildManifest,
} from "../maintenance/generate-safety-score-v9-evaluation-build-manifest";

it("rejects bootstrap/cache repairs of a stale committed manifest, including staged repairs", () => {
  const cwd = mkdtempSync(join(tmpdir(), "bootstrap-tracked-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), text);
  };
  const output = "shared/data/safety-score-v9/evaluation-build-manifest-v1.ts";
  const generate = () => renderV9EvaluationBuildManifest(buildV9EvaluationBuildManifest(cwd));
  try {
    git("init");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "user.name", "Fixture");
    git("config", "core.hooksPath", "/dev/null");
    write(".gitignore", "src/generated/\n");
    for (const source of V9_EVALUATION_BUILD_SOURCE_PATHS) write(source, `${source}\n`);
    write(output, generate());
    git("add", ".");
    git("commit", "-qm", "Fresh outputs");
    expect(() => assertBootstrapTrackedOutputsUnchanged(cwd)).not.toThrow();

    write("shared/lib/math.ts", "changed scoring math\n");
    git("add", "shared/lib/math.ts");
    git("commit", "-qm", "Source-only change");
    const repaired = generate();
    write(output, repaired); // The bootstrap repairs this before --check runs.
    write("src/generated/stablecoin-detail-snapshots/fixture.json", "ignored output\n");
    expect(() => assertBootstrapTrackedOutputsUnchanged(cwd)).toThrow(output);
    git("checkout", "--", output);
    write(output, repaired); // A restore-only consumer receives those same cache bytes.
    expect(() => assertBootstrapTrackedOutputsUnchanged(cwd)).toThrow(output);
    git("add", output);
    expect(() => assertBootstrapTrackedOutputsUnchanged(cwd)).toThrow(output);
    git("commit", "-qm", "Commit regenerated output");
    expect(() => assertBootstrapTrackedOutputsUnchanged(cwd)).not.toThrow();

    const capture = "shared/data/safety-score-v9/mechanism-measurements/nested/fixture.summary.json";
    write(capture, "{}\n");
    git("add", capture);
    expect(selectChangedGeneratedArtifactIds(collectStagedFiles({ cwd }))).toContain("safety-score-v9-evaluation-build");
    git("commit", "-qm", "Capture selection fixture");
    for (const source of [capture, "shared/lib/math.ts"]) {
      git("rm", source);
      expect(collectStagedFiles({ cwd })).toContain(source);
      expect(selectChangedGeneratedArtifactIds(collectStagedFiles({ cwd }))).toContain("safety-score-v9-evaluation-build");
      git("commit", "-qm", "Deleted input selection");
    }
    rmSync(join(cwd, output));
    expect(() => assertBootstrapTrackedOutputsUnchanged(cwd)).toThrow(output);
    git("add", "-u", output);
    git("commit", "-qm", "Delete generated manifest");
    write(output, repaired); // Bootstrap recreates the now-untracked output.
    expect(git("diff", "HEAD", "--name-only")).toBe("");
    expect(() => assertBootstrapTrackedOutputsUnchanged(cwd)).toThrow(output);
    git("add", output);
    git("commit", "-qm", "Restore manifest enrollment");
    expect(() => assertBootstrapTrackedOutputsUnchanged(cwd)).not.toThrow();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
