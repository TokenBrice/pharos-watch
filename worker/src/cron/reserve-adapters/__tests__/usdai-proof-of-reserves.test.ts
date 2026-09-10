import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import {
  expectWarningEffect,
  expectWarnings,
  runAdapter,
  type AdapterNetworkSpec,
  type AdapterRpcValue,
} from "./reserve-adapter.test-support";
import {
  adaptUsdAiProofOfReserves,
  parseUsdAiProofOfReserves,
} from "../usdai-proof-of-reserves";
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

const ANCHORED_COIN = {
  id: "susdai-usd-ai",
  name: "sUSDai",
  symbol: "sUSDai",
  liveReservesConfig: ANCHORED_CONFIG,
} as unknown as StablecoinMeta;
const NO_ANCHOR_CONFIG = {
  adapter: "usdai-proof-of-reserves", version: 2, semantics: "collateral-mix",
  inputs: { primary: { kind: "http-json", url: "https://example.com/proof-no-anchor" } },
  display: { url: "https://app.usd.ai/reserves" },
} satisfies LiveReservesConfig;
const NO_ANCHOR_COIN = {
  id: "susdai-usd-ai",
  name: "sUSDai",
  symbol: "sUSDai",
  liveReservesConfig: NO_ANCHOR_CONFIG,
} as unknown as StablecoinMeta;
const ARBSYS_ADDRESS = "0x0000000000000000000000000000000000000064";
const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
const PROOF_ENDPOINT = ANCHORED_CONFIG.inputs.primary.url;
const ANCHOR_BLOCK = 500_000_000;
const ANCHOR_TIMESTAMP = 1_788_975_000;

function proofNetwork(
  values: Record<string, AdapterRpcValue> = {},
  entries = MIXED_WEIGHT_PAYLOAD,
): AdapterNetworkSpec {
  const anchor = ANCHORED_CONFIG.params.anchor;
  const value = (label: string, fallback: AdapterRpcValue): AdapterRpcValue =>
    values[label] === undefined ? fallback : values[label]!;
  return {
    json: {
      [PROOF_ENDPOINT]: JSON.stringify(entries.map((row) => ({
        ...row,
        ...(row.type === "TBILL"
          ? { reserveLink: `https://arbiscan.io/token/${anchor.liquidReserves[0]!.tokenAddress}#balances` }
          : {}),
      }))),
    },
    rpc: {
      [`${ARBSYS_ADDRESS}:0xa3b1b31d`]: value("block", ANCHOR_BLOCK),
      [`${MULTICALL3}:0x0f28c97d`]: value("timestamp", ANCHOR_TIMESTAMP),
      [`${anchor.vaultAddress}:0x38d52e0f`]: value("asset", anchor.assetAddress),
      [`${anchor.vaultAddress}:0x01e1d114`]: value("assets", 1_000_000n * 10n ** 18n),
      [`${anchor.vaultAddress}:totalSupply()`]: value("supply", 950_000n * 10n ** 18n),
      [`${anchor.vaultAddress}:decimals()`]: value("vault-decimals", 18n),
      [`${anchor.assetAddress}:decimals()`]: value("asset-decimals", 18n),
      [`${anchor.liquidReserves[0]!.tokenAddress}:balanceOf(address)`]: value("balance-0", 944_000n * 10n ** 6n),
      [`${anchor.liquidReserves[0]!.tokenAddress}:decimals()`]: value("decimals-0", 6n),
    },
  };
}

