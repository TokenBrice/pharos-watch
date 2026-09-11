import { afterEach, describe, expect, it, vi } from "vitest";
import { makeNoopD1 } from "../../test-helpers/noop-d1";
import {
  BINANCE_ENVIRONMENT_BLOCK_TTL_SEC,
  readProviderAvailability,
  recordProviderEnvironmentAvailable,
  recordProviderEnvironmentBlocked,
} from "../pricing-provider-runtime-state";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

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

  it("persists blocking, TTL probing and recovery independently per provider", async () => {
    const { db } = fixtures.open();
    const available = { shouldFetch: true, probeOnly: false, blockedStatus: null, nextProbeAt: null };
    await recordProviderEnvironmentAvailable(db, "binance", 900);
    expect(await readProviderAvailability(db, "binance", 900)).toEqual(available);
    await recordProviderEnvironmentBlocked(db, "binance", 403, 1_000);
    await recordProviderEnvironmentBlocked(db, "coinbase", 451, 1_001);
    const probeAt = 1_000 + BINANCE_ENVIRONMENT_BLOCK_TTL_SEC;
    expect(await readProviderAvailability(db, "binance", probeAt - 1)).toEqual({
      shouldFetch: false, probeOnly: false, blockedStatus: 403, nextProbeAt: probeAt,
    });
    expect(await readProviderAvailability(db, "binance", probeAt)).toEqual({
      shouldFetch: true, probeOnly: true, blockedStatus: 403, nextProbeAt: probeAt,
    });
    await recordProviderEnvironmentAvailable(db, "binance", probeAt);
    expect(await readProviderAvailability(db, "binance", probeAt)).toEqual(available);
    expect(await readProviderAvailability(db, "coinbase", probeAt)).toEqual({
      shouldFetch: false, probeOnly: false, blockedStatus: 451, nextProbeAt: probeAt + 1,
    });
  });
});
