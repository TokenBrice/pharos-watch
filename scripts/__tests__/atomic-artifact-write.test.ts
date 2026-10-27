import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { atomicWriteFileSync } from "../lib/atomic-artifact-write.mts";

function withRoot(run: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "pharos-atomic-write-"));
  try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

describe("atomic artifact write", () => {
  it("replaces the destination with complete bytes and leaves no temporary", () => {
    withRoot((root) => {
      const destination = join(root, "coin.generated.json");
      writeFileSync(destination, "old");
      atomicWriteFileSync(destination, '{"complete":true}\n');
      expect(readFileSync(destination, "utf8")).toBe('{"complete":true}\n');
      expect(readdirSync(root)).toEqual(["coin.generated.json"]);
    });
  });

  it("preserves the destination, cleans only its temporary and keeps the original error when rename fails", () => {
    withRoot((root) => {
      // A directory occupies the destination path, so rename fails after the write succeeds.
      const destination = join(root, "occupied");
      mkdirSync(destination);
      writeFileSync(join(root, "unrelated.tmp"), "keep");
      expect(() => atomicWriteFileSync(destination, "new")).toThrow();
      expect(readdirSync(root).sort()).toEqual(["occupied", "unrelated.tmp"]);
    });
  });

  it("keeps the original error when the temporary cannot be written", () => {
    withRoot((root) => {
      expect(() => atomicWriteFileSync(join(root, "missing-dir", "x.json"), "new")).toThrow(/ENOENT/);
    });
  });
});
