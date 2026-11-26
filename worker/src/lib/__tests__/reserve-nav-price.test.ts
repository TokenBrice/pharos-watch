import { LIVE_RESERVE_FRESHNESS_SEC } from "../live-reserve-policy";
import { describe, expect, it } from "vitest";
import { BUSINESS_DAY_NAV_SOURCE_MAX_AGE_SEC } from "@shared/types/live-reserve-adapter-policy";
import { decodeReserveNavPrice as decode, reserveNavSupplyScopeReason as reason } from "../reserve-nav-price";
import {
  JLTXX_ETHEREUM_CONTRACT, JLTXX_SOLANA_MINT, JLTXX_SOLANA_TOKEN_PROGRAM,
  type PinnedNativeShareEthereumLeg, type PinnedNativeShareObservation, type PinnedNativeShareSolanaLeg,
} from "@shared/types/reserve-nav-supply";

const now = Date.parse("2026-10-03T12:00:00Z") / 1000;
const FULL = 700_000_000;
const navJson = (navPerToken: unknown, sourceTimestamp: number) => JSON.stringify({ navPerToken, sourceTimestamp });
const row = { source: "jpmorgan-nav", fetched_at: now - 60, metadata: navJson(0.998, now - 2 * 86400) };
const classMetadata = {
  navPerToken: 1, sourceTimestamp: Date.parse("2026-10-01T00:00:00Z") / 1000, freshnessMode: "verified",
  details: {
    cusip: "46655R119", shareClassNumber: "4397", ticker: "JLTXX", dealingDate: "2026-10-01", classAssetsUsd: FULL,
    supplyAdmissionReview: {
      maxNavSupplySkewSec: 216000, reviewedAt: "2026-10-01",
      evidenceRef: "https://example.com/cadence", perimeterRef: "https://example.com/perimeter",
    },
  },
};
const classRow = { ...row, metadata: JSON.stringify(classMetadata) };
const ethLeg = (rawShares: string, observedAt = now): PinnedNativeShareEthereumLeg => ({
  chain: "ethereum", contractAddress: JLTXX_ETHEREUM_CONTRACT, rawShares, decimals: 2, blockNumber: 100, blockHash: `0x${"a".repeat(64)}`, observedAt,
});
const solLeg = (rawShares: string, observedAt = now): PinnedNativeShareSolanaLeg => ({
  chain: "solana", contractAddress: JLTXX_SOLANA_MINT, rawShares, decimals: 2, slot: 460_000_000, programOwner: JLTXX_SOLANA_TOKEN_PROGRAM, observedAt,
});
const nativeShares = (v: number, t = now): PinnedNativeShareObservation => {
  const raw = BigInt(v * 100).toString();
  return { rawShares: raw, decimals: 2, observedAt: t, legs: [ethLeg(raw, t)] };
};
const twoLegShares = (e: number, s: number, et = now, st = now): PinnedNativeShareObservation => {
  const er = BigInt(e * 100).toString(); const sr = BigInt(s * 100).toString();
  return { rawShares: (BigInt(er) + BigInt(sr)).toString(), decimals: 2, observedAt: Math.min(et, st), legs: [ethLeg(er, et), solLeg(sr, st)] };
};
const twoLegFull = (et = now, st = now) => twoLegShares(50_000_000, 650_000_000, et, st);

