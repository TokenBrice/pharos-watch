import { describe, expect, it } from "vitest";
import type { SolanaMeasuredExecutionTarget } from "@shared/types/solana-measured-execution";
import type { TronMeasuredExecutionTarget } from "@shared/types/tron-measured-execution";
import {
  admitSolanaMeasuredTargets,
  orderAdmittedSolanaMeasuredTargets,
  SOLANA_MEASURED_ROTATING_TARGETS_PER_RUN,
} from "../solana-sync";
import { SOLANA_MEASURED_EXECUTION_PRIORITY_TARGETS } from "../solana-registry";
import {
  boundSolanaMeasuredExecutionTargets,
  SOLANA_MEASURED_TARGETS_PER_STABLECOIN,
} from "../solana-inventory";
import {
  admitTronMeasuredTargets,
  TRON_MEASURED_REQUEST_HEADROOM_MS,
  TRON_MEASURED_RUNTIME_BUDGET_MS,
  TRON_MEASURED_TARGETS_PER_RUN,
} from "../tron-sync";

function solanaTargets(count: number): SolanaMeasuredExecutionTarget[] {
  return Array.from({ length: count }, (_, index) => ({
    targetId: `solana-${index.toString().padStart(2, "0")}`,
    retainedTvlUsd: count - index,
  })) as SolanaMeasuredExecutionTarget[];
}

function tronTargets(count: number): TronMeasuredExecutionTarget[] {
  return Array.from({ length: count }, (_, index) => ({
    targetId: `tron-${index.toString().padStart(2, "0")}`,
    retainedTvlUsd: count - index,
  })) as TronMeasuredExecutionTarget[];
}

function solanaPriorityTarget(): SolanaMeasuredExecutionTarget {
  const priority = SOLANA_MEASURED_EXECUTION_PRIORITY_TARGETS[0]!;
  return {
    targetId: priority.targetId,
    stablecoinId: priority.stablecoinId,
    adapterProfileId: priority.adapterProfileId,
    protocol: priority.protocol,
    poolType: priority.poolType,
    poolId: priority.poolId,
    tokenIn: {
      address: priority.tokenInAddress,
      decimals: priority.tokenInDecimals,
      trackedAssetId: priority.stablecoinId,
    },
    tokenOut: {
      address: priority.tokenOutAddress,
      decimals: priority.tokenOutDecimals,
      trackedAssetId: priority.tokenOutTrackedAssetId,
    },
    retainedTvlUsd: 2_000_000,
  } as SolanaMeasuredExecutionTarget;
}

describe("native measured-execution admission", () => {
  it("bounds dominant Solana assets to the public observation denominator", () => {
    const targets = new Map(
      Array.from({ length: 25 }, (_, index) => {
        const target = {
          targetId: `dominant-${index.toString().padStart(2, "0")}`,
          stablecoinId: "dominant",
          retainedTvlUsd: index,
        } as SolanaMeasuredExecutionTarget;
        return [target.targetId, target] as const;
      }),
    );

    const bounded = boundSolanaMeasuredExecutionTargets(targets);

    expect(SOLANA_MEASURED_TARGETS_PER_STABLECOIN).toBe(10);
    expect([...bounded.values()].map((target) => target.retainedTvlUsd)).toEqual([
      24, 23, 22, 21, 20, 19, 18, 17, 16, 15,
    ]);
  });

  it("rotates a production-sized bounded cohort completely within four half-hour cycles", () => {
    const targets = Array.from({ length: 108 }, (_, index) => ({
      targetId: `bounded-${index.toString().padStart(3, "0")}`,
      stablecoinId: `asset-${index % 34}`,
      retainedTvlUsd: 108 - index,
    })) as SolanaMeasuredExecutionTarget[];
    const observed = new Set<string>();
    let cursor: string | null = null;
    for (let cycle = 0; cycle < 4; cycle++) {
      const admission = admitSolanaMeasuredTargets(targets, cursor);
      for (const targetId of admission.admitted) observed.add(targetId);
      cursor = admission.nextCursor;
    }

    expect(observed).toHaveLength(108);
  });

  it("admits thirty Solana targets per half-hour evidence cycle", () => {
    const admission = admitSolanaMeasuredTargets(solanaTargets(40), null);
    expect(SOLANA_MEASURED_ROTATING_TARGETS_PER_RUN).toBe(30);
    expect(admission.admitted.size).toBe(30);
    expect(admission.nextCursor).toBe("solana-29");
    expect(admission.missingPriorityPolicyIds).toEqual([
      "hyusd-usdc-orca-4tjw-v1",
      "wm-usdc-raydium-csmz-v1",
    ]);
  });

  it("reserves the exact HYUSD/USDC target every run without consuming the rotating budget", () => {
    const priority = solanaPriorityTarget();
    const targets = [priority, ...solanaTargets(20)];
    const first = admitSolanaMeasuredTargets(targets, null);

    expect(first.admitted.size).toBe(21);
    expect(first.admitted.has(priority.targetId)).toBe(true);
    expect(first.priorityExpectedCount).toBe(2);
    expect(first.priorityObservedCount).toBe(1);
    expect(first.rotatingAdmittedCount).toBe(20);
    expect(first.missingPriorityPolicyIds).toEqual(["wm-usdc-raydium-csmz-v1"]);
    expect(first.nextCursor).toBe("solana-19");

    const second = admitSolanaMeasuredTargets(targets, first.nextCursor);
    expect(second.admitted.has(priority.targetId)).toBe(true);
    expect(second.nextCursor).toBe("solana-19");
  });

  it("does not prioritize a lookalike direction with the wrong output mint", () => {
    const priority = solanaPriorityTarget();
    const spoofed = {
      ...priority,
      targetId: "spoofed-priority",
      tokenOut: { ...priority.tokenOut, address: "So11111111111111111111111111111111111111112" },
    };
    const admission = admitSolanaMeasuredTargets([spoofed], null);

    expect(admission.priorityObservedCount).toBe(0);
    expect(admission.missingPriorityPolicyIds).toEqual([
      "hyusd-usdc-orca-4tjw-v1",
      "wm-usdc-raydium-csmz-v1",
    ]);
    expect(admission.admitted).toEqual(new Set(["spoofed-priority"]));
  });

  it("executes the reserved direction before rotating targets without reordering the tail", () => {
    const priority = solanaPriorityTarget();
    const rotating = solanaTargets(3);
    const ordered = orderAdmittedSolanaMeasuredTargets(
      [rotating[0]!, rotating[1]!, priority, rotating[2]!],
      new Set([priority.targetId, ...rotating.map((target) => target.targetId)]),
    );

    expect(ordered.map((target) => target.targetId)).toEqual([
      priority.targetId,
      "solana-00",
      "solana-01",
      "solana-02",
    ]);
  });

  it("admits the complete current SunSwap cohort in one half-hour evidence cycle", () => {
    const targets = tronTargets(21);
    const admission = admitTronMeasuredTargets(targets, null);

    expect(TRON_MEASURED_TARGETS_PER_RUN).toBe(21);
    expect(admission.admitted.size).toBe(21);
    expect(admission.nextCursor).toBe("tron-20");
  });

  it("retains the seven-minute producer budget and final-request headroom", () => {
    expect(TRON_MEASURED_RUNTIME_BUDGET_MS).toBe(7 * 60 * 1_000);
    expect(TRON_MEASURED_REQUEST_HEADROOM_MS).toBe(20_000);
  });
});
