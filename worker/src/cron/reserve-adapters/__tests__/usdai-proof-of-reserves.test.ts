import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { fetchEvmMulticall3Aggregate3AtBlock } from "../../../lib/evm-rpc";
import type * as EvmRpc from "../../../lib/evm-rpc";

vi.mock("../../../lib/evm-rpc", async (importOriginal) => ({
  ...(await importOriginal<typeof EvmRpc>()),
  fetchEvmMulticall3Aggregate3AtBlock: vi.fn(),
}));
import {
  adaptUsdAiProofOfReserves,
  fetchUsdAiProofOfReserves,
  parseUsdAiProofOfReserves,
} from "../usdai-proof-of-reserves";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});
const SAMPLE_RAW_PAYLOAD = JSON.stringify([
  {
    type: "TBILL",
    name: "PYUSD",
    chain: 42161,
    share: "944000000000000000",
  },
  {
    type: "DEAL",
    name: "NVIDIA B200 [8]",
    chain: 42161,
    share: "30000000000000000",
  },
  {
    type: "DEAL",
    name: "NVIDIA RTX PRO 6000 [1]",
    chain: 42161,
    share: "26000000000000000",
  },
]);

const MIXED_WEIGHT_PAYLOAD = [
  {
    type: "TBILL",
    name: "PYUSD",
    chain: 42161,
    share: "944000000000000000",
    amount: "944000000000000000000000",
  },
  {
    type: "DEAL",
    name: "NVIDIA B200 [8]",
    chain: 42161,
    share: "30000000000000000",
    amount: "30000000000000000000000",
  },
  {
    type: "DEAL",
    name: "NVIDIA RTX PRO 6000 [1]",
    chain: 42161,
    share: "26000000000000000",
    amount: "26000000000000000000000",
  },
  {
    type: "DEAL",
    name: "NVIDIA GB300 [5]",
    chain: 42161,
    amount: "17500000000000000000000000",
  },
];

const ANCHORED_CONFIG = {
  adapter: "usdai-proof-of-reserves", version: 2, semantics: "collateral-mix",
  inputs: { primary: { kind: "http-json", url: "https://example.com/proof" } },
  params: {
    anchor: {
      vaultAddress: "0x0b2b2b2076d95dda7817e785989fe353fe955ef9",
      assetAddress: "0x0a1a1a107e45b7ced86833863f482bc5f4ed82ef",
      toleranceBps: 100,
      liquidReserves: [{
        name: "PYUSD", tokenAddress: "0x46850ad61c2b7d64d08c9c754f45254596696984",
        holderAddress: "0x0a1a1a107e45b7ced86833863f482bc5f4ed82ef", decimals: 6,
      }],
    },
  },
} satisfies LiveReservesConfig;

async function fetchAnchored(values: Record<string, bigint> = {}, entries = MIXED_WEIGHT_PAYLOAD) {
  mockFetch([{ match: "https://example.com/proof", body: JSON.stringify(entries.map((row) => ({
    ...row,
    ...(row.type === "TBILL" ? { reserveLink: "https://arbiscan.io/token/0x46850ad61c2b7d64d08c9c754f45254596696984#balances" } : {}),
  }))) }], { requireMatch: true });
  const words: Record<string, bigint> = {
    block: 500_000_000n, timestamp: 1_788_975_000n,
    assets: 1_000_000n * 10n ** 18n, supply: 950_000n * 10n ** 18n,
    asset: BigInt(ANCHORED_CONFIG.params.anchor.assetAddress),
    "vault-decimals": 18n, "asset-decimals": 18n, "decimals-0": 6n,
    "balance-0": 944_000n * 10n ** 6n,
    ...values,
  };
  vi.mocked(fetchEvmMulticall3Aggregate3AtBlock).mockImplementation(async (_chain, calls) =>
    calls.map((call) => ({
      label: call.label, success: words[call.label] != null,
      returnData: `0x${(words[call.label] ?? 0n).toString(16).padStart(64, "0")}` as `0x${string}`,
    })),
  );
  return fetchUsdAiProofOfReserves({ id: "susdai-usd-ai" } as never, ANCHORED_CONFIG, new AbortController().signal);
}