describe("reserve NAV admission", () => {
  it("values current NAV in upstream units and preserves its evidence clock", () => {
    expect(decode(row, now)).toMatchObject({ source: "jpmorgan-nav", price: 0.998, observedAt: now - 2 * 86400, observedAtMode: "upstream" });
  });

  it("requires fresh issuer NAV and fresh successful-fetch clocks independently", () => {
    expect(decode({ ...row, fetched_at: now, metadata: navJson(1, now - BUSINESS_DAY_NAV_SOURCE_MAX_AGE_SEC - 1) }, now)).toBeNull();
    expect(decode({ ...row, fetched_at: now - LIVE_RESERVE_FRESHNESS_SEC - 1 }, now)).toBeNull();
    expect(decode({ ...row, fetched_at: now + 1 }, now)).toBeNull();
    expect(decode({ ...row, source: "circle-transparency" }, now)).toBeNull();
  });

  it.each([
    null, undefined, "null", "[]", "broken", '{"navPerToken":1}',
    navJson(0, now), navJson(-1, now), navJson("Infinity", now), navJson(1, now + 3600),
  ])("withholds malformed or unavailable evidence (%s)", (metadata) => {
    expect(decode({ ...row, metadata }, now)).toBeNull();
  });

  it.each([696_500_000, FULL, 703_500_000])("admits inclusive 0.5%% single-leg boundaries (%s)", (v) => {
    expect(reason(decode(classRow, now), nativeShares(v), now)).toBeNull();
  });

  it.each([[50_000_000, 650_000_000], [46_500_000, 650_000_000], [53_500_000, 650_000_000]])("admits 2-leg valuations (%s + %s)", (e, s) => {
    expect(reason(decode(classRow, now), twoLegShares(e, s), now)).toBeNull();
  });

  it.each([600_000_000, 696_499_999, 703_500_001])("rejects out-of-scope valuations (%s)", (v) => {
    expect(reason(decode(classRow, now), nativeShares(v), now)).toBe("class-assets-supply-divergence");
  });

  it("rejects out-of-scope 2-leg aggregate valuation", () => {
    expect(reason(decode(classRow, now), twoLegShares(50_000_000, 550_000_000), now)).toBe("class-assets-supply-divergence");
  });

  it.each([
    { ...classMetadata, freshnessMode: "unverified" }, { ...classMetadata, details: { ...classMetadata.details, shareClassNumber: "wrong" } },
    { ...classMetadata, details: { ...classMetadata.details, dealingDate: "2026-09-30" } }, { ...classMetadata, details: { ...classMetadata.details, classAssetsUsd: 0 } },
    { ...classMetadata, details: { ...classMetadata.details, classAssetsUsd: undefined } }, { ...classMetadata, sourceTimestamp: now - BUSINESS_DAY_NAV_SOURCE_MAX_AGE_SEC - 1 },
  ])("withholds invalid or stale class evidence #%#", (metadata) => {
    expect(reason(decode({ ...classRow, metadata: JSON.stringify(metadata) }, now), nativeShares(FULL), now)).toBe("class-assets-unavailable");
  });

  it("revalidates reserve fetch and NAV source freshness at the post-I/O scope clock", () => {
    const qFetch = decode({ ...classRow, fetched_at: now - LIVE_RESERVE_FRESHNESS_SEC }, now)!;
    expect(reason(qFetch, nativeShares(FULL, now), now)).toBeNull();
    expect(reason(qFetch, nativeShares(FULL, now + 2), now + 2)).toBe("class-assets-unavailable");
    const qNav = decode({ ...classRow, fetched_at: now }, now)!;
    const pastNav = qNav.observedAt! + BUSINESS_DAY_NAV_SOURCE_MAX_AGE_SEC + 1;
    expect(reason({ ...qNav, metadata: { ...qNav.metadata, reserveFetchedAt: pastNav } }, nativeShares(FULL, pastNav), pastNav)).toBe("class-assets-unavailable");
  });

  it("rejects malformed getters, sum/clock mismatch, duplicate chains and missing Ethereum leg", () => {
    const q = decode(classRow, now);
    for (const bad of ["0", "-1", "NaN", "Infinity"]) {
      expect(reason(q, { ...nativeShares(FULL), rawShares: bad }, now)).toBe("native-share-observation-unavailable");
      expect(reason(q, { ...twoLegFull(), legs: [ethLeg("5000000000"), solLeg(bad)] }, now)).toBe("native-share-observation-unavailable");
    }
    const valid = twoLegFull(now - 120, now - 60);
    expect(reason(q, { ...valid, rawShares: "70000000001" }, now)).toBe("native-share-observation-unavailable");
    expect(reason(q, { ...valid, observedAt: now - 60 }, now)).toBe("native-share-observation-unavailable");
    expect(reason(q, { rawShares: "70000000000", decimals: 2, observedAt: now, legs: [ethLeg("35000000000"), ethLeg("35000000000")] } as PinnedNativeShareObservation, now)).toBe("native-share-observation-unavailable");
    expect(reason(q, { rawShares: "70000000000", decimals: 2, observedAt: now, legs: [solLeg("70000000000")] } as PinnedNativeShareObservation, now)).toBe("native-share-observation-unavailable");
  });

  it("withholds unsafe precision on single-leg and aggregate BigInt sums", () => {
    const q = decode(classRow, now);
    expect(reason(q, { rawShares: "9007199254740993", decimals: 2, observedAt: now, legs: [ethLeg("9007199254740993")] }, now)).toBe("native-share-precision-unsupported");
    expect(reason(q, { rawShares: "10000000000000000", decimals: 2, observedAt: now, legs: [ethLeg("5000000000000000"), solLeg("5000000000000000")] }, now)).toBe("native-share-precision-unsupported");
  });

  it("enforces temporal review, freshness, non-future clocks and NAV skew on every leg", () => {
    const qNoRev = decode(classRow, now)!;
    delete qNoRev.metadata!.supplyAdmissionReview;
    expect(reason(qNoRev, nativeShares(FULL), now)).toBe("native-class-temporal-review-unavailable");

    const q = decode(classRow, now)!;
    const bound = q.observedAt! + 216000;
    const qBound = { ...q, metadata: { ...q.metadata, reserveFetchedAt: bound - 60 } };
    expect(reason(qBound, nativeShares(FULL, bound), bound)).toBeNull();
    expect(reason(qBound, nativeShares(FULL, bound + 1), bound + 1)).toBe("nav-supply-time-skew");
    expect(reason(q, nativeShares(FULL, now), now - 1)).toBe("native-share-observation-stale");
    expect(reason(q, twoLegFull(now - 60, now - LIVE_RESERVE_FRESHNESS_SEC - 1), now)).toBe("native-share-observation-stale");
    expect(reason(q, twoLegFull(now - 60, now + 1), now)).toBe("native-share-observation-stale");
    expect(reason(qBound, twoLegFull(bound, bound + 1), bound + 1)).toBe("nav-supply-time-skew");
    expect(reason(qBound, twoLegFull(bound + 1, bound), bound + 1)).toBe("nav-supply-time-skew");
  });
});
