import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { z } from "zod";

export const DEPENDENCY_SCENARIO_EVALUATOR_MANIFEST_PATH = "shared/data/safety-score-v9/evaluation-build-manifest-v1.ts";
// Admitted manifest domains share one digest rule over the committed payload
// (v2 changes only how JSON member hashes are computed); an unlisted domain is
// unknown, never guessed.
const KNOWN_MANIFEST_DOMAINS = new Set(["safety-score-v9.evaluation-build.v1", "safety-score-v9.evaluation-build.v2"]);
const MANIFEST_PREFIX = "export const SAFETY_SCORE_V9_EVALUATION_BUILD_MANIFEST = ";
const MANIFEST_SUFFIX = " as const;";
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const ManifestSchema = z.object({
  schemaVersion: z.literal(1),
  domain: z.string().min(1),
  files: z.array(z.object({ path: z.string().min(1), sha256: Sha256 }).strict()).min(1),
  captures: z.array(z.object({ sha256: Sha256, r2Key: z.string().min(1) }).strict()).optional(),
  digest: Sha256,
}).strict();

export interface DependencyScenarioEvaluatorSource {
  schemaVersion: 1;
  kind: "dependency-scenario-evaluator-source";
  trustedRefSha: string;
  commitSha: string;
  evaluationBuildDigest: string;
  manifestDomain: string;
  registry: { ref: string; captureFingerprint: string };
}

function git(cwd: string, args: readonly string[], input?: string) {
  const run = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...(input === undefined ? {} : { input }) });
  if (run.error) throw run.error;
  return run;
}
function gitOk(cwd: string, args: readonly string[], input?: string): string {
  const run = git(cwd, args, input);
  if (run.status !== 0) throw new Error(`dependency-scenario-source-git-failed: git ${args[0]}: ${run.stderr.trim()}`);
  return run.stdout;
}

/** Parse committed manifest text as data; candidate checkouts are never executed. */
export function parseCommittedEvaluationBuildManifest(text: string) {
  const start = text.indexOf(MANIFEST_PREFIX);
  const end = start < 0 ? -1 : text.indexOf(MANIFEST_SUFFIX, start);
  if (start < 0 || end < 0) throw new Error("dependency-scenario-source-manifest-malformed");
  let manifest: z.infer<typeof ManifestSchema>;
  try {
    manifest = ManifestSchema.parse(JSON.parse(text.slice(start + MANIFEST_PREFIX.length, end)));
  } catch (error) {
    throw Object.assign(new Error("dependency-scenario-source-manifest-malformed"), { cause: error });
  }
  if (!KNOWN_MANIFEST_DOMAINS.has(manifest.domain)) throw new Error(`dependency-scenario-source-manifest-unknown: ${manifest.domain}`);
  const { digest, ...payload } = manifest;
  const recomputed = createHash("sha256").update(JSON.stringify({
    schemaVersion: payload.schemaVersion, domain: payload.domain, files: payload.files,
    ...(payload.captures ? { captures: payload.captures } : {}),
  })).digest("hex");
  if (recomputed !== digest) throw new Error("dependency-scenario-source-manifest-malformed: digest does not match manifest content");
  return manifest;
}

/**
 * Freeze the trusted ref, then walk its full first-parent ancestry newest
 * first and select the newest commit whose committed manifest names the
 * accepted evaluation-build digest.
 */
export function resolveDependencyScenarioEvaluatorSource(options: {
  cwd: string;
  trustedRef: string;
  evaluationBuildDigest: string;
  captureRegistryFingerprint: string;
}): DependencyScenarioEvaluatorSource {
  const { cwd, trustedRef, evaluationBuildDigest } = options;
  Sha256.parse(evaluationBuildDigest);
  if (trustedRef.startsWith("-")) throw new Error("dependency-scenario-source-trusted-ref-invalid");
  if (gitOk(cwd, ["rev-parse", "--is-shallow-repository"]).trim() !== "false") throw new Error("dependency-scenario-source-ancestry-shallow");
  const trustedRefSha = gitOk(cwd, ["rev-parse", "--verify", "--end-of-options", `${trustedRef}^{commit}`]).trim();
  const commits = gitOk(cwd, ["rev-list", "--first-parent", trustedRefSha]).trim().split("\n");
  const blobs = gitOk(cwd, ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
    commits.map(sha => `${sha}:${DEPENDENCY_SCENARIO_EVALUATOR_MANIFEST_PATH}\n`).join("")).trim().split("\n");
  if (blobs.length !== commits.length) throw new Error("dependency-scenario-source-git-failed: cat-file batch length");
  const texts = new Map<string, string>();
  for (const [index, commitSha] of commits.entries()) {
    const [blob, type] = blobs[index]!.split(" ");
    if (type === "missing") continue;
    if (type !== "blob") throw new Error("dependency-scenario-source-manifest-malformed: not a file");
    let text = texts.get(blob!);
    if (text === undefined) texts.set(blob!, text = gitOk(cwd, ["cat-file", "blob", blob!]));
    if (!text.includes(evaluationBuildDigest)) continue;
    const manifest = parseCommittedEvaluationBuildManifest(text);
    if (manifest.digest !== evaluationBuildDigest) continue;
    return {
      schemaVersion: 1, kind: "dependency-scenario-evaluator-source", trustedRefSha, commitSha,
      evaluationBuildDigest, manifestDomain: manifest.domain,
      registry: { ref: commitSha, captureFingerprint: options.captureRegistryFingerprint },
    };
  }
  throw new Error(`dependency-scenario-source-absent: no first-parent ancestor of ${trustedRefSha} commits evaluation build ${evaluationBuildDigest}`);
}
