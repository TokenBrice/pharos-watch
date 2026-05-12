import { describe, expect, it } from "vitest";
import {
  adaptUsdAiProofOfReserves,
  extractUsdAiProofPageTimestamp,
  extractUsdAiProofPageTimestampSummary,
  fetchUsdAiProofOfReserves,
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

describe("usdai-proof-of-reserves adapter", () => {
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

  it("extracts the latest proof-page collateral update timestamp", () => {
    const timestamp = extractUsdAiProofPageTimestamp(
      '\\"dealsDetailsCache\\":{\\"proofs\\":[{\\"timeLastUpdated\\":\\"2026-04-10T03:44:09.495Z\\"},'
      + '{\\"timeLastUpdated\\":\\"2026-04-09T19:43:32.664Z\\"}]}',
    );

    expect(timestamp).toBe(Math.floor(Date.parse("2026-04-10T03:44:09.495Z") / 1000));
  });

  it("summarizes proof-page collateral update timestamps for oldest-component freshness", () => {
    const summary = extractUsdAiProofPageTimestampSummary(
      '\\"dealsDetailsCache\\":{\\"proofs\\":[{\\"timeLastUpdated\\":\\"2026-04-10T03:44:09.495Z\\"},'
      + '{\\"timeLastUpdated\\":\\"2026-04-09T19:43:32.664Z\\"}]}',
    );

    expect(summary).toEqual({
      sourceTimestamp: Math.floor(Date.parse("2026-04-09T19:43:32.664Z") / 1000),
      latestSourceTimestamp: Math.floor(Date.parse("2026-04-10T03:44:09.495Z") / 1000),
      sourceTimestampSpreadSec: 28837,
      timestampCount: 2,
    });
  });

  it("picks the latest timeLastUpdated only from the proof-row payload", () => {
    const html =
      '\\"activity\\":[{\\"timeLastUpdated\\":\\"2099-01-01T00:00:00.000Z\\"}],'
      + '\\"dealsDetailsCache\\":{\\"tokens\\":['
      + '{\\"timeLastUpdated\\":\\"2026-04-10T03:44:09.495Z\\"},'
      + '{\\"timeLastUpdated\\":\\"2026-04-09T19:43:32.664Z\\"}'
      + ']}';

    expect(extractUsdAiProofPageTimestamp(html)).toBe(
      Math.floor(Date.parse("2026-04-10T03:44:09.495Z") / 1000),
    );
  });

  it("returns null when the proof-row container is absent", () => {
    const html = '\\"news\\":[{\\"timeLastUpdated\\":\\"2099-01-01T00:00:00.000Z\\"}]';
    expect(extractUsdAiProofPageTimestamp(html)).toBeNull();
  });

  it("can stamp adapted rows with verified proof-page freshness", () => {
    const sourceTimestamp = Math.floor(Date.parse("2026-04-09T19:43:32.664Z") / 1000);
    const result = adaptUsdAiProofOfReserves(parseUsdAiProofOfReserves(SAMPLE_RAW_PAYLOAD), sourceTimestamp);

    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      sourceTimestamp,
    });
  });

  it("uses oldest proof-row timestamp and warns when proof-row freshness is widely spread", () => {
    const oldest = Math.floor(Date.parse("2026-04-09T19:43:32.664Z") / 1000);
    const latest = Math.floor(Date.parse("2026-04-10T03:44:09.495Z") / 1000);
    const result = adaptUsdAiProofOfReserves(
      parseUsdAiProofOfReserves(SAMPLE_RAW_PAYLOAD),
      oldest,
      {
        sourceTimestamp: oldest,
        latestSourceTimestamp: latest,
        sourceTimestampSpreadSec: latest - oldest,
        timestampCount: 2,
      },
    );

    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      sourceTimestamp: oldest,
      oldestSourceTimestamp: oldest,
      latestSourceTimestamp: latest,
      sourceTimestampSpreadSec: latest - oldest,
      sourceTimestampCount: 2,
    });
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "source-timestamp-spread", effect: "degraded" }),
    ]));
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
      {
        requestCache: new Map([
          [
            "text-get:https://example.com/usdai/proof-of-reserves?chainId=42161:12000",
            Promise.resolve(SAMPLE_RAW_PAYLOAD),
          ],
          [
            "text-get:https://app.usd.ai/reserves:12000",
            Promise.resolve(
              '\\"dealsDetailsCache\\":{\\"timeLastUpdated\\":\\"2026-04-09T19:43:32.664Z\\"}',
            ),
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
    expect(result.metadata?.freshnessMode).toBe("verified");
  });
});
