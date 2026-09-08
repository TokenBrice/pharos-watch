import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CRITICAL_OWNERSHIP_WAIVERS,
  deriveCriticalOwnership,
  deriveBaseCriticalOwnership,
  findCriticalOwnershipGaps,
} from "../lib/critical-ownership.mts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("critical ownership derivation", () => {
  it("does not enroll mock-only references as executable ownership", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pharos-critical-ownership-"));
    temporaryDirectories.push(cwd);
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src/target.ts"), "export const target = 1;\n");
    writeFileSync(join(cwd, "src/first.test.ts"), 'import { target } from "./target";\nvoid target;\n');
    writeFileSync(join(cwd, "src/second.test.ts"), 'vi.mock("./target");\n');

    const ownership = deriveCriticalOwnership({
      cwd,
      testFiles: ["src/first.test.ts", "src/second.test.ts"],
    });

    expect(ownership.get("src/target.ts")).toEqual(["src/first.test.ts"]);
  });

  it("maps quoted dynamic imports without treating expressions as paths", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pharos-critical-ownership-dynamic-"));
    temporaryDirectories.push(cwd);
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src/target.ts"), "export const target = 1;\n");
    writeFileSync(
      join(cwd, "src/dynamic.test.ts"),
      'const loaded = await import("./target");\nvoid loaded;\n',
    );

    const ownership = deriveCriticalOwnership({
      cwd,
      testFiles: ["src/dynamic.test.ts"],
    });

    expect(ownership.get("src/target.ts")).toEqual(["src/dynamic.test.ts"]);
  });

  it("ignores comments, string contents, type-only imports and computed imports", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pharos-critical-syntax-"));
    temporaryDirectories.push(cwd);
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src/target.ts"), "export const target = 1;\n");
    writeFileSync(join(cwd, "src/syntax.test.ts"), [
      '// import "./target";',
      '/* import("./target") */',
      'const text = \'import "./target";\';',
      'import type { Target } from "./target";',
      'import { type Target } from "./target";',
      'const computed = import("./target" + suffix);',
      'const variableImport = import(variable);',
    ].join("\n"));
    expect(deriveCriticalOwnership({ cwd }).has("src/target.ts")).toBe(false);
  });

  it("discovers shared and script tests outside their legacy subdirectories", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pharos-critical-roots-"));
    temporaryDirectories.push(cwd);
    for (const root of ["shared/test-utils", "scripts/ci"]) {
      mkdirSync(join(cwd, root), { recursive: true });
      writeFileSync(join(cwd, root, "target.ts"), "export const target = 1;");
      writeFileSync(join(cwd, root, "target.test.ts"), 'import "./target";');
    }
    expect([...deriveCriticalOwnership({ cwd }).keys()]).toEqual([
      "scripts/ci/target.ts", "shared/test-utils/target.ts",
    ]);
  });

  it("recovers the deleted owner's runtime imports from the base tree", () => {
    const source = "worker/src/lib/auth.ts";
    const test = "worker/src/lib/__tests__/removed.test.ts";
    const ownership = deriveBaseCriticalOwnership("base", [test], (_file, args) => {
      if (args[0] === "ls-tree") return `${source}\0${test}\0`;
      if (args[0] === "show" && args[1] === `base:${test}`) return 'import "../auth";';
      throw new Error(`Unexpected Git read: ${args.join(" ")}`);
    });
    expect(ownership.get(source)).toEqual([test]);
  });

  it("reports an enrolled source without an owner unless it has a cutover waiver", () => {
    expect(findCriticalOwnershipGaps(
      ["worker/src/lib/new-critical-source.ts"],
      new Map(),
      {},
    )).toEqual(["worker/src/lib/new-critical-source.ts"]);
    expect(findCriticalOwnershipGaps(
      ["worker/src/lib/safety-score-v9/capture.ts"],
      new Map(),
      CRITICAL_OWNERSHIP_WAIVERS,
    )).toEqual([]);
  });
});
