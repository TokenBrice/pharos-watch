import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { refreshArtifactsIfChanged } from "../test/ensure-fresh-stablecoin-artifacts";

describe("stablecoin artifact bootstrap", () => {
  it("skips unchanged trees and rebuilds for source edits/deletions and missing/corrupt outputs", async () => {
    const root = mkdtempSync(join(tmpdir(), "pharos-artifact-freshness-"));
    try {
      const inputs = join(root, "inputs");
      const outputs = join(root, "outputs");
      mkdirSync(inputs);
      mkdirSync(outputs);
      const source = join(inputs, "coin.json");
      const detail = join(outputs, "coin.generated.json");
      writeFileSync(source, "original");
      writeFileSync(detail, "stale");
      // Rewriting existing details does not update the containing directory's mtime.
      utimesSync(outputs, new Date(0), new Date(0));
      const build = vi.fn(() => {
        writeFileSync(detail, existsSync(source) ? readFileSync(source) : "removed");
      });
      const refresh = () => refreshArtifactsIfChanged({
        inputPaths: [inputs], artifactPaths: [outputs], cachePath: join(root, "cache/fresh.stamp"), build,
      });

      await refresh();
      await refresh();
      expect(build).toHaveBeenCalledTimes(1);

      writeFileSync(source, "edited");
      await refresh();
      expect(readFileSync(detail, "utf8")).toBe("edited");
      rmSync(source);
      await refresh();
      expect(readFileSync(detail, "utf8")).toBe("removed");
      rmSync(detail);
      await refresh();
      expect(existsSync(detail)).toBe(true);

      const previous = statSync(detail);
      writeFileSync(detail, "corrupt");
      utimesSync(detail, previous.atime, previous.mtime);
      await refresh();
      await refresh();
      expect(readFileSync(detail, "utf8")).toBe("removed");
      expect(build).toHaveBeenCalledTimes(5);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not cache a failed build", async () => {
    const root = mkdtempSync(join(tmpdir(), "pharos-artifact-freshness-"));
    try {
      const cachePath = join(root, "fresh.stamp");
      await expect(refreshArtifactsIfChanged({
        inputPaths: [], artifactPaths: [join(root, "missing.json")], cachePath,
        build: () => { throw new Error("invalid source"); },
      })).rejects.toThrow("invalid source");
      expect(existsSync(cachePath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("admits one bootstrap at a time and lets the waiter observe the winner's output", async () => {
    const root = mkdtempSync(join(tmpdir(), "pharos-artifact-freshness-"));
    try {
      const inputs = join(root, "inputs");
      const output = join(root, "out.json");
      mkdirSync(inputs);
      writeFileSync(join(inputs, "coin.json"), "source");
      let active = 0;
      let maxActive = 0;
      const build = vi.fn(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolveBuild) => setTimeout(resolveBuild, 120));
        writeFileSync(output, "built");
        active -= 1;
      });
      const refresh = () => refreshArtifactsIfChanged({
        inputPaths: [inputs], artifactPaths: [output], cachePath: join(root, "cache/fresh.stamp"), build,
      });
      await Promise.all([refresh(), refresh()]);
      expect(build).toHaveBeenCalledTimes(1);
      expect(maxActive).toBe(1);
      expect(existsSync(join(root, "cache/fresh.stamp.lock"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("releases the lock after a failed build and rejects inputs that change during the build", async () => {
    const root = mkdtempSync(join(tmpdir(), "pharos-artifact-freshness-"));
    try {
      const inputs = join(root, "inputs");
      const source = join(inputs, "coin.json");
      const cachePath = join(root, "cache/fresh.stamp");
      mkdirSync(inputs);
      writeFileSync(source, "source");
      await expect(refreshArtifactsIfChanged({
        inputPaths: [inputs], artifactPaths: [], cachePath, build: () => { throw new Error("invalid source"); },
      })).rejects.toThrow("invalid source");
      expect(existsSync(`${cachePath}.lock`)).toBe(false);
      await expect(refreshArtifactsIfChanged({
        inputPaths: [inputs], artifactPaths: [], cachePath,
        build: () => { writeFileSync(source, "edited while building, longer"); },
      })).rejects.toThrow(/inputs changed during/);
      expect(existsSync(cachePath)).toBe(false);
      expect(existsSync(`${cachePath}.lock`)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("times out on a held lock without stealing it", async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), "pharos-artifact-freshness-"));
    try {
      const cachePath = join(root, "cache/fresh.stamp");
      mkdirSync(`${cachePath}.lock`, { recursive: true });
      const build = vi.fn();
      const pending = refreshArtifactsIfChanged({ inputPaths: [], artifactPaths: [], cachePath, build });
      const assertion = expect(pending).rejects.toThrow(/Timed out/);
      await vi.advanceTimersByTimeAsync(61_000);
      await assertion;
      expect(build).not.toHaveBeenCalled();
      expect(existsSync(`${cachePath}.lock`)).toBe(true);
    } finally {
      vi.useRealTimers();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
