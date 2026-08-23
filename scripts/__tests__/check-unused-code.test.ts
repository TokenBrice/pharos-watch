import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const CHECKER = resolve(process.cwd(), "scripts/ci/check-unused-code.ts");
const TSX = resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs");

let workspace: string | undefined;

/**
 * The checker reads `process.cwd()` as its scan root, so a fixture tree plus a
 * subprocess exercises the real scanner rather than a reimplementation of it.
 * It resolves aliases from `vitest.config.ts` and audits the shared allowlist,
 * so the fixture must supply both to reach the scan itself.
 */
const SCAFFOLD: Record<string, string> = {
  "vitest.config.ts":
    'import path from "node:path";\n' +
    "export default {\n" +
    "  resolve: {\n" +
    "    alias: {\n" +
    '      "@": path.resolve(__dirname, "src"),\n' +
    '      "@shared": path.resolve(__dirname, "shared"),\n' +
    "    },\n" +
    "  },\n" +
    "};\n",
  "src/test/setup.ts": "export {};\n",
  "shared/data/safety-score-v9/evaluation-build-manifest-v1.ts":
    "export const SAFETY_SCORE_V9_EVALUATION_BUILD_MANIFEST = { id: 1 };\n",
  "src/components/chart-primitives/data-table.tsx": "export const ChartDataTable = 1;\n",
};

function runChecker(files: Record<string, string>): { status: number; output: string } {
  workspace = mkdtempSync(join(tmpdir(), "pharos-unused-code-"));
  for (const [relativePath, contents] of Object.entries({ ...SCAFFOLD, ...files })) {
    const absolute = join(workspace, relativePath);
    mkdirSync(resolve(absolute, ".."), { recursive: true });
    writeFileSync(absolute, contents);
  }

  try {
    const output = execFileSync(process.execPath, [TSX, CHECKER], {
      cwd: workspace,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? 1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  workspace = undefined;
});

describe("check-unused-code export resolution", () => {
  it("credits a named use that reaches the declaring module through a wildcard re-export", () => {
    // `used` is imported from the barrel, never from its declaring module. The
    // scan must follow `export *` back to the owner, while the sibling export
    // that nothing imports is still reported.
    const { status, output } = runChecker({
      "shared/owner.ts": "export const used = 1;\nexport const neverImported = 2;\n",
      "shared/barrel.ts": 'export * from "./owner";\n',
      "src/entry.ts": 'import { used } from "../shared/barrel";\nexport const entry = used;\n',
    });

    expect(output).toContain("shared/owner.ts :: neverImported");
    expect(output).not.toContain("shared/owner.ts :: used");
    expect(status).toBe(1);
  });

  it("does not report a type-only specifier in a mixed export clause as runtime-dead", () => {
    // `export { fn, type Shape }` marks only `Shape` type-only. Type exports are
    // never runtime-dead, so honouring the declaration flag alone -- and not the
    // per-specifier flag -- produced false positives here.
    const { output } = runChecker({
      "shared/decls.ts":
        "export type Shape = { a: number };\n" +
        "export const unusedConst = 1;\n" +
        "export function fn(): number {\n  return 1;\n}\n",
      "shared/mixed.ts": 'export { fn, type Shape } from "./decls";\n',
      "src/entry.ts": 'import { fn } from "../shared/mixed";\nexport const entry = fn();\n',
    });

    // Positive control: a genuinely unused runtime export in the same module is
    // reported, so the absence of `Shape` is the type-only rule and not a scan
    // that failed to run.
    expect(output).toContain("shared/decls.ts :: unusedConst");
    expect(output).not.toContain("Shape");
    expect(output).not.toContain(":: fn");
  });
});
