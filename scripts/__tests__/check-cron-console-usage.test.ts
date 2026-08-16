import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  collectWorkerConsoleFindings,
  collectWorkerConsoleUsage,
  checkCronConsoleUsage,
} from "../ci/check-cron-console-usage.ts";

let tempRoot: string | null = null;

function createTempRoot(): string {
  tempRoot = mkdtempSync(join(tmpdir(), "pharos-console-usage-"));
  return tempRoot;
}

function writeFixture(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(absolute.slice(0, absolute.lastIndexOf("/")), { recursive: true });
  writeFileSync(absolute, content);
}

describe("check-cron-console-usage", () => {
  afterEach(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
  });

  it("counts raw worker console calls while accepting structured JSON calls", () => {
    const root = createTempRoot();
    writeFixture(
      root,
      "worker/src/api/example.ts",
      `
      console.warn("raw route warning");
      console.error(JSON.stringify({ ts: "now", scope: "status", level: "error", message: "structured" }));
      `,
    );

    expect(collectWorkerConsoleUsage(["worker/src/api"], root)).toEqual({
      "worker/src/api/example.ts": 1,
    });
    expect(collectWorkerConsoleFindings(["worker/src/api"], root)).toEqual([
      {
        file: "worker/src/api/example.ts",
        line: 2,
        text: 'console.warn("raw route warning");',
        structured: false,
      },
      {
        file: "worker/src/api/example.ts",
        line: 3,
        text: 'console.error(JSON.stringify({ ts: "now", scope: "status", level: "error", message: "structured" }));',
        structured: true,
      },
    ]);
  });

  it("fails when raw worker console usage rises above the baseline", () => {
    const root = createTempRoot();
    writeFixture(
      root,
      "worker/src/api/example.ts",
      `
      console.warn("first raw warning");
      console.error("second raw warning");
      `,
    );
    writeFixture(root, "scripts/lib/cron-console-usage-baseline.json", JSON.stringify({
      "worker/src/api/example.ts": 1,
    }));

    let stderr = "";
    const exitCode = checkCronConsoleUsage({
      roots: ["worker/src/api"],
      cwd: root,
      stdout: { write: () => true },
      stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Worker raw console usage increased");
    expect(stderr).toContain("worker/src/api/example.ts: 2 > baseline 1");
  });
});
