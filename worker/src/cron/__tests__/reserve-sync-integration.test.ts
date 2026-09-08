import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockRegistry } from "../../test-helpers/cron";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { mockLiveReserveAdapterRegistry, shouldAttemptFetchMock, recordOutcomeSafeMock } from "./live-reserves.test-support";

vi.mock("@shared/lib/stablecoins/registry", () => mockRegistry({ stablecoins: ["shared-a", "shared-b", "control"].map((id) => ({
  id, name: id, symbol: id, flags: { backing: "rwa-backed", pegCurrency: "USD", governance: "centralized", yieldBearing: false, rwa: true, navToken: false },
  liveReservesConfig: { adapter: "m0", version: 1, semantics: "collateral-mix", inputs: { primary: { kind: "http-json", url: id === "control" ? "https://example.com/control" : "https://example.com/shared" } } },
})) }));

import { syncLiveReserves } from "../sync-live-reserves";
import { resolveReserveResult } from "../../lib/live-reserves/store";

const fixtures = createLatestSchemaFixtureTracker();
const slices = [{ name: "US Treasuries", pct: 80, risk: "low" as const }, { name: "Cash", pct: 20, risk: "low" as const }];
const ids = ["control", "shared-a", "shared-b"];
afterEach(fixtures.closeAll);
beforeEach(() => {
  vi.clearAllMocks();
  shouldAttemptFetchMock.mockResolvedValue(true);
  recordOutcomeSafeMock.mockResolvedValue(undefined);
});

describe("reserve sync durable API resolution", () => {
  it("stores successful composition and exposes it through the reserve resolver", async () => {
    mockLiveReserveAdapterRegistry(async () => ({ slices, metadata: { freshnessMode: "verified", sourceTimestamp: Math.floor(Date.now() / 1000) } }));
    const { sqlite, db } = fixtures.open();
    expect(await syncLiveReserves(db, new AbortController().signal, {})).toMatchObject({ status: "ok", itemCount: 3 });
    expect(sqlite.prepare("SELECT stablecoin_id FROM reserve_composition ORDER BY stablecoin_id").all()).toEqual(ids.map((stablecoin_id) => ({ stablecoin_id })));
    for (const id of ids) {
      expect(await resolveReserveResult(db, id, Math.floor(Date.now() / 1000))).toMatchObject({ reserves: slices, sync: { status: "ok" } });
    }
  });

  it("preserves previous successful composition after validation rejection", async () => {
    mockLiveReserveAdapterRegistry(async () => ({ slices, metadata: { freshnessMode: "verified", sourceTimestamp: Math.floor(Date.now() / 1000) } }));
    const { sqlite, db } = fixtures.open();
    await syncLiveReserves(db, new AbortController().signal, {});
    const previous = sqlite.prepare("SELECT * FROM reserve_composition ORDER BY stablecoin_id").all();
    expect(previous).toHaveLength(3);
    mockLiveReserveAdapterRegistry(async () => ({ slices: [{ name: "Asset A", pct: 80, risk: "low" }, { name: "Asset B", pct: 25, risk: "low" }] }));
    expect(await syncLiveReserves(db, new AbortController().signal, {})).toMatchObject({ status: "error", itemCount: 0 });
    expect(sqlite.prepare("SELECT * FROM reserve_composition ORDER BY stablecoin_id").all()).toEqual(previous);
    for (const id of ids) expect(await resolveReserveResult(db, id, Math.floor(Date.now() / 1000))).toMatchObject({ reserves: slices });
  });

  it("shares failed outcomes within a run and retries that source on the next run", async () => {
    let failShared = true;
    const fetch = mockLiveReserveAdapterRegistry(async (_coin, config) => {
      if (config?.inputs.primary.kind === "http-json" && config.inputs.primary.url.endsWith("/shared") && failShared) throw new Error("transient network failure");
      return { slices, metadata: { freshnessMode: "verified", sourceTimestamp: Math.floor(Date.now() / 1000) } };
    });
    const { sqlite, db } = fixtures.open();
    await syncLiveReserves(db, new AbortController().signal, {});
    expect(fetch.mock.calls.map(([, config]) => config.inputs.primary.url)).toEqual(["https://example.com/shared", "https://example.com/control"]);
    expect(sqlite.prepare("SELECT stablecoin_id FROM reserve_composition").all()).toEqual([{ stablecoin_id: "control" }]);
    expect(sqlite.prepare("SELECT stablecoin_id, last_status, last_error FROM reserve_sync_state WHERE stablecoin_id != 'control' ORDER BY stablecoin_id").all()).toEqual([
      { stablecoin_id: "shared-a", last_status: "error", last_error: expect.stringContaining("transient network failure") },
      { stablecoin_id: "shared-b", last_status: "error", last_error: expect.stringContaining("transient network failure") },
    ]);
    failShared = false;
    await syncLiveReserves(db, new AbortController().signal, {});
    expect(fetch.mock.calls.map(([, config]) => config.inputs.primary.url)).toEqual(["https://example.com/shared", "https://example.com/control", "https://example.com/shared", "https://example.com/control"]);
    expect(await resolveReserveResult(db, "shared-b", Math.floor(Date.now() / 1000))).toMatchObject({ reserves: slices, sync: { status: "ok" } });
  });
});
