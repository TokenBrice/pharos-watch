import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectScriptEntrypointErrors,
  collectScriptEntrypoints,
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
  it("forward-scans workflow commands across YAML line breaks", () => {
    const command = "node";
    const helper = ".github/scripts/deploy.mjs";
    const workflow = ["run: |-", `  ${command} \\`, `    ${helper} --flag`, ""].join("\n");

    expect(collectScriptEntrypoints(workflow, { allowLineBreaks: true })).toEqual([helper]);
  });

  it("reports a missing repo-owned GitHub script target", () => {
    const root = fixtureRoot();
    writeFileSync(
      join(root, ".github/workflows/deploy.yml"),
      "steps:\n  - run: " + "node " + ".github/scripts/missing-helper.mjs\n",
    );

    expect(collectScriptEntrypointErrors({ root }).errors).toContain(
      ".github/workflows/deploy.yml:2: stale script entrypoint `.github/scripts/missing-helper.mjs`",
    );
  });

  it("accepts referenced GitHub helpers and includes them in the reverse check", () => {
    const root = fixtureRoot();
    writeFileSync(join(root, ".github/scripts/deploy-helper.mjs"), "#!/usr/bin/env node\n");
    writeFileSync(
      join(root, ".github/workflows/deploy.yml"),
      "steps:\n  - run: " + "node " + ".github/scripts/deploy-helper.mjs\n",
    );

    expect(collectScriptEntrypointErrors({ root }).errors).toEqual([]);
  });

  it.each(["none", "docs", "self", "test"])("rejects an orphan with only a %s reference", (reference) => {
    const root = fixtureRoot();
    const helper = ".github/scripts/orphan.mjs";
    const command = `node ${helper}\n`;
    writeFileSync(join(root, helper), "#!/usr/bin/env node\n" + (reference === "self" ? `// ${command}` : ""));
    if (reference === "docs") writeFileSync(join(root, "docs/usage.md"), command);
    if (reference === "test") writeFileSync(join(root, ".github/scripts/orphan.test.mjs"), `// ${command}`);

    const errors = collectScriptEntrypointErrors({ root }).errors;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(helper);

    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { orphan: command.trim() } }));
    expect(collectScriptEntrypointErrors({ root }).errors).toEqual([]);
  });
});
