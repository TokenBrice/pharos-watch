import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { mockCircuitBreaker, mockCircuitOutcomeRecord } from "../../test-helpers/cron";
import { makeNoopD1 } from "../../test-helpers/noop-d1";

vi.mock("../../lib/circuit-breaker", () => mockCircuitBreaker());

vi.mock("../../lib/fetch-retry", () => ({
  fetchTextWithRetry: vi.fn(),
}));

import { recordOutcomeSafe, shouldAttemptFetch } from "../../lib/circuit-breaker";
import { fetchTextWithRetry } from "../../lib/fetch-retry";
import { syncKinesisSupply, parseKinesisResponse } from "../sync-kinesis-supply";

const fixtures = createLatestSchemaFixtureTracker();

async function textResult(response: Response | null) {
  if (!response) return null;
  return { response, body: await response.text() };
}

function makeDb(runFn = vi.fn().mockResolvedValue({ meta: { changes: 1 } })) {
  const bindFn = vi.fn().mockReturnValue({ run: runFn });
  const prepareFn = vi.fn().mockReturnValue({ bind: bindFn });
  return {
    db: makeNoopD1({ prepare: prepareFn }),
    prepareFn,
    bindFn,
    runFn,
  };
}

function horizonResponse(circulation: number, mint: number, redemption: number, date = "2026-03-23T00:00:00Z", ledgerClock: unknown = new Date(Date.now()).toISOString()) {
  return new Response(
    JSON.stringify({
      history_latest_ledger: 42_691_026,
      history_latest_ledger_closed_at: ledgerClock,
      records: [{ circulation: String(circulation), mint: String(mint), redemption: String(redemption), date }],
    }),
    { status: 200 },
  );
}

function kauResponse(circulation = 2_586_388, mint = 131_051_834, redemption = 128_465_446) {
  return horizonResponse(circulation, mint, redemption);
}

function kagResponse(circulation = 3_742_495, mint = 10_523_270, redemption = 6_780_775) {
  return horizonResponse(circulation, mint, redemption);
}

describe("parseKinesisResponse", () => {
  it("parses a single object", () => {
    expect(parseKinesisResponse({ circulation: 100, mint: 200, redemption: 100 })).toEqual({
      circulation: 100,
      mint: 200,
      redemption: 100,
    });
  });

  it("parses an array and selects the newest parsed date", () => {
    const data = [
      { date: "2026-03-23", circulation: 100, mint: 200, redemption: 100 },
      { date: "2026-03-22", circulation: 90, mint: 190, redemption: 100 },
    ];
    expect(parseKinesisResponse(data)).toEqual({ circulation: 100, mint: 200, redemption: 100 });
  });

  it("parses a newest-first Horizon envelope by date", () => {
    expect(
      parseKinesisResponse({
        history_latest_ledger: 42_691_026,
        records: [
          { date: "2026-03-23T00:00:00Z", circulation: "100", mint: "200", redemption: "100" },
          { date: "2026-03-22T00:00:00Z", circulation: "90", mint: "190", redemption: "100" },
        ],
      }),
    ).toEqual({ circulation: 100, mint: 200, redemption: 100 });
  });

  it("returns null for an empty array", () => {
    expect(parseKinesisResponse([])).toBeNull();
  });

  it("returns null for non-object input", () => {
    expect(parseKinesisResponse("not an object")).toBeNull();
    expect(parseKinesisResponse(null)).toBeNull();
    expect(parseKinesisResponse(42)).toBeNull();
  });

  it.each([null, "", " ", true])("rejects missing or non-numeric field %j", (value) => {
    expect(parseKinesisResponse({ circulation: value, mint: 0, redemption: 0 })).toBeNull();
  });

  it("accepts numeric zero and canonical zero strings", () => {
    expect(parseKinesisResponse({ circulation: 0, mint: "0", redemption: 0 })).toEqual({
      circulation: 0,
      mint: 0,
      redemption: 0,
    });
  });

});

