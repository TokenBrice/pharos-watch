import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EthCallJournal, EthCallSpec } from "../lib/mechanism-measurement/core";
import { encodeWord, ReplayEthCaller } from "../lib/mechanism-measurement/core";
import { measureConfiguredTarget } from "../lib/mechanism-measurement/measure";
import { measureLiquityV1 } from "../lib/mechanism-measurement/families/liquity-v1";
import { measureLiquityV2 } from "../lib/mechanism-measurement/families/liquity-v2";
import {
  MechanismMeasurementEvidenceV1Schema,
  type MeasurementCall,
  type MeasurementLog,
  type MeasurementLogQuery,
  type MechanismMeasurementEvidenceV1,
} from "../lib/mechanism-measurement/schema";
import { redactRpcUrlForEvidence } from "../lib/mechanism-measurement/rpc-provenance";
import { captureFixture, cleanupCaptures, remote } from "./measure-cdp-mechanism-metrics.test-support";
import { gzipSync } from "node:zlib";
import { resolveCaptureBody, run } from "../maintenance/measure-cdp-mechanism-metrics";
import { CDP_MEASUREMENT_TARGETS } from "../lib/mechanism-measurement/targets";

interface RecordedFixture {
  block: { number: number; hash: string; timestampUnix: number; timestampIso: string };
  calls: MeasurementCall[];
  derived: Record<string, unknown>;
  metrics: { collateralizationRatio: number; liquidationCapacityRatio: number };
}

function loadFixture(name: string): RecordedFixture {
  return JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf8")) as RecordedFixture;
}
const FIXTURE_PATH = join(__dirname, "fixtures", "lusd-liquity-mechanism-measurement-block-25533257.json");

// Recorded live returndata from block 25533257 (finalized at capture time);
// replaying it must reproduce the committed measurement exactly, no network.
const FIXTURE = loadFixture("lusd-liquity-mechanism-measurement-block-25533257.json") as RecordedFixture & {
  derived: { priceWei: string; lastGoodPrice: { deltaPct: number } };
};

interface RecordedCalls {
  calls: readonly MeasurementCall[];
  logQueries?: readonly MeasurementLogQuery[];
}

/**
 * Keyed replay with per-call returndata overrides, for mutating one recorded
 * observation while the rest of the journal stays authentic. Log queries are
 * served in recorded order, as the pipelines issue them once each.
 */
function callerFromFixture(fixture: RecordedCalls, overrides: Map<string, string> = new Map()): EthCallJournal {
  const byCallData = new Map(fixture.calls.map((call) => [`${call.to}:${call.callData}`, call.returnData]));
  const calls: MeasurementCall[] = [];
  const logQueries: MeasurementLogQuery[] = [];
  return {
    calls,
    logQueries,
    async call(spec: EthCallSpec): Promise<string> {
      const callData = `${spec.selector}${(spec.args ?? []).map(encodeWord).join("")}`;
      const key = `${spec.to.toLowerCase()}:${callData}`;
      const returnData = overrides.get(key) ?? byCallData.get(key);
      if (!returnData) throw new Error(`No recorded returndata for ${spec.name} (${key})`);
      calls.push({
        name: spec.name,
        to: spec.to.toLowerCase(),
        signature: spec.signature,
        selector: spec.selector,
        callData,
        returnData,
        decoded: "",
      });
      return returnData;
    },
    recordDecoded(decoded: string): void {
      calls[calls.length - 1]!.decoded = decoded;
    },
    async queryLogs(): Promise<readonly MeasurementLog[]> {
      const recorded = fixture.logQueries?.[logQueries.length];
      if (!recorded) throw new Error("Fixture has no further recorded log queries");
      logQueries.push({ ...recorded, logs: recorded.logs.map((log) => ({ ...log })), decoded: "" });
      return recorded.logs;
    },
    recordLogsDecoded(decoded: string): void {
      logQueries[logQueries.length - 1]!.decoded = decoded;
    },
  };
}

