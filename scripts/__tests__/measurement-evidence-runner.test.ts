import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseEvidenceProducerMode,
  runEvidenceProducer,
  type EvidenceProducerMode,
} from "../lib/measurement-evidence-runner";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "pharos-evidence-runner-"));
  tempDirs.push(path);
  return path;
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("measurement evidence runner", () => {
  it("parses the shared repeatable asset, replay, and output modes", () => {
    expect(parseEvidenceProducerMode({ asset: ["one", "two"], "out-dir": "custom", replay: [] }, "default"))
      .toEqual({ assets: ["one", "two"], outDir: "custom", replayPaths: [] });
    expect(parseEvidenceProducerMode({}, "default"))
      .toEqual({ assets: [], outDir: "default", replayPaths: [] });
  });

  it("runs replay inputs in order and skips live target lookup", async () => {
    const replay = vi.fn((path: string) => path.toUpperCase());
    const afterReplay = vi.fn();
    await runEvidenceProducer({
      options: { assets: [], outDir: "unused", replayPaths: ["one", "two"] },
      configuredAssets: ["asset"],
      resolveTarget: vi.fn(() => ({ id: "asset" })),
      unknownTargetError: (assetId) => `unknown ${assetId}`,
      replay,
      afterReplay,
      capture: vi.fn(async () => ({ value: "unused" })),
      artifactPath: () => "unused",
      serialize: JSON.stringify,
      compareExisting: vi.fn(),
      onExisting: vi.fn(),
      onWritten: vi.fn(),
    });

    expect(replay.mock.calls).toEqual([["one"], ["two"]]);
    expect(afterReplay).toHaveBeenCalledWith(["ONE", "TWO"]);
  });

  it("keeps retries, append-only collisions, and exact serialization in one lifecycle", async () => {
    interface Options extends EvidenceProducerMode<"asset"> {
      marker: string;
    }
    const root = makeTempDir();
    const options: Options = { assets: [], outDir: root, replayPaths: [], marker: "kept" };
    const failures: string[] = [];
    const existing: string[] = [];
    const written: string[] = [];
    const capture = vi.fn(async (_target: { id: "asset" }, attempt: string | undefined) => {
      if (attempt === "first") throw new Error("temporary");
      return { assetId: "asset" as const, marker: options.marker };
    });
    const common = {
      options,
      configuredAssets: ["asset"] as const,
      resolveTarget: () => ({ id: "asset" as const }),
      unknownTargetError: (assetId: string) => `unknown ${assetId}`,
      replay: vi.fn(),
      attempts: () => ["first", "second"],
      capture,
      artifactPath: () => join(root, "asset", "evidence.json"),
      serialize: (evidence: { assetId: "asset"; marker: string }) => `${JSON.stringify(evidence)}\n`,
      compareExisting: (path: string, evidence: { assetId: "asset"; marker: string }) => {
        expect(readFileSync(path, "utf8")).toBe(`${JSON.stringify(evidence)}\n`);
      },
      onExisting: ({ outPath }: { outPath: string }) => existing.push(outPath),
      onWritten: ({ outPath }: { outPath: string }) => written.push(outPath),
      exclusiveWrite: true,
      onAttemptError: (error: unknown) => failures.push(error instanceof Error ? error.message : String(error)),
      attemptsFailedError: (error: unknown) => `failed: ${error instanceof Error ? error.message : String(error)}`,
    };

    await runEvidenceProducer(common);
    await runEvidenceProducer(common);

    expect(failures).toEqual(["temporary", "temporary"]);
    expect(written).toHaveLength(1);
    expect(existing).toHaveLength(1);
    expect(readFileSync(join(root, "asset", "evidence.json"), "utf8"))
      .toBe('{"assetId":"asset","marker":"kept"}\n');
  });
});
