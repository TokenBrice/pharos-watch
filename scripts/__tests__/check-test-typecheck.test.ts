import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const CHECK_SCRIPT = resolve("scripts/ci/check-test-typecheck.mjs");

function makeWorkdir() {
  const cwd = mkdtempSync(join(tmpdir(), "pharos-test-typecheck-"));
  mkdirSync(join(cwd, "scripts/lib"), { recursive: true });
  writeFileSync(join(cwd, "scripts/lib/test-typecheck-baseline.json"), '{"diagnostics":[]}\n');
  return cwd;
}

function writeBaseline(cwd: string, diagnostics: Record<string, unknown>[]) {
  writeFileSync(
    join(cwd, "scripts/lib/test-typecheck-baseline.json"),
    `${JSON.stringify({ diagnostics })}\n`,
  );
}

function makeFakeNpx(cwd: string, body: string) {
  const binDir = join(cwd, "bin");
  mkdirSync(binDir, { recursive: true });
  const npxPath = join(binDir, "npx");
  writeFileSync(npxPath, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return binDir;
}

function runCheck(cwd: string, binDir: string, args: string[] = []) {
  return spawnSync(process.execPath, [CHECK_SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: binDir,
    },
  });
}

describe("check-test-typecheck", () => {
  it("fails when tsc exits with an unparsed config-level diagnostic", () => {
    const cwd = makeWorkdir();
    const binDir = makeFakeNpx(
      cwd,
      'echo "tsconfig.test-typecheck.json(1,1): error TS18003: No inputs were found in config file." >&2\nexit 1',
    );

    const result = runCheck(cwd, binDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unparsed TypeScript diagnostic");
    expect(result.stderr).toContain("TS18003");
  });

  it("does not update the baseline when tsc fails before parseable test-file diagnostics", () => {
    const cwd = makeWorkdir();
    const baselinePath = join(cwd, "scripts/lib/test-typecheck-baseline.json");
    const originalBaseline = readFileSync(baselinePath, "utf8");
    const binDir = makeFakeNpx(cwd, 'echo "npx: command failed" >&2\nexit 1');

    const result = runCheck(cwd, binDir, ["--update-baseline"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("failed without parseable test-file diagnostics");
    expect(readFileSync(baselinePath, "utf8")).toBe(originalBaseline);
  });

  it("continues to ratchet parseable test-file diagnostics", () => {
    const cwd = makeWorkdir();
    const binDir = makeFakeNpx(cwd, 'echo "scripts/__tests__/sample.test.ts(1,1): error TS9999: Example failure." >&2\nexit 1');

    const result = runCheck(cwd, binDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("new scripts/__tests__/sample.test.ts");
    expect(result.stderr).toContain("TS9999");
  });

  it("rejects a replacement diagnostic with the same file and TypeScript code", () => {
    const cwd = makeWorkdir();
    writeBaseline(cwd, [{
      file: "scripts/__tests__/sample.test.ts",
      code: "TS2322",
      message: "Type 'string' is not assignable to type 'number'.",
      count: 1,
      examples: ["1:1"],
    }]);
    const binDir = makeFakeNpx(
      cwd,
      `echo "scripts/__tests__/sample.test.ts(1,1): error TS2322: Type 'boolean' is not assignable to type 'number'." >&2\nexit 1`,
    );

    const result = runCheck(cwd, binDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Type 'boolean' is not assignable");
  });

  it("normalizes diagnostic whitespace before comparing message identity", () => {
    const cwd = makeWorkdir();
    writeBaseline(cwd, [{
      file: "scripts/__tests__/sample.test.ts",
      code: "TS2322",
      message: "Type 'string'   is not assignable to type 'number'.",
      count: 1,
      examples: ["1:1"],
    }]);
    const binDir = makeFakeNpx(
      cwd,
      `echo "scripts/__tests__/sample.test.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'." >&2\nexit 1`,
    );

    const result = runCheck(cwd, binDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No new test type diagnostics");
  });
});