const CANDIDATE = CDP_MEASUREMENT_TARGETS.find((target) => target.assetId === "lusd-liquity")!;
if (CANDIDATE.family !== "liquity-v1") throw new Error("lusd-liquity must be a liquity-v1 target");
const TARGET = CANDIDATE;
const BLOCK = { ...FIXTURE.block, selection: "operator-pinned" as const };

function recordedCaller(overrides: Map<string, string> = new Map()): EthCallJournal {
  return callerFromFixture(FIXTURE, overrides);
}

describe("redactRpcUrlForEvidence", () => {
  it("keeps only the RPC origin for evidence and logs", () => {
    expect(redactRpcUrlForEvidence("https://user:pass@example.com/v3/SECRET?apiKey=PRIVATE#fragment")).toBe(
      "https://example.com",
    );
    expect(redactRpcUrlForEvidence("https://ethereum-rpc.publicnode.com")).toBe("https://ethereum-rpc.publicnode.com");
    expect(redactRpcUrlForEvidence("not a url")).toBe("[invalid-rpc-url]");
  });
});

describe("measureLiquityV1", () => {
  it("reproduces the recorded measurement from replayed returndata", async () => {
    const caller = new ReplayEthCaller(FIXTURE.calls);
    const evidence = MechanismMeasurementEvidenceV1Schema.parse(
      await measureConfiguredTarget(caller, TARGET, BLOCK, "https://example.invalid/rpc"),
    );
    caller.assertExhausted();
    if (evidence.family !== "liquity-v1") throw new Error("Expected Liquity V1 evidence");
    expect(evidence.metrics).toEqual(FIXTURE.metrics);
    expect(evidence.derived.priceWei).toBe(FIXTURE.derived.priceWei);
    expect(evidence.derived.lastGoodPrice.deltaPct).toBe(FIXTURE.derived.lastGoodPrice.deltaPct);
    expect(evidence.checks.every((check) => check.status === "pass")).toBe(true);
  });

  it("fails closed when the derived contract graph disagrees with the pinned config", async () => {
    const overrides = new Map([
      [
        // token.troveManagerAddress() returns an unexpected address
        `${TARGET.contracts.token}:0x5a4d28bb`,
        `0x${"00".repeat(12)}${"11".repeat(20)}`,
      ],
    ]);
    await expect(
      measureLiquityV1(recordedCaller(overrides), TARGET, BLOCK, "https://example.invalid/rpc"),
    ).rejects.toThrow(/graph\.troveManager/);
  });

  it("fails closed when the protocol price diverges from Chainlink beyond tolerance", async () => {
    const badPrice = 2_100n * 10n ** 18n; // ~12% above the recorded Chainlink answer
    const overrides = new Map([
      [`${TARGET.contracts.priceFeed}:0x0fdb11cf`, `0x${encodeWord(badPrice)}`],
      // getTCR/checkRecoveryMode take the price as an argument, so their
      // recorded returndata would not match; the run must abort before them.
    ]);
    await expect(
      measureLiquityV1(recordedCaller(overrides), TARGET, BLOCK, "https://example.invalid/rpc"),
    ).rejects.toThrow(/price\.chainlink-agree/);
  });
});

