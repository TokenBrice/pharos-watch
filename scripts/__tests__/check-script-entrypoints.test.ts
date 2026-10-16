import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectScriptEntrypointErrors,
} from "../ci/check-script-entrypoints.ts";
import { createTempRepoTracker } from "./helpers/test-state";

const { makeRoot, cleanup } = createTempRepoTracker("pharos-script-entrypoints");
afterEach(cleanup);

function fixtureRoot(): string {
  const root = makeRoot();
  for (const directory of [
    "scripts/ci",
    "scripts/maintenance",
    "scripts/build-data",
    "docs",
    ".github/scripts",
    ".github/workflows",
    ".github/actions",
  ]) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  writeFileSync(join(root, "package.json"), "{}\n");
  return root;
}

describe("script entrypoint validation", () => {
  it("checks unreferenced .mts scripts and command targets inside .mts consumers", () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "scripts/maintenance/orphan.mts"), "export {};");
    writeFileSync(join(root, "scripts/ci/runner.mts"), 'const command = "node ' + 'scripts/maintenance/missing.mts";');
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { run: "node " + "scripts/ci/runner.mts" } }));
    expect(collectScriptEntrypointErrors({ root }).errors).toEqual([
      "scripts/ci/runner.mts:1: stale script entrypoint `scripts/maintenance/missing.mts`",
      "scripts/maintenance/orphan.mts: unreferenced script — wire it into package.json/CI or delete it",
    ]);
  });

  it("accepts .mts reference consumers, extensionless references and retained operator policy", () => {
    const root = fixtureRoot();
    mkdirSync(join(root, "scripts/lib"), { recursive: true });
    writeFileSync(join(root, "scripts/maintenance/operator.mts"), "export {};");
    writeFileSync(join(root, "scripts/ci/runner.mts"), 'const retained = "scripts/maintenance/operator";');
    writeFileSync(join(root, "scripts/lib/policy.mts"), 'const retained = ["scripts/ci/runner.mts"];');
    expect(collectScriptEntrypointErrors({ root }).errors).toEqual([]);
  });

});
