import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

describe("generate-api-reference check mode", () => {
  it.each([
    { modified: true, exitCode: 1, message: "docs/api-reference.md is out of date" },
    { modified: false, exitCode: 0, message: "docs/api-reference.md is current" },
  ])("checks a generated API block without writing the document (modified: $modified)", ({ modified, exitCode, message }) => {
    // Keep both the filesystem mocks and exit status out of Vitest's shared
    // process. Use a path-specific read, not a next-call mock that a loader can consume.
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
      import fs from "node:fs";
      import { resolve } from "node:path";
      import { syncBuiltinESMExports } from "node:module";
      import * as generator from ${JSON.stringify(pathToFileURL(resolve("scripts/maintenance/generate-api-reference.ts")).href)};
      const docPath = resolve("docs/api-reference.md");
      const readFileSync = fs.readFileSync;
      const originalDocument = readFileSync(docPath, "utf8");
      const block = ${modified}
        ? generator.START_MARKER + "\\nmodified generated content\\n" + generator.END_MARKER
        : generator.renderGeneratedBlock(generator.loadOpenapi());
      const fixture = "hand-authored prefix\\n" + block + "\\nhand-authored suffix";
      let writes = 0;
      fs.readFileSync = (path, ...args) => path === docPath ? fixture : readFileSync(path, ...args);
      fs.writeFileSync = () => { writes++; };
      syncBuiltinESMExports();
      generator.main(true);
      console.log(JSON.stringify({ writes, unchanged: readFileSync(docPath, "utf8") === originalDocument }));
    `], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(exitCode);
    expect(`${result.stdout}${result.stderr}`).toContain(message);
    expect(result.stdout.trim().split("\n").pop()).toBe('{"writes":0,"unchanged":true}');
  });
});