describe("measureLiquityV2", () => {
  const V2_FIXTURE = loadFixture("bold-liquity-mechanism-measurement-block-25533671.json");
  const V2_CANDIDATE = CDP_MEASUREMENT_TARGETS.find((target) => target.assetId === "bold-liquity")!;
  if (V2_CANDIDATE.family !== "liquity-v2") throw new Error("bold-liquity must be a liquity-v2 target");
  const V2_TARGET = V2_CANDIDATE;
  const V2_BLOCK = { ...V2_FIXTURE.block, selection: "operator-pinned" as const };

  it("reproduces the recorded multi-branch measurement from replayed returndata", async () => {
    const caller = new ReplayEthCaller(V2_FIXTURE.calls);
    const evidence = MechanismMeasurementEvidenceV1Schema.parse(
      await measureConfiguredTarget(caller, V2_TARGET, V2_BLOCK, "https://example.invalid/rpc"),
    );
    caller.assertExhausted();
    if (evidence.family !== "liquity-v2") throw new Error("Expected Liquity V2 evidence");
    expect(evidence.metrics).toEqual(V2_FIXTURE.metrics);
    expect(evidence.derived.branches).toHaveLength(3);
    expect(evidence.derived.branchCappedLiquidationCapacityRatio).toBe(
      (V2_FIXTURE.derived as { branchCappedLiquidationCapacityRatio: number }).branchCappedLiquidationCapacityRatio,
    );
    expect(evidence.derived.priceCrossCheck.mode).toBe("chainlink-branch0");
    expect(evidence.checks.every((check) => check.status === "pass")).toBe(true);
  });

  it("fails closed on a shut-down branch and on a non-redeemable price", async () => {
    const branch0TroveManager = (V2_FIXTURE.derived as { branches: Array<{ troveManager: string }> }).branches[0]!
      .troveManager;
    const shutDown = new Map([[`${branch0TroveManager}:0x58569081`, `0x${encodeWord(1_750_000_000n)}`]]);
    await expect(
      measureLiquityV2(callerFromFixture(V2_FIXTURE, shutDown), V2_TARGET, V2_BLOCK, "https://example.invalid/rpc"),
    ).rejects.toThrow(/not-shut-down/);

    // redeemable=false with an otherwise valid price must abort
    const recorded = V2_FIXTURE.calls.find(
      (call) => call.to === branch0TroveManager && call.selector === "0x4ea15f37",
    )!;
    const notRedeemable = new Map([
      [`${branch0TroveManager}:0x4ea15f37`, `${recorded.returnData.slice(0, 2 + 64 * 2)}${"0".repeat(64)}`],
    ]);
    await expect(
      measureLiquityV2(
        callerFromFixture(V2_FIXTURE, notRedeemable),
        V2_TARGET,
        V2_BLOCK,
        "https://example.invalid/rpc",
      ),
    ).rejects.toThrow(/branch\[0\]\.price/);
  });
});

/**
 * Original recorded journals for the remaining configured families, recovered
 * byte-identically from the history that moved capture bodies to R2; each one
 * still hashes to its committed capture summary (asserted below), so replaying
 * them exercises the real family pipelines against authentic returndata.
 */
const FAMILY_JOURNALS = [
  {
    assetId: "audm-mento",
    fixture: "audm-mento-mechanism-measurement-block-72202914.json",
    capture: "audm-mento/2026-07-15-block-72202914.summary.json",
  },
  {
    assetId: "gho-aave",
    fixture: "gho-aave-mechanism-measurement-block-25536894.json",
    capture: "gho-aave/2026-07-15-block-25536894.summary.json",
  },
  {
    assetId: "usdq-quill",
    fixture: "usdq-quill-mechanism-measurement-block-34367075.json",
    capture: "usdq-quill/2026-07-15-block-34367075.summary.json",
  },
  {
    assetId: "fxusd-f-x-protocol",
    fixture: "fxusd-f-x-protocol-mechanism-measurement-block-25536894.json",
    capture: "fxusd-f-x-protocol/2026-07-15-block-25536894.summary.json",
  },
  {
    assetId: "fxsave-f-x-protocol",
    fixture: "fxsave-f-x-protocol-mechanism-measurement-block-25536894.json",
    capture: "fxsave-f-x-protocol/2026-07-15-block-25536894.summary.json",
  },
] as const;

type FamilyAssetId = (typeof FAMILY_JOURNALS)[number]["assetId"];

function loadJournal(assetId: FamilyAssetId): MechanismMeasurementEvidenceV1 {
  const entry = FAMILY_JOURNALS.find((candidate) => candidate.assetId === assetId)!;
  return MechanismMeasurementEvidenceV1Schema.parse(
    JSON.parse(readFileSync(join(__dirname, "fixtures", entry.fixture), "utf8")),
  );
}

