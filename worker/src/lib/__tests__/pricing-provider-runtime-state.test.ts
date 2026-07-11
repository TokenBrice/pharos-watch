import { describe, expect, it, vi } from "vitest";
import {
  BINANCE_ENVIRONMENT_BLOCK_TTL_SEC,
  readProviderAvailability,
  recordProviderEnvironmentBlocked,
  rotateTargets,
} from "../pricing-provider-runtime-state";

function makeDb(row: Record<string, unknown> | null = null) {
  const run = vi.fn(async () => ({ meta: { changes: 1 } }));
  const first = vi.fn(async () => row);
  const bind = vi.fn(() => ({ run, first }));
  const prepare = vi.fn(() => ({ bind }));
  return { db: { prepare } as unknown as D1Database, prepare, bind, first, run };
}

describe("pricing provider runtime state", () => {
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

  it("rotates a bounded target queue without dropping entries", () => {
    expect(rotateTargets(["a", "b", "c", "d"], 2)).toEqual(["c", "d", "a", "b"]);
    expect(rotateTargets(["a", "b", "c", "d"], 6)).toEqual(["c", "d", "a", "b"]);
  });
});