describe("usdai-proof-of-reserves adapter", () => {
  it("anchors composition to same-call liquid balance and vault assets rather than document clocks", async () => {
    const result = await fetchAnchored();
    expect(result.slices.map(({ pct }) => pct)).toEqual([94.4, 5.6]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      observedBlock: { number: 500_000_000, timestamp: 1_788_975_000 },
      details: { anchor: { block: 500_000_000, tolerance: 0.01, checkedRows: [expect.objectContaining({ name: "PYUSD" })] } },
    });
    expect(result.warnings?.some((warning) => warning.effect === "degraded")).toBe(false);
  });

  it("enforces the reviewed tolerance without floating-point boundary drift", async () => {
    const atLimit = await fetchAnchored({ assets: 1_010_000n * 10n ** 18n });
    expect(atLimit.metadata?.freshnessMode).toBe("not-applicable");
    const overLimit = await fetchAnchored({ assets: 1_010_000n * 10n ** 18n + 1n });
    expect(overLimit.metadata?.freshnessMode).toBe("unverified");
    expect(overLimit.warnings).toContainEqual(expect.objectContaining({ code: "usdai-anchor-mismatch" }));
  });

  it("does not mistake a zero liquid row for evidence covering the loan composition", async () => {
    const result = await fetchAnchored({ "balance-0": 0n }, [
      { ...MIXED_WEIGHT_PAYLOAD[0], amount: "0", share: "0" },
      { ...MIXED_WEIGHT_PAYLOAD[1], share: "1000000000000000000" },
    ]);
    expect(result.slices[0].pct).toBe(100);
    expect(result.metadata?.freshnessMode).toBe("unverified");
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "usdai-anchor-mismatch" }));
  });

  it("withholds freshness when token decimals drift even if the old scale would reconcile", async () => {
    const result = await fetchAnchored({ "decimals-0": 18n });
    expect(result.metadata?.freshnessMode).toBe("unverified");
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "usdai-anchor-mismatch" }));
  });

  it("degrades a balance mismatch without discarding the observed composition", async () => {
    const result = await fetchAnchored({ "balance-0": 900_000n * 10n ** 6n });
    expect(result.slices.map(({ pct }) => pct)).toEqual([94.4, 5.6]);
    expect(result.metadata?.freshnessMode).toBe("unverified");
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "usdai-anchor-mismatch", effect: "degraded" }));
  });

  it("does not accept matching liquid amounts against an unrelated vault denominator", async () => {
    const result = await fetchAnchored({ assets: 2_000_000n * 10n ** 18n });
    expect(result.metadata?.freshnessMode).toBe("unverified");
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "usdai-anchor-mismatch", effect: "degraded" }));
  });

  it("degrades unavailable anchor reads without turning readable reserves into an error", async () => {
    mockFetch([{ match: "https://example.com/proof", body: JSON.stringify([{
      ...MIXED_WEIGHT_PAYLOAD[0],
      share: "1000000000000000000",
      reserveLink: "https://arbiscan.io/token/0x46850ad61c2b7d64d08c9c754f45254596696984#balances",
    }]) }]);
    vi.mocked(fetchEvmMulticall3Aggregate3AtBlock).mockResolvedValue(null);
    const result = await fetchUsdAiProofOfReserves({ id: "susdai-usd-ai" } as never, ANCHORED_CONFIG, new AbortController().signal);
    expect(result.slices[0].pct).toBe(100);
    expect(result.metadata?.freshnessMode).toBe("unverified");
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "usdai-anchor-unavailable", effect: "degraded" }));
  });

  it("does not certify document-update clocks when no on-chain anchor is configured", async () => {
    mockFetch([
      { match: "https://example.com/proof", body: SAMPLE_RAW_PAYLOAD },
      { match: "https://app.usd.ai/reserves", body: '\\"dealsDetailsCache\\":{\\"tokens\\":[{\\"timeLastUpdated\\":\\"2026-09-09T12:00:00Z\\"}]}' },
    ]);
    const result = await fetchUsdAiProofOfReserves(
      { id: "susdai-usd-ai" } as never,
      {
        adapter: "usdai-proof-of-reserves", version: 2, semantics: "collateral-mix",
        inputs: { primary: { kind: "http-json", url: "https://example.com/proof" } },
        display: { url: "https://app.usd.ai/reserves" },
      },
      new AbortController().signal,
    );
    expect(result.metadata?.freshnessMode).toBe("unverified");
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "usdai-anchor-unavailable", effect: "degraded" }));
  });

  it("preserves oversized share strings when parsing the raw API payload", () => {
    const parsed = parseUsdAiProofOfReserves(SAMPLE_RAW_PAYLOAD);

    expect(parsed[0]).toMatchObject({
      type: "TBILL",
      name: "PYUSD",
      share: "944000000000000000",
    });
  });

  it("accepts raw numeric amount values after preserving them as strings", () => {
    const raw = JSON.stringify([
      { type: "TBILL", name: "PYUSD", chain: 42161, amount: 9440 },
      { type: "DEAL", name: "NVIDIA B300 [1]", chain: 42161, amount: 560 },
    ]);

    const parsed = parseUsdAiProofOfReserves(raw);
    expect(parsed[0].amount).toBe("9440");
    expect(typeof parsed[0].amount).toBe("string");

    const result = adaptUsdAiProofOfReserves(parsed);
    expect(result.slices).toEqual([
      { name: "PYUSD (PayPal USD)", pct: 94.4, risk: "low", coinId: "pyusd-paypal" },
      { name: "GPU-backed infrastructure loans (NVIDIA hardware)", pct: 5.6, risk: "high" },
    ]);
    expect(result.metadata).toMatchObject({
      weightingBasis: "amount",
    });
  });

  it("preserves large numeric share and amount fields from the live API payload", () => {
    const raw = `[
      {"type":"TBILL","name":"PYUSD","chain":42161,"amount":255497995783104000000000000,"share":806489349701830000},
      {"type":"DEAL","name":"H200 [75]","chain":42161,"amount":61340534611896000000000000,"share":193510650298169860}
    ]`;

    const parsed = parseUsdAiProofOfReserves(raw);

    expect(parsed[0].share).toBe("806489349701830000");
    expect(parsed[0].amount).toBe("255497995783104000000000000");

    const result = adaptUsdAiProofOfReserves(parsed);
    expect(result.slices).toEqual([
      { name: "PYUSD (PayPal USD)", pct: 80.6, risk: "low", coinId: "pyusd-paypal" },
      { name: "GPU-backed infrastructure loans (NVIDIA hardware)", pct: 19.4, risk: "high" },
    ]);
    expect(result.metadata).toMatchObject({
      weightingBasis: "share",
      declaredSharePct: 100,
    });
  });

  it("rejects unsafe-integer numeric values that are already parsed as JS numbers", () => {
    // Direct adapter callers can still pass JS numbers that have already lost
    // precision. The raw API parser quotes large numeric literals before JSON
    // parsing, while the adapter rejects unsafe parsed numbers instead of
    // computing slices from corrupted values.
    const parsedShareOnly = [
      { type: "TBILL", name: "PYUSD", chain: 42161, share: "944000000000000000" },
      // amount is a JSON number above MAX_SAFE_INTEGER — would lose precision if accepted.
      { type: "DEAL", name: "NVIDIA B300 [1]", chain: 42161, amount: 9_007_199_254_740_993 },
    ];
    expect(() => adaptUsdAiProofOfReserves(parsedShareOnly)).toThrow(
      /missing a valid share/,
    );

    // Same input forced into amount-only weighting (no share present) causes a missing-amount throw.
    const amountOnly = [
      { type: "TBILL", name: "PYUSD", chain: 42161, amount: 9_007_199_254_740_993 },
      { type: "DEAL", name: "NVIDIA B300 [1]", chain: 42161, amount: 560 },
    ];
    expect(() => adaptUsdAiProofOfReserves(amountOnly)).toThrow(
      /usdai-proof-of-reserves entry is missing a valid amount/,
    );
  });

  it("treats partial-share-only payloads as degraded (with undisclosed bucket)", () => {
    const result = adaptUsdAiProofOfReserves([
      {
        type: "TBILL",
        name: "PYUSD",
        chain: 42161,
        share: "13000000000000000",
      },
    ]);

    expect(result.slices).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "PYUSD (PayPal USD)", pct: 1.3, risk: "low", coinId: "pyusd-paypal" }),
      expect.objectContaining({ name: "Undisclosed USD.AI reserve buckets", pct: 98.7, risk: "high" }),
    ]));
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "usdai-share-coverage-gap",
      effect: "degraded",
    }));
    expect(result.metadata).toMatchObject({
      weightingBasis: "share",
      unknownExposurePct: 98.7,
      apiEntryCount: 1,
      liquidBucketCount: 1,
      dealCount: 0,
    });
  });

  it("groups live PYUSD and deal exposures into readable reserve slices", () => {
    const result = adaptUsdAiProofOfReserves(parseUsdAiProofOfReserves(SAMPLE_RAW_PAYLOAD));

    expect(result.slices).toEqual([
      { name: "PYUSD (PayPal USD)", pct: 94.4, risk: "low", coinId: "pyusd-paypal" },
      { name: "GPU-backed infrastructure loans (NVIDIA hardware)", pct: 5.6, risk: "high" },
    ]);
    expect(result.metadata).toMatchObject({
      apiEntryCount: 3,
      liquidBucketCount: 1,
      dealCount: 2,
      declaredSharePct: 100,
      unknownExposurePct: 0,
      freshnessMode: "unverified",
      details: {
        freshnessSource: "usdai-proof-of-reserves-api",
      },
      liquidReserveLabels: ["PYUSD (PayPal USD)"],
      chains: [42161],
    });
  });

  it("ignores amount-only rows when share-bearing rows already disclose the full mix", () => {
    const result = adaptUsdAiProofOfReserves(MIXED_WEIGHT_PAYLOAD);

    expect(result.slices).toEqual([
      { name: "PYUSD (PayPal USD)", pct: 94.4, risk: "low", coinId: "pyusd-paypal" },
      { name: "GPU-backed infrastructure loans (NVIDIA hardware)", pct: 5.6, risk: "high" },
    ]);
    expect(result.warnings).toContainEqual({
      code: "missing-share-rows-ignored",
      message:
        "1 USD.AI reserve entry lacked composition share weights and was ignored while share-bearing rows already covered 100.00% of reserves",
      severity: "info",
      effect: "info",
    });
    expect(result.metadata).toMatchObject({
      apiEntryCount: 4,
      dealCount: 2,
      weightingBasis: "share",
      ignoredMissingShareEntryCount: 1,
    });
  });

  it("falls back to amount weights when the payload no longer publishes share values", () => {
    const result = adaptUsdAiProofOfReserves([
      { type: "TBILL", name: "PYUSD", chain: 42161, amount: "9440" },
      { type: "DEAL", name: "NVIDIA B300 [9]", chain: 42161, amount: "560" },
    ]);

    expect(result.slices).toEqual([
      { name: "PYUSD (PayPal USD)", pct: 94.4, risk: "low", coinId: "pyusd-paypal" },
      { name: "GPU-backed infrastructure loans (NVIDIA hardware)", pct: 5.6, risk: "high" },
    ]);
    expect(result.metadata).toMatchObject({
      apiEntryCount: 2,
      liquidBucketCount: 1,
      dealCount: 1,
      weightingBasis: "amount",
      unknownExposurePct: 0,
      freshnessMode: "unverified",
      liquidReserveLabels: ["PYUSD (PayPal USD)"],
      chains: [42161],
    });
  });

  it("falls back to amount weights when shares are partial and marks coverage as degraded", () => {
    const result = adaptUsdAiProofOfReserves([
      { type: "TBILL", name: "PYUSD", chain: 42161, share: "944000000000000000", amount: "9440" },
      { type: "DEAL", name: "NVIDIA B300 [9]", chain: 42161, share: "30000000000000000", amount: "560" },
    ]);

    expect(result.slices).toEqual([
      { name: "PYUSD (PayPal USD)", pct: 94.4, risk: "low", coinId: "pyusd-paypal" },
      { name: "GPU-backed infrastructure loans (NVIDIA hardware)", pct: 5.6, risk: "high" },
    ]);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: "usdai-share-coverage-gap",
        effect: "degraded",
      }),
    );
    expect(result.metadata).toMatchObject({
      apiEntryCount: 2,
      weightingBasis: "amount",
    });
  });

  it("surfaces unmapped reserve types explicitly instead of silently hiding them", () => {
    const result = adaptUsdAiProofOfReserves([
      { type: "TBILL", name: "PYUSD", chain: 42161, share: "910000000000000000" },
      { type: "DEAL", name: "NVIDIA B300 [9]", chain: 42161, share: "50000000000000000" },
      { type: "MYSTERY", name: "Future Reserve Bucket", chain: 42161, share: "40000000000000000" },
    ]);

    expect(result.slices).toEqual([
      { name: "PYUSD (PayPal USD)", pct: 91, risk: "low", coinId: "pyusd-paypal" },
      { name: "GPU-backed infrastructure loans (NVIDIA hardware)", pct: 5, risk: "high" },
      { name: "Unmapped USD.AI reserve buckets", pct: 4, risk: "high" },
    ]);
    expect(result.warnings).toEqual([
      {
        code: "unknown-reserve-type",
        message: "Unmapped USD.AI reserve types: MYSTERY (4.00% of reserves)",
        severity: "info",
        effect: "info",
      },
    ]);
    expect(result.metadata).toMatchObject({
      unknownTypeCount: 1,
      unknownReserveTypes: ["MYSTERY"],
      unknownExposurePct: 4,
    });
  });

  it("fetches the raw API payload through the shared text cache and adapts it", async () => {
    const fetchSpy = mockFetch([
      {
        match: "https://example.com/usdai/proof-of-reserves?chainId=42161",
        body: SAMPLE_RAW_PAYLOAD,
      },
    ], { requireMatch: true, strictUrl: true });
    const result = await fetchUsdAiProofOfReserves(
      { id: "susdai-usd-ai" } as never,
      {
        adapter: "usdai-proof-of-reserves",
        version: 2,
        semantics: "collateral-mix",
        display: {
          url: "https://app.usd.ai/reserves",
        },
        inputs: {
          primary: { kind: "http-json", url: "https://example.com/usdai/proof-of-reserves?chainId=42161" },
        },
      },
      new AbortController().signal,
      { requestCache: new Map() },
    );
    fetchSpy.assertAllRoutesUsed();

    expect(result.slices[0]).toEqual({
      name: "PYUSD (PayPal USD)",
      pct: 94.4,
      risk: "low",
      coinId: "pyusd-paypal",
    });
    expect(result.metadata?.freshnessMode).toBe("unverified");
    expect(result.metadata?.sourceTimestamp).toBeUndefined();
  });
});
