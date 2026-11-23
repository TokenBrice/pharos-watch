import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredPromise } from "./deferred.test-support";

const word = (v: bigint): string => v.toString(16).padStart(64, "0");
const roundHex = (ans: bigint, updAt: number): `0x${string}` => `0x${[word(1n), word(ans >= 0n ? ans : (1n << 256n) + ans), word(0n), word(BigInt(updAt)), word(1n)].join("")}`;

vi.mock("../evm-rpc", () => ({ fetchEvmCallHexAtBlock: vi.fn(), fetchEtherscanProxyHex: vi.fn(), fetchJsonRpcHexAtUrl: vi.fn() }));

import { fetchEtherscanProxyHex, fetchEvmCallHexAtBlock, fetchJsonRpcHexAtUrl } from "../evm-rpc";
import { CHAINLINK_REFERENCE_FEEDS as FEEDS, fetchChainlinkReferenceQuoteSnapshot as fetchSnap } from "../chainlink-feeds";
import { parseChainlinkLatestRoundData as parseRound, parseSignedInt256Word as parseI256, requireChainlinkLatestRoundData as reqRound } from "../chainlink-round-data";

const mEvm = vi.mocked(fetchEvmCallHexAtBlock), mEth = vi.mocked(fetchEtherscanProxyHex), mRpc = vi.mocked(fetchJsonRpcHexAtUrl);
const NOW = 1_763_888_000, DEC8 = `0x${word(8n)}` as const, DEC_SEL = "0x313ce567", RND_SEL = "0xfeaf968c";
const feedOf = (k: string) => FEEDS.find((f) => f.pegKey === k);

afterEach(() => { vi.restoreAllMocks(); mEvm.mockReset(); mEth.mockReset(); mRpc.mockReset(); });

