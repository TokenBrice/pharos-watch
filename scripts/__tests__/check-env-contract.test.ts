import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  collectRuntimeEnvReads,
  collectSourceEnvKeys,
  findEnvExamplePolicyErrors,
  findUndeclaredRuntimeEnvKeys,
  findWranglerBindingContractErrors,
  getWorkerEnvBindings,
  parseWranglerWorkerConfigBindings,
} from "../ci/check-env-contract";
import { withTempRepo } from "./helpers/test-state";

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
      "worker/wrangler.toml declares duplicate Worker binding keys: CORS_ORIGIN",
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

describe("check-env-contract runtime env reads", () => {
  it("collects binding reads per runtime and only NEXT_PUBLIC_* from the static frontend", () => {
    withTempRepo("pharos-env-reads", {
      "worker/src/runtime.ts": "export const x = env.WORKER_KEY; export const y = process.env.NODE_ENV;",
      "worker/src/__tests__/runtime.test.ts": "export const z = env.TEST_ONLY_KEY;",
      "functions/proxy.ts": "export const x = context.env.PAGES_KEY;",
      "src/lib/flags.ts": "export const a = process.env.NEXT_PUBLIC_FEATURE; export const b = process.env.PHAROS_API_KEY;",
    }, (cwd) => {
      const reads = collectRuntimeEnvReads(cwd);
      expect([...reads.worker]).toEqual(["WORKER_KEY"]);
      expect([...reads.pages]).toEqual(["PAGES_KEY"]);
      expect([...reads.frontend]).toEqual(["NEXT_PUBLIC_FEATURE"]);
    });
  });

  it("reads computed access, destructuring and runtime.env, and ignores comments and strings", () => {
    withTempRepo("pharos-env-reads-ast", {
      "worker/src/computed.ts": 'export const a = env["COMPUTED_KEY"];',
      "worker/src/destructured.ts": "const { DESTRUCTURED_KEY, ALIASED_KEY: local } = env; export { local };",
      "worker/src/nested.ts": "export const a = runtime.env.RUNTIME_KEY;",
      "worker/src/noise.ts": [
        "// env.COMMENT_KEY is optional and env.ANOTHER_KEY is not read",
        'export const note = "env.STRING_KEY";',
        "const template = `env.TEMPLATE_KEY`;",
        "export { note, template };",
      ].join("\n"),
      "worker/src/lib/dash-test-support.ts": "export const s = env.SUPPORT_ONLY_KEY;",
      "src/app/stablecoin/[id]/client-test-support.tsx": "export const f = process.env.NEXT_PUBLIC_HELPER_FLAG;",
    }, (cwd) => {
      const reads = collectRuntimeEnvReads(cwd);
      // `ALIASED_KEY: local` reads ALIASED_KEY from the binding, not the local name.
      expect([...reads.worker].sort()).toEqual(["ALIASED_KEY", "COMPUTED_KEY", "DESTRUCTURED_KEY", "RUNTIME_KEY"]);
      expect([...reads.frontend]).toEqual([]);
    });
  });

  it("rejects an undeclared read or a key declared for another runtime", () => {
    expect(findUndeclaredRuntimeEnvKeys({
      worker: new Set(["CORS_ORIGIN"]),
      pages: new Set(["DB"]),
      frontend: new Set(["NEXT_PUBLIC_API_BASE"]),
    })).toEqual([]);

    expect(findUndeclaredRuntimeEnvKeys({
      worker: new Set(["UNDECLARED_WORKER_KEY", "SITE_API_ORIGIN"]),
      pages: new Set(),
      frontend: new Set(),
    })).toEqual([
      expect.stringContaining("Worker runtime reads undeclared env key SITE_API_ORIGIN"),
      expect.stringContaining("Worker runtime reads undeclared env key UNDECLARED_WORKER_KEY"),
    ]);

    expect(findUndeclaredRuntimeEnvKeys({
      worker: new Set(),
      pages: new Set(),
      frontend: new Set(["NEXT_PUBLIC_UNDECLARED"]),
    })).toEqual([expect.stringContaining("Frontend build reads undeclared env key NEXT_PUBLIC_UNDECLARED")]);
  });
});

describe("check-env-contract .env.example content policy", () => {
  it("rejects retired example keys and a non-canonical site API origin", () => {
    const requiredEntries = [
      "NEXT_PUBLIC_API_BASE=",
      "SELECTOR_SNAPSHOT_IP_HASH_SECRET=",
      "SITE_API_SHARED_SECRET=",
    ];
    const validEntries = [
      ...requiredEntries,
      "SITE_API_ORIGIN=https://site-api.pharos.watch",
      "CORS_ORIGIN=https://pharos.watch",
    ];
    expect(findEnvExamplePolicyErrors(validEntries.join("\n"))).toEqual([]);
    for (const entry of requiredEntries) {
      expect(findEnvExamplePolicyErrors(validEntries.filter((line) => line !== entry).join("\n"))).toEqual([
        `.env.example must document ${entry.slice(0, -1)}`,
      ]);
    }

    expect(findEnvExamplePolicyErrors([
      ...requiredEntries,
      "DB=local-d1",
      "VAULTS_FYI_TOKEN=secret",
      "TELEGRAM_ADOPTION_IP_HASH_SECRET=secret",
      "SITE_API_ORIGIN=http://localhost:8787",
    ].join("\n"))).toEqual([
      ".env.example must not document DB",
      ".env.example must not document TELEGRAM_ADOPTION_IP_HASH_SECRET",
      ".env.example must not document retired VAULTS_FYI_* keys (found VAULTS_FYI_TOKEN)",
      '.env.example must document SITE_API_ORIGIN=https://site-api.pharos.watch (found "http://localhost:8787")',
    ]);
    expect(findEnvExamplePolicyErrors("# empty example\n")).toEqual([
      ".env.example must document NEXT_PUBLIC_API_BASE",
      ".env.example must document SELECTOR_SNAPSHOT_IP_HASH_SECRET",
      ".env.example must document SITE_API_SHARED_SECRET",
      ".env.example must document SITE_API_ORIGIN=https://site-api.pharos.watch (found no entry)",
    ]);
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
});
