import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CRITICAL_OWNERSHIP_WAIVERS,
  deriveCriticalOwnership,
  findCriticalOwnershipGaps,
} from "../lib/critical-ownership.mts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("critical ownership derivation", () => {
  it("maps both static imports to the same source", () => {
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

    expect(ownership.get("src/target.ts")).toEqual([
      "src/first.test.ts",
      "src/second.test.ts",
    ]);
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

  it("reports an enrolled source without an owner unless it has a cutover waiver", () => {
    expect(findCriticalOwnershipGaps(
      ["worker/src/lib/new-critical-source.ts"],
      new Map(),
      {},
    )).toEqual(["worker/src/lib/new-critical-source.ts"]);
    expect(findCriticalOwnershipGaps(
      ["worker/src/lib/safety-score-v9-capture.ts"],
      new Map(),
      CRITICAL_OWNERSHIP_WAIVERS,
    )).toEqual([]);
  });
});
