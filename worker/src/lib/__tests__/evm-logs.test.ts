import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import {
  decodeAddress,
  decodeAddressWord,
  decodeUint256,
  decodeUint256Word,
  createBudget,
  budgetExhausted,
  createRateLimiter,
  getEvmBlockNumber,
  fetchEvmLogsForTopicWithCompleteness,
  readDataWord,
} from "../evm-logs";

// --- decodeAddress ---

describe("decodeAddress", () => {
  it("extracts 20-byte address from standard 32-byte topic", () => {
    const topic = "0x000000000000000000000000dac17f958d2ee523a2206206994597c13d831ec7";
    expect(decodeAddress(topic)).toBe("0xdac17f958d2ee523a2206206994597c13d831ec7");
  });

  it("handles topic without 0x prefix", () => {
    const topic = "000000000000000000000000dac17f958d2ee523a2206206994597c13d831ec7";
    expect(decodeAddress(topic)).toBe("0xdac17f958d2ee523a2206206994597c13d831ec7");
  });

  it("returns lowercase address", () => {
    const topic = "0x000000000000000000000000DAC17F958D2EE523A2206206994597C13D831EC7";
    expect(decodeAddress(topic)).toBe("0xdac17f958d2ee523a2206206994597c13d831ec7");
  });

  it("handles zero address (mint from)", () => {
    const topic = "0x0000000000000000000000000000000000000000000000000000000000000000";
    expect(decodeAddress(topic)).toBe("0x0000000000000000000000000000000000000000");
  });
});

describe("decodeAddressWord", () => {
  it("returns null for malformed or short words", () => {
    expect(decodeAddressWord(null)).toBeNull();
    expect(decodeAddressWord("0xdeadbeef")).toBeNull();
    expect(decodeAddressWord("0x" + "z".repeat(64))).toBeNull();
  });

  it("extracts a lowercase address from a strict 32-byte word", () => {
    expect(
      decodeAddressWord("0x000000000000000000000000DAC17F958D2EE523A2206206994597C13D831EC7"),
    ).toBe("0xdac17f958d2ee523a2206206994597c13d831ec7");
  });
});

// --- readDataWord ---

describe("readDataWord", () => {
  const USER = "000000000000000000000000aaaa1111aaaa2222aaaa3333aaaa4444aaaa5555";
  const TOKEN = "000000000000000000000000bbbb1111bbbb2222bbbb3333bbbb4444bbbb5555";
  const AMOUNT = "0000000000000000000000000000000000000000000000000de0b6b3a7640000";

  it("returns the slot-0 word with 0x prefix", () => {
    expect(readDataWord("0x" + USER + TOKEN + AMOUNT, 0)).toBe("0x" + USER);
  });
  it("returns slot-1 when composed correctly", () => {
    expect(readDataWord("0x" + USER + TOKEN + AMOUNT, 1)).toBe("0x" + TOKEN);
  });
  it("returns null when slot is out of range", () => {
    expect(readDataWord("0x" + USER, 3)).toBeNull();
  });
  it("handles data without 0x prefix", () => {
    expect(readDataWord(USER, 0)).toBe("0x" + USER);
  });
  it("composes with decodeAddress for unindexed-param extraction", () => {
    expect(decodeAddress(readDataWord("0x" + USER + TOKEN, 0)!)).toBe(
      "0xaaaa1111aaaa2222aaaa3333aaaa4444aaaa5555",
    );
  });
});

// --- decodeUint256 ---

describe("decodeUint256", () => {
  it("decodes standard uint256 with 18 decimals", () => {
    // 1e18 in hex = 0xDE0B6B3A7640000
    const hex = "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000";
    expect(decodeUint256(hex, 18)).toBeCloseTo(1.0, 10);
  });

  it("decodes uint256 with 6 decimals (USDC)", () => {
    // 1,000,000 in hex = 0xF4240
    const hex = "0x00000000000000000000000000000000000000000000000000000000000f4240";
    expect(decodeUint256(hex, 6)).toBeCloseTo(1.0, 10);
  });

  it("decodes zero value", () => {
    const hex = "0x0000000000000000000000000000000000000000000000000000000000000000";
    expect(decodeUint256(hex, 18)).toBe(0);
  });

  it("handles hex without 0x prefix", () => {
    const hex = "00000000000000000000000000000000000000000000000000000000000f4240";
    expect(decodeUint256(hex, 6)).toBeCloseTo(1.0, 10);
  });

  it("decodes large values (1 billion USDC)", () => {
    // 1e9 * 1e6 = 1e15 = 0x38D7EA4C68000
    const hex = "0x00000000000000000000000000000000000000000000000000038d7ea4c68000";
    expect(decodeUint256(hex, 6)).toBeCloseTo(1_000_000_000, 0);
  });
});

