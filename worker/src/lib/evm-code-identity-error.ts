import type { EvmCodeIdentityCheckResult } from "../cron/reserve-adapters/evm-observation-plan";

/** Carries only authored rejection classes, never provider response text. */
export class EvmCodeIdentityError extends Error {
  readonly rejectionCode: Extract<EvmCodeIdentityCheckResult, { status: "rejected" }>["rejectionCode"];

  constructor(
    coinId: string,
    rejection: Extract<EvmCodeIdentityCheckResult, { status: "rejected" }>,
    blockNumber: number,
  ) {
    const reason = {
      "code-unavailable": "code unavailable",
      "implementation-unavailable": "implementation unavailable",
      "code-drift": "code identity drift (observed mismatch)",
      "implementation-drift": "implementation identity drift (observed mismatch)",
    }[rejection.rejectionCode];
    super(`${coinId} executable redemption observer failed closed: ${reason} at ${rejection.address} (${rejection.kind}, block ${blockNumber})`);
    this.name = "EvmCodeIdentityError";
    this.rejectionCode = rejection.rejectionCode;
  }
}
