import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/db", () => ({
  batchExecute: vi.fn(async (_db: D1Database, stmts: D1PreparedStatement[]) => stmts.length),
}));

vi.mock("../../lib/fetch-retry", () => ({
  fetchWithRetry: vi.fn(),
}));

import { batchExecute } from "../../lib/db";
import { fetchWithRetry } from "../../lib/fetch-retry";
import {
  DEPEG_PENDING_EXPIRY_SEC,
  DEPEG_PENDING_MIN_AGE_SEC,
} from "../../lib/constants";
import { makeAsset } from "../../api/__tests__/helpers/fixtures";
import { confirmPendingDepegs } from "../confirm-pending-depegs";

interface PendingRow {
  id: number;
  stablecoin_id: string;
  symbol: string;
  peg_type: string;
  direction: string;
  first_seen_bps: number;
  first_seen_at: number;
  first_price: number;
  peg_reference: number;
}

interface PreparedStatementWithMeta extends D1PreparedStatement {
  sql: string;
  boundValues: unknown[];
}

function makePendingRow(overrides: Partial<PendingRow> = {}): PendingRow {
  return {
    id: 1,
    stablecoin_id: "usdt-tether",
    symbol: "USDT",
    peg_type: "peggedUSD",
    direction: "below",
    first_seen_bps: -200,
    first_seen_at: 0,
    first_price: 0.98,
    peg_reference: 1,
    ...overrides,
  };
}

function makeNeutralUsdAssets(count = 6) {
  return Array.from({ length: count }, (_, index) =>
    makeAsset({
      id: `neutral-usd-${index + 1}`,
      name: `Neutral USD ${index + 1}`,
      symbol: `NUSD${index + 1}`,
      geckoId: undefined,
      price: 1,
    }),
  );
}

