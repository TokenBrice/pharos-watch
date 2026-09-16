import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyAppendOnlyMechanismRefreshDiff } from "../ci/verify-mechanism-refresh-diff";

const TSX_LOADER = import.meta.resolve("tsx");
const TSCONFIG = resolve("tsconfig.json");

function write(root: string, path: string, content: string): void {
  const absolutePath = join(root, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

describe("mechanism refresh append-only verifier", () => {
  it("preserves the workflow rejection for a synthetic non-append PR", () => {
    const root = mkdtempSync(join(tmpdir(), "pharos-mechanism-refresh-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
    const path = "shared/data/safety-score-v9/mechanism-measurements/usde-ethena/existing-protocol-api.json";
    try {
      git("init", "-q");
      git("config", "user.name", "Fixture");
      git("config", "user.email", "fixture@example.test");
      write(root, path, "before\n");
      git("add", "--", path);
      git("commit", "-qm", "base");
      git("update-ref", "refs/remotes/origin/main", "HEAD");
      write(root, path, "after\n");
      git("add", "--", path);
      git("commit", "-qm", "modify capture");

      const expected = `::error title=Non-append-only mechanism PR::${path} has status M.`;
      expect(() => verifyAppendOnlyMechanismRefreshDiff("usde-ethena", { cwd: root })).toThrow(expected);

      const cli = spawnSync(
        process.execPath,
        [
          "--import",
          TSX_LOADER,
          resolve(process.cwd(), "scripts/ci/verify-mechanism-refresh-diff.ts"),
          "--asset",
          "usde-ethena",
          "--stage",
          "verify-diff",
        ],
        { cwd: root, encoding: "utf8", env: { ...process.env, TSX_TSCONFIG_PATH: TSCONFIG } },
      );
      expect(cli.status).toBe(1);
      expect(cli.stderr).toBe(`${expected}\n`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
