import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { DEPENDENCY_SCENARIO_EVALUATOR_MANIFEST_PATH, parseCommittedEvaluationBuildManifest, resolveDependencyScenarioEvaluatorSource } from "../lib/dependency-scenario-source";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })));
const FINGERPRINT = "f".repeat(64);

function manifestText(fileSha: string, domain = "safety-score-v9.evaluation-build.v1") {
  const payload = { schemaVersion: 1, domain, files: [{ path: "shared/lib/example.ts", sha256: fileSha }] };
  const manifest = { ...payload, digest: createHash("sha256").update(JSON.stringify(payload)).digest("hex") };
  return { digest: manifest.digest, text: `// Generated.\nexport const SAFETY_SCORE_V9_EVALUATION_BUILD_MANIFEST = ${JSON.stringify(manifest, null, 2)} as const;\n` };
}

function repo() {
  const cwd = mkdtempSync(resolve(tmpdir(), "pharos-scenario-source-"));
  directories.push(cwd);
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } }).trim();
  git("init", "-q", "-b", "main");
  const commit = (message: string, files: Record<string, string>) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(resolve(cwd, path)), { recursive: true });
      writeFileSync(resolve(cwd, path), content);
    }
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", message);
    return git("rev-parse", "HEAD");
  };
  return { cwd, git, commit };
}
const resolveIn = (cwd: string, evaluationBuildDigest: string, trustedRef = "main") =>
  resolveDependencyScenarioEvaluatorSource({ cwd, trustedRef, evaluationBuildDigest, captureRegistryFingerprint: FINGERPRINT });

describe("dependency scenario evaluator source resolver", () => {
  it("selects the newest first-parent commit carrying the accepted manifest while main is ahead", () => {
    const { cwd, commit } = repo();
    commit("before manifest", { "README.md": "x" });
    const accepted = manifestText("a".repeat(64));
    commit("accepted evaluator", { [DEPENDENCY_SCENARIO_EVALUATOR_MANIFEST_PATH]: accepted.text });
    const newestAccepted = commit("reader-only change", { "worker/reader.ts": "export {};" });
    const ahead = manifestText("b".repeat(64));
    const tip = commit("main ahead", { [DEPENDENCY_SCENARIO_EVALUATOR_MANIFEST_PATH]: ahead.text });
    expect(resolveIn(cwd, accepted.digest)).toEqual({
      schemaVersion: 1, kind: "dependency-scenario-evaluator-source", trustedRefSha: tip, commitSha: newestAccepted,
      evaluationBuildDigest: accepted.digest, manifestDomain: "safety-score-v9.evaluation-build.v1",
      registry: { ref: newestAccepted, captureFingerprint: FINGERPRINT },
    });
    expect(resolveIn(cwd, ahead.digest).commitSha).toBe(tip);
  });

  it("ignores manifests reachable only through a merged side parent", () => {
    const { cwd, git, commit } = repo();
    commit("root", { [DEPENDENCY_SCENARIO_EVALUATOR_MANIFEST_PATH]: manifestText("a".repeat(64)).text });
    git("checkout", "-q", "-b", "side");
    const side = manifestText("c".repeat(64));
    commit("side evaluator", { [DEPENDENCY_SCENARIO_EVALUATOR_MANIFEST_PATH]: side.text });
    commit("side revert", { [DEPENDENCY_SCENARIO_EVALUATOR_MANIFEST_PATH]: manifestText("a".repeat(64)).text });
    git("checkout", "-q", "main");
    commit("main work", { "README.md": "y" });
    git("merge", "-q", "--no-ff", "-m", "merge side", "side");
    expect(() => resolveIn(cwd, side.digest)).toThrow("dependency-scenario-source-absent");
  });

  it.each([
    ["absent", () => manifestText("0".repeat(64)).text, "dependency-scenario-source-absent"],
    ["malformed", (digest: string) => `export const SAFETY_SCORE_V9_EVALUATION_BUILD_MANIFEST = { "digest": "${digest}", } as const;`, "dependency-scenario-source-manifest-malformed"],
    ["unknown-domain", () => manifestText("d".repeat(64), "safety-score-v9.evaluation-build.v9").text, "dependency-scenario-source-manifest-unknown"],
  ] as const)("fails closed on an %s match", (label, text, reason) => {
    const { cwd, commit } = repo();
    const target = label === "unknown-domain" ? manifestText("d".repeat(64), "safety-score-v9.evaluation-build.v9").digest : "e".repeat(64);
    commit("candidate", { [DEPENDENCY_SCENARIO_EVALUATOR_MANIFEST_PATH]: text(target) });
    expect(() => resolveIn(cwd, target)).toThrow(reason);
  });

  it("rejects a manifest whose recorded digest does not cover its content", () => {
    const valid = manifestText("a".repeat(64));
    expect(() => parseCommittedEvaluationBuildManifest(valid.text.replace("a".repeat(64), "b".repeat(64))))
      .toThrow("digest does not match manifest content");
  });

  it("refuses a shallow ancestry instead of resolving against a truncated history", () => {
    const { cwd, commit } = repo();
    const accepted = manifestText("a".repeat(64));
    commit("accepted", { [DEPENDENCY_SCENARIO_EVALUATOR_MANIFEST_PATH]: accepted.text });
    commit("later", { "README.md": "z" });
    const clone = mkdtempSync(resolve(tmpdir(), "pharos-scenario-source-shallow-"));
    directories.push(clone);
    execFileSync("git", ["clone", "-q", "--depth", "1", `file://${cwd}`, clone]);
    expect(() => resolveIn(clone, accepted.digest, "HEAD")).toThrow("dependency-scenario-source-ancestry-shallow");
  });
});