describe("fetchChainlinkReferenceQuoteSnapshot", () => {
  it("returns fresh quotes for configured feeds", async () => {
    const eur = feedOf("peggedEUR"); expect(eur).toBeDefined();
    mEvm.mockImplementation(async (_c, a, d) => a !== eur!.proxyAddress ? null : d === DEC_SEL ? DEC8 : d === RND_SEL ? roundHex(115_820_000n, NOW - 100) : null);
    expect((await fetchSnap(undefined, undefined, NOW)).quotes.get("peggedEUR")?.price).toBeCloseTo(1.1582, 4);
  });

  it("falls back to the Etherscan proxy when RPC calls return null", async () => {
    expect(feedOf("peggedEUR")).toBeDefined();
    mEvm.mockResolvedValue(null); mRpc.mockResolvedValue(null);
    const ids: Record<string, number> = { base: 8453, ethereum: 1, arbitrum: 42161 };
    mEth.mockImplementation(async ({ evmChainId, to, data }) => {
      if (!FEEDS.find((f) => f.proxyAddress === to && ids[f.chainId] === evmChainId)) return null;
      return data === DEC_SEL ? DEC8 : data === RND_SEL ? roundHex(115_820_000n, NOW - 100) : null;
    });
    const snap = await fetchSnap(undefined, undefined, NOW, undefined, "etherscan-key");
    expect(snap.quotes.get("peggedEUR")?.price).toBeCloseTo(1.1582, 4);
    expect(snap.summary).toMatchObject({ fetchErrors: 0, usableQuotes: FEEDS.length });
    expect(mEth.mock.calls.map(([c]) => [c.evmChainId, c.to, c.data]).sort()).toEqual(FEEDS.flatMap((f) => [DEC_SEL, RND_SEL].map((d) => [ids[f.chainId], f.proxyAddress, d])).sort());
  });

  it("prefers dRPC before shared RPC and Etherscan fallbacks", async () => {
    const eur = feedOf("peggedEUR"); expect(eur).toBeDefined();
    mRpc.mockImplementation(async (_u, _m, p) => {
      const [c] = p as [{ to: string; data: string }];
      return c.to !== eur!.proxyAddress ? null : c.data === DEC_SEL ? DEC8 : c.data === RND_SEL ? roundHex(115_820_000n, NOW - 100) : null;
    });
    expect((await fetchSnap(undefined, undefined, NOW, "drpc-key")).quotes.get("peggedEUR")?.price).toBeCloseTo(1.1582, 4);
    expect(mRpc).toHaveBeenCalled();
    for (const sel of [DEC_SEL, RND_SEL]) expect(mEvm).not.toHaveBeenCalledWith("base", eur!.proxyAddress, sel, "latest", expect.anything());
    expect(mEth).not.toHaveBeenCalled();
  });

  it("reports summary counts for unavailable and stale feeds", async () => {
    const eur = feedOf("peggedEUR"), gbp = feedOf("peggedGBP"); expect(eur).toBeDefined(); expect(gbp).toBeDefined();
    mEvm.mockImplementation(async (_c, a, d) => a === eur!.proxyAddress ? (d === DEC_SEL ? DEC8 : d === RND_SEL ? roundHex(115_820_000n, 1_763_800_000) : null) : a === gbp!.proxyAddress && d === DEC_SEL ? DEC8 : null);
    const snap = await fetchSnap(undefined, undefined, NOW, undefined, undefined, { peggedEUR: 3, peggedGBP: 3 });
    expect(snap.quotes.size).toBe(0); expect(snap.summary).toMatchObject({ usableQuotes: 0, staleQuotes: 1 }); expect(snap.summary.roundDataUnavailable).toBeGreaterThanOrEqual(1);
    expect(snap.perFeedOutcomes).toMatchObject({ peggedEUR: "out-of-budget", peggedGBP: "failure" });
    expect(snap.outOfBudgetRounds).toEqual({ peggedEUR: { updatedAt: 1_763_800_000, staleAfterSec: 21_600 } });
    expect(snap.failingRuns).toMatchObject({ peggedEUR: 0, peggedGBP: 4 });
  });

  it("counts malformed decimals words as unavailable", async () => {
    mEvm.mockImplementation(async (_c, _a, d) => d === DEC_SEL ? (`0x${"g".repeat(64)}` as `0x${string}`) : roundHex(115_820_000n, NOW - 100));
    const snap = await fetchSnap(undefined, undefined, NOW);
    expect(snap.quotes.size).toBe(0); expect(snap.summary).toMatchObject({ decimalsUnavailable: FEEDS.length, fetchErrors: 0 });
  });

  it("enforces numeric and freshness boundaries independently", async () => {
    const eur = feedOf("peggedEUR")!;
    for (const tc of [{ d: 36n, a: 10n ** 36n, u: NOW, c: null }, { d: 37n, a: 10n ** 37n, u: NOW, c: "invalidDecimals" }, { d: 8n, a: 100_000_000n, u: NOW - 21_600, c: null }, { d: 8n, a: 100_000_000n, u: NOW - 21_601, c: "staleQuotes" }] as const) {
      mEvm.mockImplementation(async (_c, addr, data) => addr !== eur.proxyAddress ? null : data === DEC_SEL ? `0x${word(tc.d)}` : roundHex(tc.a, tc.u));
      const snap = await fetchSnap(undefined, undefined, NOW);
      expect(snap.quotes.get("peggedEUR")?.price).toBe(tc.c ? undefined : 1);
      if (tc.c) expect(snap.summary[tc.c]).toBe(1);
      expect(snap.summary.fetchErrors).toBe(0);
    }
  });

  it.each([[0n, NOW], [-1n, NOW], [100_000_000n, 0]] as const)("classifies answer %s at %s as invalid evidence rather than a transport error", async (ans, updAt) => {
    mEvm.mockImplementation(async (_c, _a, d) => d === DEC_SEL ? DEC8 : roundHex(ans, updAt));
    const snap = await fetchSnap(undefined, undefined, NOW);
    expect(snap.quotes.size).toBe(0); expect(snap.summary).toMatchObject({ invalidAnswers: FEEDS.length, fetchErrors: 0 });
  });

  it("rejects cancellation during pending transport", async () => {
    const ctrl = new AbortController(), { promise: pend, resolve: started } = createDeferredPromise();
    mRpc.mockImplementation(async () => { started(); return new Promise<never>((_, rej) => { ctrl.signal.addEventListener("abort", () => rej(ctrl.signal.reason), { once: true }); }); });
    const rej = expect(fetchSnap(ctrl.signal)).rejects.toThrow("cancelled during transport");
    await pend; ctrl.abort(new Error("cancelled during transport")); await rej;
  });

  it("bounds parallel feed fetches to the cron connection budget", async () => {
    let active = 0, max = 0;
    const { promise: gate, resolve: rel } = createDeferredPromise(), { promise: pend, resolve: started } = createDeferredPromise();
    mRpc.mockImplementation(async (_u, _m, p) => {
      active++; max = Math.max(max, active); if (active === 3) started(); await gate; active--;
      const [c] = p as [{ to: string; data: string }];
      if (!FEEDS.find((f) => f.proxyAddress === c.to)) return null;
      return c.data === DEC_SEL ? DEC8 : c.data === RND_SEL ? roundHex(115_820_000n, NOW - 100) : null;
    });
    const run = fetchSnap(undefined, undefined, NOW);
    await pend; const init = active; rel();
    const snap = await run;
    expect(init).toBe(3); expect(snap.summary.usableQuotes).toBe(FEEDS.length); expect(max).toBeLessThanOrEqual(3);
  });

  it("skips the legacy dRPC endpoint after premium and public failures", async () => {
    expect(feedOf("peggedEUR")).toBeDefined();
    mRpc.mockResolvedValue(null); mEvm.mockResolvedValue(null); mEth.mockResolvedValue(null);
    await fetchSnap(undefined, undefined, NOW, "drpc-key");
    const eurUrls = mRpc.mock.calls.map(([u]) => String(u)).filter((u) => u.includes("drpc") && (u.includes("/base") || u.includes("network=base")));
    expect(eurUrls.some((u) => u.includes("lb.drpc.live/base/"))).toBe(true);
    expect(eurUrls.some((u) => u === "https://base.drpc.org")).toBe(true);
    expect(eurUrls.some((u) => u.includes("lb.drpc.org/ogrpc"))).toBe(false);
  });

  it("tracks per-feed outcomes and consecutive failing runs", async () => {
    const eur = feedOf("peggedEUR"); expect(eur).toBeDefined();
    mEvm.mockImplementation(async (_c, a, d) => a !== eur!.proxyAddress ? null : d === DEC_SEL ? DEC8 : d === RND_SEL ? roundHex(115_820_000n, NOW - 100) : null);
    const snap = await fetchSnap(undefined, undefined, NOW, undefined, undefined, { peggedEUR: 2, peggedGBP: 0 });
    expect(snap.perFeedOutcomes).toMatchObject({ peggedEUR: "success", peggedGBP: "failure" });
    expect(snap.failingRuns).toMatchObject({ peggedEUR: 0, peggedGBP: 1 });
  });
});

