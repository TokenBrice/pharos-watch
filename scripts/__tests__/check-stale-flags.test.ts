import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempRepoTracker } from "./helpers/test-state";

const { cleanup, makeRoot, writeText } = createTempRepoTracker("pharos-stale-flags");
const checker = resolve("scripts/ci/check-stale-flags.ts");
const loader = resolve("node_modules/tsx/dist/loader.mjs");
afterEach(cleanup);

describe("check-stale-flags", () => {
  it("exits with the expired flag identity rather than a parser failure or healthy report", () => {
    const root = makeRoot();
    writeText(root, "src/lib/feature-flags.ts", [
      "// expiresAt: 2020-01-01 — test-only expired flag",
      "TEST_ONLY_FLAG: true,",
    ].join("\n"));

    const result = spawnSync(process.execPath, ["--import", loader, checker], {
      cwd: root,
      encoding: "utf8",
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("TEST_ONLY_FLAG expired 2020-01-01");
    expect(result.stdout).toBe("");
  });
});
