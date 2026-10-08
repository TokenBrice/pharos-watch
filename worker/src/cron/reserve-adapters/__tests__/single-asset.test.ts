import { describe, expect, it } from "vitest";
import { installAdapterNetwork, runAdapter } from "./reserve-adapter.test-support";
import qcadSnapshot from "./fixtures/qcad-balances-2026-10-07.json";
import { computeLiveReserveConfigFingerprint } from "@shared/lib/live-reserve-adapters";
import { evaluateLiveReserveAdmission } from "../../../lib/live-reserves/store-snapshot-state";
import { getReserveAdapter } from "../index";

const TGBP_URL = "https://api.tgbp.io/api/v1/public/data/tgbp";
const QCAD_URL = "https://api.sdc.stablecorp.ca/reports/balances?type=unformatted_json";
const NOW = Date.parse("2026-03-20T12:01:00Z") / 1000;

function runJson(
  coinId: "tgbp-tokenised" | "qcad-stablecorp",
  payload: unknown,
  params: Record<string, unknown> = {},
  nowSec = NOW,
) {
  const url = coinId === "tgbp-tokenised" ? TGBP_URL : QCAD_URL;
  return runAdapter("single-asset", coinId, {
    network: installAdapterNetwork({ json: { [url]: payload } }),
    params,
    nowSec,
  });
}

function runOnchain(network = installAdapterNetwork({
  chains: { ethereum: "https://rpc.example" },
  rpc: { "ethereum:0x18160ddd": 1_000_000n },
})) {
  return runAdapter("single-asset", "axcnh-anchorx", { network });
}