const LIT_HEX = `0x${"0".repeat(63)}7${"0".repeat(56)}3b9aca00${"0".repeat(56)}65a8f000${"0".repeat(56)}65a8f100${"0".repeat(63)}1`;

describe("parseSignedInt256Word", () => {
  it("parses positive values", () => { expect(parseI256(`${"0".repeat(63)}5`)).toBe(5n); });
  it("parses negative values via two's complement", () => { expect(parseI256("f".repeat(64))).toBe(-1n); });
});

describe("parseChainlinkLatestRoundData", () => {
  it("decodes the literal five-word response, taking updatedAt from the fourth word", () => {
    expect(parseRound(LIT_HEX, "test-feed")).toEqual({ roundId: 7n, answer: 1_000_000_000n, updatedAt: 0x65a8f100, invalidReason: null });
  });
  it("decodes a response truncated to the four words it reads", () => {
    expect(parseRound(`0x${roundHex(115_820_000n, NOW).slice(2, 2 + 256)}`, "test-feed")).toEqual({ roundId: 1n, answer: 115_820_000n, updatedAt: NOW, invalidReason: null });
  });
  it.each([
    { label: "a response shorter than four words", hex: `0x${"00".repeat(80)}`, msg: "test-feed: latestRoundData response too short (160 hex chars)" },
    { label: "a response with non-hex characters", hex: `${roundHex(115_820_000n, NOW).slice(0, -1)}g`, msg: "test-feed: latestRoundData response contains malformed hex" },
  ])("throws for $label", ({ hex, msg }) => { expect(() => parseRound(hex, "test-feed")).toThrow(msg); });
  it.each([
    { label: "a zero answer", a: 0n, u: NOW, r: "non-positive-answer" },
    { label: "a negative answer", a: -1n, u: NOW, r: "non-positive-answer" },
    { label: "a zero updatedAt", a: 115_820_000n, u: 0, r: "non-positive-updated-at" },
  ])("classifies $label as unusable evidence instead of throwing", ({ a, u, r }) => {
    expect(parseRound(roundHex(a, u), "test-feed")).toEqual({ roundId: 1n, answer: a, updatedAt: u, invalidReason: r });
  });
});

describe("requireChainlinkLatestRoundData", () => {
  it("returns the decoded round when the answer and timestamp are usable", () => { expect(reqRound(LIT_HEX, "test-feed").answer).toBe(1_000_000_000n); });
  it.each([
    { a: 0n, u: NOW, message: "test-feed: latestRoundData returned non-positive answer" },
    { a: -1n, u: NOW, message: "test-feed: latestRoundData returned non-positive answer" },
    { a: 115_820_000n, u: 0, message: "test-feed: latestRoundData returned non-positive updatedAt" },
  ])("fails closed with $message", ({ a, u, message }) => { expect(() => reqRound(roundHex(a, u), "test-feed")).toThrow(message); });
});
