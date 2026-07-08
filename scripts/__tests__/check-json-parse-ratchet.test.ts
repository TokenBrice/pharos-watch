import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { checkJsonParseRatchet, collectWorkerJsonParseUsage } from "../ci/check-json-parse-ratchet.mjs";

let tempRoot: string | null = null;

function createTempRoot(): string {
  tempRoot = mkdtempSync(join(tmpdir(), "pharos-json-parse-ratchet-"));
  return tempRoot;
}

function writeFixture(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(absolute.slice(0, absolute.lastIndexOf("/")), { recursive: true });
  writeFileSync(absolute, content);
}

describe("check-json-parse-ratchet", () => {
  afterEach(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
  });

  it("counts raw worker JSON.parse calls outside the sanctioned helper and tests", () => {
    const root = createTempRoot();
    writeFixture(
      root,
      "worker/src/api/example.ts",
      `
      const first = JSON.parse(payload);
      // JSON.parse(commentedPayload);
      const second = JSON.parse (otherPayload);
      `,
    );
    writeFixture(
      root,
      "worker/src/lib/json-parse.ts",
      `
      export function parse(value: string): unknown {
        return JSON.parse(value);
      }
      `,
    );
    writeFixture(
      root,
      "worker/src/api/__tests__/example.test.ts",
      `
      expect(JSON.parse(body)).toEqual({ ok: true });
      `,
    );

    expect(collectWorkerJsonParseUsage(["worker/src"], root)).toEqual({
      "worker/src/api/example.ts": 2,
    });
  });

  it("fails when raw worker JSON.parse usage rises above the baseline", () => {
    const root = createTempRoot();
    writeFixture(
      root,
      "worker/src/api/example.ts",
      `
      JSON.parse(firstPayload);
      JSON.parse(secondPayload);
      `,
    );
    writeFixture(
      root,
      "scripts/lib/json-parse-ratchet-baseline.json",
      JSON.stringify({
        "worker/src/api/example.ts": 1,
      }),
    );

    let stderr = "";
    const exitCode = checkJsonParseRatchet({
      roots: ["worker/src/api"],
      cwd: root,
      stdout: { write: () => true },
      stderr: {
        write: (chunk: string) => {
          stderr += chunk;
          return true;
        },
      },
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Worker raw JSON.parse usage increased");
    expect(stderr).toContain("worker/src/api/example.ts: 2 > baseline 1");
    expect(stderr).toContain("worker/src/lib/json-parse.ts");
  });
});
