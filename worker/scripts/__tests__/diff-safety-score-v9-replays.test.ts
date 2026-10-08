import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  diffReplayArtifacts,
  extractCardGrades,
  runSafetyScoreV9DiffCli,
  categorizeReplayChanges,
} from "../diff-safety-score-v9-replays";
import { collectMovers, parseMoverManifest } from "../diff-safety-score-v9-movers";

// Minimal artifact shape. The card array lives at `pipeline.candidate.cards`
// (`SafetyScoreV9CandidatePipelineResult.candidate` is the
// `SafetyScoreV9CurrentResponse` built by `buildSafetyScoreV9Response`).
function artifact(cards: unknown[], volatile: Record<string, unknown> = {}) {
  return {
    pipeline: { candidate: { cards, ...volatile } },
  };
}

describe("diffReplayArtifacts", () => {
  it("keeps the movers entrypoint and registration inside the Worker tooling boundary", () => {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../../../package.json", import.meta.url).href), "utf8"));
    expect(pkg.scripts["safety-score-v9:movers"]).toBe("node --import tsx worker/scripts/diff-safety-score-v9-movers.ts");
    expect(existsSync(fileURLToPath(new URL("../../../scripts/maintenance/diff-safety-score-v9-movers.ts", import.meta.url).href))).toBe(false);
    const policy = readFileSync(fileURLToPath(new URL("../../../scripts/lib/cli-argv-policy.mjs", import.meta.url).href), "utf8");
    expect(policy).toContain('strict("worker/scripts/diff-safety-score-v9-movers.ts")');
    expect(policy).not.toContain('strict("scripts/maintenance/diff-safety-score-v9-movers.ts")');
  });

  it.each([
    {}, { pipeline: { candidate: {} } },
    artifact([{ id: "", grade: "A", score: 90 }]),
    artifact([{ id: "a", grade: "A", score: 90 }, { id: "a", grade: "B", score: 70 }]),
    artifact([{ id: "a", grade: "A", score: null }]),
    artifact([{ id: "a", grade: "A", score: 90, ratingStatus: "pipeline-gap" }]),
  ])("rejects malformed equivalence inputs %#", (value) => {
    expect(() => diffReplayArtifacts(value, value)).toThrow();
    expect(() => extractCardGrades(value)).toThrow();
  });

  it("accepts valid reordered live-card projections", () => {
    const cards = [{ id: "a", grade: "A", score: 90 }, { id: "b", grade: "NR", score: null }];
    expect(diffReplayArtifacts(artifact(cards), artifact([...cards].reverse())).equal).toBe(true);
  });

  it("rejects malformed, duplicate and unreviewed mover declarations", () => {
    const entry = { id: "a", from: "B", to: "A", reason: "reviewed evidence", workstream: "curation" };
    expect(parseMoverManifest({ movers: [entry] }).movers).toHaveLength(1);
    for (const movers of [[entry, entry], [{ ...entry, from: "bogus" }], [{ ...entry, reason: "" }], [{ ...entry, ratingStatusTo: "pipeline-gap" }]]) {
      expect(() => parseMoverManifest({ movers })).toThrow();
    }
  });
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


  it.each([
    "publishedAt", "safetyScoreIdentity", "baseInputGenerationId", "publicationGenerationId",
    "evaluationBuildDigest", "capturedAt", "updatedAt", "payloadSha256", "contentSha256",
    "generationId", "releaseCandidateId", "stateDigest", "resultDigest", "scoreResultDigest",
    "evaluatedSetDigest", "candidateId", "compilerFactSchemaDigest", "policyVersion",
  ])("ignores %s at the candidate and nested card levels", (key) => {
    for (const nested of [false, true]) {
      const make = (value: string) => artifact(
        [{ id: "usdc-circle", grade: "A", score: 85, ...(nested ? { evidence: [{ [key]: value }] } : {}) }],
        nested ? {} : { [key]: value },
      );
      expect(diffReplayArtifacts(make("before"), make("after"))).toEqual({ equal: true, entries: [] });
    }
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

  it("retains pipeline-gap null grades separately from historical NR", () => {
    const baseline = artifact([{ id: "asset", grade: "NR", score: null }]);
    const candidate = artifact([{ id: "asset", grade: null, score: null, ratingStatus: "pipeline-gap" }]);
    expect(extractCardGrades(baseline).get("asset")).toMatchObject({ grade: "NR", ratingStatus: "not-rated" });
    expect(extractCardGrades(candidate).get("asset")).toMatchObject({ grade: null, score: null, ratingStatus: "pipeline-gap" });
    expect(categorizeReplayChanges(baseline, candidate).availability).toEqual([
      expect.objectContaining({ assetId: "asset", path: "cards[asset].ratingStatus", candidate: "pipeline-gap" }),
    ]);
  });

  it("separates unknown credit, removed caps, reserve admission, routes, causes and schema diagnostics", () => {
    const a = { id: "asset", grade: "C", score: 55, schemaVersion: 3, caps: [{ kind: "missing-data", source: "evidence", limit: 55 }],
      breakdowns: { backing: { contributions: [{ key: "reserve:one", observationState: "missing", score: 25, wholeAssetWeight: 0.5 }] }, control: { components: [{ key: "mint", posture: "unknown", score: 35 }] } },
      scoreTrace: { primaryRouteKey: "old" } };
    const b = { ...a, schemaVersion: 4, caps: [], breakdowns: {
      backing: { contributions: [{ key: "reserve:one", observationState: "missing", score: 25, wholeAssetWeight: 0.8, cause: "U" }] },
      control: { components: [{ key: "mint", posture: "unknown", score: 50 }] },
    }, scoreTrace: { primaryRouteKey: "new" } };
    const categories = categorizeReplayChanges(artifact([a]), artifact([b]));
    expect(categories["unknown-credit-raises"]).toEqual([expect.objectContaining({ baseline: 35, candidate: 50 })]);
    expect(categories["cap-removal"]).toEqual([expect.objectContaining({ path: "cards[asset].caps" })]);
    expect(categories["reserve-admission"]).toEqual([expect.objectContaining({ baseline: 0.5, candidate: 0.8 })]);
    expect(categories["route-selection"]).toEqual([expect.objectContaining({ baseline: "old", candidate: "new" })]);
    expect(categories["cause-classification"]).toEqual([expect.objectContaining({ candidate: "U" })]);
    expect(categories.schema).toEqual([expect.objectContaining({ baseline: 3, candidate: 4 })]);
  });

  it("retains status-only and diagnostic-only movers without inventing numeric deltas", () => {
    const before = new Map([["gap", { id: "gap", grade: "NR", score: null }], ["rated", { id: "rated", grade: "C", score: 55, bindingCap: { kind: "missing", limit: 55 } }]]);
    const after = new Map([["gap", { id: "gap", grade: null, score: null, ratingStatus: "pipeline-gap" as const }], ["rated", { id: "rated", grade: "C", score: 55, bindingCap: null }]]);
    const result = collectMovers(before, after, null);
    expect(result.movers.find(row => row.id === "gap")).toMatchObject({ scoreDelta: null, gradeAfter: null, ratingStatusBefore: "not-rated", ratingStatusAfter: "pipeline-gap", ratingStatusChanged: true });
    expect(result.movers.find(row => row.id === "rated")).toMatchObject({ scoreDelta: 0, gradeFlipped: false, categories: { "cap-removal": [expect.objectContaining({ candidate: null })] } });
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
