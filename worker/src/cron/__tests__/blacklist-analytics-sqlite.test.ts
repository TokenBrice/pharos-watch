import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "../../test-helpers/latest-schema-sqlite";
import { hydrateBlacklistEvents } from "../../lib/dews/source-state/hydration";
import { collectBlacklistActivity } from "../daily-digest/collectors-market";

const fixtures = createLatestSchemaFixtureTracker();
const NOW = 1_800_000_000;
afterEach(fixtures.closeAll);

describe("public blacklist analytics eligibility", () => {
  it("excludes two suppressed EURC zero rows from DEWS and digest candidacy, retaining NULL rows", async () => {
    const { sqlite, db } = fixtures.open();
    const insert = sqlite.prepare(`INSERT INTO blacklist_events
      (id, stablecoin, chain_id, chain_name, event_type, address, tx_hash, block_number, timestamp, amount_usd_at_event, suppression_reason, explorer_tx_url, explorer_address_url)
      VALUES (?, 'EURC', 'ethereum', 'Ethereum', 'blacklist', '0x1', ?, 1, ?, 0, ?, '', '')`);
    insert.run("suppressed-1", "0xtx1", NOW - 10, "circle_mirror_zero_balance");
    insert.run("suppressed-2", "0xtx2", NOW - 20, "circle_mirror_zero_balance");
    const registerSourceFailure = vi.fn();
    const hydrate = () => hydrateBlacklistEvents({ db, nowSec: NOW, bootstrapPending: false,
      registerSourceFailure, registerMalformedPersistedInput: vi.fn() });
    const collect = () => collectBlacklistActivity({ db, nowSec: NOW, todayTs: NOW, yesterdayTs: NOW - 86400,
      trackedStablecoinAssets: [], trackedStablecoinIds: new Set(), coreAggregateStablecoinAssets: [],
      coreAggregateStablecoinIds: new Set(), stablecoinAssetById: new Map(), mcapById: new Map(),
      stablecoinsCacheIsFresh: true });
    expect.soft(await hydrate()).toEqual({ blacklistCounts: new Map(), rowsRead: 0 });
    expect.soft(await collect()).toEqual({ value: undefined, degradedReasons: [] });
    expect(registerSourceFailure).not.toHaveBeenCalled();

    insert.run("public-1", "0xtx3", NOW - 30, null);
    insert.run("public-2", "0xtx4", NOW - 40, null);
    expect(await hydrate()).toEqual({ blacklistCounts: new Map([["eurc-circle", { count24h: 2, count7d: 2 }]]), rowsRead: 2 });
    expect(await collect()).toMatchObject({ value: { eventCount: 2, totalAmountUsd: 0 }, degradedReasons: [] });
  });
});