async function fetchAnchored(
  values: Record<string, AdapterRpcValue> = {},
  entries = MIXED_WEIGHT_PAYLOAD,
) {
  const { result } = await runAdapter(
    "usdai-proof-of-reserves",
    ANCHORED_COIN,
    {
      network: proofNetwork(values, entries),
      nowSec: ANCHOR_TIMESTAMP,
    },
  );
  return result;
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
    const result = await fetchAnchored(
      { block: null },
      [{ ...MIXED_WEIGHT_PAYLOAD[0]!, share: "1000000000000000000" }],
    );
    expect(result.slices[0]!.pct).toBe(100);
    expect(result.metadata?.freshnessMode).toBe("unverified");
    expectWarnings(result, ["usdai-anchor-unavailable"]);
    expectWarningEffect(result, "usdai-anchor-unavailable", "degraded");
  });

  it("does not certify document-update clocks when no on-chain anchor is configured", async () => {
    const { result } = await runAdapter("usdai-proof-of-reserves", NO_ANCHOR_COIN, {
      network: { json: { [NO_ANCHOR_CONFIG.inputs.primary.url]: SAMPLE_RAW_PAYLOAD } },
      nowSec: ANCHOR_TIMESTAMP,
    });
    expect(result.metadata?.freshnessMode).toBe("unverified");
    expectWarnings(result, ["usdai-anchor-unavailable"]);
    expectWarningEffect(result, "usdai-anchor-unavailable", "degraded");
  });

  it("rejects a proof row after the upstream drops both composition weights", async () => {
    const drifted = JSON.stringify([
      { type: "TBILL", name: "PYUSD", chain: 42161 },
      { type: "DEAL", name: "NVIDIA B200 [8]", chain: 42161, share: "1000000000000000000" },
    ]);
    await expect(runAdapter("usdai-proof-of-reserves", NO_ANCHOR_COIN, {
      network: { json: { [NO_ANCHOR_CONFIG.inputs.primary.url]: drifted } },
      nowSec: ANCHOR_TIMESTAMP,
      validate: false,
    })).rejects.toThrow(/missing a valid share/);
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
      { sourceKey: "usdai-proof-of-reserves:pyusd", name: "PYUSD (PayPal USD)", pct: 94.4, risk: "low", coinId: "pyusd-paypal" },
      { sourceKey: "usdai-proof-of-reserves:deal", name: "GPU-backed infrastructure loans (NVIDIA hardware)", pct: 5.6, risk: "high" },
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
      { sourceKey: "usdai-proof-of-reserves:pyusd", name: "PYUSD (PayPal USD)", pct: 80.6, risk: "low", coinId: "pyusd-paypal" },
      { sourceKey: "usdai-proof-of-reserves:deal", name: "GPU-backed infrastructure loans (NVIDIA hardware)", pct: 19.4, risk: "high" },
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
      { sourceKey: "usdai-proof-of-reserves:pyusd", name: "PYUSD (PayPal USD)", pct: 94.4, risk: "low", coinId: "pyusd-paypal" },
      { sourceKey: "usdai-proof-of-reserves:deal", name: "GPU-backed infrastructure loans (NVIDIA hardware)", pct: 5.6, risk: "high" },
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
      { sourceKey: "usdai-proof-of-reserves:pyusd", name: "PYUSD (PayPal USD)", pct: 94.4, risk: "low", coinId: "pyusd-paypal" },
      { sourceKey: "usdai-proof-of-reserves:deal", name: "GPU-backed infrastructure loans (NVIDIA hardware)", pct: 5.6, risk: "high" },
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
      { sourceKey: "usdai-proof-of-reserves:pyusd", name: "PYUSD (PayPal USD)", pct: 94.4, risk: "low", coinId: "pyusd-paypal" },
      { sourceKey: "usdai-proof-of-reserves:deal", name: "GPU-backed infrastructure loans (NVIDIA hardware)", pct: 5.6, risk: "high" },
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
      { sourceKey: "usdai-proof-of-reserves:pyusd", name: "PYUSD (PayPal USD)", pct: 94.4, risk: "low", coinId: "pyusd-paypal" },
      { sourceKey: "usdai-proof-of-reserves:deal", name: "GPU-backed infrastructure loans (NVIDIA hardware)", pct: 5.6, risk: "high" },
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
      { sourceKey: "usdai-proof-of-reserves:pyusd", name: "PYUSD (PayPal USD)", pct: 91, risk: "low", coinId: "pyusd-paypal" },
      { sourceKey: "usdai-proof-of-reserves:deal", name: "GPU-backed infrastructure loans (NVIDIA hardware)", pct: 5, risk: "high" },
      { sourceKey: "usdai-proof-of-reserves:unknown", name: "Unmapped USD.AI reserve buckets", pct: 4, risk: "high" },
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

  it("fetches the raw API payload through the shared text boundary and adapts it", async () => {
    const { result, network } = await runAdapter("usdai-proof-of-reserves", NO_ANCHOR_COIN, {
      network: { json: { [NO_ANCHOR_CONFIG.inputs.primary.url]: SAMPLE_RAW_PAYLOAD } },
      nowSec: ANCHOR_TIMESTAMP,
    });

    expect(network.requests.map(({ url }) => url)).toEqual([NO_ANCHOR_CONFIG.inputs.primary.url]);
    expect(result.slices[0]).toEqual({
      sourceKey: "usdai-proof-of-reserves:pyusd",
      name: "PYUSD (PayPal USD)",
      pct: 94.4,
      risk: "low",
      coinId: "pyusd-paypal",
    });
    expect(result.metadata?.freshnessMode).toBe("unverified");
    expect(result.metadata?.sourceTimestamp).toBeUndefined();
  });
});