describe("fetchSingleAssetReserves", () => {
  it("returns 100% slice in http-json mode when probe returns non-zero", async () => {
    const { result } = await runJson("tgbp-tokenised", { total_supply: "1000000" }, {
      label: "ETH collateral",
      risk: "low",
      reserveProbe: { kind: "json-path", path: ["total_supply"] },
      supplyProbe: undefined,
      timestampProbe: undefined,
      reserveSourceLabel: "ETH collateral",
    });
    expect(result.slices).toEqual([
      { name: "ETH collateral", pct: 100, risk: "low" },
    ]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "unverified",
      details: {
        proofKind: "single-asset-liveness-probe",
        reserveSourceLabel: "ETH collateral",
      },
    });
  });

  it("preserves optional coinId and depType in the slice", async () => {
    const { result } = await runJson("tgbp-tokenised", { value: "42" }, {
      label: "USDC backing",
      risk: "very-low",
      coinId: "usdc-circle",
      depType: "wrapper",
      reserveProbe: { kind: "json-path", path: ["value"] },
      supplyProbe: undefined,
      timestampProbe: undefined,
    });
    expect(result.slices).toEqual([
      { name: "USDC backing", pct: 100, risk: "very-low", coinId: "usdc-circle", depType: "wrapper" },
    ]);
  });

  it.each(["0", "0.0"])("throws on '%s' probe value in http-json mode", async (probeValue) => {
    await expect(runJson("tgbp-tokenised", { total_supply: probeValue }, {
      label: "ETH collateral",
      risk: "low",
      reserveProbe: { kind: "json-path", path: ["total_supply"] },
      supplyProbe: undefined,
      timestampProbe: undefined,
    })).rejects.toThrow("zero/empty");
  });

  it("throws when http-json mode has no probe configured", async () => {
    await expect(runJson("tgbp-tokenised", { value: "100" }, {
      reserveProbe: undefined,
      supplyProbe: undefined,
    })).rejects.toThrow("params.reserveProbe or params.supplyProbe");
  });

  it.each([
    { name: "invalid risk value", params: { risk: "invalid-risk" } },
    { name: "label is missing", params: { label: undefined } },
  ])("throws when $name", async ({ params }) => {
    await expect(runJson("tgbp-tokenised", {}, params)).rejects.toThrow("single-asset adapter params invalid");
  });

  it("returns 100% slice in onchain mode when probe succeeds", async () => {
    const { result } = await runOnchain();
    expect(result.slices).toEqual([
      { name: "CNH cash reserves", pct: 100, risk: "very-low" },
    ]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "unverified",
      details: {
        proofKind: "erc20-total-supply-liveness",
        compositionMeasured: false,
        observationScope: "configured-chain-token-liveness",
        tokenFreshnessMode: "not-applicable",
        scopedTokenChain: "ethereum",
        scopedTokenQuantityRaw: "1000000",
      },
    });
  });

  it("keeps the pinned CAD book native and diagnoses ARC/missing Solana without a reserve clock", async () => {
    const { result } = await runJson("qcad-stablecorp", qcadSnapshot);
    expect(result.metadata).toMatchObject({
      freshnessMode: "unverified",
      details: {
        reserveUnit: "CAD",
        nativeReserveQuantity: 2474672.34,
        nativeSupplyQuantity: 2474672.34,
        reportedNativeReserveToSupplyRatio: 1,
        liabilitySourceTimestamp: Math.floor(Date.parse(qcadSnapshot.chains[0].lastSyncedAt) / 1000),
        liabilityScopeComplete: false,
        missingLiabilityChains: ["solana"],
        unreviewedLiabilityChains: ["arc"],
      },
    });
    for (const field of ["totalReserveUsd", "supplyUsd", "collateralizationRatio", "sourceTimestamp", "redemption"]) {
      expect(result.metadata).not.toHaveProperty(field);
    }
    expect(result.metadata?.details?.liabilityComponents).toEqual(expect.arrayContaining([
      expect.objectContaining({ chain: "base", quantity: 0 }),
    ]));
  });

  function completeNativePayload() {
    return {
      totalFiatReserves: "100",
      totalSupply: "100",
      chains: [
        { chain: "ETH", totalSupply: "60", lastSyncedAt: "2026-10-07T21:00:00Z" },
        { chain: "BASE", totalSupply: "40", lastSyncedAt: "2026-10-07T19:00:00Z" },
        { chain: "SOLANA", totalSupply: "0", lastSyncedAt: "2026-10-07T20:00:00Z" },
      ],
    };
  }

  it("uses the oldest contributing liability clock independent of order, never as a fiat reserve clock", async () => {
    const payload = completeNativePayload();
    const first = (await runJson("qcad-stablecorp", payload)).result;
    const reordered = (await runJson("qcad-stablecorp", { ...payload, chains: [...payload.chains].reverse() })).result;
    expect(first.metadata?.details?.liabilitySourceTimestamp).toBe(Date.parse("2026-10-07T19:00:00Z") / 1000);
    expect(reordered.metadata?.details?.liabilitySourceTimestamp).toBe(first.metadata?.details?.liabilitySourceTimestamp);
    expect(first.metadata?.details?.liabilityScopeComplete).toBe(true);
    expect(first.metadata?.freshnessMode).toBe("unverified");
    expect(first.metadata).not.toHaveProperty("sourceTimestamp");
    expect(first.metadata).not.toHaveProperty("collateralizationRatio");
  });

  it.each([undefined, null, "bad-clock"])("rejects a missing/malformed clock on a positive liability contributor: %s", async (lastSyncedAt) => {
    const payload = completeNativePayload();
    await expect(runJson("qcad-stablecorp", {
      ...payload, chains: [{ ...payload.chains[0], lastSyncedAt }, ...payload.chains.slice(1)],
    })).rejects.toThrow();
  });

  it.each([undefined, null, "-1", "NaN", "Infinity", "0x10"])("rejects missing or invalid native component quantities: %s", async (totalSupply) => {
    const payload = completeNativePayload();
    await expect(runJson("qcad-stablecorp", {
      ...payload, chains: [{ ...payload.chains[0], totalSupply }, ...payload.chains.slice(1)],
    })).rejects.toThrow();
  });

  it.each([-1, "-0.01", null, "NaN", "Infinity", "0x10"])("rejects invalid native reserve quantities independently of liability reconciliation: %s", async (totalFiatReserves) => {
    await expect(runJson("qcad-stablecorp", { ...completeNativePayload(), totalFiatReserves })).rejects.toThrow();
  });

  it("rejects a balanced aggregate containing a negative liability component", async () => {
    const payload = completeNativePayload();
    await expect(runJson("qcad-stablecorp", {
      ...payload,
      chains: [
        { ...payload.chains[0], totalSupply: "101" },
        { ...payload.chains[1], totalSupply: "-1" },
        payload.chains[2],
      ],
    })).rejects.toThrow();
  });

  it("preserves an observed zero reserve quantity without inventing USD coverage", async () => {
    const { result } = await runJson("qcad-stablecorp", { ...completeNativePayload(), totalFiatReserves: "0" });
    expect(result.metadata?.details?.nativeReserveQuantity).toBe(0);
    expect(result.metadata?.details?.reportedNativeReserveToSupplyRatio).toBe(0);
    expect(result.metadata).not.toHaveProperty("collateralizationRatio");
  });

  it("rejects duplicate identities including observed zero rows before aggregate admission", async () => {
    const payload = completeNativePayload();
    await expect(runJson("qcad-stablecorp", {
      ...payload, chains: [...payload.chains, { ...payload.chains[2], chain: "solana" }],
    })).rejects.toThrow();
  });

  it("rejects incompatible aggregate amounts and missing component identities", async () => {
    const payload = completeNativePayload();
    await expect(runJson("qcad-stablecorp", { ...payload, totalSupply: "101" })).rejects.toThrow();
    await expect(runJson("qcad-stablecorp", {
      ...payload, chains: [{ ...payload.chains[0], chain: "" }, ...payload.chains.slice(1)],
    })).rejects.toThrow();
  });

  it("retains a measured native shortfall as diagnostics rather than USD coverage or capacity", async () => {
    const { result } = await runJson("qcad-stablecorp", { ...completeNativePayload(), totalFiatReserves: "99" });
    expect(result.metadata?.details?.reportedNativeReserveToSupplyRatio).toBe(0.99);
    expect(result.metadata).not.toHaveProperty("collateralizationRatio");
    expect(result.metadata).not.toHaveProperty("redemption");
  });

  it("marks timestamp-backed liveness probes as freshness-verified even without reserve totals", async () => {
    const { result } = await runJson("tgbp-tokenised", {
      data: {
        price: "1.120735576038699094",
        timestamp: "1774874195",
      },
    }, {
      label: "Treasury reserve",
      risk: "very-low",
      reserveProbe: { kind: "json-path", path: ["data", "price"] },
      supplyProbe: undefined,
      timestampProbe: { kind: "json-path", path: ["data", "timestamp"] },
      reserveSourceLabel: "Treasury reserve",
    }, 1_774_874_255);
    expect(result.metadata).toMatchObject({
      sourceTimestamp: 1_774_874_195,
      freshnessMode: "verified",
      details: {
        proofKind: "single-asset-liveness-probe",
        reserveSourceLabel: "Treasury reserve",
      },
    });
  });

  it.each([0n, null])("fails closed on missing/nonpositive scoped token reads: %s", async (quantity) => {
    await expect(runOnchain(installAdapterNetwork({
      chains: { ethereum: "https://rpc.example" }, rpc: { "ethereum:0x18160ddd": quantity },
    }))).rejects.toThrow();
  });

  it("never fetches the display page or turns a multi-contract roster into global reserves/supply", async () => {
    const network = installAdapterNetwork({
      chains: { ethereum: "https://rpc.example" }, rpc: { "ethereum:0x18160ddd": 123n },
    });
    const { result } = await runOnchain(network);
    expect(network.requests.every((request) => request.url === "https://rpc.example/")).toBe(true);
    expect(result.metadata?.details?.scopedTokenQuantityRaw).toBe("123");
    expect(result.metadata).not.toHaveProperty("supplyUsd");
    expect(result.metadata).not.toHaveProperty("totalReserveUsd");
    expect(result.metadata).not.toHaveProperty("collateralizationRatio");
  });

  it.each(["onchain", "native-json"])("keeps a successful %s weak probe out of score-grade admission", async (mode) => {
    const { result, coin, config } = mode === "onchain"
      ? await runOnchain()
      : await runJson("qcad-stablecorp", qcadSnapshot);
    const now = Date.parse("2026-10-07T21:06:00Z") / 1000;
    const descriptor = getReserveAdapter("single-asset")!;
    const snapshot = {
      stablecoinId: coin.id, slices: result.slices,
      fetchedAt: now, attemptId: "weak-probe-success", source: config.adapter,
      metadata: result.metadata ?? {}, warnings: result.warnings ?? [],
      warningCount: result.warnings?.length ?? 0,
      adapterSourceModel: descriptor.sourceModel, adapterEvidenceClass: descriptor.evidenceClass,
      configFingerprint: computeLiveReserveConfigFingerprint(config),
    };
    const admission = evaluateLiveReserveAdmission(snapshot, {
      lastSuccessAt: now, lastSuccessAttemptId: snapshot.attemptId,
    }, { liveReservesConfig: config }, now);
    expect(admission.eligible).toBe(false);
    expect(admission.reasons).toContain("non-independent");
  });

  it("propagates a failed on-chain supply probe", async () => {
    const error = new Error("RPC unavailable");
    const network = installAdapterNetwork({
      chains: { ethereum: "https://rpc.example" },
      rpc: { "ethereum:0x18160ddd": () => { throw error; } },
    });
    await expect(runOnchain(network)).rejects.toThrow("single-asset totalSupply probe failed");
  });
});