function makeDb(config: {
  pendingRows?: PendingRow[];
  dexRows?: Array<{ stablecoin_id: string; dex_price_usd: number; updated_at: number }>;
  openRows?: Array<{ stablecoin_id: string }>;
  dexError?: unknown;
}): D1Database {
  function createStatement(sql: string, boundValues: unknown[] = []): PreparedStatementWithMeta {
    return {
      sql,
      boundValues,
      bind: (...args: unknown[]) => createStatement(sql, args),
      all: async <T>() => {
        if (sql.includes("FROM depeg_pending")) {
          return { results: (config.pendingRows ?? []) as T[], success: true, meta: {} };
        }
        if (sql.includes("FROM dex_prices")) {
          if (config.dexError != null) throw (config.dexError instanceof Error ? config.dexError : new Error(String(config.dexError)));
          return { results: (config.dexRows ?? []) as T[], success: true, meta: {} };
        }
        if (sql.includes("FROM depeg_events")) {
          return { results: (config.openRows ?? []) as T[], success: true, meta: {} };
        }
        return { results: [] as T[], success: true, meta: {} };
      },
      first: async <T>() => null as T | null,
      run: async () => ({ success: true, meta: { changes: 1 } }),
    } as unknown as PreparedStatementWithMeta;
  }

  return {
    prepare: (sql: string) => createStatement(sql),
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;
}

describe("confirmPendingDepegs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("returns early when there are no pending rows", async () => {
    await confirmPendingDepegs(makeDb({ pendingRows: [] }), []);

    expect(batchExecute).not.toHaveBeenCalled();
    expect(fetchWithRetry).not.toHaveBeenCalled();
  });

  it("cleans invalid, duplicate, recovered, young, and expired pending rows correctly", async () => {
    const nowSec = 1_700_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);

    await confirmPendingDepegs(
      makeDb({
        pendingRows: [
          makePendingRow({ id: 1, stablecoin_id: "usdt-tether", symbol: "USDT", peg_reference: 0 }),
          makePendingRow({ id: 2, stablecoin_id: "usdc-circle", symbol: "USDC" }),
          makePendingRow({
            id: 3,
            stablecoin_id: "usde-ethena",
            symbol: "USDe",
            first_seen_bps: -150,
            first_seen_at: nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
          }),
          makePendingRow({
            id: 4,
            stablecoin_id: "usds-sky",
            symbol: "USDS",
            first_seen_at: nowSec - DEPEG_PENDING_MIN_AGE_SEC + 60,
          }),
          makePendingRow({
            id: 5,
            stablecoin_id: "cusd-cap",
            symbol: "CUSD",
            first_seen_at: nowSec - DEPEG_PENDING_EXPIRY_SEC - 60,
          }),
        ],
        openRows: [{ stablecoin_id: "usdc-circle" }],
      }),
      [
        makeAsset({ id: "usde-ethena", name: "USDe", symbol: "USDe", geckoId: "ethena-usde", price: 1.005 }),
        makeAsset({ id: "usds-sky", name: "USDS", symbol: "USDS", geckoId: "usds", price: 0.94 }),
        makeAsset({ id: "cusd-cap", name: "CUSD", symbol: "CUSD", geckoId: undefined, price: 0.93 }),
        ...makeNeutralUsdAssets(),
      ],
    );

    expect(fetchWithRetry).not.toHaveBeenCalled();
    expect(batchExecute).toHaveBeenCalledTimes(1);
    const [, statements] = vi.mocked(batchExecute).mock.calls[0]!;
    const deletes = (statements as PreparedStatementWithMeta[])
      .filter((stmt) => stmt.sql.startsWith("DELETE FROM depeg_pending"))
      .map((stmt) => stmt.boundValues[0]);
    expect(deletes).toEqual([1, 2, 3, 5]);
  });

  it("promotes or rejects pending rows based on secondary-source agreement", async () => {
    const nowSec = 1_700_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    vi.spyOn(console, "log").mockImplementation(() => {});

    vi.mocked(fetchWithRetry).mockImplementation(async (url: string) => {
      if (url.includes("tether")) {
        return new Response(JSON.stringify({ tether: { usd: 0.95 } }), { status: 200 });
      }
      if (url.includes("usd-coin")) {
        return null;
      }
      if (url.includes("ethena-usde")) {
        return new Response(JSON.stringify({ "ethena-usde": { usd: 1 } }), { status: 200 });
      }
      if (url.includes("usds")) {
        return new Response(JSON.stringify({ usds: { usd: 1 } }), { status: 200 });
      }
      return null;
    });

    await confirmPendingDepegs(
      makeDb({
        pendingRows: [
          makePendingRow({
            id: 10,
            stablecoin_id: "usdt-tether",
            symbol: "USDT",
            first_seen_bps: -250,
            first_seen_at: nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
            first_price: 0.975,
          }),
          makePendingRow({
            id: 11,
            stablecoin_id: "usdc-circle",
            symbol: "USDC",
            first_seen_bps: -200,
            first_seen_at: nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
            first_price: 0.98,
          }),
          makePendingRow({
            id: 12,
            stablecoin_id: "usde-ethena",
            symbol: "USDe",
            first_seen_bps: -220,
            first_seen_at: nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
            first_price: 0.978,
          }),
          makePendingRow({
            id: 13,
            stablecoin_id: "usds-sky",
            symbol: "USDS",
            first_seen_bps: -210,
            first_seen_at: nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
            first_price: 0.979,
          }),
          makePendingRow({
            id: 14,
            stablecoin_id: "mystery-coin",
            symbol: "MYST",
            first_seen_bps: -230,
            first_seen_at: nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
            first_price: 0.977,
          }),
        ],
        dexRows: [
          { stablecoin_id: "usdc-circle", dex_price_usd: 0.96, updated_at: nowSec - 30 },
          { stablecoin_id: "usde-ethena", dex_price_usd: 1.001, updated_at: nowSec - 30 },
        ],
      }),
      [
        makeAsset({ id: "usdt-tether", symbol: "USDT", geckoId: "tether", price: 0.95 }),
        makeAsset({ id: "usdc-circle", symbol: "USDC", geckoId: "usd-coin", price: 0.94 }),
        makeAsset({ id: "usde-ethena", symbol: "USDe", geckoId: "ethena-usde", price: 0.93 }),
        makeAsset({ id: "usds-sky", symbol: "USDS", geckoId: "usds", price: 0.94 }),
        makeAsset({ id: "mystery-coin", name: "Mystery USD", symbol: "MYST", geckoId: undefined, price: 0.92 }),
        ...makeNeutralUsdAssets(),
      ],
    );

    expect(fetchWithRetry).toHaveBeenCalledTimes(4);
    expect(batchExecute).toHaveBeenCalledTimes(1);

    const [, statements] = vi.mocked(batchExecute).mock.calls[0]!;
    const prepared = statements as PreparedStatementWithMeta[];
    const inserts = prepared.filter((stmt) => stmt.sql.startsWith("INSERT INTO depeg_events"));
    const deletes = prepared
      .filter((stmt) => stmt.sql.startsWith("DELETE FROM depeg_pending"))
      .map((stmt) => stmt.boundValues[0]);

    expect(inserts).toHaveLength(2);
    expect(inserts[0]?.boundValues).toEqual([
      "usdt-tether",
      "USDT",
      "peggedUSD",
      "below",
      -500,
      nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
      0.975,
      0.95,
      1,
    ]);
    expect(inserts[1]?.boundValues).toEqual([
      "usdc-circle",
      "USDC",
      "peggedUSD",
      "below",
      -600,
      nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
      0.98,
      0.94,
      1,
    ]);
    expect(deletes).toEqual([10, 11, 12, 13]);
  });

  it("handles a missing dex_prices table without failing the run", async () => {
    const nowSec = 1_700_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    vi.mocked(fetchWithRetry).mockResolvedValue(null);

    await expect(
      confirmPendingDepegs(
        makeDb({
          pendingRows: [
            makePendingRow({
              id: 20,
              stablecoin_id: "usdt-tether",
              symbol: "USDT",
              first_seen_at: nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
            }),
          ],
          dexError: new Error("no such table: dex_prices"),
        }),
        [
          makeAsset({ id: "usdt-tether", symbol: "USDT", geckoId: "tether", price: 0.94 }),
          ...makeNeutralUsdAssets(),
        ],
      ),
    ).resolves.toBeUndefined();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(batchExecute).not.toHaveBeenCalled();
  });

  it("rethrows abort-related failures from secondary fetches", async () => {
    const nowSec = 1_700_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);

    const controller = new AbortController();
    vi.mocked(fetchWithRetry).mockImplementation(async () => {
      controller.abort(new Error("stop now"));
      throw new Error("network aborted");
    });

    await expect(
      confirmPendingDepegs(
        makeDb({
          pendingRows: [
            makePendingRow({
              id: 30,
              stablecoin_id: "usdt-tether",
              symbol: "USDT",
              first_seen_at: nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
            }),
          ],
        }),
        [
          makeAsset({ id: "usdt-tether", symbol: "USDT", geckoId: "tether", price: 0.94 }),
          ...makeNeutralUsdAssets(),
        ],
        undefined,
        controller.signal,
      ),
    ).rejects.toThrow("network aborted");

    expect(batchExecute).not.toHaveBeenCalled();
  });
});
