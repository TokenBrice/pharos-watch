import { matchesGlob } from "node:path";
import { selectGeneratedArtifacts } from "./automation-registry.mjs";
import { collectGitPaths } from "./changed-files.mts";

/** Detect bootstrap/cache repairs against the checkout's committed source state. */
export function assertBootstrapTrackedOutputsUnchanged(cwd = process.cwd()): void {
  const outputs: string[] = selectGeneratedArtifacts({ bootstrap: true, check: true })
    .flatMap((artifact: { outputPaths: string[] }) => artifact.outputPaths);
  const changed = collectGitPaths(
    { kind: "working", includeUntracked: true, noRenames: true },
    { cwd },
  );
  const repaired = changed.filter((path) => outputs.some((output) =>
    path === output || path.startsWith(`${output}/`) || matchesGlob(path, output),
  ));
  if (repaired.length > 0) {
    throw new Error(
      `Bootstrap or cache restore changed committed generated artifacts: ${repaired.join(", ")}. ` +
      "Regenerate and commit these outputs with their sources before retrying CI.",
    );
  }
}