describe("decodeUint256Word", () => {
  it("returns null for malformed or short words", () => {
    expect(decodeUint256Word(null, 6)).toBeNull();
    expect(decodeUint256Word("0xf4240", 6)).toBeNull();
    expect(decodeUint256Word("0x" + "g".repeat(64), 6)).toBeNull();
  });

  it("decodes a strict 32-byte word", () => {
    const word = "0x00000000000000000000000000000000000000000000000000000000000f4240";
    expect(decodeUint256Word(word, 6)).toBe(1);
  });
});

// --- createBudget & budgetExhausted ---

describe("createBudget", () => {
  it("creates budget with default limit of 900", () => {
    const budget = createBudget();
    expect(budget.limit).toBe(900);
    expect(budget.count).toBe(0);
  });

  it("creates budget with custom limit", () => {
    const budget = createBudget(50);
    expect(budget.limit).toBe(50);
    expect(budget.count).toBe(0);
  });
});

describe("budgetExhausted", () => {
  it("returns false when under limit", () => {
    expect(budgetExhausted({ count: 5, limit: 10 })).toBe(false);
  });

  it("returns true when at limit", () => {
    expect(budgetExhausted({ count: 10, limit: 10 })).toBe(true);
  });

  it("returns true when over limit", () => {
    expect(budgetExhausted({ count: 15, limit: 10 })).toBe(true);
  });
});

// --- createRateLimiter ---

describe("createRateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("exposes the configured requests-per-second so callers can report it", () => {
    expect(createRateLimiter(4).requestsPerSecond).toBe(4);
  });

  it("executes function and returns result", async () => {
    const limiter = createRateLimiter(10); // 10 req/s = 100ms interval
    const promise = limiter(() => Promise.resolve(42));
    await vi.advanceTimersByTimeAsync(200);
    const result = await promise;
    expect(result).toBe(42);
  });

  it("enforces timing between sequential calls", async () => {
    const limiter = createRateLimiter(5); // 5 req/s = 200ms interval
    const callTimes: number[] = [];

    const p1 = limiter(async () => {
      callTimes.push(Date.now());
      return 1;
    });

    const p2 = limiter(async () => {
      callTimes.push(Date.now());
      return 2;
    });

    // Advance time to let both complete
    await vi.advanceTimersByTimeAsync(500);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(1);
    expect(r2).toBe(2);
    expect(callTimes).toHaveLength(2);
    // Second call should be at least 200ms after first
    expect(callTimes[1] - callTimes[0]).toBeGreaterThanOrEqual(200);
  });
});

// --- getEvmBlockNumber ---

