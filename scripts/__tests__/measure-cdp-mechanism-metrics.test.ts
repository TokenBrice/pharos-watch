import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EthCallJournal, EthCallSpec } from "../lib/mechanism-measurement/core";
import { encodeWord, ReplayEthCaller } from "../lib/mechanism-measurement/core";
import { measureConfiguredTarget } from "../lib/mechanism-measurement/measure";
import { measureLiquityV1 } from "../lib/mechanism-measurement/families/liquity-v1";
import { measureLiquityV2 } from "../lib/mechanism-measurement/families/liquity-v2";
import { MechanismMeasurementEvidenceV1Schema, type MeasurementCall } from "../lib/mechanism-measurement/schema";
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

function callerFromFixture(fixture: RecordedFixture, overrides: Map<string, string> = new Map()): EthCallJournal {
  const byCallData = new Map(fixture.calls.map((call) => [`${call.to}:${call.callData}`, call.returnData]));
  const calls: MeasurementCall[] = [];
  return {
    calls,
    logQueries: [],
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
    async queryLogs(): Promise<never> {
      throw new Error("Fixture has no recorded log queries");
    },
    recordLogsDecoded(): void {
      throw new Error("Fixture has no recorded log queries");
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
