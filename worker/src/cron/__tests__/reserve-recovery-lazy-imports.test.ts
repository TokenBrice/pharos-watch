import { expect, it, vi } from "vitest";
import { computeLiveReserveConfigFingerprint } from "@shared/lib/live-reserve-adapters";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { mockWorkerRuntimeRegistry } from "../../test-helpers/cron";

const mocks = vi.hoisted(() => ({
  adapterInitialized: false,
  runnerInitialized: false,
  coreInitialized: false,
  config: {
    adapter: "m0", version: 1, semantics: "collateral-mix",
    inputs: { primary: { kind: "http-json", url: "https://example.com" } },
  } satisfies LiveReservesConfig,
  states: vi.fn(),
}));

vi.mock("../sync-live-reserves-shared", () => ({
  CONFIGURED_COINS: [{ id: "coin", liveReservesConfig: mocks.config }],
}));
vi.mock("@shared/lib/stablecoins/worker-runtime-registry", () => ({
  ...mockWorkerRuntimeRegistry({ stablecoins: [{
    id: "coin", name: "Coin", symbol: "COIN",
    flags: { backing: "rwa-backed", pegCurrency: "USD", governance: "centralized", yieldBearing: false, rwa: true, navToken: false },
    liveReservesConfig: mocks.config,
  }] }),
  WORKER_ACTIVE_LIVE_RESERVE_CIRCUIT_SOURCES: [],
}));
vi.mock("../../lib/live-reserves/store", () => ({ loadReserveSyncStateMap: mocks.states }));
vi.mock("../../lib/cron-lease-primitives", () => ({
  createLeaseOwner: () => "test-owner",
  runCronWithLease: async (_db: unknown, _job: unknown, run: (ctx: { signal: AbortSignal }) => Promise<unknown>, options: { abortSignal: AbortSignal }) => ({
    status: "ok", result: await run({ signal: options.abortSignal }),
  }),
}));
vi.mock("../reserve-adapters/m0", () => {
  mocks.adapterInitialized = true;
  return { fetchM0Reserves: vi.fn() };
});
vi.mock("../reserve-adapter-runner", () => {
  mocks.runnerInitialized = true;
  return {};
});
vi.mock("../sync-live-reserves-core", () => {
  mocks.coreInitialized = true;
  return {};
});

import { recoverLiveReserveConfigChanges } from "../reserve-recovery-config";

it("checks a consumed fingerprint without initializing adapters or producer execution", async () => {
  const fingerprint = computeLiveReserveConfigFingerprint(mocks.config);
  mocks.states.mockResolvedValue(new Map([["coin", {
    configFingerprint: fingerprint, lastAttemptedAt: Math.floor(Date.now() / 1000),
  }]]));
  const db = {
    prepare: () => ({ all: async () => ({ results: [
      { stablecoin_id: "coin", config_fingerprint: "old-config", binding_source: "snapshot" },
      { stablecoin_id: "coin", config_fingerprint: fingerprint, binding_source: "attempt" },
    ] }) }),
  } as unknown as D1Database;
  expect(await recoverLiveReserveConfigChanges(db, new AbortController().signal, {})).toMatchObject({
    mismatchCount: 1, missingFetcherCount: 0, skippedSameFingerprintCount: 1, dueCount: 0, attempted: [],
  });
  expect(mocks.adapterInitialized).toBe(false);
  expect(mocks.runnerInitialized).toBe(false);
  expect(mocks.coreInitialized).toBe(false);
});
