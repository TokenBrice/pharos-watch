import { execFileSync } from "node:child_process";
import { matchesGlob } from "node:path";
import { selectGeneratedArtifacts } from "./automation-registry.mjs";

/** Detect bootstrap/cache repairs against the checkout's committed source state. */
export function assertBootstrapTrackedOutputsUnchanged(cwd = process.cwd()): void {
  const outputs: string[] = selectGeneratedArtifacts({ bootstrap: true, check: true })
    .flatMap((artifact: { outputPaths: string[] }) => artifact.outputPaths);
  const changed = execFileSync("git", ["diff", "HEAD", "--name-only", "--no-renames", "-z"], {
    cwd,
    encoding: "utf8",
  }).split("\0").filter(Boolean);
  // A committed deletion can be recreated as an untracked output by setup.
  // Exclude ignored compile projections, but require every other output in Git.
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd,
    encoding: "utf8",
  }).split("\0").filter(Boolean);
  const repaired = [...new Set([...changed, ...untracked])].filter((path) => outputs.some((output) =>
    path === output || path.startsWith(`${output}/`) || matchesGlob(path, output),
  ));
  if (repaired.length > 0) {
    throw new Error(
      `Bootstrap or cache restore changed committed generated artifacts: ${repaired.join(", ")}. ` +
      "Regenerate and commit these outputs with their sources before retrying CI.",
    );
  }
}
