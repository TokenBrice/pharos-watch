import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  collectSourceEnvKeys,
  extractExportedEnvInterfaceBody,
  parseWorkerEnvInterfaceBindings,
  parseWorkerEnvInterfaceKeys,
  parseWranglerWorkerConfigBindings,
} from "../ci/check-env-contract";

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

  it("parses top-level Env binding types", () => {
    const filePath = withTempEnvSource(`
      export interface Env {
        DB: D1Database;
        CORS_ORIGIN: string;
        OPTIONAL_KEY?: string;
        NESTED?: {
          INNER_KEY: string;
        };
      }
    `);

    try {
      expect([...parseWorkerEnvInterfaceBindings(filePath)]).toEqual([
        ["DB", { optional: false, type: "D1Database" }],
        ["CORS_ORIGIN", { optional: false, type: "string" }],
        ["OPTIONAL_KEY", { optional: true, type: "string" }],
        ["NESTED", { optional: true, type: "{" }],
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

describe("check-env-contract source references", () => {
  it("finds env names passed through shared helper APIs", () => {
    const filePath = withTempEnvSource(`
      const TOOL_ENV_NAMES = ["TOOL_API_KEY"];
      requireEnv("ACCESS_CLIENT_ID");
      apiFetchHeaders(["DIRECT_API_KEY"]);
    `);

    try {
      expect([...collectSourceEnvKeys([filePath])].sort()).toEqual([
        "ACCESS_CLIENT_ID",
        "DIRECT_API_KEY",
        "TOOL_API_KEY",
      ]);
    } finally {
      rmSync(dirname(filePath), { recursive: true, force: true });
    }
  });
});

describe("check-env-contract Wrangler binding parser", () => {
  it("extracts source-owned Worker bindings and vars from wrangler.toml", () => {
    const result = parseWranglerWorkerConfigBindings(`
      name = "stablecoin-api"

      [vars]
      CORS_ORIGIN = "https://pharos.watch"
      SELF_URL = 'https://api.pharos.watch'
      lower_key = "ignored"

      [[d1_databases]]
      binding = "DB"
      database_name = "stablecoin-db"

      [triggers]
      crons = ["*/15 * * * *"]
    `);

    expect([...result.bindings]).toEqual([
      ["CORS_ORIGIN", { source: "[vars]", type: "string" }],
      ["SELF_URL", { source: "[vars]", type: "string" }],
      ["DB", { source: "[[d1_databases]]", type: "D1Database" }],
    ]);
    expect([...result.duplicates]).toEqual([]);
    expect(result.unsupported).toEqual([]);
  });

  it("reports duplicate Wrangler binding keys", () => {
    const result = parseWranglerWorkerConfigBindings(`
      [vars]
      CORS_ORIGIN = "https://pharos.watch"

      [[d1_databases]]
      binding = "CORS_ORIGIN"
    `);

    expect([...result.duplicates]).toEqual(["CORS_ORIGIN"]);
  });
});
