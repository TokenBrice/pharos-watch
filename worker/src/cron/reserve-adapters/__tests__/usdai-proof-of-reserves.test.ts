import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import {
  evaluateAdapterSnapshotAdmission,
  expectWarningEffect,
  expectWarnings,
  installAdapterNetwork,
  runAdapter,
  type AdapterNetworkSpec,
  type AdapterRpcValue,
} from "./reserve-adapter.test-support";
import {
  adaptUsdAiProofOfReserves,
  fetchUsdAiProofOfReserves,
  parseUsdAiProofOfReserves,
} from "../usdai-proof-of-reserves";

const OCTOBER_RAW_PAYLOAD = readFileSync(new URL("./fixtures/usdai-oct7-2026.json", import.meta.url), "utf8");
const CORROBORATED_RAW_PAYLOAD = readFileSync(new URL("./fixtures/usdai-oct24-2026.json", import.meta.url), "utf8");
const LOAN_ROUTER_BALANCES = "0x66518b81";
const VAULT_BALANCES = "0x7bb98a68";
const DEPOSIT_TIMELOCK_BALANCE = "0x37d0a739";

function twoWords(first: bigint, second = 0n): string {
  return `0x${first.toString(16).padStart(64, "0")}${second.toString(16).padStart(64, "0")}`;
}

