import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

describe("check-stale-flags", () => {
  it("fails an expired flag from a test-only fixture", async () => {
    const root = mkdtempSync(join(tmpdir(), "pharos-stale-flags-"));
    try {
      const flagsDirectory = join(root, "src/lib");
      mkdirSync(flagsDirectory, { recursive: true });
      writeFileSync(
        join(flagsDirectory, "feature-flags.ts"),
        ["// expiresAt: 2020-01-01 — test-only expired flag", "TEST_ONLY_FLAG: true,"].join("\n"),
      );

      const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);

      try {
        await import("../ci/check-stale-flags.mjs");
        expect(exit).toHaveBeenCalledWith(1);
      } finally {
        cwd.mockRestore();
        exit.mockRestore();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
