import { describe, expect, it, vi } from "vitest";
import { makeNoopD1 } from "../../test-helpers/noop-d1";
import {
  BINANCE_ENVIRONMENT_BLOCK_TTL_SEC,
  readProviderAvailability,
  recordProviderEnvironmentAvailable,
  recordProviderEnvironmentBlocked,
} from "../pricing-provider-runtime-state";

function makeDb(row: Record<string, unknown> | null = null) {
  const run = vi.fn(async () => ({ meta: { changes: 1 } }));
  const first = vi.fn(async () => row);
  const bind = vi.fn(() => ({ run, first }));
  const prepare = vi.fn(() => ({ bind }));
  return { db: makeNoopD1({ prepare }), prepare, bind, first, run };
}

describe("pricing provider runtime state", () => {
  it("allows fetches when no runtime block exists", async () => {
    const { db } = makeDb();

    await expect(readProviderAvailability(db, "binance", 1_000)).resolves.toEqual({
      shouldFetch: true,
      probeOnly: false,
      blockedStatus: null,
      nextProbeAt: null,
    });
  });

  it("suppresses a blocked environment until its TTL probe", async () => {
    const { db } = makeDb({ availability: "blocked", blocked_status: 451, next_probe_at: 10_000 });
    await expect(readProviderAvailability(db, "binance", 9_999)).resolves.toEqual({
      shouldFetch: false,
      probeOnly: false,
      blockedStatus: 451,
      nextProbeAt: 10_000,
    });
    await expect(readProviderAvailability(db, "binance", 10_000)).resolves.toEqual({
      shouldFetch: true,
      probeOnly: true,
      blockedStatus: 451,
      nextProbeAt: 10_000,
    });
  });

  it("records a bounded next-probe time for environment blocks", async () => {
    const { db, bind } = makeDb();
    await recordProviderEnvironmentBlocked(db, "binance", 403, 1_000);
    expect(bind).toHaveBeenCalledWith(
      "binance",
      403,
      1_000,
      1_000 + BINANCE_ENVIRONMENT_BLOCK_TTL_SEC,
      1_000,
      1_000,
    );
  });

  it("records recovery after a successful environment probe", async () => {
    const { db, bind, run } = makeDb();

    await recordProviderEnvironmentAvailable(db, "binance", 2_000);

    expect(bind).toHaveBeenCalledWith("binance", 2_000, 2_000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