describe("USD.AI captured full-book boundary", () => {
  it("does not promote an undated share book or add its six auxiliary amount-only entries", async () => {
    const { result, report } = await runAdapter("usdai-proof-of-reserves", NO_ANCHOR_COIN, {
      network: { json: { [NO_ANCHOR_CONFIG.inputs.primary.url]: OCTOBER_RAW_PAYLOAD } },
      nowSec: Date.parse("2026-10-07T20:47:43Z") / 1000,
    });
    expect(result.metadata).toMatchObject({ freshnessMode: "unverified", ignoredMissingShareEntryCount: 6 });
    expect(result.metadata?.sourceTimestamp).toBeUndefined();
    expect(result.metadata?.collateralizationRatio).toBeUndefined();
    expect(report.warnings.some((warning) => warning.effect === "degraded")).toBe(true);
    const liquid = parseUsdAiProofOfReserves(OCTOBER_RAW_PAYLOAD)[0];
    expect(String(liquid.amount)).toBe("344101883192942000000000000");
    expect(String(liquid.share)).toBe("659954474541340800");
    // The liquid balance/share implies a system denominator, not the
    // separately captured vault's 545,013,940.488789 USDai NAV.
    const impliedSystemUnits = Number(liquid.amount) / 1e18 / (Number(liquid.share) / 1e18);
    expect(impliedSystemUnits).toBeCloseTo(521_402_454.9679552, 5);
    expect(impliedSystemUnits).not.toBeCloseTo(545_013_940.4887891, 0);
  });
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
      [`${anchor.assetAddress}:balanceOf(address)`]: value("idle-asset", 944_000n * 10n ** 18n),
      [`${anchor.vaultAddress}:${LOAN_ROUTER_BALANCES}`]: value(
        "loan-router-balances", twoWords(56_000n * 10n ** 18n),
      ),
      [`${anchor.vaultAddress}:${VAULT_BALANCES}`]: value("vault-balances", twoWords(944_000n * 10n ** 18n)),
      [`${anchor.vaultAddress}:${DEPOSIT_TIMELOCK_BALANCE}`]: value("deposit-timelock", 0n),
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
  it("lets a 15-second origin response finish without restarting the read", async () => {
    vi.useFakeTimers();
    try {
      const network = installAdapterNetwork({
        json: {
          [NO_ANCHOR_CONFIG.inputs.primary.url]: async (request: Request) => {
            await new Promise<void>((resolve) => setTimeout(resolve, 15_000));
            if (request.signal.aborted) throw request.signal.reason;
            return JSON.parse(SAMPLE_RAW_PAYLOAD);
          },
        },
      });
      const pending = fetchUsdAiProofOfReserves(
        NO_ANCHOR_COIN, NO_ANCHOR_CONFIG, new AbortController().signal,
      );
      await vi.advanceTimersByTimeAsync(15_000);
      const result = await pending;
      expect(result.slices.map(({ pct }) => pct)).toEqual([94.4, 5.6]);
      expect(network.fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not spend the remaining adapter budget retrying a failed origin read", async () => {
    const network = installAdapterNetwork({
      json: { [NO_ANCHOR_CONFIG.inputs.primary.url]: { status: 503, body: "unavailable" } },
    });
    await expect(fetchUsdAiProofOfReserves(
      NO_ANCHOR_COIN, NO_ANCHOR_CONFIG, new AbortController().signal,
    )).rejects.toThrow("HTTP 503");
    expect(network.fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("retains amount observations without certifying composition shares", async () => {
    const result = await fetchAnchored();
    expect(result.slices.map(({ pct }) => pct)).toEqual([94.4, 5.6]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "unverified",
      observedBlock: { number: 500_000_000, timestamp: 1_788_975_000 },
      details: { anchor: { block: 500_000_000, tolerance: 0.01, checkedRows: [expect.objectContaining({ name: "PYUSD" })] } },
    });
    expectWarningEffect(result, "usdai-composition-unverified", "degraded");
  });

  it("does not certify fabricated full liquid shares with correct balances and omitted deals", async () => {
    const result = await fetchAnchored({}, [
      { ...MIXED_WEIGHT_PAYLOAD[0], share: "1000000000000000000" },
    ]);
    expect(result.slices.map(({ pct }) => pct)).toEqual([100]);
    expect(result.metadata?.freshnessMode).toBe("unverified");
    expectWarningEffect(result, "usdai-composition-unverified", "degraded");
  });

  it("enforces the reviewed tolerance without floating-point boundary drift", async () => {
    const atLimit = await fetchAnchored({ "balance-0": 953_535n * 10n ** 6n });
    expect(atLimit.metadata?.freshnessMode).toBe("unverified");
    const overLimit = await fetchAnchored({ "balance-0": 953_536n * 10n ** 6n });
    expect(overLimit.metadata?.freshnessMode).toBe("unverified");
    expect(overLimit.warnings).toContainEqual(expect.objectContaining({ code: "usdai-anchor-mismatch" }));
  });

  it("does not multiply system-scope share weights by the vault NAV denominator", async () => {
    // Production shape (2026-09-25): the PYUSD share divides the hub sleeve plus
    // legacy deals at their remaining balances, so share x vault totalAssets can
    // never equal the hub balance once the issuer's scopes drift apart; the
    // amount check must still pass while composition remains unverified.
    const result = await fetchAnchored(
      { assets: 2_000_000n * 10n ** 18n, "idle-asset": 1_944_000n * 10n ** 18n },
      [
        { type: "TBILL", name: "PYUSD", chain: 42161, share: "540000000000000000", amount: "944000000000000000000000" },
        { type: "DEAL", name: "NVIDIA B300 [9]", chain: 42161, share: "460000000000000000", amount: "56000000000000000000000" },
      ],
    );
    expect(result.slices.map(({ pct }) => pct)).toEqual([54, 46]);
    expect(result.metadata?.freshnessMode).toBe("unverified");
    expectWarningEffect(result, "usdai-composition-unverified", "degraded");
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
      { sourceKey: "usdai-proof-of-reserves:pyusd", name: "PYUSD (PayPal USD)", pct: 80.6, risk: "low", coinId: "pyusd-paypal", depType: "collateral" },
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
      expect.objectContaining({ name: "PYUSD (PayPal USD)", pct: 1.3, risk: "low", coinId: "pyusd-paypal", depType: "collateral" }),
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
      { sourceKey: "usdai-proof-of-reserves:pyusd", name: "PYUSD (PayPal USD)", pct: 94.4, risk: "low", coinId: "pyusd-paypal", depType: "collateral" },
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
      { sourceKey: "usdai-proof-of-reserves:pyusd", name: "PYUSD (PayPal USD)", pct: 94.4, risk: "low", coinId: "pyusd-paypal", depType: "collateral" },
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
      { sourceKey: "usdai-proof-of-reserves:pyusd", name: "PYUSD (PayPal USD)", pct: 94.4, risk: "low", coinId: "pyusd-paypal", depType: "collateral" },
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
      { sourceKey: "usdai-proof-of-reserves:pyusd", name: "PYUSD (PayPal USD)", pct: 94.4, risk: "low", coinId: "pyusd-paypal", depType: "collateral" },
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
      { sourceKey: "usdai-proof-of-reserves:pyusd", name: "PYUSD (PayPal USD)", pct: 91, risk: "low", coinId: "pyusd-paypal", depType: "collateral" },
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
      coinId: "pyusd-paypal", depType: "collateral",
    });
    expect(result.metadata?.freshnessMode).toBe("unverified");
    expect(result.metadata?.sourceTimestamp).toBeUndefined();
  });
});

describe("USD.AI on-chain composition corroboration", () => {
  // Arbitrum block 517749549 (2026-10-24T05:30:28Z), read with the paired
  // fixture: hub PYUSD balance and the sUSDai vault accounting words.
  const BLOCK = 517_749_549;
  const TIMESTAMP = 1_792_819_828;
  const PENDING = 181_842_265_063_556_519_922_543_790n;
  const ACCRUED = 1_113_533_414_041_791_958_124_029n;
  const DEPOSITS = 242_375_499_853_794_364_517_058_684n;
  const REDEMPTION_RESERVED = 69_320_514_364_861_966_653_782n;
  const TIMELOCK = 128_895_244_100_000_000_000_000_000n;
  const TOTAL_ASSETS = 555_599_346_880_440_560_033_679_865n;
  const anchor = ANCHORED_CONFIG.params.anchor;
  const liveEntries = parseUsdAiProofOfReserves(CORROBORATED_RAW_PAYLOAD);

  async function runCorroboration(
    values: Record<string, AdapterRpcValue> = {},
    payload = CORROBORATED_RAW_PAYLOAD,
  ) {
    const value = (label: string, fallback: AdapterRpcValue): AdapterRpcValue =>
      values[label] === undefined ? fallback : values[label]!;
    return runAdapter("usdai-proof-of-reserves", "susdai-usd-ai", {
      network: {
        json: { "https://api.usd.ai/usdai/dashboard/proof-of-reserves?chainId=42161": payload },
        rpc: {
          [`${ARBSYS_ADDRESS}:0xa3b1b31d`]: BLOCK,
          [`${MULTICALL3}:0x0f28c97d`]: TIMESTAMP,
          [`${anchor.vaultAddress}:0x38d52e0f`]: anchor.assetAddress,
          [`${anchor.vaultAddress}:0x01e1d114`]: value("assets", TOTAL_ASSETS),
          [`${anchor.vaultAddress}:totalSupply()`]: 269_170_783_627_993_002_005_161_409n,
          [`${anchor.vaultAddress}:decimals()`]: 18n,
          [`${anchor.assetAddress}:decimals()`]: 18n,
          [`${anchor.assetAddress}:balanceOf(address)`]: value("idle-asset", DEPOSITS),
          [`${anchor.vaultAddress}:${VAULT_BALANCES}`]: value("vault-balances", twoWords(DEPOSITS, REDEMPTION_RESERVED)),
          [`${anchor.vaultAddress}:${DEPOSIT_TIMELOCK_BALANCE}`]: value("deposit-timelock", TIMELOCK),
          [`${anchor.vaultAddress}:${LOAN_ROUTER_BALANCES}`]: value(
            "loan-router-balances", twoWords(PENDING, ACCRUED),
          ),
          [`${anchor.liquidReserves[0]!.tokenAddress}:balanceOf(address)`]: value("balance-0", 260_363_184_436_082n),
          [`${anchor.liquidReserves[0]!.tokenAddress}:decimals()`]: 6n,
        },
      },
      nowSec: TIMESTAMP,
    });
  }

  it("publishes the vault-basis book but keeps the off-chain escrow receivable unverified", async () => {
    // Live state: the whole timelock balance equals EscrowTimelock
    // 0x1e710cc0…6438 totalDeposits, whose USDai sits with the escrow admin.
    const run = await runCorroboration();
    expect(run.result.slices).toEqual([
      { sourceKey: "usdai-proof-of-reserves:vault-usdai", name: "USDai (idle in sUSDai vault)", pct: 43.8, risk: "low", coinId: "usdai-usd-ai", depType: "collateral" },
      { sourceKey: "usdai-proof-of-reserves:deal", name: "GPU-backed infrastructure loans (NVIDIA hardware)", pct: 32.9, risk: "high" },
      { sourceKey: "usdai-proof-of-reserves:escrow-receivable", name: "Escrowed USDai receivable (pending deals)", pct: 23.3, risk: "high" },
    ]);
    expect(run.result.warnings?.map(({ code }) => code)).toEqual(["missing-share-rows-ignored", "usdai-composition-unverified"]);
    expectWarningEffect(run.result, "usdai-composition-unverified", "degraded");
    expect(run.result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      observedBlock: { number: BLOCK, timestamp: TIMESTAMP },
      details: {
        freshnessSource: "usdai-onchain-composition-anchor",
        anchor: {
          block: BLOCK,
          pendingLoanPrincipalRaw: PENDING.toString(),
          dealRemainingAmountRaw: "181842265043791831159434867",
          vaultDepositBalanceRaw: (DEPOSITS - REDEMPTION_RESERVED).toString(),
          depositTimelockRaw: TIMELOCK.toString(),
          accruedResidualRaw: (TOTAL_ASSETS - (DEPOSITS - REDEMPTION_RESERVED) - TIMELOCK - PENDING).toString(),
          compositionCorroboration: { status: "unverified", reason: "escrow-receivable-unverified" },
        },
      },
      compositionBasis: "vault-total-assets",
      unknownExposurePct: 0,
    });
    const issuer = run.result.metadata?.issuerSharePcts as { liquid: number; deal: number };
    expect(issuer.liquid).toBeCloseTo(58.88, 2);
    expect(issuer.deal).toBeCloseTo(41.12, 2);
    expect(evaluateAdapterSnapshotAdmission(run, TIMESTAMP)).toMatchObject({ eligible: false, reasons: ["degraded-snapshot"] });
  });

  it("certifies the vault-basis book once the escrow receivable is immaterial", async () => {
    // Hypothetical drained escrow: the timelock USDai returned to the vault,
    // in both its deposit accounting and its observed token holdings.
    const run = await runCorroboration({
      "idle-asset": DEPOSITS + TIMELOCK - 1n * 10n ** 18n,
      "vault-balances": twoWords(DEPOSITS + TIMELOCK - 1n * 10n ** 18n, REDEMPTION_RESERVED),
      "deposit-timelock": 1n * 10n ** 18n,
    });
    expect(run.result.warnings?.map(({ code }) => code)).toEqual(["missing-share-rows-ignored"]);
    expect(run.result.metadata?.details).toMatchObject({
      anchor: { compositionCorroboration: { status: "corroborated" } },
    });
    expect(evaluateAdapterSnapshotAdmission(run, TIMESTAMP)).toMatchObject({ eligible: true, reasons: [] });
  });

  it("keeps composition unverified when on-chain deal principal drifts beyond tolerance", async () => {
    const { result } = await runCorroboration({
      "loan-router-balances": twoWords(PENDING * 102n / 100n, ACCRUED),
    });
    expect(result.metadata?.freshnessMode).toBe("unverified");
    expect(result.metadata?.details).toMatchObject({
      anchor: { compositionCorroboration: { status: "unverified", reason: "deal-principal-mismatch" } },
    });
    expectWarningEffect(result, "usdai-composition-unverified", "degraded");
  });

  it("rejects accounted deposits the vault's observed USDai does not hold", async () => {
    const run = await runCorroboration({
      "idle-asset": 0n,
      "vault-balances": twoWords(DEPOSITS + TIMELOCK - 1n * 10n ** 18n, REDEMPTION_RESERVED),
      "deposit-timelock": 1n * 10n ** 18n,
    });
    expect(run.result.slices.map(({ sourceKey }) => sourceKey)).toEqual([
      "usdai-proof-of-reserves:pyusd", "usdai-proof-of-reserves:deal",
    ]);
    expect(run.result.metadata?.details).toMatchObject({
      anchor: { compositionCorroboration: { status: "unverified", reason: "idle-custody-shortfall" } },
    });
    expectWarningEffect(run.result, "usdai-composition-unverified", "degraded");
    expect(evaluateAdapterSnapshotAdmission(run, TIMESTAMP).eligible).toBe(false);
  });

  it("keeps the issuer book when vault legs do not reconcile to totalAssets", async () => {
    const { result } = await runCorroboration({ assets: TOTAL_ASSETS * 102n / 100n });
    expect(result.slices.map(({ sourceKey }) => sourceKey)).toEqual([
      "usdai-proof-of-reserves:pyusd", "usdai-proof-of-reserves:deal",
    ]);
    expect(result.metadata?.details).toMatchObject({
      anchor: { compositionCorroboration: { status: "unverified", reason: "vault-total-assets-unreconciled" } },
    });
    expectWarningEffect(result, "usdai-composition-unverified", "degraded");
  });

  it("never reads unreadable vault balances as an empty vault", async () => {
    const { result } = await runCorroboration({ "deposit-timelock": null });
    expect(result.metadata?.details).toMatchObject({
      anchor: { compositionCorroboration: { status: "unverified", reason: "vault-balances-unreadable" } },
    });
    expectWarningEffect(result, "usdai-composition-unverified", "degraded");
  });

  it("keeps composition unverified when share weights disagree with corroborated amounts", async () => {
    // Move five points of share from PYUSD to one deal: totals and amounts still
    // reconcile, so only the weight cross-check can catch it.
    const tampered = liveEntries.map((row, index) => {
      const shift = 50_000_000_000_000_000n;
      if (index === 0) return { ...row, share: String(BigInt(String(row.share)) - shift) };
      if (index === 1) return { ...row, share: String(BigInt(String(row.share)) + shift) };
      return row;
    });
    const { result } = await runCorroboration({}, JSON.stringify(tampered));
    expect(result.metadata?.details).toMatchObject({
      anchor: { compositionCorroboration: { status: "unverified", reason: "share-weights-mismatch" } },
    });
    expectWarningEffect(result, "usdai-composition-unverified", "degraded");
  });

  it("keeps composition unverified when a share-bearing deal drops its remaining principal", async () => {
    const stripped = liveEntries.map((row, index) => {
      if (index !== 1) return row;
      const { remainingAmount: _remaining, ...rest } = row;
      return rest;
    });
    const { result } = await runCorroboration({}, JSON.stringify(stripped));
    expect(result.metadata?.details).toMatchObject({
      anchor: { compositionCorroboration: { status: "unverified", reason: "deal-remaining-amount-missing" } },
    });
    expectWarningEffect(result, "usdai-composition-unverified", "degraded");
  });

  it("never treats an unreadable loan-principal read as zero outstanding loans", async () => {
    for (const unreadable of [null, `0x${PENDING.toString(16).padStart(64, "0")}`]) {
      const { result } = await runCorroboration({ "loan-router-balances": unreadable });
      expect(result.metadata?.details).toMatchObject({
        anchor: { compositionCorroboration: { status: "unverified", reason: "loan-principal-unreadable" } },
      });
      expect((result.metadata?.details as { anchor: Record<string, unknown> }).anchor.pendingLoanPrincipalRaw).toBeUndefined();
      expectWarningEffect(result, "usdai-composition-unverified", "degraded");
    }
  });

  it("still degrades on a liquid balance mismatch before considering the deal leg", async () => {
    const { result } = await runCorroboration({ "balance-0": 250_000_000_000_000n });
    expect(result.metadata?.freshnessMode).toBe("unverified");
    expectWarnings(result, ["missing-share-rows-ignored", "usdai-anchor-mismatch"]);
  });
});
