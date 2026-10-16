import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateStaleFlags, run as runStaleFlags } from "../ci/check-stale-flags";
import { createTempRepoTracker } from "./helpers/test-state";

const { cleanup, makeRoot, writeText } = createTempRepoTracker("pharos-stale-flags");
const checker = resolve("scripts/ci/check-stale-flags.ts");
const loader = resolve("node_modules/tsx/dist/loader.mjs");
afterEach(cleanup);

describe("check-stale-flags", () => {
  it("classifies expired flags with the explicit evaluation date", () => {
    const result = evaluateStaleFlags([
      "// expiresAt: 2026-09-09 — test-only expired flag",
      "TEST_ONLY_FLAG: true,",
      "// expiresAt: 2026-10-15 — future flag",
      "FUTURE_FLAG: true,",
    ].join("\n"), new Date("2026-09-09T12:30:00Z"));

    expect(result.status).toBe(1);
    expect(result.expired).toEqual([
      expect.objectContaining({ flag: "TEST_ONLY_FLAG", daysUntil: 0 }),
    ]);
    expect(result.approaching).toEqual([]);
    expect(result.stdout).toBe("");
  });

  it("classifies approaching and healthy flags without reading the repository", () => {
    const result = runStaleFlags([], {
      source: [
        "// expiresAt: 2026-09-10 — soon",
        "SOON_FLAG: true,",
        "// expiresAt: 2026-10-15 — later",
        "LATER_FLAG: true,",
      ].join("\n"),
      today: new Date("2026-09-09T00:00:00Z"),
    });

    expect(result.status).toBe(0);
    expect(result.expired).toEqual([]);
    expect(result.approaching).toEqual([
      expect.objectContaining({ flag: "SOON_FLAG", daysUntil: 1, reason: "soon" }),
    ]);
    expect(result.oldest).toEqual(expect.objectContaining({ flag: "SOON_FLAG", daysUntil: 1 }));
  });

  it("fails closed when the expiration convention is absent", () => {
    const result = runStaleFlags([], {
      source: "const featureFlags = {};",
      today: new Date("2026-09-09T00:00:00Z"),
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  });

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
