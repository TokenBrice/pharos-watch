import { describe, expect, it } from "vitest";
import {
  adaptUsdAiProofOfReserves,
  fetchUsdAiProofOfReserves,
  parseUsdAiProofOfReserves,
} from "../usdai-proof-of-reserves";

const SAMPLE_RAW_PAYLOAD = JSON.stringify([
  {
    type: "TBILL",
    name: "PYUSD",
    chain: 42161,
    share: 944000000000000000,
  },
  {
    type: "DEAL",
    name: "NVIDIA B200 [8]",
    chain: 42161,
    share: 30000000000000000,
  },
  {
    type: "DEAL",
    name: "NVIDIA RTX PRO 6000 [1]",
    chain: 42161,
    share: 26000000000000000,
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

describe("usdai-proof-of-reserves adapter", () => {
  it("preserves oversized share integers when parsing the raw API payload", () => {
    const parsed = parseUsdAiProofOfReserves(SAMPLE_RAW_PAYLOAD);

    expect(parsed[0]).toMatchObject({
      type: "TBILL",
      name: "PYUSD",
      share: "944000000000000000",
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
    const result = await fetchUsdAiProofOfReserves(
      { id: "susdai-usd-ai" } as never,
      {
        adapter: "usdai-proof-of-reserves",
        version: 2,
        semantics: "collateral-mix",
        inputs: {
          primary: { kind: "http-json", url: "https://example.com/usdai/proof-of-reserves?chainId=42161" },
        },
      },
      new AbortController().signal,
      {
        requestCache: new Map([
          [
            "text-get:https://example.com/usdai/proof-of-reserves?chainId=42161:12000",
            Promise.resolve(SAMPLE_RAW_PAYLOAD),
          ],
        ]),
      } as never,
    );

    expect(result.slices[0]).toEqual({
      name: "PYUSD (PayPal USD)",
      pct: 94.4,
      risk: "low",
      coinId: "pyusd-paypal",
    });
  });
});
