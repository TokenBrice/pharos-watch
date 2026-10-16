import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { scanForUnusedCode } from "../ci/check-unused-code";
import { describe, expect, it } from "vitest";

const CHECKER = resolve(process.cwd(), "scripts/ci/check-unused-code.ts");
const TSX_LOADER = resolve(process.cwd(), "node_modules/tsx/dist/loader.mjs");

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

function writeFixture(
  files: Record<string, string>,
  scaffold: Record<string, string> = SCAFFOLD,
): string {
  workspace = mkdtempSync(join(tmpdir(), "pharos-unused-code-"));
  for (const [relativePath, contents] of Object.entries({ ...scaffold, ...files })) {
    const absolute = join(workspace, relativePath);
    mkdirSync(resolve(absolute, ".."), { recursive: true });
    writeFileSync(absolute, contents);
  }
  return workspace;
}

/**
 * Scan a fixture workspace in-process. This is the same pipeline the CLI
 * executes, without paying a child-process startup per case; the real-process
 * exit contract is owned by the single `runCheckerCli` case below.
 */
function runChecker(
  files: Record<string, string>,
  args: string[] = [],
  scaffold: Record<string, string> = SCAFFOLD,
): { status: number; output: string } {
  return scanForUnusedCode({ root: writeFixture(files, scaffold), argv: args });
}

/** The suite's single real-process invocation: it spawns the actual CLI. */
function runCheckerCli(
  files: Record<string, string>,
  args: string[] = [],
  scaffold: Record<string, string> = SCAFFOLD,
): { status: number; output: string } {
  const root = writeFixture(files, scaffold);
  try {
    const output = execFileSync(process.execPath, ["--import", TSX_LOADER, CHECKER, ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? 1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}


describe("check-unused-code export resolution", () => {
  it("credits a named use that reaches the declaring module through a wildcard re-export", () => {
    // `used` is imported from the barrel, never from its declaring module. The
    // scan must follow `export *` back to the owner, while the sibling export
    // that nothing imports is still reported.
    // This case is the suite's single real-process invocation: it pins the
    // checker's exit code and output through an actual child process.
    const { status, output } = runCheckerCli({
      "shared/owner.ts": "export const used = 1;\nexport const neverImported = 2;\n",
      "shared/barrel.ts": 'export * from "./owner";\n',
      "src/app/page.tsx": 'import { used } from "../../shared/barrel";\nexport const entry = used;\n',
    });

    expect(output).toContain("shared/owner.ts :: neverImported");
    expect(output).not.toContain("shared/owner.ts :: used");
    expect(status).toBe(1);
  });

});

describe("check-unused-code production reachability", () => {
  const minimalScaffold = { "vitest.config.ts": SCAFFOLD["vitest.config.ts"] };
  const skipAudit = ["--skip-allowlist-audit"];

  it("reports a production helper only tests import as dead, including through test-only re-exports", () => {
    // Tests are not consumers: a module whose only importers are test files is
    // dead product code, and a non-test barrel that only tests import must not
    // transitively vouch for what it re-exports.
    const { status, output } = runChecker(
      {
        "src/lib/test-only-helper.ts": "export const helper = 1;\n",
        "src/lib/__tests__/helper.test.ts":
          'import { helper } from "../test-only-helper";\n\ntest("helper", () => helper);\n',
        "src/lib/test-only-barrel.ts": 'export { victimValue } from "../../shared/victim";\n',
        "src/lib/__tests__/barrel.test.ts":
          'import { victimValue } from "../test-only-barrel";\n\ntest("victim", () => victimValue);\n',
        "shared/victim.ts": "export const victimValue = 1;\n",
      },
      skipAudit,
      minimalScaffold,
    );

    expect(output).toContain("src/lib/test-only-helper.ts (only referenced by tests or test fixtures)");
    expect(output).toContain("src/lib/test-only-barrel.ts (only referenced by tests or test fixtures)");
    expect(output).toContain(
      "shared/victim.ts (only referenced from modules that are not production-reachable)",
    );
    expect(status).toBe(1);
  });

  it("keeps a production import and re-export chain from a framework root live", () => {
    const { status, output } = runChecker(
      {
        "src/app/page.tsx":
          'import { chainValue } from "@/lib/chain-entry";\n' +
          'import { ChainWidget } from "@/components/chain-widget";\n' +
          "export default function Page() {\n  return <ChainWidget value={chainValue} />;\n}\n",
        "src/lib/chain-entry.ts": 'export { chainValue } from "../../shared/chain-owner";\n',
        "shared/chain-owner.ts": "export const chainValue = 1;\n",
        "src/components/chain-widget.tsx":
          'import { chainValue } from "../../shared/chain-owner";\n' +
          "export function ChainWidget({ value }: { value: number }) {\n  return value + chainValue;\n}\n",
      },
      skipAudit,
      minimalScaffold,
    );

    expect(output).toContain("No dead internal modules or unused named exports found.");
    expect(status).toBe(0);
  });

});

