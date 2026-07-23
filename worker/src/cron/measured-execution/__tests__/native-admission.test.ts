import { describe, expect, it } from "vitest";
import type { SolanaMeasuredExecutionTarget } from "@shared/types/solana-measured-execution";
import type { TronMeasuredExecutionTarget } from "@shared/types/tron-measured-execution";
import { admitSolanaMeasuredTargets } from "../solana-sync";
import { admitTronMeasuredTargets } from "../tron-sync";

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

describe("native measured-execution admission", () => {
  it("admits twelve Solana targets per half-hour evidence cycle", () => {
    const admission = admitSolanaMeasuredTargets(solanaTargets(20), null);
    expect(admission.admitted.size).toBe(12);
    expect(admission.nextCursor).toBe("solana-11");
  });

  it("limits SunSwap to two paced targets per run", () => {
    const admission = admitTronMeasuredTargets(tronTargets(10), null);
    expect(admission.admitted.size).toBe(2);
    expect(admission.nextCursor).toBe("tron-01");
  });
});
