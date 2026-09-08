import { afterEach, describe, it, expect } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(fixtures.closeAll);
import { type MockD1Database, type MockTableConfig } from "@shared/test-utils/mock-d1";
import { projectMintBurnLargeFlows } from "../mint-burn";
import { mockTapeD1, tapeInsertBinds, tapeInsertBindsForType } from "./test-support";

const SEC = 1_700_000_000;

const MATCH_FETCH_FLOWS = "FROM mint_burn_events";

function withRows(rows: Record<string, unknown>[]): MockTableConfig[] {
  return [
    { match: "FROM cache WHERE key", rows: [] },
    { match: MATCH_FETCH_FLOWS, rows },
  ];
}

function makeFlow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "ethereum-0xabc-0",
    stablecoin_id: "usdt-tether",
    symbol: "USDT",
    chain_id: "ethereum",
    direction: "mint",
    amount_usd: 15_000_000,
    counterparty: null,
    timestamp: SEC,
    flow_type: "standard",
    burn_type: null,
    ...overrides,
  };
}

describe("mint_burn projector", () => {
  it("emits mint_burn.large_mint at notice severity for $15M mints", async () => {
    const db = mockTapeD1(withRows([makeFlow({ amount_usd: 15_000_000 })])) as MockD1Database;
    await projectMintBurnLargeFlows(db);
    const inserts = tapeInsertBindsForType(db, "mint_burn.large_mint");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]![2]).toBe("notice");
  });

  it("scales severity to warning at $25M and severe at $100M", async () => {
    const db = mockTapeD1(withRows([
      makeFlow({ id: "ethereum-0xa-0", amount_usd: 30_000_000 }),
      makeFlow({ id: "ethereum-0xb-0", amount_usd: 150_000_000, direction: "burn", burn_type: "effective_burn" }),
    ])) as MockD1Database;
    await projectMintBurnLargeFlows(db);
    const mints = tapeInsertBindsForType(db, "mint_burn.large_mint");
    const burns = tapeInsertBindsForType(db, "mint_burn.large_burn");
    expect(mints[0]![2]).toBe("warning"); // $30M mint
    expect(burns[0]![2]).toBe("severe");  // $150M burn
  });

  it("renders compact USD in the title and a burn verb for burn rows", async () => {
    const db = mockTapeD1(withRows([
      makeFlow({
        id: "polygon-0xc-0",
        stablecoin_id: "usdc-circle",
        symbol: "USDC",
        chain_id: "polygon",
        direction: "burn",
        amount_usd: 50_000_000,
        burn_type: "effective_burn",
      }),
    ])) as MockD1Database;
    await projectMintBurnLargeFlows(db);
    const inserts = tapeInsertBindsForType(db, "mint_burn.large_burn");
    expect(inserts).toHaveLength(1);
    // bind order: eventId, type, severity, ts, ends_at, coin_id, issuer_id, peg, chain, title, ...
    const title = inserts[0]![9];
    expect(title).toMatch(/USDC burned \$50\.0M.*polygon/);
  });

  it("persists only economic flows at exact severity boundaries and keeps reruns durable", async () => {
    const { db, sqlite } = fixtures.open();
    const rows = [
      makeFlow({ id: "below", amount_usd: 9_999_999 }),
      makeFlow({ id: "notice", amount_usd: 10_000_000 }),
      makeFlow({ id: "warning", amount_usd: 25_000_000 }),
      makeFlow({ id: "severe", amount_usd: 100_000_000, direction: "burn", burn_type: "effective_burn" }),
      makeFlow({ id: "bridge", amount_usd: 100_000_000, flow_type: "bridge_transfer" }),
      makeFlow({ id: "review", amount_usd: 100_000_000, direction: "burn", burn_type: "review_required" }),
      makeFlow({ id: "unpriced", amount_usd: null }),
    ];
    for (const row of rows) {
      sqlite.prepare(`INSERT INTO mint_burn_events
        (id, stablecoin_id, symbol, chain_id, direction, amount, amount_usd, counterparty, timestamp, flow_type, burn_type, tx_hash, block_number, explorer_tx_url)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, '0xtest', 1, 'https://example.com')`)
        .run(row.id as string, row.stablecoin_id as string, row.symbol as string, row.chain_id as string,
          row.direction as string, row.amount_usd as number | null, row.counterparty as null,
          row.timestamp as number, row.flow_type as string, row.burn_type as string | null);
    }
    await projectMintBurnLargeFlows(db);
    const select = sqlite.prepare("SELECT event_id, source_row_id, type, severity FROM tape_events ORDER BY source_row_id");
    const events = select.all();
    expect(events).toEqual([
      { event_id: expect.any(String), source_row_id: "notice", type: "mint_burn.large_mint", severity: "notice" },
      { event_id: expect.any(String), source_row_id: "severe", type: "mint_burn.large_burn", severity: "severe" },
      { event_id: expect.any(String), source_row_id: "warning", type: "mint_burn.large_mint", severity: "warning" },
    ]);
    const cursor = sqlite.prepare("SELECT value FROM cache WHERE key = 'tape-projector:cursor:mint_burn.large_flow'");
    expect(cursor.get()).toEqual({ value: String(SEC) });
    await projectMintBurnLargeFlows(db);
    await projectMintBurnLargeFlows(db, { since: 0 });
    expect(select.all()).toEqual(events);
    expect(cursor.get()).toEqual({ value: String(SEC) });
  });

  it("derives the same nonempty event identity independently of persistence", async () => {
    const first = mockTapeD1(withRows([makeFlow()])) as MockD1Database;
    const second = mockTapeD1(withRows([makeFlow()])) as MockD1Database;
    await projectMintBurnLargeFlows(first);
    await projectMintBurnLargeFlows(second);
    const firstIds = tapeInsertBindsForType(first, "mint_burn.large_mint").map((binds) => binds[0]);
    expect(firstIds).toEqual([expect.stringMatching(/\S+/)]);
    expect(tapeInsertBindsForType(second, "mint_burn.large_mint").map((binds) => binds[0])).toEqual(firstIds);
  });

  it("expands a full batch to include all rows at the cutoff timestamp before advancing", async () => {
    const rows = [
      makeFlow({ id: "ethereum-0xa-0", timestamp: SEC }),
      makeFlow({ id: "ethereum-0xb-0", timestamp: SEC }),
      makeFlow({ id: "ethereum-0xc-0", timestamp: SEC }),
    ];
    const db = mockTapeD1([
      { match: "FROM cache WHERE key", rows: [] },
      { match: MATCH_FETCH_FLOWS, matchBinds: [0, 10_000_000, 2], rows: rows.slice(0, 2) },
      { match: MATCH_FETCH_FLOWS, matchBinds: [0, SEC, 10_000_000], rows },
    ]) as MockD1Database;

    const result = await projectMintBurnLargeFlows(db, { maxRows: 2 });

    expect(result.advanced).toBe(SEC);
    expect(tapeInsertBindsForType(db, "mint_burn.large_mint")).toHaveLength(3);
  });

  it("emits nothing on an empty source", async () => {
    const db = mockTapeD1(withRows([])) as MockD1Database;
    await projectMintBurnLargeFlows(db);
    expect(tapeInsertBinds(db)).toHaveLength(0);
  });
});
