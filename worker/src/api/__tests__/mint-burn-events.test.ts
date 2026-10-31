import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { afterEach, describe, it, expect } from "vitest";
import { mockD1 as createMockD1, type MockD1Database, type MockTableConfig } from "@shared/test-utils/mock-d1";
import { makeMintBurnRow } from "../../test-helpers/__shared/fixtures";
import { registerStablecoinParameterContract } from "../../test-helpers/__shared/endpoint-contracts";
import { handleMintBurnEvents } from "../mint-burn-events";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { MINT_BURN_CONFIGS } from "../../lib/mint-burn-contracts";
import { isGrandfatheredMintBurnConfig } from "../../lib/mint-burn-publication";
import { ACTIVE_MINT_BURN_CONFIGS } from "../mint-burn-flows/aggregate";
import { mintBurnConfigKey } from "../../lib/mint-burn-pipeline/sync-state";
import { mintBurnScanFingerprint } from "../../lib/mint-burn-pipeline/scan-coverage";

function mockD1(tables: MockTableConfig[] = []) {
  return createMockD1([...tables,
    { match: "FROM mint_burn_admission", rows: [] },
    { match: "FROM mint_burn_publication_policy", rows: [] },
    { match: "pharos:mint-burn-scan-coverage:read", rows: [] },
    { match: "pharos:mint-burn-legacy-evidence", rows: [] },
  ]);
}

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

function eventDb(rows: Record<string, string | number | null>[]) {
  const { sqlite, db } = fixtures.open();
  for (const row of rows) {
    sqlite.prepare(`INSERT INTO mint_burn_events (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`)
      .run(...Object.values(row));
  }
  return db;
}

