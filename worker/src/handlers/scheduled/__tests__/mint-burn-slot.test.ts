import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledRuntimeContext } from "../context";
import { makeScheduledRuntime } from "../../../test-helpers/scheduled-runtime.test-support";
import { recordOutcomeDecision, shouldAttemptFetch } from "../../../lib/circuit-breaker";
import { fetchEvmBlockNumber, requestJsonRpcAtUrl } from "../../../lib/evm-rpc";
import { CIRCUIT_SOURCE } from "../../../lib/constants";
import type { RpcEndpoint } from "../../../lib/chain-registry";
import { withRpcRequestOperation, withRpcRequestScope } from "../../../lib/rpc-request-observer";
import { hasTerminalMintBurnRpcFailure } from "../../../cron/mint-burn/sync-config";
import { getAlchemyTransactionContextBatchMany } from "../../../lib/alchemy-logs";
import { TronJsonRpcReader } from "../../../lib/tron-jsonrpc";
import { createDwellirNativeCapability } from "../../../lib/dwellir-native";

const mocks = vi.hoisted(() => ({
  syncMintBurn: vi.fn(),
  refreshAggregateMintBurnFlowCache: vi.fn(),
}));

vi.mock("../../../cron/sync-mint-burn", () => ({ syncMintBurn: mocks.syncMintBurn }));
vi.mock("../../../api/mint-burn-flows", () => ({
  refreshAggregateMintBurnFlowCache: mocks.refreshAggregateMintBurnFlowCache,
}));
vi.mock("../../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: vi.fn(async () => true),
  recordOutcomeDecision: vi.fn(async () => undefined),
  mapCronStatusToCircuitOutcome: vi.fn((status: string | null | undefined) =>
    status === "error" ? "failure" : status == null || status === "ok" ? "success" : "neutral"),
}));

import { runHalfHourlyMintBurnCriticalSlot } from "../twenty-minute-mint-burn-critical";
import { runHalfHourlyMintBurnExtendedSlot } from "../twenty-minute-mint-burn-extended";

const ALCHEMY_URL = "https://alchemy-r2.example.test";
const DWELLIR_URL = "https://dwellir-r2.example.test";

function withProviders(rt: ScheduledRuntimeContext): ScheduledRuntimeContext {
  const endpoints: RpcEndpoint[] = [
    { url: ALCHEMY_URL, operator: "alchemy", keyed: true, position: "registry", stateHistory: "archive", logsHistory: "full" },
    { url: DWELLIR_URL, operator: "dwellir", keyed: true, position: "registry", stateHistory: "archive", logsHistory: "full" },
  ];
  rt.chainRpcs.set("ethereum", { chainId: "ethereum", chainName: "Ethereum", type: "evm", explorerUrl: "", endpoints });
  return rt;
}

function rpcRead(url: string, signal?: AbortSignal) {
  return requestJsonRpcAtUrl(url, { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }, { signal, maxRetries: 0 });
}

function configRead(url: string, failed = true, affectsRun = true) {
  return configScope(url, () => rpcRead(url), () => failed, affectsRun);
}

function configScope<T>(key: string, run: () => Promise<T>, failed: (result: T) => boolean, affectsRun = true) {
  return withRpcRequestScope({ kind: "config", key, affectsRun }, () =>
    withRpcRequestOperation(key, "test-read", run, failed), failed);
}

function runtime(scheduleKey: string, cron: string): ScheduledRuntimeContext {
  const signal = new AbortController().signal;
  return makeScheduledRuntime({
    scheduleKey: scheduleKey as ScheduledRuntimeContext["scheduleKey"],
    cron,
    runLeasedCron: vi.fn(async (_job, fn) => fn(signal, vi.fn())),
  });
}

