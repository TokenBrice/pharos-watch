import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { URL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { assertMatchingFixedInput, categorizeReplayChanges, detectMonotonicityViolations, diffReplayArtifacts, extractCardGrades, runSafetyScoreV9DiffCli } from "../diff-safety-score-v9-replays";
import { collectMovers, evaluateMonotonicityGate, parseMoverManifest } from "../diff-safety-score-v9-movers";
import { CliUsageError } from "../../../scripts/lib/cli-args.mjs";

// Minimal artifact shape. The card array lives at `pipeline.candidate.cards`
// (`SafetyScoreV9CandidatePipelineResult.candidate` is the
// `SafetyScoreV9CurrentResponse` built by `buildSafetyScoreV9Response`).
function artifact(cards: unknown[], volatile: Record<string, unknown> = {}) {
  return {
    pipeline: { candidate: { cards, ...volatile } },
  };
}

describe("diffReplayArtifacts", () => {
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

  it("rejects malformed, duplicate and unreviewed mover declarations", () => {
    const entry = { id: "a", from: "B", to: "A", reason: "reviewed evidence", workstream: "curation" };
    expect(parseMoverManifest({ movers: [entry] }).movers).toHaveLength(1);
    for (const movers of [[entry, entry], [{ ...entry, from: "bogus" }], [{ ...entry, reason: "" }], [{ ...entry, ratingStatusTo: "pipeline-gap" }]]) {
      expect(() => parseMoverManifest({ movers })).toThrow();
    }
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

  it("matches the wire projection used by each runbook comparison", async () => {
    const root = new URL("../../../", import.meta.url);
    const runbook = readFileSync(new URL("docs/process/safety-score-equivalence-harness.md", root), "utf8");
    const card = { id: "mxne-real-mxn", grade: "C", score: 55 };
    const optedIn = { ...card, reserveCompositionAdmission: { reasons: ["report-confidence-unverified"] } };
    const [replay, wire] = writeArtifacts([optedIn], [card]);
    writeFileSync(replay!, JSON.stringify({ ...artifact([optedIn]), sourceAdmissionBaseline: null }));
    for (const [section, expected] of [
      ["Full local-registry mover comparison", card],
      ["Neutral release: pre-cutover comparison", card],
      ["Exact deployed code: accepted-publication equivalence", optedIn],
    ] as const) {
      const procedure = runbook.split(`### ${section}\n`)[1]?.split(/^#{2,3} /m)[0];
      if (expected === optedIn) {
        expect(procedure).toMatch(/^ +jq '[^'\n]+' \\\n +\S+\/opted-in-wire\.json \\\n +> \S+\/live-cards\.json$/m);
      }
      const input = procedure?.match(/<<'NODE'\n([\s\S]*?)\n *NODE$/m)?.[1];
      expect(input, section).toBeDefined();
      const projected = `${wire}.projected`;
      execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-", replay!, projected], { cwd: root, input });
      const args = ["--baseline", projected, "--candidate", wire!, "--assert-empty"];
      writeFileSync(wire!, JSON.stringify(artifact([expected])));
      expect(await runCli(args), section).toBe(0);
      if (expected === optedIn) {
        writeFileSync(wire!, JSON.stringify(artifact([card])));
        expect(await runCli(args), section).toBe(1);
      }
    }
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

  it("enforces --assert-monotone", () => {
    const t = 1795601872, l = { evidenceLevel: "limited", limitedEvidenceCauses: ["U"] };
    const mk = (rs: Array<[string, number, Record<string, unknown>?]>, fi?: object, ne = false) => ({
      pipeline: { fixedInput: { baseInputGenerationId: "g", clockSec: t, ...fi }, candidate: { cards: rs.map(([id, score]) => ({ id, grade: "C", score })) }, ...(ne ? {} : { evaluatedSet: { assets: rs.map(([assetId, s, o = {}]) => ({ assetId, scoreInput: { pillars: { backing: { score: 80 }, exit: { score: 40 }, control: { score: 70 }, ...(o.p as object) } }, exit: { routes: o.er ?? [{}] }, control: { structuralFailures: o.sf ?? [] }, dependencyInputs: { serial: o.ser ?? [] }, trace: { finalScore: s, preCapScore: s, deploymentAdjustments: o.adj ?? [] } })) } }) },
    });
    const ev = (x: unknown, y: unknown) => detectMonotonicityViolations(x, y).violations, pm = (w: unknown[]) => parseMoverManifest({ movers: [], monotonicityWaivers: w }), gt = (v: typeof v1, w: unknown[]) => evaluateMonotonicityGate(v, pm(w), t);
    const a: Array<[string, number]> = [["a", 50]], b = mk(a), v1 = ev(b, mk([["a", 55, { p: { exit: { score: 50, ...l } }, er: [] }]])), ser = [{ upstreamAssetId: "p" }], v2 = ev(mk([["p", 70, { adj: [{ adjustmentPoints: 4 }], sf: [{}] }], ["c", 65, { ser }]]), mk([["p", 74, { p: { control: { score: 70, ...l } } }], ["c", 69, { ser }]]));
    const w = { id: "a", workstream: "w", reason: "Owner-approved waiver", ownerApprovalRef: "1", witnessCodes: [...new Set(v1[0]!.witnesses.map((x) => x.code))], expiresOn: "2026-12-31" };
    for (const x of [mk(a, { clockSec: t + 1 }), mk(a, undefined, true)]) expect(() => assertMatchingFixedInput(b, x)).toThrow(CliUsageError);
    expect(() => pm([{ ...w, id: "*" }])).toThrow();
    expect([v1[0]?.riseChannels, ev(b, mk([["a", 53, { p: { backing: { score: 90 }, control: { score: 65, ...l } } }]])), v2.map((v) => [v.assetId, v.riseChannels]), gt(v1, [w]).unwaivedViolations.length, gt([], [w]).unusedWaiverIds, gt(v1, [{ ...w, expiresOn: "2020-01-01" }]).expiredWaiverIds]).toEqual([["pillar-rise"], [], [["c", ["parent-propagated"]], ["p", ["deployment-adjustment-drop"]]], 0, ["a"], ["a"]]);
  });
});
