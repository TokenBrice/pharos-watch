import { describe, it, expect } from "vitest";
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

  it("is idempotent on rerun (event_id is stable for the same source row)", async () => {
    const row = makeFlow({ id: "ethereum-0xdup-0", amount_usd: 20_000_000 });
    const db1 = mockTapeD1(withRows([row])) as MockD1Database;
    await projectMintBurnLargeFlows(db1);
    const id1 = tapeInsertBindsForType(db1, "mint_burn.large_mint")[0]?.[0] as string;

    const db2 = mockTapeD1(withRows([row])) as MockD1Database;
    await projectMintBurnLargeFlows(db2);
    const id2 = tapeInsertBindsForType(db2, "mint_burn.large_mint")[0]?.[0] as string;
    expect(id1).toEqual(id2);
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
