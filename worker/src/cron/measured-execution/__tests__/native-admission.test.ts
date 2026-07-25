import { describe, expect, it } from "vitest";
import type { SolanaMeasuredExecutionTarget } from "@shared/types/solana-measured-execution";
import type { TronMeasuredExecutionTarget } from "@shared/types/tron-measured-execution";
import { admitSolanaMeasuredTargets } from "../solana-sync";
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

describe("native measured-execution admission", () => {
  it("admits twelve Solana targets per half-hour evidence cycle", () => {
    const admission = admitSolanaMeasuredTargets(solanaTargets(20), null);
    expect(admission.admitted.size).toBe(12);
    expect(admission.nextCursor).toBe("solana-11");
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