function configuredTarget(assetId: string) {
  const target = CDP_MEASUREMENT_TARGETS.find((candidate) => candidate.assetId === assetId);
  if (!target) throw new Error(`No configured measurement target for ${assetId}`);
  return target;
}

/**
 * Recompute evidence from a recorded journal through the configured target.
 * Without overrides the strict ordered replayer is used, so a pipeline that
 * skips, reorders or invents a call fails instead of silently agreeing.
 */
async function recomputeFromJournal(
  recorded: MechanismMeasurementEvidenceV1,
  overrides?: Map<string, string>,
): Promise<MechanismMeasurementEvidenceV1> {
  const target = configuredTarget(recorded.assetId);
  const caller = overrides
    ? callerFromFixture(recorded, overrides)
    : new ReplayEthCaller(recorded.calls, recorded.logQueries ?? []);
  const evidence = MechanismMeasurementEvidenceV1Schema.parse(
    await measureConfiguredTarget(caller, target, recorded.block, recorded.rpcUrl),
  );
  if (caller instanceof ReplayEthCaller) caller.assertExhausted();
  return evidence;
}

describe("recorded family measurement replay", () => {
  it.each(FAMILY_JOURNALS)("replays the original $assetId capture byte-identically", async ({ assetId, capture }) => {
    const summary = JSON.parse(
      readFileSync(
        join(__dirname, "..", "..", "shared", "data", "safety-score-v9", "mechanism-measurements", capture),
        "utf8",
      ),
    ) as { sha256: string; bytes: number };
    const entry = FAMILY_JOURNALS.find((candidate) => candidate.assetId === assetId)!;
    const bytes = readFileSync(join(__dirname, "fixtures", entry.fixture));
    // Provenance: the fixture is the capture the committed summary pins.
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(summary.sha256);
    expect(bytes.byteLength).toBe(summary.bytes);

    const recorded = MechanismMeasurementEvidenceV1Schema.parse(JSON.parse(bytes.toString("utf8")));
    expect(await recomputeFromJournal(recorded)).toEqual(recorded);
  });

  it("reports analogous capacity instead of liquidation capacity for conversion, facilitator and wrapper mechanisms", async () => {
    const mento = await recomputeFromJournal(loadJournal("audm-mento"));
    const gho = await recomputeFromJournal(loadJournal("gho-aave"));
    const wrapper = await recomputeFromJournal(loadJournal("fxsave-f-x-protocol"));
    for (const evidence of [mento, gho, wrapper]) {
      expect(evidence.metrics.collateralizationRatio).toBeNull();
      expect(evidence.metrics.liquidationCapacityRatio).toBeNull();
      const applicability = evidence.metrics.applicability;
      if (applicability?.liquidationCapacityRatio.state !== "not-applicable") {
        throw new Error(`${evidence.assetId} must classify liquidation capacity as not-applicable`);
      }
      expect(applicability.collateralizationRatio.state).toBe("not-applicable");
      expect(applicability.liquidationCapacityRatio.rationale.length).toBeGreaterThan(0);
    }

    // Each family keeps its own measured analogue rather than reporting it as capacity.
    if (mento.family !== "mento-conversion-evidence-v1") throw new Error("Expected Mento conversion evidence");
    expect(mento.analogousMetrics.conversionCapacityCounterUnits).toBeGreaterThan(0);
    if (gho.family !== "gho-facilitator-evidence-v1") throw new Error("Expected GHO facilitator evidence");
    expect(gho.analogousMetrics.facilitatorUnusedCapacityRatio).toBeGreaterThan(0);
    if (wrapper.family !== "wrapper-mechanism-v1") throw new Error("Expected wrapper evidence");
    expect(wrapper.analogousMetrics.localBackingRatio).toBeGreaterThan(0);

    for (const assetId of ["usdq-quill", "fxusd-f-x-protocol"] as const) {
      const evidence = await recomputeFromJournal(loadJournal(assetId));
      expect(evidence.metrics.applicability).toEqual({
        collateralizationRatio: { state: "measured" },
        liquidationCapacityRatio: { state: "measured" },
      });
      expect(evidence.metrics.collateralizationRatio).toBeGreaterThan(0);
      expect(evidence.metrics.liquidationCapacityRatio).toBeGreaterThan(0);
    }
  });

  it("holds the wrapper incomplete on its unattached parent while the parent itself clears", async () => {
    const wrapper = await recomputeFromJournal(loadJournal("fxsave-f-x-protocol"));
    const parentTarget = configuredTarget("fxsave-f-x-protocol");
    if (parentTarget.family !== "wrapper-mechanism-v1") throw new Error("fxsave must be a wrapper target");
    expect(wrapper.completeness).toEqual({ complete: false, blockers: [parentTarget.blocker] });
    // The blocker is surfaced to overlay consumers, not only recorded internally.
    expect(wrapper.warnings).toEqual([parentTarget.blocker]);
    if (wrapper.family !== "wrapper-mechanism-v1") throw new Error("Expected wrapper evidence");
    expect(wrapper.derived.parentAssetId).toBe(parentTarget.parentAssetId);

    const parent = await recomputeFromJournal(loadJournal("fxusd-f-x-protocol"));
    expect(parent.completeness).toEqual({ complete: true, blockers: [] });
  });

  it("derives branch shutdown and non-redeemability from recorded enumerated state", async () => {
    const recorded = loadJournal("usdq-quill");
    const evidence = await recomputeFromJournal(recorded);
    if (evidence.family !== "liquity-v2-enumerated-v1") throw new Error("Expected enumerated Liquity evidence");
    const unhealthy = evidence.derived.branches.filter((branch) => branch.shutdownTime !== 0 || !branch.redeemable);
    expect(unhealthy.map((branch) => branch.index)).toEqual([3]);
    const checkIds = evidence.checks.map((check) => check.id);
    expect(checkIds).toContain("branch[3].health-state-captured");
    expect(checkIds).not.toContain("branch[0].health-state-captured");
    // Both the shutdown and the non-redeemable oracle state raise their own warning.
    expect(evidence.warnings).toHaveLength(2);

    const branch0 = evidence.derived.branches[0]!;
    const shutDown = await recomputeFromJournal(
      recorded,
      new Map([[`${branch0.troveManager}:0x58569081`, `0x${encodeWord(1_784_100_000n)}`]]),
    );
    if (shutDown.family !== "liquity-v2-enumerated-v1") throw new Error("Expected enumerated Liquity evidence");
    expect(shutDown.derived.branches[0]!.shutdownTime).toBe(1_784_100_000);
    expect(shutDown.checks.map((check) => check.id)).toContain("branch[0].health-state-captured");
    expect(shutDown.warnings).toHaveLength(3);
    // A shut-down branch is retained in the aggregate, not silently dropped.
    expect(shutDown.metrics).toEqual(evidence.metrics);
  });

  it("raises an f(x) pause warning only when a recorded pool reports borrowing paused", async () => {
    const recorded = loadJournal("fxusd-f-x-protocol");
    const evidence = await recomputeFromJournal(recorded);
    if (evidence.family !== "fx-protocol-v1") throw new Error("Expected f(x) evidence");
    expect(evidence.derived.pools.map((pool) => pool.borrowPaused)).toEqual([false, false]);
    expect(evidence.warnings).toBeUndefined();

    const paused = await recomputeFromJournal(
      recorded,
      new Map([[`${evidence.derived.pools[0]!.address}:0x70f3c4b1`, `0x${encodeWord(1n)}`]]),
    );
    if (paused.family !== "fx-protocol-v1") throw new Error("Expected f(x) evidence");
    expect(paused.derived.pools.map((pool) => pool.borrowPaused)).toEqual([true, false]);
    expect(paused.warnings).toHaveLength(1);
    expect(paused.completeness).toEqual({ complete: true, blockers: [] });
  });
});
describe("CDP replay CLI seam", () => {
  it("replays a committed artifact in-process without using the process streams", async () => {
    const logs: string[] = [];
    const warnings: string[] = [];
    const errors: string[] = [];
    const status = await run({
      argv: ["--replay", FIXTURE_PATH],
      io: {
        error: (message) => errors.push(message),
        log: (message) => logs.push(message),
        warn: (message) => warnings.push(message),
      },
    });

    expect(status).toBe(0);
    expect(logs.join("")).toContain("[measure-cdp] lusd-liquity: offline byte replay passed");
    expect(warnings).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("returns a runtime status and captured diagnostic for a missing artifact", async () => {
    const errors: string[] = [];
    const status = await run({
      argv: ["--replay", "missing-cdp-artifact.json"],
      io: { error: (message) => errors.push(message) },
    });

    expect(status).toBe(1);
    expect(errors.join("")).toContain("measure-cdp-mechanism-metrics: Missing mechanism evidence capture or summary:");
  });
});


afterEach(cleanupCaptures);

describe("capture resolution", () => {
  it("resolves opaque cached bytes without contacting R2", async () => {
    const capture = captureFixture();
    writeFileSync(capture.cachePath, capture.body);
    const get = vi.fn(async () => { throw new Error("offline"); });
    expect(await resolveCaptureBody(capture.bodyPath, { ...capture, r2Client: remote(get) })).toEqual(capture.body);
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects tampered cache bytes rather than falling through to R2", async () => {
    const capture = captureFixture();
    writeFileSync(capture.cachePath, "tampered");
    const get = vi.fn(async () => capture.body);
    await expect(resolveCaptureBody(capture.bodyPath, { ...capture, r2Client: remote(get) })).rejects.toThrow(/integrity mismatch/);
    expect(get).not.toHaveBeenCalled();
  });

  it("prefers pinned data and persists it for a subsequent offline read", async () => {
    const capture = captureFixture();
    const get = vi.fn(async (key: string) => key.startsWith("pinned/") ? capture.body : Buffer.from("wrong ordinary data"));
    expect(await resolveCaptureBody(capture.bodyPath, { ...capture, r2Client: remote(get) })).toEqual(capture.body);
    expect(get.mock.calls.map(([key]) => key)).toEqual([capture.r2Key.replace("captures/", "pinned/")]);
    expect(readFileSync(capture.cachePath)).toEqual(capture.body);
    const offline = remote(async () => { throw new Error("offline"); });
    expect(await resolveCaptureBody(capture.bodyPath, { ...capture, r2Client: offline })).toEqual(capture.body);
  });

  it("falls through missing pinned data to gzip ordinary data and rejects total absence", async () => {
    const capture = captureFixture();
    const get = vi.fn(async (key: string) => key.startsWith("pinned/") ? null : gzipSync(capture.body));
    expect(await resolveCaptureBody(capture.bodyPath, { ...capture, r2Client: remote(get) })).toEqual(capture.body);
    expect(get.mock.calls.map(([key]) => key)).toEqual([capture.r2Key.replace("captures/", "pinned/"), capture.r2Key]);
    rmSync(capture.cachePath);
    await expect(resolveCaptureBody(capture.bodyPath, { ...capture, r2Client: remote(async () => null) })).rejects.toThrow(
      "capture " + capture.sha256 + " expired: non-replayable",
    );
  });

  it("rejects remote corruption without writing cache", async () => {
    const capture = captureFixture();
    await expect(resolveCaptureBody(capture.bodyPath, { ...capture, r2Client: remote(async () => gzipSync(Buffer.from("tampered"))) })).rejects.toThrow(/integrity mismatch/);
    expect(existsSync(capture.cachePath)).toBe(false);
  });

  it("prefers the local artifact over corrupt cache and remote storage", async () => {
    const capture = captureFixture();
    writeFileSync(capture.bodyPath, "local artifact");
    writeFileSync(capture.cachePath, "corrupt cache");
    const get = vi.fn(async () => { throw new Error("offline"); });
    expect(await resolveCaptureBody(capture.bodyPath, { ...capture, r2Client: remote(get) })).toEqual(Buffer.from("local artifact"));
    expect(get).not.toHaveBeenCalled();
  });
});