describe("mint/burn slot lanes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(shouldAttemptFetch).mockResolvedValue(true);
    mocks.syncMintBurn.mockResolvedValue({ status: "ok", itemCount: 1 });
    mocks.refreshAggregateMintBurnFlowCache.mockImplementation(async () =>
      new Response("{}", { headers: { "X-Data-Freshness": "fresh" } }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("runs the critical lane with 24h and 168h aggregate cache publication", async () => {
    const rt = runtime("halfHourlyMintBurnCritical", "4 * * * *");

    const summary = await runHalfHourlyMintBurnCriticalSlot(rt);

    expect(mocks.syncMintBurn).toHaveBeenCalledWith(
      rt.db,
      rt.env.ALCHEMY_API_KEY ?? null,
      expect.objectContaining({ lane: "critical", jobName: "sync-mint-burn" }),
    );
    expect(mocks.refreshAggregateMintBurnFlowCache).toHaveBeenCalledWith(rt.db, 24);
    expect(mocks.refreshAggregateMintBurnFlowCache).toHaveBeenCalledWith(rt.db, 168);
    expect(summary.jobs.map((job) => job.job)).toEqual(["sync-mint-burn"]);
  });

  it("retains FTQ advisories without degrading completed fresh flow publication", async () => {
    const warning = '199 - "Flight-to-quality classification is unavailable (publication-held)."';
    mocks.refreshAggregateMintBurnFlowCache.mockImplementation(async () =>
      new Response("{}", { headers: { "X-Data-Freshness": "fresh", Warning: warning } }));
    const rt = runtime("halfHourlyMintBurnCritical", "4 * * * *");

    const summary = await runHalfHourlyMintBurnCriticalSlot(rt);
    const result = await vi.mocked(rt.runLeasedCron).mock.results[0].value;

    expect(summary.jobs[0]).toMatchObject({ status: "ok", outcome: "ok" });
    expect(JSON.parse(result?.metadata ?? "{}").sidecars[0]).toMatchObject({
      status: "ok", reason: null, itemCount: 2,
      windows: [
        { hours: 24, published: true, freshness: "fresh", warning },
        { hours: 168, published: true, freshness: "fresh", warning },
      ],
    });
  });

  it.each(["degraded", "stale", "unknown", null])(
    "degrades published windows with %s flow freshness",
    async (freshness) => {
      mocks.refreshAggregateMintBurnFlowCache.mockImplementation(async () =>
        new Response("{}", { headers: freshness == null ? {} : { "X-Data-Freshness": freshness } }));
      const summary = await runHalfHourlyMintBurnCriticalSlot(runtime("halfHourlyMintBurnCritical", "4 * * * *"));

      expect(summary.jobs[0]).toMatchObject({
        status: "degraded", reason: "mint-burn-aggregate-freshness-unavailable",
      });
    },
  );

  it("names a failed aggregate publication without claiming the scan failed", async () => {
    mocks.refreshAggregateMintBurnFlowCache
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("{}", { headers: { "X-Data-Freshness": "fresh" } }));
    const rt = runtime("halfHourlyMintBurnCritical", "4 * * * *");

    const summary = await runHalfHourlyMintBurnCriticalSlot(rt);
    const result = await vi.mocked(rt.runLeasedCron).mock.results[0].value;

    expect(summary.jobs[0]).toMatchObject({
      status: "degraded", reason: "mint-burn-aggregate-publication-failed",
    });
    expect(JSON.parse(result?.metadata ?? "{}").sidecars[0]).toMatchObject({
      status: "error", reason: "mint-burn-aggregate-publication-failed", itemCount: 1,
    });
  });

  it("preserves a primary scan failure reason when aggregate publication also fails", async () => {
    mocks.syncMintBurn.mockResolvedValue({
      status: "degraded", itemCount: 1, metadata: JSON.stringify({ reason: "finality-head-unavailable" }),
    });
    mocks.refreshAggregateMintBurnFlowCache.mockImplementation(async () => {
      throw new Error("cache write failed");
    });
    const summary = await runHalfHourlyMintBurnCriticalSlot(runtime("halfHourlyMintBurnCritical", "4 * * * *"));

    expect(summary.jobs[0]).toMatchObject({ status: "degraded", reason: "finality-head-unavailable" });
  });

  it("runs the extended lane without aggregate cache publication", async () => {
    const rt = runtime("halfHourlyMintBurnExtended", "18 * * * *");

    const summary = await runHalfHourlyMintBurnExtendedSlot(rt);

    expect(mocks.syncMintBurn).toHaveBeenCalledWith(
      rt.db,
      rt.env.ALCHEMY_API_KEY ?? null,
      expect.objectContaining({ lane: "extended", jobName: "sync-mint-burn-extended" }),
    );
    expect(mocks.refreshAggregateMintBurnFlowCache).not.toHaveBeenCalled();
    expect(summary.jobs.map((job) => job.job)).toEqual(["sync-mint-burn-extended"]);
  });

  it.each([runHalfHourlyMintBurnCriticalSlot, runHalfHourlyMintBurnExtendedSlot])(
    "keeps non-Alchemy failures separate through degraded-to-error escalation (%#)",
    async (runSlot) => {
      vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify({ id: 1, result: "0x7b" }), {
        status: url === DWELLIR_URL ? 503 : 200,
      })));
      const rt = withProviders(runtime("halfHourlyMintBurnCritical", "4 * * * *"));
      for (const status of ["degraded", "degraded", "error"] as const) {
        mocks.syncMintBurn.mockImplementationOnce(async () => {
          await configRead(DWELLIR_URL);
          await configRead(ALCHEMY_URL, false);
          return { status, metadata: JSON.stringify({ reason: "mint-burn-source-coverage-degraded" }) };
        });
        await runSlot(rt);
      }
      expect(vi.mocked(recordOutcomeDecision).mock.calls.every(([, source]) => source === CIRCUIT_SOURCE.ALCHEMY)).toBe(true);
      expect(vi.mocked(recordOutcomeDecision).mock.calls.filter(([, source, decision]) =>
        source === CIRCUIT_SOURCE.ALCHEMY && decision === "neutral")).toHaveLength(3);
      expect(recordOutcomeDecision).not.toHaveBeenCalledWith(rt.db, CIRCUIT_SOURCE.ALCHEMY, "failure");
      const result = await vi.mocked(rt.runLeasedCron).mock.results[2].value;
      expect(JSON.parse(result?.metadata ?? "{}").providerOutcomes).toEqual(expect.arrayContaining([
        expect.objectContaining({ provider: "dwellir", circuitSource: null, successes: 0, failures: 1, terminalFailures: 1 }),
        expect.objectContaining({ provider: "alchemy", successes: 1, failures: 0 }),
      ]));
    },
  );

  it("records successful run outcome despite recovered request failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connection reset"); }));
    mocks.syncMintBurn.mockImplementationOnce(async () => {
      await rpcRead(ALCHEMY_URL);
      return { status: "ok" };
    });
    const rt = withProviders(runtime("halfHourlyMintBurnExtended", "18 * * * *"));
    await runHalfHourlyMintBurnExtendedSlot(rt);
    expect(recordOutcomeDecision).toHaveBeenCalledExactlyOnceWith(rt.db, CIRCUIT_SOURCE.ALCHEMY, "success");
  });

  it.each([
    { status: "ok", decision: "success" },
    { status: "degraded", decision: "neutral" },
    { status: "error", decision: "failure" },
  ])("keeps run-level $status semantics for terminal Alchemy failure", async ({ status, decision }) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: 1, result: null }), { status: 503 })));
    const rt = withProviders(runtime("halfHourlyMintBurnCritical", "4 * * * *"));
    mocks.syncMintBurn.mockImplementationOnce(async () => {
      await configRead(ALCHEMY_URL);
      return { status };
    });
    await runHalfHourlyMintBurnCriticalSlot(rt);
    expect(recordOutcomeDecision).toHaveBeenCalledExactlyOnceWith(rt.db, CIRCUIT_SOURCE.ALCHEMY, decision);
  });

  it("retains Alchemy protection when another Alchemy config succeeds", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 1, result: "0x7b" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 1, result: null }), { status: 503 })));
    const rt = withProviders(runtime("halfHourlyMintBurnCritical", "4 * * * *"));
    mocks.syncMintBurn.mockImplementationOnce(async () => {
      await configScope("healthy", () => rpcRead(ALCHEMY_URL), () => false);
      await configScope("failed", () => rpcRead(ALCHEMY_URL), () => true);
      return { status: "error" };
    });
    await runHalfHourlyMintBurnCriticalSlot(rt);
    expect(recordOutcomeDecision).toHaveBeenCalledExactlyOnceWith(rt.db, CIRCUIT_SOURCE.ALCHEMY, "failure");
  });

  it("does not attribute a recovered Alchemy split to another provider's terminal failure", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 1, result: null }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 1, result: "0x7b" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 1, result: null }), { status: 503 })));
    const rt = withProviders(runtime("halfHourlyMintBurnCritical", "4 * * * *"));
    mocks.syncMintBurn.mockImplementationOnce(async () => {
      await configScope("recovered", async () => {
        await rpcRead(ALCHEMY_URL);
        await rpcRead(ALCHEMY_URL);
      }, () => false);
      await configRead(DWELLIR_URL);
      return { status: "error" };
    });
    await runHalfHourlyMintBurnCriticalSlot(rt);
    expect(recordOutcomeDecision).toHaveBeenCalledExactlyOnceWith(rt.db, CIRCUIT_SOURCE.ALCHEMY, "neutral");
  });

  it("keeps a recovered Alchemy split plus a decode-only config error neutral", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 1, result: null }), { status: 504 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 1, result: "0x7b" }))));
    const rt = withProviders(runtime("halfHourlyMintBurnCritical", "4 * * * *"));
    mocks.syncMintBurn.mockImplementationOnce(async () => {
      await configScope("decode-only", async () => {
        await rpcRead(ALCHEMY_URL);
        await rpcRead(ALCHEMY_URL);
        return { rpcEvidenceIncomplete: false, newLastBlock: null,
          summary: { advanceReason: "scan-coverage-unproven" as const }, apiErrors: 1 };
      }, hasTerminalMintBurnRpcFailure);
      return { status: "error" };
    });
    await runHalfHourlyMintBurnCriticalSlot(rt);
    expect(recordOutcomeDecision).toHaveBeenCalledExactlyOnceWith(rt.db, CIRCUIT_SOURCE.ALCHEMY, "neutral");
  });

  it("does not blame recovered Alchemy work for a later Dwellir-only failure in the same config", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 1, result: null }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 1, result: "0x7b" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 1, result: null }), { status: 503 })));
    const rt = withProviders(runtime("halfHourlyMintBurnCritical", "4 * * * *"));
    mocks.syncMintBurn.mockImplementationOnce(async () => {
      await withRpcRequestScope({ kind: "config", key: "mixed", affectsRun: true }, async () => {
        await withRpcRequestOperation("mixed", "recovered-logs", async () => {
          await rpcRead(ALCHEMY_URL);
          await rpcRead(DWELLIR_URL);
        }, () => false);
        await withRpcRequestOperation("mixed", "unavailable-context", () => rpcRead(DWELLIR_URL), () => true);
      }, () => true);
      return { status: "error" };
    });
    await runHalfHourlyMintBurnCriticalSlot(rt);
    expect(recordOutcomeDecision).toHaveBeenCalledExactlyOnceWith(rt.db, CIRCUIT_SOURCE.ALCHEMY, "neutral");
  });

  it("preserves a failed Alchemy operation when a different operation succeeds in the same config", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 1, result: null }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 1, result: "0x7b" }))));
    const rt = withProviders(runtime("halfHourlyMintBurnCritical", "4 * * * *"));
    mocks.syncMintBurn.mockImplementationOnce(async () => {
      await withRpcRequestScope({ kind: "config", key: "mixed", affectsRun: true }, async () => {
        await withRpcRequestOperation("mixed", "failed-topic", () => rpcRead(ALCHEMY_URL), () => true);
        await withRpcRequestOperation("mixed", "healthy-topic", () => rpcRead(ALCHEMY_URL), () => false);
      }, () => true);
      return { status: "error" };
    });
    await runHalfHourlyMintBurnCriticalSlot(rt);
    expect(recordOutcomeDecision).toHaveBeenCalledExactlyOnceWith(rt.db, CIRCUIT_SOURCE.ALCHEMY, "failure");
  });

  it("discards failed operations from an earlier retry attempt", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: 1, result: null }), { status: 503 })));
    const rt = withProviders(runtime("halfHourlyMintBurnCritical", "4 * * * *"));
    mocks.syncMintBurn.mockImplementationOnce(async () => {
      await withRpcRequestScope({ kind: "config", key: "retried", affectsRun: true }, async () => {
        await withRpcRequestScope({ kind: "config-attempt", key: "retried", affectsRun: true }, () =>
          withRpcRequestOperation("retried", "old-topic", () => rpcRead(ALCHEMY_URL), () => true), () => false);
        await withRpcRequestScope({ kind: "config-attempt", key: "retried", affectsRun: true }, () =>
          withRpcRequestOperation("retried", "final-topic", () => rpcRead(DWELLIR_URL), () => true), () => false);
      }, () => true);
      return { status: "error" };
    });
    await runHalfHourlyMintBurnCriticalSlot(rt);
    expect(recordOutcomeDecision).toHaveBeenCalledExactlyOnceWith(rt.db, CIRCUIT_SOURCE.ALCHEMY, "neutral");
  });

  it("keeps maintenance failures out of required operation attribution", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: 1, result: null }), { status: 503 })));
    const rt = withProviders(runtime("halfHourlyMintBurnCritical", "4 * * * *"));
    mocks.syncMintBurn.mockImplementationOnce(async () => {
      await withRpcRequestScope({ kind: "config", key: "maintenance", affectsRun: true }, async () => {
        await withRpcRequestOperation("maintenance", "required-context", () => rpcRead(DWELLIR_URL), () => true);
        await rpcRead(ALCHEMY_URL);
      }, () => true);
      return { status: "error" };
    });
    await runHalfHourlyMintBurnCriticalSlot(rt);
    expect(recordOutcomeDecision).toHaveBeenCalledExactlyOnceWith(rt.db, CIRCUIT_SOURCE.ALCHEMY, "neutral");
  });

  it("retains Alchemy protection when a required transaction-context transport fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connection reset"); }));
    const rt = withProviders(runtime("halfHourlyMintBurnCritical", "4 * * * *"));
    mocks.syncMintBurn.mockImplementationOnce(async () => {
      await configScope("context", () => getAlchemyTransactionContextBatchMany(ALCHEMY_URL, ["0xtx"], { count: 0, limit: 10 }),
        (contexts) => contexts.get("0xtx")?.tx == null);
      return { status: "error" };
    });
    await runHalfHourlyMintBurnCriticalSlot(rt);
    expect(recordOutcomeDecision).toHaveBeenCalledExactlyOnceWith(rt.db, CIRCUIT_SOURCE.ALCHEMY, "failure");
  });

  it("does not attribute pending config failures or local exceptions to Alchemy run failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: 1, result: null }), { status: 503 })));
    const rt = withProviders(runtime("halfHourlyMintBurnCritical", "4 * * * *"));
    mocks.syncMintBurn.mockImplementationOnce(async () => {
      await configRead(ALCHEMY_URL, true, false);
      return { status: "error" };
    });
    await runHalfHourlyMintBurnCriticalSlot(rt);
    expect(recordOutcomeDecision).toHaveBeenCalledExactlyOnceWith(rt.db, CIRCUIT_SOURCE.ALCHEMY, "neutral");
    vi.mocked(recordOutcomeDecision).mockClear();
    mocks.syncMintBurn.mockImplementationOnce(async () => {
      await configScope("local-error", async () => {
        await rpcRead(ALCHEMY_URL);
        throw new Error("D1 write failed");
      }, () => true);
    });
    await expect(runHalfHourlyMintBurnCriticalSlot(rt)).rejects.toThrow("D1 write failed");
    expect(recordOutcomeDecision).not.toHaveBeenCalled();
  });

  it.each([false, true])("attributes failed chain heads only when admitted scope is affected (%s)", async (admitted) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: 1, result: null }), { status: 503 })));
    const rt = withProviders(runtime("halfHourlyMintBurnCritical", "4 * * * *"));
    mocks.syncMintBurn.mockImplementationOnce(async () => {
      await withRpcRequestScope({ kind: "chain-head", key: "synthetic-chain", affectsRun: true }, () => rpcRead(ALCHEMY_URL), () => true);
      return { status: "error", metadata: JSON.stringify({ admittedFinalityUnavailableChains: admitted ? ["synthetic-chain"] : [] }) };
    });
    await runHalfHourlyMintBurnCriticalSlot(rt);
    expect(recordOutcomeDecision).toHaveBeenCalledExactlyOnceWith(rt.db, CIRCUIT_SOURCE.ALCHEMY, admitted ? "failure" : "neutral");
  });

  it.each([true, false])("keeps real Tron reader outcomes diagnostic without circuit writes (healthy fallback: %s)", async (healthyFallback) => {
    const timestamp = Math.floor(Date.now() / 1000);
    const hash = `0x${"a".repeat(64)}`;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes("dwellir") || !healthyFallback) return new Response("unavailable", { status: 503 });
      if (url.endsWith("/walletsolidity/getnowblock")) return Response.json({
        blockID: hash.slice(2), block_header: { raw_data: { number: 100, timestamp: timestamp * 1000 } },
      });
      const body = JSON.parse(String(init.body));
      return Response.json({ jsonrpc: "2.0", id: body.id, result: body.method === "eth_blockNumber"
        ? "0x65" : { number: "0x64", hash, timestamp: `0x${timestamp.toString(16)}` } });
    }));
    const rt = runtime("halfHourlyMintBurnCritical", "4 * * * *");
    rt.dwellirNative = createDwellirNativeCapability("test-key");
    rt.env.TRONGRID_API_KEY = "test-grid-key";
    mocks.syncMintBurn.mockImplementationOnce(async (_db, _key, options) => {
      expect(options.dwellirNative).toBe(rt.dwellirNative);
      expect(options.trongridApiKey).toBe(rt.env.TRONGRID_API_KEY);
      const reader = new TronJsonRpcReader({ ...options,
        budget: { count: 0, limit: 10 }, deadlineMs: Date.now() + 30_000, rateLimit: (fn) => fn(),
      });
      if (healthyFallback) expect((await reader.getSolidHead()).number).toBe(100);
      else await expect(reader.getSolidHead()).rejects.toMatchObject({ reason: "tron-rpc-providers-unavailable" });
      return { status: healthyFallback ? "ok" : "error" };
    });
    await runHalfHourlyMintBurnCriticalSlot(rt);
    expect(recordOutcomeDecision).not.toHaveBeenCalled();
    const result = await vi.mocked(rt.runLeasedCron).mock.results[0].value;
    expect(JSON.parse(result?.metadata ?? "{}").providerOutcomes).toEqual([
      expect.objectContaining({ provider: "dwellir", circuitSource: null, terminalFailures: 0, failures: 1, successes: 0,
        reasons: { "tron-rpc-transport-error": 1 } }),
      expect.objectContaining({ provider: "trongrid", circuitSource: null, terminalFailures: 0,
        failures: healthyFallback ? 0 : 1, successes: healthyFallback ? 3 : 0 }),
    ]);
  });

  it.each(["head", "scan"] as const)("does not blame recovered Alchemy work for a terminal Tron %s failure", async (operation) => {
    const timestamp = Math.floor(Date.now() / 1000);
    const hash = `0x${"a".repeat(64)}`;
    let alchemyReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (url === ALCHEMY_URL) return Response.json({ id: 1, result: "0x7b" }, { status: ++alchemyReads === 1 ? 503 : 200 });
      if (operation === "head") return new Response("unavailable", { status: 503 });
      if (url.endsWith("/walletsolidity/getnowblock")) return Response.json({
        blockID: hash.slice(2), block_header: { raw_data: { number: 100, timestamp: timestamp * 1000 } },
      });
      const body = JSON.parse(String(init.body));
      if (body.method === "eth_getLogs") return new Response("unavailable", { status: 503 });
      return Response.json({ jsonrpc: "2.0", id: body.id, result: body.method === "eth_blockNumber"
        ? "0x65" : { number: "0x64", hash, timestamp: `0x${timestamp.toString(16)}` } });
    }));
    const rt = withProviders(runtime("halfHourlyMintBurnCritical", "4 * * * *"));
    mocks.syncMintBurn.mockImplementationOnce(async (_db, _key, options) => {
      await configScope("recovered", async () => {
        await rpcRead(ALCHEMY_URL);
        await rpcRead(ALCHEMY_URL);
      }, () => false);
      const reader = new TronJsonRpcReader({ signal: options.signal,
        dwellirNative: createDwellirNativeCapability("test-key"), trongridAllowed: false,
        budget: { count: 0, limit: 10 }, deadlineMs: Date.now() + 30_000, rateLimit: (fn) => fn(),
      });
      if (operation === "head") {
        const head = await withRpcRequestScope({ kind: "chain-head", key: "tron", affectsRun: true },
          () => reader.getSolidHead().catch(() => null), (value) => value == null);
        expect(head).toBeNull();
      } else {
        const scan = await configScope("usdt-tether:tron", () =>
          reader.getLogs(`0x${"1".repeat(40)}`, [`0x${"2".repeat(64)}`], 90, 100), (value) => !value.complete);
        expect(scan).toMatchObject({ complete: false, reason: "tron-rpc-providers-unavailable" });
      }
      return { status: "error", metadata: JSON.stringify({ admittedFinalityUnavailableChains: operation === "head" ? ["tron"] : [] }) };
    });
    await runHalfHourlyMintBurnCriticalSlot(rt);
    expect(recordOutcomeDecision).toHaveBeenCalledExactlyOnceWith(rt.db, CIRCUIT_SOURCE.ALCHEMY, "neutral");
    const result = await vi.mocked(rt.runLeasedCron).mock.results[0].value;
    expect(JSON.parse(result?.metadata ?? "{}").providerOutcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "alchemy", terminalFailures: 0, successes: 1, failures: 1 }),
      expect.objectContaining({ provider: "dwellir", circuitSource: null, terminalFailures: 0, failures: 1 }),
    ]));
  });

  it.each([
    { reason: "stale", decision: "failure", outcomeReason: "tron-rpc-stale-solid-head" },
    { reason: "rate-limit", decision: "failure", outcomeReason: "rpc-rate-limited" },
    { reason: "semantic", decision: "neutral", outcomeReason: "rpc-semantic-error-or-unavailable-result" },
    { reason: "unavailable", decision: "neutral", outcomeReason: "tron-rpc-missing-result" },
    { reason: "budget", decision: null, outcomeReason: null },
    { reason: "disabled", decision: null, outcomeReason: null },
  ])("keeps Tron $reason outcomes separate from Alchemy", async ({ reason, decision, outcomeReason }) => {
    const timestamp = Math.floor(Date.now() / 1000) - 601;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      if (reason === "stale") return Response.json({ blockID: "a".repeat(64),
        block_header: { raw_data: { number: 100, timestamp: timestamp * 1000 } } });
      const body = JSON.parse(String(init.body));
      if (reason === "unavailable") return Response.json({ jsonrpc: "2.0", id: body.id, result: null });
      return Response.json({ jsonrpc: "2.0", id: body.id, error: reason === "rate-limit"
        ? { code: -32005, message: "Rate limit exceeded" } : { code: -32602, message: "Invalid params" } });
    }));
    const rt = runtime("halfHourlyMintBurnExtended", "18 * * * *");
    mocks.syncMintBurn.mockImplementationOnce(async (_db, _key, options) => {
      const reader = new TronJsonRpcReader({ signal: options.signal,
        dwellirNative: reason === "disabled" ? undefined : createDwellirNativeCapability("test-key"),
        trongridAllowed: false, budget: { count: 0, limit: reason === "budget" ? 0 : 10 },
        deadlineMs: Date.now() + 30_000, rateLimit: (fn) => fn(),
      });
      if (reason === "stale") await expect(reader.getSolidHead()).rejects.toMatchObject({ reason: outcomeReason });
      else await expect(reader.getBlock(100)).rejects.toThrow();
      return { status: "degraded" };
    });
    await runHalfHourlyMintBurnExtendedSlot(rt);
    expect(recordOutcomeDecision).not.toHaveBeenCalled();
    const result = await vi.mocked(rt.runLeasedCron).mock.results[0].value;
    expect(JSON.parse(result?.metadata ?? "{}").providerOutcomes).toEqual(decision == null ? [] : [
      expect.objectContaining({ provider: "dwellir", circuitSource: null, terminalFailures: 0,
        failures: decision === "failure" ? 1 : 0, neutral: decision === "neutral" ? 1 : 0,
        reasons: { [outcomeReason!]: 1 } }),
    ]);
  });

  it("keeps another provider usable when Alchemy's circuit is open", async () => {
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify({ id: 1, result: "0x7b" })));
    vi.stubGlobal("fetch", fetchMock);
    const rt = withProviders(runtime("halfHourlyMintBurnCritical", "4 * * * *"));
    rt.mintBurnDisabledIds = ["synthetic-disabled-coin"];
    rt.mintBurnDisabledSymbols = ["SYNTH"];
    mocks.syncMintBurn.mockImplementationOnce(async () => {
      expect((await rpcRead(ALCHEMY_URL)).status).toBe("control-error");
      expect(await fetchEvmBlockNumber("ethereum", { chainRpcs: rt.chainRpcs, maxRetries: 0 })).toBe(123);
      return { status: "ok" };
    });
    await runHalfHourlyMintBurnCriticalSlot(rt);
    expect(mocks.syncMintBurn).toHaveBeenCalledWith(rt.db, rt.env.ALCHEMY_API_KEY ?? null,
      expect.objectContaining({ disabledConfigIds: ["synthetic-disabled-coin"], disabledSymbols: ["SYNTH"] }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(DWELLIR_URL);
    expect(recordOutcomeDecision).toHaveBeenCalledWith(rt.db, CIRCUIT_SOURCE.ALCHEMY, "neutral");
    expect(vi.mocked(recordOutcomeDecision).mock.calls.every(([, source]) => source === CIRCUIT_SOURCE.ALCHEMY)).toBe(true);
    expect(mocks.refreshAggregateMintBurnFlowCache).toHaveBeenCalledTimes(2);
    const result = await vi.mocked(rt.runLeasedCron).mock.results[0].value;
    expect(JSON.parse(result?.metadata ?? "{}").providerOutcomes[0]).toMatchObject({
      provider: "alchemy", blockedRequests: 1, failures: 0, reasons: { "circuit-open": 1 },
    });
  });

  it("does not treat sidecar failures, missing requests or thrown local errors as provider failures", async () => {
    const rt = withProviders(runtime("halfHourlyMintBurnCritical", "4 * * * *"));
    mocks.refreshAggregateMintBurnFlowCache.mockRejectedValue(new Error("D1 unavailable"));
    await runHalfHourlyMintBurnCriticalSlot(rt);
    expect(recordOutcomeDecision).not.toHaveBeenCalled();
    mocks.syncMintBurn.mockRejectedValueOnce(new Error("D1 write failed"));
    await expect(runHalfHourlyMintBurnCriticalSlot(rt)).rejects.toThrow("D1 write failed");
    expect(recordOutcomeDecision).not.toHaveBeenCalled();
  });

  it.each([
    { status: 400, code: -32602, message: "Invalid params", decision: "neutral" },
    { status: 422, code: 3, message: "execution reverted", decision: "neutral" },
    { status: 400, code: -32603, message: "Internal error", decision: "failure" },
    { status: 400, code: -32005, message: "Rate limit exceeded", decision: "failure" },
    ...[401, 402, 403, 408, 429, 503].map((status) => ({
      status, code: -32602, message: "Invalid params", decision: "failure",
    })),
  ])("attributes Alchemy HTTP $status / $message as $decision", async ({ status, code, message, decision }) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: 1, error: { code, message } }), { status })));
    const rt = withProviders(runtime("halfHourlyMintBurnExtended", "18 * * * *"));
    mocks.syncMintBurn.mockImplementationOnce(async () => {
      await configRead(ALCHEMY_URL);
      return { status: "error" };
    });
    await runHalfHourlyMintBurnExtendedSlot(rt);
    expect(recordOutcomeDecision).toHaveBeenCalledExactlyOnceWith(rt.db, CIRCUIT_SOURCE.ALCHEMY, decision);
  });

  it.each([
    { code: -32603, message: "Internal error", reason: "rpc-server-error" },
    { code: -32000, message: "Rate limit exceeded", reason: "rpc-rate-limited" },
    { code: -32005, message: "Too many requests", reason: "rpc-rate-limited" },
  ])("records Alchemy RPC service failures ($message)", async ({ code, message, reason }) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: 1, error: { code, message } }))));
    const rt = withProviders(runtime("halfHourlyMintBurnExtended", "18 * * * *"));
    mocks.syncMintBurn.mockImplementationOnce(async () => {
      await configRead(ALCHEMY_URL);
      return { status: "error" };
    });
    await runHalfHourlyMintBurnExtendedSlot(rt);
    expect(recordOutcomeDecision).toHaveBeenCalledExactlyOnceWith(rt.db, CIRCUIT_SOURCE.ALCHEMY, "failure");
    const result = await vi.mocked(rt.runLeasedCron).mock.results[0].value;
    expect(JSON.parse(result?.metadata ?? "{}").providerOutcomes[0].reasons).toEqual({ [reason]: 1 });
  });

  it.each([
    { code: 3, message: "execution reverted" },
    { code: -32603, message: "execution reverted" },
    { code: -32601, message: "Method not found" },
    { code: -32602, message: "Invalid params" },
    { code: -32005, message: "Block range limit exceeded" },
  ])("keeps RPC semantic errors neutral ($message)", async ({ code, message }) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      id: 1, error: { code, message },
    }))));
    const rt = withProviders(runtime("halfHourlyMintBurnExtended", "18 * * * *"));
    mocks.syncMintBurn.mockImplementationOnce(async () => {
      await configRead(ALCHEMY_URL);
      return { status: "error", metadata: JSON.stringify({ reason: "mint-burn-source-coverage-degraded" }) };
    });
    await runHalfHourlyMintBurnExtendedSlot(rt);
    expect(recordOutcomeDecision).toHaveBeenCalledExactlyOnceWith(rt.db, CIRCUIT_SOURCE.ALCHEMY, "neutral");
  });
});