describe("syncKinesisSupply", () => {
  beforeEach(() => {
    vi.mocked(shouldAttemptFetch).mockResolvedValue(true);
    vi.mocked(recordOutcomeSafe).mockResolvedValue(mockCircuitOutcomeRecord());
  });

  afterEach(() => {
    fixtures.closeAll();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("rejects pre-aborted work without provider calls or writes", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const { db, runFn } = makeDb();
    await expect(syncKinesisSupply(db, controller.signal)).rejects.toThrow("cancelled");
    expect(fetchTextWithRetry).not.toHaveBeenCalled();
    expect(recordOutcomeSafe).not.toHaveBeenCalled();
    expect(runFn).not.toHaveBeenCalled();
  });

  it("does not charge provider health or start the second chain after fetch cancellation", async () => {
    const controller = new AbortController();
    const failure = new Error("cancelled fetch");
    vi.mocked(fetchTextWithRetry).mockImplementationOnce(async () => {
      controller.abort(failure);
      throw failure;
    });
    const { db, runFn } = makeDb();
    await expect(syncKinesisSupply(db, controller.signal)).rejects.toBe(failure);
    expect(fetchTextWithRetry).toHaveBeenCalledTimes(1);
    expect(shouldAttemptFetch).toHaveBeenCalledTimes(1);
    expect(recordOutcomeSafe).not.toHaveBeenCalled();
    expect(runFn).not.toHaveBeenCalled();
  });
  it("rejects independently invalid parser fields and malformed bodies without publishing supply", async () => {
    for (const body of [
      '{"circulation":100,"mint":-1,"redemption":0}',
      '{"circulation":100,"mint":"Infinity","redemption":0}',
      '{"circulation":100,"mint":200,"redemption":-1}',
      '{"circulation":100,"mint":200,"redemption":"NaN"}',
      '{"records":[{"circulation":null,"mint":"","redemption":" "}]}',
      '{"records":[]}',
      'malformed JSON',
    ]) {
      vi.mocked(recordOutcomeSafe).mockClear();
      vi.mocked(fetchTextWithRetry).mockResolvedValue({ response: new Response(body), body });
      const { db, runFn } = makeDb();
      const result = await syncKinesisSupply(db, new AbortController().signal);
      expect(result.itemCount).toBe(0);
      expect(result.status).toBe("degraded");
      expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({ reason: "invalid-upstream-payload" });
      expect(runFn).not.toHaveBeenCalled();
      expect(vi.mocked(recordOutcomeSafe).mock.calls.map((call) => call[2])).toEqual([false, false]);
    }
  });
  it.each([0, 100])("admits fresh ledger evidence despite an old last-change record (supply %s)", async (supply) => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    vi.mocked(fetchTextWithRetry).mockResolvedValue(await textResult(
      horizonResponse(supply, 200, 100, "2020-01-01T00:00:00Z", new Date(1_799_999_880_000).toISOString()),
    ));
    const { db, sqlite } = fixtures.open();
    const result = await syncKinesisSupply(db, new AbortController().signal);
    expect(result.status).toBe("ok");
    expect(result.itemCount).toBe(2);
    expect(sqlite.prepare("SELECT stablecoin_id, supply, updated_at FROM onchain_supply ORDER BY stablecoin_id").all()).toEqual([
      { stablecoin_id: "kag-kinesis", supply, updated_at: 1_799_999_880 },
      { stablecoin_id: "kau-kinesis", supply, updated_at: 1_799_999_880 },
    ]);
  });

  it.each<[string, unknown, string, number?]>([
    ["stale", new Date((1_800_000_000 - 8 * 3600 - 1) * 1000).toISOString(), "ledger-clock-stale"],
    ["future", new Date(1_800_000_001_000).toISOString(), "ledger-clock-future"],
    ["malformed", "not-a-date", "ledger-clock-malformed"],
    ["empty", "", "ledger-clock-malformed"],
    ["null", null, "ledger-clock-malformed"],
    ["numeric", 1_800_000_000, "ledger-clock-malformed"],
    ["impossible February day", "2026-02-30T08:00:00Z", "ledger-clock-malformed", Date.parse("2026-03-02T08:01:00Z")],
    ["non-leap February day", "2026-02-29T08:00:00Z", "ledger-clock-malformed", Date.parse("2026-03-01T08:01:00Z")],
    ["impossible month day with offset", "2026-04-31T10:00:00.123456+02:00", "ledger-clock-malformed", Date.parse("2026-05-01T08:01:00Z")],
    ["rollover midnight", "2026-03-01T24:00:00Z", "ledger-clock-malformed", Date.parse("2026-03-02T00:01:00Z")],
    ["invalid minute", "2026-03-02T08:60:00Z", "ledger-clock-malformed", Date.parse("2026-03-02T09:01:00Z")],
    ["invalid second", "2026-03-02T08:00:60Z", "ledger-clock-malformed", Date.parse("2026-03-02T08:01:00Z")],
    ["invalid offset hour", "2026-03-02T08:00:00+24:00", "ledger-clock-malformed", Date.parse("2026-03-02T08:01:00Z")],
    ["invalid offset minute", "2026-03-02T08:00:00+00:60", "ledger-clock-malformed", Date.parse("2026-03-02T08:01:00Z")],
  ])("retains last accepted stock without renewing a %s declared ledger clock", async (_label, clock, reason, nowMs = 1_800_000_000_000) => {
    vi.spyOn(Date, "now").mockReturnValue(nowMs);
    vi.mocked(fetchTextWithRetry).mockResolvedValue(await textResult(
      horizonResponse(100, 200, 100, "2027-01-15T08:00:00Z", clock),
    ));
    const { db, sqlite } = fixtures.open();
    sqlite.exec(`INSERT INTO onchain_supply VALUES
      ('kau-kinesis', 'kinesis-kau', 9, 1799990000),
      ('kag-kinesis', 'kinesis-kag', 8, 1799990000)`);
    const prepareSpy = vi.spyOn(db, "prepare");
    const result = await syncKinesisSupply(db, new AbortController().signal);
    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(0);
    expect(prepareSpy).not.toHaveBeenCalled();
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      reason,
      chains: [
        { chain: "kinesis-kau", status: "invalid_payload", reason },
        { chain: "kinesis-kag", status: "invalid_payload", reason },
      ],
    });
    expect(sqlite.prepare("SELECT stablecoin_id, supply, updated_at FROM onchain_supply ORDER BY stablecoin_id").all()).toEqual([
      { stablecoin_id: "kag-kinesis", supply: 8, updated_at: 1_799_990_000 },
      { stablecoin_id: "kau-kinesis", supply: 9, updated_at: 1_799_990_000 },
    ]);
    expect(vi.mocked(recordOutcomeSafe).mock.calls.map((call) => call[2])).toEqual([false, false]);
  });

  it.each([
    ["2024-02-29T08:00:00Z", "2024-02-29T08:01:00Z"],
    ["2026-03-01T10:00:00.123456+02:00", "2026-03-01T08:01:00Z"],
    ["2026-02-28T23:00:00.123-09:00", "2026-03-01T08:01:00Z"],
  ])("admits valid calendar and offset ledger evidence %s", async (clock, now) => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(now));
    vi.mocked(fetchTextWithRetry).mockResolvedValue(await textResult(
      horizonResponse(100, 200, 100, "2020-01-01T00:00:00Z", clock),
    ));
    const { db, sqlite } = fixtures.open();
    const result = await syncKinesisSupply(db, new AbortController().signal);
    expect(result.status).toBe("ok");
    expect(result.itemCount).toBe(2);
    expect(sqlite.prepare("SELECT supply, updated_at FROM onchain_supply ORDER BY stablecoin_id").all()).toEqual([
      { supply: 100, updated_at: Math.floor(Date.parse(clock) / 1000) },
      { supply: 100, updated_at: Math.floor(Date.parse(clock) / 1000) },
    ]);
  });

  it("admits the inclusive ledger age boundary", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    vi.mocked(fetchTextWithRetry).mockResolvedValue(await textResult(
      horizonResponse(100, 200, 100, "2020-01-01T00:00:00Z", new Date((1_800_000_000 - 8 * 3600) * 1000).toISOString()),
    ));
    const { db, sqlite } = fixtures.open();
    expect((await syncKinesisSupply(db, new AbortController().signal)).status).toBe("ok");
    expect(sqlite.prepare("SELECT supply, updated_at FROM onchain_supply WHERE stablecoin_id = 'kau-kinesis'").get())
      .toEqual({ supply: 100, updated_at: 1_799_971_200 });
  });

  it.each(["object", "array", "envelope"])("retains explicit local-fetch compatibility for an undated legacy %s", async (shape) => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const record = { circulation: 0, mint: 0, redemption: 0 };
    const body = JSON.stringify(shape === "array" ? [record] : shape === "envelope" ? { records: [record] } : record);
    vi.mocked(fetchTextWithRetry).mockResolvedValue({ response: new Response(body), body });
    const { db, sqlite } = fixtures.open();
    expect((await syncKinesisSupply(db, new AbortController().signal)).status).toBe("ok");
    expect(sqlite.prepare("SELECT supply, updated_at FROM onchain_supply WHERE stablecoin_id = 'kau-kinesis'").get())
      .toEqual({ supply: 0, updated_at: 1_800_000_000 });
  });

  it("syncs both chains on happy path", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    vi.mocked(fetchTextWithRetry).mockImplementation(async (url: string) => {
      if (url.includes("kau-mainnet")) return await textResult(kauResponse());
      if (url.includes("kag-mainnet")) return await textResult(kagResponse());
      return null;
    });

    const { db, bindFn } = makeDb();
    const result = await syncKinesisSupply(db, AbortSignal.timeout(5000));

    expect(result.status).toBe("ok");
    expect(result.itemCount).toBe(2);
    expect(fetchTextWithRetry).toHaveBeenCalledTimes(2);
    expect(recordOutcomeSafe).toHaveBeenCalledTimes(2);
    expect(vi.mocked(recordOutcomeSafe).mock.calls.every((c) => c[2] === true)).toBe(true);

    // Verify DB upserts
    expect(bindFn).toHaveBeenCalledWith("kau-kinesis", "kinesis-kau", 2_586_388, 1_700_000_000);
    expect(bindFn).toHaveBeenCalledWith("kag-kinesis", "kinesis-kag", 3_742_495, 1_700_000_000);
  });

  it("skips a chain when its circuit breaker is open", async () => {
    vi.mocked(shouldAttemptFetch).mockImplementation(async (_db, source) => source !== "kinesis-kau-horizon");
    vi.mocked(fetchTextWithRetry).mockResolvedValue(await textResult(kagResponse()));

    const { db } = makeDb();
    const result = await syncKinesisSupply(db, AbortSignal.timeout(5000));

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(1);
    expect(fetchTextWithRetry).toHaveBeenCalledTimes(1);
    const meta = JSON.parse(result.metadata!);
    expect(meta.skipped).toBe(1);
    expect(meta.synced).toBe(1);
  });

  it("returns degraded when both circuits are open", async () => {
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);

    const { db } = makeDb();
    const result = await syncKinesisSupply(db, AbortSignal.timeout(5000));

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(0);
    expect(fetchTextWithRetry).not.toHaveBeenCalled();
    expect(JSON.parse(result.metadata!)).toMatchObject({
      synced: 0,
      failed: 0,
      skipped: 2,
    });
  });

  it("records failure and continues when one chain fetch fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(fetchTextWithRetry).mockImplementation(async (url: string) => {
      if (url.includes("kau-mainnet")) return null; // fetch failure
      if (url.includes("kag-mainnet")) return await textResult(kagResponse());
      return null;
    });

    const { db } = makeDb();
    const controller = new AbortController();
    const result = await syncKinesisSupply(db, controller.signal);

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(1);
    expect(vi.mocked(recordOutcomeSafe).mock.calls[0]).toEqual(
      expect.arrayContaining([expect.anything(), "kinesis-kau-horizon", false]),
    );
    expect(vi.mocked(recordOutcomeSafe).mock.calls[1]).toEqual(
      expect.arrayContaining([expect.anything(), "kinesis-kag-horizon", true]),
    );
  });

  it("retries D1 overloads when upserting onchain supply", async () => {
    vi.useFakeTimers();
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.mocked(fetchTextWithRetry).mockResolvedValue(await textResult(kauResponse()));
    vi.mocked(shouldAttemptFetch).mockImplementation(async (_db, source) => source !== "kinesis-kag-horizon");
    const runFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long."))
      .mockResolvedValue({ meta: { changes: 1 } });

    const { db, bindFn } = makeDb(runFn);
    const syncing = syncKinesisSupply(db, new AbortController().signal);
    await vi.runAllTimersAsync();
    const result = await syncing;

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(1);
    expect(JSON.parse(result.metadata!).skipped).toBe(1);
    expect(bindFn).toHaveBeenCalledWith("kau-kinesis", "kinesis-kau", 2_586_388, 1_700_000_000);
    expect(runFn).toHaveBeenCalledTimes(2);
    expect(vi.mocked(recordOutcomeSafe).mock.calls[0]![2]).toBe(true);
  });

  it("handles array response format", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const arrayResponse = new Response(
      JSON.stringify([
        { date: "2026-03-22", circulation: 2_580_000, mint: 131_000_000, redemption: 128_420_000 },
        { date: "2026-03-23", circulation: 2_586_388, mint: 131_051_834, redemption: 128_465_446 },
      ]),
      { status: 200 },
    );
    vi.mocked(fetchTextWithRetry).mockResolvedValue(await textResult(arrayResponse));

    const { db, bindFn } = makeDb();
    // Only test KAU by making KAG circuit open
    vi.mocked(shouldAttemptFetch).mockImplementation(async (_db, source) => source !== "kinesis-kag-horizon");
    await syncKinesisSupply(db, AbortSignal.timeout(5000));

    // Should use the last element
    expect(bindFn).toHaveBeenCalledWith("kau-kinesis", "kinesis-kau", 2_586_388, 1_700_000_000);
  });

  it("treats invalid circulation as failure", async () => {
    vi.mocked(fetchTextWithRetry).mockResolvedValue(
      await textResult(new Response(JSON.stringify({ circulation: -5, mint: 0, redemption: 0 }), { status: 200 })),
    );

    const { db } = makeDb();
    // Only test KAU
    vi.mocked(shouldAttemptFetch).mockImplementation(async (_db, source) => source !== "kinesis-kag-horizon");
    const result = await syncKinesisSupply(db, AbortSignal.timeout(5000));

    expect(result.itemCount).toBe(0);
    expect(vi.mocked(recordOutcomeSafe).mock.calls[0]![2]).toBe(false);
  });

  it("does not record provider failure when D1 persistence fails after a successful fetch", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.mocked(fetchTextWithRetry).mockResolvedValue(await textResult(kauResponse()));
    vi.mocked(shouldAttemptFetch).mockImplementation(async (_db, source) => source !== "kinesis-kag-horizon");
    const runFn = vi.fn().mockRejectedValue(new Error("D1 DB storage operation exceeded timeout"));

    const { db } = makeDb(runFn);
    const syncing = syncKinesisSupply(db, new AbortController().signal);
    await vi.runAllTimersAsync();
    const result = await syncing;

    expect(result.status).toBe("error");
    expect(result.itemCount).toBe(0);
    expect(runFn).toHaveBeenCalledTimes(4);
    expect(vi.mocked(recordOutcomeSafe)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordOutcomeSafe).mock.calls[0]).toEqual(
      expect.arrayContaining([expect.anything(), "kinesis-kau-horizon", true]),
    );
    expect(JSON.parse(result.metadata!)).toMatchObject({
      failed: 1,
      skipped: 1,
      chains: [
        { chain: "kinesis-kau", status: "d1_error", circulation: 2_586_388 },
        { chain: "kinesis-kag", status: "circuit_open" },
      ],
    });
  });
});
