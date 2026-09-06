import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  diffReplayArtifacts,
  extractCardGrades,
  runSafetyScoreV9DiffCli,
  VERSION_ACTIVATION_KEYS,
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

  it("VERSION_ACTIVATION_KEYS covers the pinned-build and methodology-identity family", () => {
    for (const key of [
      "stateDigest",
      "resultDigest",
      "scoreResultDigest",
      "evaluatedSetDigest",
      "candidateId",
      "compilerFactSchemaDigest",
      "policyVersion",
    ]) {
      expect(VERSION_ACTIVATION_KEYS.has(key)).toBe(true);
    }
  });

  it("keeps the two stripped families disjoint", () => {
    const overlap = [...VERSION_ACTIVATION_KEYS].filter((key) => VOLATILE_KEYS.has(key));
    expect(overlap).toEqual([]);
  });

  it("strips version-activation digests at every depth without hiding scored drift", () => {
    const card = (overrides: Record<string, unknown> = {}) => ({
      id: "usdc-circle",
      grade: "A",
      score: 85,
      scoreResultDigest: "a".repeat(64),
      ...overrides,
    });
    // A pure version activation: every VERSION_ACTIVATION_KEYS value moves,
    // nested and top level, and nothing scored does.
    const baseline = artifact([card()], {
      policyVersion: "9.06",
      candidateId: "safety-score-v9:v1:aaaa",
      resultDigest: "a".repeat(64),
      evaluatedSet: {
        evaluatedSetDigest: "a".repeat(64),
        scoreResultDigest: "a".repeat(64),
        assets: [{ id: "usdc-circle", stressState: { stateDigest: "a".repeat(64), request: 100 } }],
      },
      compilerFactSchemaDigest: "a".repeat(64),
    });
    const activated = artifact([card({ scoreResultDigest: "b".repeat(64) })], {
      policyVersion: "9.07",
      candidateId: "safety-score-v9:v1:bbbb",
      resultDigest: "b".repeat(64),
      evaluatedSet: {
        evaluatedSetDigest: "b".repeat(64),
        scoreResultDigest: "b".repeat(64),
        assets: [{ id: "usdc-circle", stressState: { stateDigest: "b".repeat(64), request: 100 } }],
      },
      compilerFactSchemaDigest: "b".repeat(64),
    });

    expect(diffReplayArtifacts(baseline, activated)).toEqual({ equal: true, entries: [] });

    // The same activation, but one scored value moved: still reported.
    const drifted = structuredClone(activated) as typeof activated & {
      pipeline: { candidate: { cards: { grade: string }[] } };
    };
    drifted.pipeline.candidate.cards[0]!.grade = "B";
    const result = diffReplayArtifacts(baseline, drifted);
    expect(result.equal).toBe(false);
    expect(result.entries.some((entry) => entry.path.includes("grade"))).toBe(true);
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
