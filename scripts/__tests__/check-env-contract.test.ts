import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  collectSourceEnvKeys,
  extractExportedEnvInterfaceBody,
  parseWorkerEnvInterfaceBindings,
  parseWorkerEnvInterfaceKeys,
  parseWranglerWorkerConfigBindings,
} from "../ci/check-env-contract";

function withTempEnvSource<T>(source: string, run: (filePath: string) => T, filename = "env.ts"): T {
  const dir = mkdtempSync(join(tmpdir(), "pharos-env-contract-"));
  try {
    const filePath = join(dir, filename);
    writeFileSync(filePath, source);
    return run(filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("check-env-contract worker Env parser", () => {
  it("extracts the exported Env interface body through nested braces", () => {
    expect(extractExportedEnvInterfaceBody("export interface Other {}\n")).toBeNull();
    const body = extractExportedEnvInterfaceBody(`
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
      `);
    expect(body).toContain("INNER_KEY: string;");
    expect(body).toContain("API_KEY?: string;");
    expect(body).not.toContain("interface After");
    expect(body).not.toContain("SHOULD_NOT_APPEAR");
    expect(extractExportedEnvInterfaceBody("export interface Env { NESTED: { KEY: string; }")).toBeNull();
  });

  it("parses only top-level uppercase Env bindings", () => {
    withTempEnvSource(`
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
    `, (filePath) => {
      expect([...parseWorkerEnvInterfaceKeys(filePath)].sort()).toEqual([
        "DB",
        "NESTED",
        "OPTIONAL_KEY",
        "REQUIRED_KEY",
      ]);
    });
  });

  it("parses top-level Env binding types", () => {
    withTempEnvSource(`
      export interface Env {
        DB: D1Database;
        CORS_ORIGIN: string;
        OPTIONAL_KEY?: string;
        NESTED?: {
          INNER_KEY: string;
        };
      }
    `, (filePath) => {
      expect([...parseWorkerEnvInterfaceBindings(filePath)]).toEqual([
        ["DB", { optional: false, type: "D1Database" }],
        ["CORS_ORIGIN", { optional: false, type: "string" }],
        ["OPTIONAL_KEY", { optional: true, type: "string" }],
        ["NESTED", { optional: true, type: "{" }],
      ]);
    });
  });

  it("fails closed when worker env.ts does not export Env", () => {
    withTempEnvSource("export interface NotEnv { API_KEY: string; }\n", (filePath) => {
      expect(() => parseWorkerEnvInterfaceKeys(filePath)).toThrow(/missing export interface Env/);
    });
  });
});

describe("check-env-contract source references", () => {
  it("finds env names passed through shared helper APIs", () => {
    withTempEnvSource(`
      const TOOL_ENV_NAMES = ["TOOL_API_KEY"];
      requireEnv("ACCESS_CLIENT_ID");
      apiFetchHeaders(["DIRECT_API_KEY"]);
    `, (filePath) => {
      expect([...collectSourceEnvKeys([filePath])].sort()).toEqual([
        "ACCESS_CLIENT_ID",
        "DIRECT_API_KEY",
        "TOOL_API_KEY",
      ]);
    });
  });

  it("finds direct process, Worker and GitHub references without duplicates or invalid candidates", () => {
    withTempEnvSource(`
      process.env.PROCESS_KEY; env.WORKER_KEY; context.env.CONTEXT_KEY;
      secrets.SECRET_KEY; vars.VARIABLE_KEY; process.env.PROCESS_KEY;
      process.env.lower_key; env.PLAIN; secrets.lower_key;
      requireEnv("BAD-KEY"); requireEnv("lower_key"); requireEnv("_INVALID");
    `, (filePath) => {
      expect([...collectSourceEnvKeys([filePath])].sort()).toEqual([
        "CONTEXT_KEY", "PROCESS_KEY", "SECRET_KEY", "VARIABLE_KEY", "WORKER_KEY",
      ]);
    });
  });

  it("finds scalar and array helper declarations", () => {
    withTempEnvSource(`
      readEnvFirst("SCALAR_KEY");
      readEnvFirst(["FIRST_KEY", "SECOND_KEY", "FIRST_KEY", "lower_key", "BAD-KEY"]);
      const options = { envNames: ["OPTION_KEY"], apiKeyEnv: "PROVIDER_KEY" };
    `, (filePath) => {
      expect([...collectSourceEnvKeys([filePath])].sort()).toEqual([
        "FIRST_KEY", "OPTION_KEY", "PROVIDER_KEY", "SCALAR_KEY", "SECOND_KEY",
      ]);
    });
  });

  it("scans shell expansion only in shell files", () => {
    const source = 'echo "$DIRECT_KEY ${DEFAULT_KEY:-fallback} $DIRECT_KEY $lower_key $PLAIN $_INVALID"';
    withTempEnvSource(source, (filePath) => {
      expect([...collectSourceEnvKeys([filePath])].sort()).toEqual(["DEFAULT_KEY", "DIRECT_KEY"]);
    }, "env.sh");
    withTempEnvSource(source, (filePath) => {
      expect([...collectSourceEnvKeys([filePath])]).toEqual([]);
    });
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
