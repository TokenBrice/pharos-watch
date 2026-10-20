import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  collectSourceEnvKeys,
  findWranglerBindingContractErrors,
  getWorkerEnvBindings,
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

describe("check-env-contract manifest bindings", () => {
  it("projects platform types and ingress requiredness independently of operator requirements", () => {
    const bindings = getWorkerEnvBindings();
    expect(bindings.get("DB")).toEqual({ optional: false, type: "D1Database" });
    expect(bindings.get("CORS_ORIGIN")).toEqual({ optional: false, type: "string" });
    expect(bindings.get("SAFETY_CAPTURE_ARCHIVE")).toEqual({ optional: true, type: "R2Bucket" });
    for (const key of ["GITHUB_PAT", "FEEDBACK_IP_SALT", "BANXICO_TOKEN"]) {
      expect(bindings.get(key)).toEqual({ optional: true, type: "string" });
    }
    expect(bindings.has("SITE_API_ORIGIN")).toBe(false);
  });

  it("accepts matching config and rejects missing keys and platform type drift", () => {
    expect(findWranglerBindingContractErrors(`
      [vars]
      CORS_ORIGIN = "https://pharos.watch"
      [[d1_databases]]
      binding = "DB"
    `)).toEqual([]);
    expect(findWranglerBindingContractErrors(`
      [vars]
      DB = "not-a-database"
      UNKNOWN_WORKER_BINDING = "unknown"
    `)).toEqual([
      expect.stringContaining("UNKNOWN_WORKER_BINDING ([vars])"),
      expect.stringContaining("DB ([vars]) is string, manifest declares D1Database"),
    ]);
  });

  it("retains duplicate and unsupported deployed binding failures", () => {
    expect(findWranglerBindingContractErrors(`
      [vars]
      CORS_ORIGIN = "https://pharos.watch"
      [[d1_databases]]
      binding = "CORS_ORIGIN"
      [[services]]
      binding = "invalid-binding"
    `)).toEqual([
      expect.stringContaining("duplicate Worker binding keys: CORS_ORIGIN"),
      expect.stringContaining("unsupported Worker binding keys: invalid-binding"),
      expect.stringContaining("CORS_ORIGIN ([[d1_databases]]) is D1Database"),
    ]);
  });
});

describe("check-env-contract source references", () => {
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


      [[r2_buckets]]
      binding = "SAFETY_CAPTURE_ARCHIVE"
      bucket_name = "pharos-measurements"
      [[services]]
      binding = "HEAVY_EXECUTOR"
      service = "stablecoin-heavy"
      [triggers]
      crons = ["*/15 * * * *"]
    `);

    expect([...result.bindings]).toEqual([
      ["CORS_ORIGIN", { source: "[vars]", type: "string" }],
      ["SELF_URL", { source: "[vars]", type: "string" }],
      ["DB", { source: "[[d1_databases]]", type: "D1Database" }],
      ["SAFETY_CAPTURE_ARCHIVE", { source: "[[r2_buckets]]", type: "R2Bucket" }],
      ["HEAVY_EXECUTOR", { source: "[[services]]", type: "Fetcher" }],
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