describe("getEvmBlockNumber", () => {
  beforeEach(() => {
    mockFetch([], { requireMatch: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const noopLimiter = <T>(fn: () => Promise<T>) => fn();

  it("returns null for malformed hex block numbers", async () => {
    mockFetch([{ match: () => true, body: { result: "0x" } }]);

    const budget = createBudget(10);
    await expect(getEvmBlockNumber(1, null, noopLimiter, budget)).resolves.toBeNull();
    expect(budget.count).toBe(1);
  });

  it("parses valid hex block numbers", async () => {
    mockFetch([{ match: () => true, body: { result: "0x1312d00" } }]);

    await expect(getEvmBlockNumber(1, null, noopLimiter, createBudget(10))).resolves.toBe(20_000_000);
  });
});

// --- fetchEvmLogsForTopicWithCompleteness ---

describe("fetchEvmLogsForTopicWithCompleteness", () => {
  beforeEach(() => {
    mockFetch([], { requireMatch: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const noopLimiter = <T>(fn: () => Promise<T>) => fn();

  it("returns logs on success", async () => {
    const mockLogs = [
      { address: "0x123", topics: ["0xabc"], data: "0x", blockNumber: "0x1", timeStamp: "1000", transactionHash: "0xhash", logIndex: "0x0" },
    ];
    mockFetch([{ match: () => true, body: { status: "1", message: "OK", result: mockLogs } }]);

    const budget = createBudget(10);
    const result = await fetchEvmLogsForTopicWithCompleteness(1, "0x123", "0xabc", null, 0, 100, 0, noopLimiter, budget);

    expect(result.complete).toBe(true);
    expect(result.logs).toHaveLength(1);
    expect(budget.count).toBe(1);
  });

  it("marks the scan incomplete on HTTP error", async () => {
    vi.useFakeTimers();
    mockFetch([{ match: () => true, body: "Server Error", status: 500 }]);

    const budget = createBudget(10);
    const pending = fetchEvmLogsForTopicWithCompleteness(1, "0x123", "0xabc", null, 0, 100, 0, noopLimiter, budget);
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result.complete).toBe(false);
    expect(result.logs).toEqual([]);
  });

  it("returns a complete empty result on 'No records found'", async () => {
    mockFetch([{ match: () => true, body: { status: "0", message: "No records found", result: [] } }]);

    const budget = createBudget(10);
    const result = await fetchEvmLogsForTopicWithCompleteness(1, "0x123", "0xabc", null, 0, 100, 0, noopLimiter, budget);

    expect(result).toMatchObject({ complete: true, logs: [], scannedToBlock: 100 });
  });

  it("marks the scan incomplete when budget is exhausted", async () => {
    const budget = { count: 10, limit: 10 }; // Already exhausted
    const result = await fetchEvmLogsForTopicWithCompleteness(1, "0x123", "0xabc", null, 0, 100, 0, noopLimiter, budget);

    expect(result).toMatchObject({
      complete: false,
      logs: [],
      scannedToBlock: -1,
      failureReason: "budget-exhausted",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("marks the scan incomplete at max recursion depth", async () => {
    const budget = createBudget(10);
    const result = await fetchEvmLogsForTopicWithCompleteness(1, "0x123", "0xabc", null, 0, 100, 9, noopLimiter, budget);

    expect(result).toMatchObject({
      complete: false,
      logs: [],
      scannedToBlock: -1,
      failureReason: "max-recursion-depth",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  function logAt(block: number, index = 0) {
    return {
      address: "0x123", topics: ["0xabc"], data: "0x",
      blockNumber: `0x${block.toString(16)}`, timeStamp: "1000",
      transactionHash: `0xhash${block}`, logIndex: `0x${index.toString(16)}`,
    };
  }

  const cappedLogs = Array.from({ length: 1000 }, (_, index) => logAt(0, index));
  function range(from: number, to: number, result: typeof cappedLogs, message = "OK") {
    return {
      match: (request: Request) => {
        const params = new URL(request.url).searchParams;
        return params.get("fromBlock") === String(from) && params.get("toBlock") === String(to);
      },
      body: { status: message === "OK" ? "1" : "0", message, result },
    };
  }

  it("recursively splits into disjoint contiguous ranges", async () => {
    const first = [logAt(1), logAt(50)];
    const second = [logAt(51), logAt(100)];
    const fetchSpy = mockFetch([
      range(0, 100, cappedLogs),
      range(0, 50, first),
      range(51, 100, second),
    ], { requireMatch: true });
    const budget = createBudget(10);
    const result = await fetchEvmLogsForTopicWithCompleteness(1, "0x123", "0xabc", null, 0, 100, 0, noopLimiter, budget);
    expect(result).toEqual({
      logs: [...first, ...second], complete: true, scannedToBlock: 100,
      calls: 3, maxDepth: 1, failureReason: undefined,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(budget.count).toBe(3);
  });

  it("does not advance past a capped unsplittable block", async () => {
    mockFetch([range(0, 0, cappedLogs)], { requireMatch: true });
    const result = await fetchEvmLogsForTopicWithCompleteness(1, "0x123", "0xabc", null, 0, 0, 0, noopLimiter, createBudget(10));
    expect(result).toEqual({
      logs: cappedLogs, complete: false, scannedToBlock: -1, calls: 1,
      maxDepth: 0, failureReason: "etherscan-result-cap-unsplittable",
    });
  });

  it("propagates nested first-child failure without requesting later ranges", async () => {
    const fetchSpy = mockFetch([
      range(0, 100, cappedLogs),
      range(0, 50, cappedLogs),
      range(0, 25, [], "NOTOK"),
    ], { requireMatch: true });
    const budget = createBudget(10);
    expect(await fetchEvmLogsForTopicWithCompleteness(1, "0x123", "0xabc", null, 0, 100, 0, noopLimiter, budget)).toEqual({
      logs: [], complete: false, scannedToBlock: -1, calls: 3, maxDepth: 2, failureReason: "NOTOK",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(budget.count).toBe(3);
  });

  it("retains the first child's logs and contiguous watermark when the second exhausts its budget", async () => {
    const first = [logAt(50)];
    const fetchSpy = mockFetch([range(0, 100, cappedLogs), range(0, 50, first)], { requireMatch: true });
    const budget = createBudget(2);
    expect(await fetchEvmLogsForTopicWithCompleteness(1, "0x123", "0xabc", null, 0, 100, 0, noopLimiter, budget)).toEqual({
      logs: first, complete: false, scannedToBlock: 50, calls: 2, maxDepth: 1, failureReason: "budget-exhausted",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(budget.count).toBe(2);
  });
});
