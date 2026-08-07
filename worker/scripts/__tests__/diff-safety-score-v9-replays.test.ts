import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  diffReplayArtifacts,
  extractCardGrades,
  runSafetyScoreV9DiffCli,
  VOLATILE_KEYS,
} from "../diff-safety-score-v9-replays";

// Minimal artifact shape. The card array lives at `pipeline.candidate.cards`
// (`SafetyScoreV9CandidatePipelineResult.candidate` is the
// `SafetyScoreV9CurrentResponse` built by `buildSafetyScoreV9Response`).
function artifact(cards: unknown[], volatile: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    kind: "safety-score-v9-candidate-replay",
    pipeline: { candidate: { cards, ...volatile } },
  };
}

describe("diffReplayArtifacts", () => {
  it("self-diff is empty even when volatile identity fields differ", () => {
    const a = artifact([{ id: "usdt-tether", grade: "B+", score: 72 }], {
      publishedAt: 1,
      safetyScoreIdentity: { x: 1 },
    });
    const b = artifact([{ id: "usdt-tether", grade: "B+", score: 72 }], {
      publishedAt: 2,
      safetyScoreIdentity: { x: 2 },
    });
    const diff = diffReplayArtifacts(a, b);
    expect(diff.equal).toBe(true);
    expect(diff.entries).toEqual([]);
  });

  it("reports a changed score with its asset id and path", () => {
    const a = artifact([{ id: "usdt-tether", grade: "B+", score: 72 }]);
    const b = artifact([{ id: "usdt-tether", grade: "B+", score: 71 }]);
    const diff = diffReplayArtifacts(a, b);
    expect(diff.equal).toBe(false);
    expect(diff.entries[0]).toMatchObject({
      assetId: "usdt-tether",
      path: "cards[usdt-tether].score",
      baseline: 72,
      candidate: 71,
    });
  });

  it("reports added and removed cards against their asset id", () => {
    const a = artifact([{ id: "usdt-tether", grade: "B+", score: 72 }]);
    const b = artifact([{ id: "frax", grade: "C", score: 55 }]);
    const diff = diffReplayArtifacts(a, b);
    const byAsset = new Map(diff.entries.map((entry) => [entry.assetId, entry]));
    expect(byAsset.get("usdt-tether")).toMatchObject({ candidate: undefined });
    expect(byAsset.get("frax")).toMatchObject({ baseline: undefined });
  });

  it("reports drift outside the card array with a null asset id", () => {
    const a = artifact([], { completeness: { expectedCount: 0 } });
    const b = artifact([], { completeness: { expectedCount: 1 } });
    const diff = diffReplayArtifacts(a, b);
    expect(diff.equal).toBe(false);
    expect(diff.entries).toEqual([
      {
        assetId: null,
        path: "$.pipeline.candidate.completeness.expectedCount",
        baseline: 0,
        candidate: 1,
      },
    ]);
  });

  it("extractCardGrades keys every card by id", () => {
    const grades = extractCardGrades(artifact([{ id: "frax", grade: "C", score: 55 }]));
    expect(grades.get("frax")).toEqual({ grade: "C", score: 55 });
  });

  it("extractCardGrades keeps a not-rated card with a null score", () => {
    const grades = extractCardGrades(artifact([{ id: "frax", grade: "NR", score: null }]));
    expect(grades.get("frax")).toEqual({ grade: "NR", score: null });
  });

  it("extractCardGrades returns an empty map when the card path is absent", () => {
    expect(extractCardGrades({ pipeline: {} }).size).toBe(0);
  });

  it("VOLATILE_KEYS covers the identity/timestamp family", () => {
    for (const key of [
      "publishedAt",
      "safetyScoreIdentity",
      "baseInputGenerationId",
      "publicationGenerationId",
      "evaluationBuildDigest",
      "capturedAt",
      "updatedAt",
      "payloadSha256",
      "contentSha256",
      "generationId",
      "releaseCandidateId",
    ]) {
      expect(VOLATILE_KEYS.has(key)).toBe(true);
    }
  });
});

describe("runSafetyScoreV9DiffCli", () => {
  const cleanups: (() => void)[] = [];

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
    process.exitCode = undefined;
  });

  /** Run the CLI with stdio silenced and report the exit code it selected. */
  async function runCli(argv: string[]): Promise<number> {
    const streams = [process.stdout, process.stderr] as const;
    const originals = streams.map((stream) => stream.write.bind(stream));
    for (const stream of streams) stream.write = (() => true) as typeof stream.write;
    try {
      process.exitCode = undefined;
      await runSafetyScoreV9DiffCli(argv);
      return typeof process.exitCode === "number" ? process.exitCode : 0;
    } finally {
      streams.forEach((stream, index) => {
        stream.write = originals[index]! as typeof stream.write;
      });
    }
  }

  function writeArtifacts(baselineCards: unknown[], candidateCards: unknown[]): string[] {
    const dir = mkdtempSync(resolve(tmpdir(), "v9-diff-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return [baselineCards, candidateCards].map((cards, index) => {
      const path = resolve(dir, `${index === 0 ? "baseline" : "candidate"}.json`);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- isolated temporary test path.
      writeFileSync(path, JSON.stringify(artifact(cards)), "utf8");
      return path;
    });
  }

  it("exits 0 under --assert-empty when the artifacts match", async () => {
    const card = { id: "usdc-circle", grade: "A", score: 90 };
    const [baseline, candidate] = writeArtifacts([card], [card]);
    expect(await runCli(["--baseline", baseline!, "--candidate", candidate!, "--assert-empty"])).toBe(0);
  });

  it("exits 1 under --assert-empty when a score moves", async () => {
    const [baseline, candidate] = writeArtifacts(
      [{ id: "usdc-circle", grade: "A", score: 90 }],
      [{ id: "usdc-circle", grade: "A", score: 89 }],
    );
    expect(await runCli(["--baseline", baseline!, "--candidate", candidate!, "--assert-empty"])).toBe(1);
  });

  it("exits 0 under --assert-grade-stable when only the score moves", async () => {
    const [baseline, candidate] = writeArtifacts(
      [{ id: "usdc-circle", grade: "A", score: 90 }],
      [{ id: "usdc-circle", grade: "A", score: 89 }],
    );
    expect(await runCli(["--baseline", baseline!, "--candidate", candidate!, "--assert-grade-stable"])).toBe(0);
  });

  it("exits 1 under --assert-grade-stable when a grade flips", async () => {
    const [baseline, candidate] = writeArtifacts(
      [{ id: "usdc-circle", grade: "A", score: 90 }],
      [{ id: "usdc-circle", grade: "B+", score: 72 }],
    );
    expect(await runCli(["--baseline", baseline!, "--candidate", candidate!, "--assert-grade-stable"])).toBe(1);
  });

  it("rejects the two assertions together and a missing artifact path", async () => {
    const card = { id: "usdc-circle", grade: "A", score: 90 };
    const [baseline, candidate] = writeArtifacts([card], [card]);
    await expect(
      runCli(["--baseline", baseline!, "--candidate", candidate!, "--assert-empty", "--assert-grade-stable"]),
    ).rejects.toThrow(/cannot be used together/);
    await expect(runCli(["--candidate", candidate!, "--assert-empty"])).rejects.toThrow(/--baseline is required/);
  });
});