describe("handleMintBurnEvents", () => {
  const row = makeMintBurnRow();

  it.each(["all", "counted"])("keeps %s event totals and pagination inside admitted enabled scope", async (scope) => {
    const { sqlite, db } = fixtures.open();
    const incumbent = MINT_BURN_CONFIGS.find((config) => config.stablecoinId === "usdt-tether")!;
    const pending = { ...incumbent, chain: { ...incumbent.chain, chainId: "synthetic-pending" } };
    MINT_BURN_CONFIGS.push(pending);
    ACTIVE_MINT_BURN_CONFIGS.push(pending);
    try {
      for (const event of [makeMintBurnRow({ id: "pending", chain_id: pending.chain.chainId, timestamp: 100 }),
        makeMintBurnRow({ id: "admitted", timestamp: 99 })]) {
        sqlite.prepare(`INSERT INTO mint_burn_events (${Object.keys(event).join(",")}) VALUES (${Object.keys(event).map(() => "?").join(",")})`)
          .run(...Object.values(event));
      }
      const url = new URL(`https://x/api/mint-burn-events?stablecoin=usdt-tether&scope=${scope}&limit=1`);
      const admitted = await readJsonResponse(await handleMintBurnEvents(db, url), 200) as { events: Array<{ id: string }>; total: number };
      expect(admitted.events.map((event) => event.id)).toEqual(["admitted"]);
      expect(admitted.total).toBe(1);
      sqlite.prepare("INSERT INTO mint_burn_publication_policy (id, disabled_keys, updated_at) VALUES (1, ?, ?)")
        .run(JSON.stringify([mintBurnConfigKey(incumbent)]), 100);
      const disabled = await readJsonResponse(await handleMintBurnEvents(db, url), 200) as { events: unknown[]; total: number };
      expect(disabled.events).toEqual([]);
      expect(disabled.total).toBe(0);
    } finally {
      MINT_BURN_CONFIGS.splice(MINT_BURN_CONFIGS.indexOf(pending), 1);
      ACTIVE_MINT_BURN_CONFIGS.splice(ACTIVE_MINT_BURN_CONFIGS.indexOf(pending), 1);
    }
  });

  it("maps snake_case to camelCase", async () => {
    const db = mockD1([
      { match: "COUNT", rows: [{ total: 1 }] },
      { match: "mint_burn_events", rows: [row] },
    ]);
    const res = await handleMintBurnEvents(db, new URL("https://x/api/mint-burn-events?stablecoin=usdt-tether"));
    const body = (await res.json()) as { events: Array<Record<string, unknown>> };
    const event = body.events[0];
    expect(event).toHaveProperty("stablecoinId");
    expect(event).toHaveProperty("chainId");
    expect(event).toHaveProperty("amountUsd");
    expect(event).toHaveProperty("priceUsed");
    expect(event).toHaveProperty("priceTimestamp");
    expect(event).toHaveProperty("priceSource");
    expect(event).toHaveProperty("flowType");
    expect(event).toHaveProperty("burnType");
    expect(event).toHaveProperty("burnReviewReason");
    expect(event).toHaveProperty("txHash");
    expect(event).toHaveProperty("blockNumber");
    expect(event).toHaveProperty("explorerTxUrl");
    expect(event).not.toHaveProperty("stablecoin_id");
  });

  it("rejects invalid direction with 400", async () => {
    const db = mockD1([]);
    const res = await handleMintBurnEvents(db, new URL("https://x/api/mint-burn-events?stablecoin=usdt-tether&direction=delete"));
    expect(res.status).toBe(400);
  });

  it("rejects chain filters outside the tracked scope for the requested stablecoin", async () => {
    const db = mockD1([]);
    const res = await handleMintBurnEvents(db, new URL("https://x/api/mint-burn-events?stablecoin=usdt-tether&chain=base"));
    expect(res.status).toBe(400);
  });

  it("accepts Arbitrum as the canonical USDai mint/burn chain", async () => {
    const db = mockD1([
      { match: "COUNT", rows: [{ total: 1 }] },
      { match: "mint_burn_events", rows: [makeMintBurnRow({ stablecoin_id: "usdai-usd-ai", chain_id: "arbitrum", symbol: "USDai" })] },
    ]) as MockD1Database;

    const res = await handleMintBurnEvents(
      db,
      new URL("https://x/api/mint-burn-events?stablecoin=usdai-usd-ai&chain=arbitrum"),
    );

    expect(res.status).toBe(200);
    const countQuery = db.getHistory().find((entry) => entry.sql.includes("COUNT(*) as total"));
    expect(countQuery?.sql).toContain("chain_id IN");
    expect(countQuery?.binds).toContain("arbitrum");
  });

  it("keeps Tron events pending until admission, then filters them and preserves the explorer URL", async () => {
    const explorerTxUrl = `https://tronscan.org/#/transaction/${"a".repeat(64)}`;
    const db = eventDb([
      makeMintBurnRow({ id: "usdt-ethereum", chain_id: "ethereum" }),
      makeMintBurnRow({ id: "usdt-tron", chain_id: "tron", explorer_tx_url: explorerTxUrl }),
    ]);
    const url = new URL("https://x/api/mint-burn-events?stablecoin=usdt-tether&chain=tron");
    expect(await readJsonResponse(await handleMintBurnEvents(db, url), 200)).toMatchObject({ total: 0, events: [] });
    const config = MINT_BURN_CONFIGS.find((config) => config.chain.chainId === "tron")!;
    const now = Math.floor(Date.now() / 1000);
    await db.prepare(`INSERT INTO mint_burn_admission
      (config_key, config_fingerprint, admitted_at, baseline_from, baseline_to) VALUES (?, ?, ?, ?, ?)`)
      .bind(mintBurnConfigKey(config), mintBurnScanFingerprint(config), now, now - 90 * 86400, now).run();
    const res = await handleMintBurnEvents(
      db, url,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      total: 1,
      events: [{ id: "usdt-tron", chainId: "tron", explorerTxUrl }],
    });
  });

  it("rejects invalid burnType with 400", async () => {
    const db = mockD1([]);
    const res = await handleMintBurnEvents(db, new URL("https://x/api/mint-burn-events?stablecoin=usdt-tether&burnType=foo"));
    expect(res.status).toBe(400);
  });

  it("accepts valid bridge_burn filter", async () => {
    const bridgeRow = makeMintBurnRow({
      direction: "burn",
      burn_type: "bridge_burn",
    });
    const db = mockD1([
      { match: "COUNT", rows: [{ total: 1 }] },
      { match: "mint_burn_events", rows: [bridgeRow] },
    ]);
    const res = await handleMintBurnEvents(
      db,
      new URL("https://x/api/mint-burn-events?stablecoin=usdt-tether&burnType=bridge_burn"),
    );
    const body = (await readJsonResponse(res, 200)) as { events: Array<{ burnType: string | null }> };
    expect(body.events[0]?.burnType).toBe("bridge_burn");
  });

  it("maps flowType from snake_case and preserves atomic roundtrip rows", async () => {
    const atomicRow = makeMintBurnRow({
      direction: "burn",
      flow_type: "atomic_roundtrip",
      burn_type: "effective_burn",
    });
    const db = mockD1([
      { match: "COUNT", rows: [{ total: 1 }] },
      { match: "mint_burn_events", rows: [atomicRow] },
    ]);
    const res = await handleMintBurnEvents(
      db,
      new URL("https://x/api/mint-burn-events?stablecoin=usdt-tether"),
    );
    const body = (await readJsonResponse(res, 200)) as { events: Array<{ flowType: string }> };
    expect(body.events[0]?.flowType).toBe("atomic_roundtrip");
  });

  it("preserves bridge_transfer flow types for bridge noise rows", async () => {
    const bridgeRow = makeMintBurnRow({
      direction: "mint",
      flow_type: "bridge_transfer",
    });
    const db = mockD1([
      { match: "COUNT", rows: [{ total: 1 }] },
      { match: "mint_burn_events", rows: [bridgeRow] },
    ]);
    const res = await handleMintBurnEvents(
      db,
      new URL("https://x/api/mint-burn-events?stablecoin=usdt-tether"),
    );
    const body = (await readJsonResponse(res, 200)) as { events: Array<{ flowType: string }> };
    expect(body.events[0]?.flowType).toBe("bridge_transfer");
  });

  it("rejects invalid scope with 400", async () => {
    const db = mockD1([]);
    const res = await handleMintBurnEvents(
      db,
      new URL("https://x/api/mint-burn-events?stablecoin=usdt-tether&scope=debug"),
    );
    expect(res.status).toBe(400);
  });

  it.each([
    ["scope=counted", ["priced", "unpriced", "effective"]],
    ["minAmount=1000000", ["priced", "atomic", "bridge", "effective"]],
    ["scope=counted&minAmount=1000000", ["priced", "effective"]],
  ])("keeps count and selection aligned for %s", async (query, expected) => {
    const db = eventDb([
      makeMintBurnRow({ id: "priced", amount_usd: 1_000_000 }),
      makeMintBurnRow({ id: "unpriced", amount: 9_000_000, amount_usd: null }),
      makeMintBurnRow({ id: "atomic", amount_usd: 2_000_000, flow_type: "atomic_roundtrip" }),
      makeMintBurnRow({ id: "bridge", amount_usd: 2_000_000, direction: "burn", burn_type: "bridge_burn" }),
      makeMintBurnRow({ id: "effective", amount_usd: 2_000_000, direction: "burn", burn_type: "effective_burn" }),
      makeMintBurnRow({ id: "small", amount_usd: 999_999, flow_type: "bridge_transfer" }),
    ]);
    const body = await readJsonResponse<{ events: { id: string }[]; total: number }>(
      await handleMintBurnEvents(db, new URL(`https://x/api/mint-burn-events?stablecoin=usdt-tether&${query}`)), 200);
    expect(body.events.map((event) => event.id).sort()).toEqual([...expected].sort());
    expect(body.total).toBe(expected.length);
  });

  it("rejects malformed minAmount with 400", async () => {
    const db = mockD1([]);
    const res = await handleMintBurnEvents(
      db,
      new URL("https://x/api/mint-burn-events?stablecoin=usdt-tether&minAmount=oops"),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid minAmount: must be a number" });
  });

  it("rejects out-of-range limit values instead of clamping them", async () => {
    const db = mockD1([]);
    const res = await handleMintBurnEvents(
      db,
      new URL("https://x/api/mint-burn-events?stablecoin=usdt-tether&limit=999"),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid limit: must be between 1 and 500" });
  });

  it("rejects offsets above the endpoint cap", async () => {
    const db = mockD1([]);
    const res = await handleMintBurnEvents(
      db,
      new URL("https://x/api/mint-burn-events?stablecoin=usdt-tether&offset=25001"),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid offset: must be between 0 and 25000" });
  });

  it("can skip exact total counts for cursor-style callers", async () => {
    const db = mockD1([
      { match: "mint_burn_events", rows: [row] },
    ]) as MockD1Database;

    const res = await handleMintBurnEvents(
      db,
      new URL("https://x/api/mint-burn-events?stablecoin=usdt-tether&includeTotal=false"),
    );

    const body = (await readJsonResponse(res, 200)) as { events: unknown[]; total: number; totalExact: boolean };
    expect(body.events).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.totalExact).toBe(false);
    expect(db.getHistory().some((entry) => entry.sql.includes("COUNT(*) as total"))).toBe(false);
  });

  it("exhausts timestamp and block ties without losing cursor rows", async () => {
    const db = eventDb([
      makeMintBurnRow({ id: "mb-a", timestamp: 1_700_000_003, block_number: 103 }),
      makeMintBurnRow({ id: "mb-b", timestamp: 1_700_000_003, block_number: 103 }),
      makeMintBurnRow({ id: "mb-c", timestamp: 1_700_000_003, block_number: 102 }),
      makeMintBurnRow({ id: "mb-d", timestamp: 1_700_000_002, block_number: 101 }),
    ]);
    let cursor: string | null = null;
    const ids: string[] = [];
    for (let page = 0; page < 4; page++) {
      const url = new URL("https://x/api/mint-burn-events?stablecoin=usdt-tether&limit=1&includeTotal=false");
      if (cursor) url.searchParams.set("cursor", cursor);
      const body = await readJsonResponse<{ events: { id: string }[]; nextCursor: string | null }>(
        await handleMintBurnEvents(db, url), 200);
      ids.push(...body.events.map((event) => event.id));
      cursor = body.nextCursor;
      expect(cursor === null).toBe(page === 3);
    }
    expect(ids).toEqual(["mb-b", "mb-a", "mb-c", "mb-d"]);
  });

  it("includes X-Data-Age header", async () => {
    const db = mockD1([
      { match: "COUNT", rows: [{ total: 1 }] },
      { match: "mint_burn_events", rows: [row] },
    ]);
    const res = await handleMintBurnEvents(db, new URL("https://x/api/mint-burn-events?stablecoin=usdt-tether"));
    expect(res.headers.has("X-Data-Age")).toBe(true);
  });

  it("uses sync-mint-burn cron timestamp for freshness metadata", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "COUNT", rows: [{ total: 1 }] },
      { match: "mint_burn_events", rows: [makeMintBurnRow({ timestamp: now - 10 * 86400 })] },
      { match: "cron_runs", rows: [], first: { started_at: now - 20 } },
    ]);
    const res = await handleMintBurnEvents(db, new URL("https://x/api/mint-burn-events?stablecoin=usdt-tether"));
    const age = Number(res.headers.get("X-Data-Age"));
    expect(age).toBeLessThan(120);
  });

  it("dates an extended-only coin from the extended lane, never the critical sibling", async () => {
    const { sqlite, db } = fixtures.open();
    const now = Math.floor(Date.now() / 1000);
    const currentHour = Math.floor(now / 3600) * 3600;
    const extendedOutputAt = now - 3 * 86400;
    // PYUSD is configured only for the extended lane, so only that lane can
    // insert its rows; its scan proof is three days old while the critical
    // lane's proof is current.
    const insertProof = sqlite.prepare(`INSERT INTO mint_burn_scan_coverage
      (config_key, config_fingerprint, chain_id, from_block, to_block,
       from_timestamp, to_timestamp, finality_tag, finalized_block, accepted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'finalized', ?, ?)`);
    for (const config of MINT_BURN_CONFIGS.filter(isGrandfatheredMintBurnConfig)) {
      const proofEnd = config.tier === "extended" ? currentHour - 3 * 86400 : currentHour;
      const toBlock = config.startBlock + 1_000_000;
      insertProof.run(
        mintBurnConfigKey(config), mintBurnScanFingerprint(config), config.chain.chainId,
        config.startBlock, toBlock, proofEnd - 90 * 86400, proofEnd, toBlock, proofEnd,
      );
    }
    const event = makeMintBurnRow({
      id: "pyusd-extended-only", stablecoin_id: "pyusd-paypal", symbol: "PYUSD", timestamp: extendedOutputAt,
    });
    sqlite.prepare(`INSERT INTO mint_burn_events (${Object.keys(event).join(",")})
      VALUES (${Object.keys(event).map(() => "?").join(",")})`).run(...Object.values(event));
    const insertRun = sqlite.prepare(
      "INSERT INTO cron_runs (job, started_at, duration_ms, status, item_count, metadata) VALUES (?,?,?,?,?,?)",
    );
    insertRun.run("sync-mint-burn", now - 60, 1_000, "ok", 2, "{}");
    insertRun.run("sync-mint-burn-extended", extendedOutputAt, 1_000, "ok", 2, "{}");

    const response = await handleMintBurnEvents(db, new URL("https://x/api/mint-burn-events?stablecoin=pyusd-paypal"));
    const body = (await response.json()) as { events: Array<{ id: string }> };
    expect(body.events.map((entry) => entry.id)).toEqual(["pyusd-extended-only"]);

    // ADR-30/R3: the freshness verdict names the generation for the served rows.
    const ageHeader = response.headers.get("X-Data-Age");
    const age = ageHeader === "unavailable" ? Number.POSITIVE_INFINITY : Number(ageHeader);
    expect(age).toBeGreaterThanOrEqual(3 * 86400 - 60);
    expect(response.headers.get("Warning")).toMatch(/^110 /);
    expect(response.headers.get("Cache-Control") ?? "").toContain("no-store");
  });
});

registerStablecoinParameterContract({
  name: "mint/burn events",
  path: "/api/mint-burn-events",
  invoke: handleMintBurnEvents,
  missingParameterError: "Missing required parameter: stablecoin",
});
