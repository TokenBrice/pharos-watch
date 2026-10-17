import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { withTempRepo } from "./helpers/test-state";

const script = resolve("scripts/ci/check-feature-flag-inlining.ts");
const loader = import.meta.resolve("tsx");
const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (name.startsWith("NEXT_PUBLIC_PHAROS_")) delete env[name];
}

describe("feature flag inlining", () => {
  it.each([
    ["direct literal flag", "export const enabled = process.env.NEXT_PUBLIC_PHAROS_TEST === 'true';", 0],
    ["comment", "// process.env[name]\nexport const enabled = true;", 0],
    ["strings and template text", "const text = 'process.env[name]'; const template = `process.env[name]`;", 0],
    ["regular expression", "const pattern = /process.env[name]/;", 0],
    ["dynamic access", "const enabled = process.env[name];", 1],
    ["whitespace and comments", "const enabled = process /* prose */ . env [name];", 1],
    ["template interpolation", "const enabled = `flag: ${process.env[name]}`;", 1],
    ["nested template interpolation", "const enabled = `outer ${`inner ${process.env[name]}`}`;", 1],
  ])("scans %s as syntax rather than literal text", (_label, source, status) => {
    withTempRepo("pharos-feature-flag", { "src/lib/feature-flags.ts": source }, (cwd) => {
      const result = spawnSync(process.execPath, ["--import", loader, script], { cwd, env, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(status);
      if (status === 1) expect(result.stderr).toContain("uses dynamic `process.env[...]` access");
      else expect(result.stdout).toContain("source-level OK");
    });
  });

  it.each([
    ["inlined", "const enabled = false;", 0],
    ["retained lookup", "const enabled = process.env.NEXT_PUBLIC_PHAROS_TEST;", 1],
  ])("preserves the bundle check for an empty-string env flag: %s", (_label, chunk, status) => {
    withTempRepo("pharos-feature-flag", {
      "src/lib/feature-flags.ts": "export const enabled = process.env.NEXT_PUBLIC_PHAROS_TEST === 'true';",
      ".next/static/chunks/nested/page.js": chunk,
    }, (cwd) => {
      const result = spawnSync(process.execPath, ["--import", loader, script], {
        cwd, env: { ...env, NEXT_PUBLIC_PHAROS_TEST: "" }, encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(status);
      expect(status === 1 ? result.stderr : result.stdout).toContain(status === 1 ? "not inlined" : "inlined across 1 chunks");
    });
  });
});
