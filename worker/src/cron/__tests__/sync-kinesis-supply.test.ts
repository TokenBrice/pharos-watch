import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockCircuitBreaker, mockCircuitOutcomeRecord } from "../../test-helpers/cron";

vi.mock("../../lib/circuit-breaker", () => mockCircuitBreaker());

vi.mock("../../lib/fetch-retry", () => ({
  fetchTextWithRetry: vi.fn(),
}));

import { recordOutcomeSafe, shouldAttemptFetch } from "../../lib/circuit-breaker";
import { fetchTextWithRetry } from "../../lib/fetch-retry";
import { syncKinesisSupply, parseKinesisResponse } from "../sync-kinesis-supply";

async function textResult(response: Response | null) {
  if (!response) return null;
  return { response, body: await response.text() };
}

function makeDb(runFn = vi.fn().mockResolvedValue({ meta: { changes: 1 } })) {
  const bindFn = vi.fn().mockReturnValue({ run: runFn });
  const prepareFn = vi.fn().mockReturnValue({ bind: bindFn });
  return {
    db: { prepare: prepareFn } as unknown as D1Database,
    prepareFn,
    bindFn,
    runFn,
  };
}

function horizonResponse(circulation: number, mint: number, redemption: number, date = "2026-03-23T00:00:00Z") {
  return new Response(
    JSON.stringify({
      history_latest_ledger: 42_691_026,
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

  it("parses an array and takes the last element", () => {
    const data = [
      { date: "2026-03-22", circulation: 90, mint: 190, redemption: 100 },
      { date: "2026-03-23", circulation: 100, mint: 200, redemption: 100 },
    ];
    expect(parseKinesisResponse(data)).toEqual({ circulation: 100, mint: 200, redemption: 100 });
  });

  it("parses a Horizon envelope and takes the last record", () => {
    expect(
      parseKinesisResponse({
        history_latest_ledger: 42_691_026,
        records: [
          { date: "2026-03-22T00:00:00Z", circulation: "90", mint: "190", redemption: "100" },
          { date: "2026-03-23T00:00:00Z", circulation: "100", mint: "200", redemption: "100" },
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

  it("returns null when circulation is negative", () => {
    expect(parseKinesisResponse({ circulation: -1, mint: 0, redemption: 0 })).toBeNull();
  });

  it("returns null when fields are non-numeric", () => {
    expect(parseKinesisResponse({ circulation: "abc", mint: 0, redemption: 0 })).toBeNull();
  });
});

describe("syncKinesisSupply", () => {
  beforeEach(() => {
    vi.mocked(shouldAttemptFetch).mockResolvedValue(true);
    vi.mocked(recordOutcomeSafe).mockResolvedValue(mockCircuitOutcomeRecord());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
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
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.mocked(fetchTextWithRetry).mockResolvedValue(await textResult(kauResponse()));
    vi.mocked(shouldAttemptFetch).mockImplementation(async (_db, source) => source !== "kinesis-kag-horizon");
    const runFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long."))
      .mockResolvedValue({ meta: { changes: 1 } });

    const { db, bindFn } = makeDb(runFn);
    const result = await syncKinesisSupply(db, AbortSignal.timeout(5000));

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
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.mocked(fetchTextWithRetry).mockResolvedValue(await textResult(kauResponse()));
    vi.mocked(shouldAttemptFetch).mockImplementation(async (_db, source) => source !== "kinesis-kag-horizon");
    const runFn = vi.fn().mockRejectedValue(new Error("D1 DB storage operation exceeded timeout"));

    const { db } = makeDb(runFn);
    const result = await syncKinesisSupply(db, AbortSignal.timeout(5000));

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
