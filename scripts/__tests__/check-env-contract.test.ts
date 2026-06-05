import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  extractExportedEnvInterfaceBody,
  parseWorkerEnvInterfaceKeys,
} from "../ci/check-env-contract.mjs";

function withTempEnvSource(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pharos-env-contract-"));
  const filePath = join(dir, "env.ts");
  writeFileSync(filePath, source);
  return filePath;
}

describe("check-env-contract worker Env parser", () => {
  it("extracts the exported Env interface body through nested braces", () => {
    expect(extractExportedEnvInterfaceBody("export interface Other {}\n")).toBeNull();
    expect(
      extractExportedEnvInterfaceBody(`
        export interface Env {
          DB: D1Database;
          NESTED?: {
            INNER_KEY: string;
          };
          API_KEY?: string;
        }
        export interface After {
          SHOULD_NOT_APPEAR: string;
        }
      `),
    ).toContain("API_KEY?: string;");
  });

  it("parses only top-level uppercase Env bindings", () => {
    const filePath = withTempEnvSource(`
      export interface Env {
        DB: D1Database;
        REQUIRED_KEY: string;
        OPTIONAL_KEY?: string;
        NESTED?: {
          INNER_KEY: string;
          DEEP?: {
            DEEP_KEY: string;
          };
        };
        lower_key: string;
        "QUOTED_KEY": string;
      }
    `);

    try {
      expect([...parseWorkerEnvInterfaceKeys(filePath)].sort()).toEqual([
        "DB",
        "NESTED",
        "OPTIONAL_KEY",
        "REQUIRED_KEY",
      ]);
    } finally {
      rmSync(dirname(filePath), { recursive: true, force: true });
    }
  });

  it("fails closed when worker env.ts does not export Env", () => {
    const filePath = withTempEnvSource("export interface NotEnv { API_KEY: string; }\n");
    try {
      expect(() => parseWorkerEnvInterfaceKeys(filePath)).toThrow(/missing export interface Env/);
    } finally {
      rmSync(dirname(filePath), { recursive: true, force: true });
    }
  });
});
