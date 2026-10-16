import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  runBootstrapRehearsal,
} from "../maintenance/run-bootstrap-rehearsal";

describe("bootstrap rehearsal generated imports", () => {
  it.each([0, 1])("accepts concrete snapshot ownership and restores original bytes after bootstrap status %s", async (status) => {
    const root = mkdtempSync(join(tmpdir(), "bootstrap-rehearsal-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const directory = join(root, "src/generated/stablecoin-detail-snapshots");
    const original = join(directory, "original.json");
    try {
      execFileSync("git", ["init"], { cwd: root, stdio: "pipe" });
      writeFileSync(join(root, ".gitignore"), "src/generated/\n.cache/\n");
      mkdirSync(directory, { recursive: true });
      writeFileSync(original, "original snapshot bytes\n");
      writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { "bootstrap:generated": "node fixture.cjs" } }));
      writeFileSync(join(root, "fixture.cjs"), `
        const fs = require('node:fs');
        fs.mkdirSync('src/generated/stablecoin-detail-snapshots', { recursive: true });
        fs.writeFileSync('src/generated/stablecoin-detail-snapshots/new.json', 'generated');
        process.exit(${status});
      `);
      if (status === 0) await expect(runBootstrapRehearsal({ repoRoot: root, argv: [] })).resolves.toBe(0);
      else await expect(runBootstrapRehearsal({ repoRoot: root, argv: [] })).rejects.toThrow(/bootstrap:generated failed/);
      expect(readFileSync(original, "utf8")).toBe("original snapshot bytes\n");
      expect(existsSync(join(directory, "new.json"))).toBe(false);
      expect(existsSync(join(root, ".cache/bootstrap-rehearsal"))).toBe(false);
    } finally {
      log.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
