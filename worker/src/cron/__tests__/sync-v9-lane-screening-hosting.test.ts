import { describe, expect, it, vi } from "vitest";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import type { LaneScreeningDescriptor } from "../sync-v9-lane-admin-events";
import { runV9LaneScreeningShadowPhase } from "../sync-v9-supply-attribution";

const db = {} as never;
const signal = new AbortController().signal;
const deadlineMs = Date.now() + 10 * 60_000;
const window = { deadlineMs } as never;

function descriptor(): LaneScreeningDescriptor {
  return {
    subjectDeploymentKey: "ethereum:0x1111111111111111111111111111111111111111",
    emitters: [{
      address: "0x1111111111111111111111111111111111111111",
      expectedRuntimeCodeSha256: "a".repeat(64),
      families: ["OwnershipTransferred"],
    }],
    lookbackBlocks: 50_000,
  };
}

describe("hosted lane screening phase", () => {
  it("is inert while the reviewed catalog has no admitted lane", async () => {
    const run = vi.fn();
    const outcome = await runV9LaneScreeningShadowPhase({
      db, signal, executionWindow: window, options: { descriptors: [], run },
    });
    expect(outcome).toMatchObject({ status: "skipped", reason: "lane-screening-no-descriptors", catalog: 0 });
    expect(run).not.toHaveBeenCalled();
  });

  it("runs after the publication budget with the slot deadline and journals the counts", async () => {
    const run = vi.fn().mockResolvedValue({
      status: "ok",
      itemCount: 1,
      metadata: {
        catalog: 1, candidates: 1, attempted: 1, admitted: 1, failed: 0,
        certificatesWritten: 1, deadlineExhausted: false,
      },
    });
    const outcome = await runV9LaneScreeningShadowPhase({
      db, signal, executionWindow: window, options: { descriptors: [descriptor()], run },
    });
    expect(run).toHaveBeenCalledTimes(1);
    const [calledDb, chainRpcs, calledSignal, options] = run.mock.calls[0]!;
    expect(calledDb).toBe(db);
    expect(chainRpcs).toBeInstanceOf(Map);
    expect(calledSignal).toBe(signal);
    expect(options).toEqual({ descriptors: [descriptor()], deadlineMs });
    expect(outcome).toMatchObject({
      status: "published", reason: "lane-screening-completed", catalog: 1,
      attempted: 1, admitted: 1, certificatesWritten: 1,
    });
  });

  it("journals a producer failure instead of failing the host", async () => {
    const run = vi.fn().mockRejectedValue(Object.assign(new Error("store down"), { name: "D1Error" }));
    const outcome = await runV9LaneScreeningShadowPhase({
      db, signal, executionWindow: window, options: { descriptors: [descriptor()], run },
    });
    expect(outcome).toMatchObject({ status: "failed", reason: "lane-screening-failed", code: "D1Error" });
  });

  it("skips without a slot window and when the window is nearly spent", async () => {
    const run = vi.fn();
    const noWindow = await runV9LaneScreeningShadowPhase({
      db, signal, options: { descriptors: [descriptor()], run },
    });
    expect(noWindow).toMatchObject({ status: "skipped", reason: "lane-screening-slot-window-unavailable" });
    const spent = await runV9LaneScreeningShadowPhase({
      db,
      signal,
      executionWindow: { deadlineMs: Date.now() + 1_000 } as never,
      options: { descriptors: [descriptor()], run },
    });
    expect(spent).toMatchObject({ status: "skipped", reason: "lane-screening-window-insufficient" });
    expect(run).not.toHaveBeenCalled();
  });

  it("does not start work after an abort", async () => {
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn();
    const outcome = await runV9LaneScreeningShadowPhase({
      db, signal: controller.signal, executionWindow: window, options: { descriptors: [descriptor()], run },
    });
    expect(outcome).toMatchObject({ status: "skipped", reason: "lane-screening-aborted" });
    expect(run).not.toHaveBeenCalled();
  });
});

// Keep the injected RPC map's type exercised so a config change cannot silently
// drop the chain registry contract from the phase seam.
const _chainRpcs: Map<string, ChainRpcConfig> = new Map();
void _chainRpcs;
