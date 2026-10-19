import { describe, expect, it, afterEach, vi } from "vitest";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { encodeAbiParameters, parseAbiParameters } from "viem/utils";
import fixture from "./fixtures/midas-mtbill-save.json";
import septemberCapture from "./fixtures/midas-mtbill-transparency.json";
import octoberCapture from "./fixtures/midas-rejection-oct7-2026.json";
import { TRACKED_SOURCE_COINS } from "@shared/lib/stablecoins/registry";
import { computeLiveReserveConfigFingerprint } from "@shared/lib/live-reserve-adapters";
import { LIVE_RESERVE_ADAPTER_DESCRIPTOR_DECLARATIONS } from "@shared/types/live-reserve-adapter-declarations";
import source from "@shared/data/stablecoins/coins/mtbill-midas.json";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext } from "../types";
import { fetchMidasMtbillReserves } from "../midas-mtbill";
import { installAdapterNetwork, expectValidAdapterOutput, type AdapterNetworkSpec } from "./reserve-adapter.test-support";
import { midasNetwork, midasClaimData, MIDAS_CAPTURE_NOW, MIDAS_CHECKPOINT_SEC, type MidasTestDocument } from "./midas-mtbill.test-support";
import { evaluateLiveReserveAdmission } from "../../../lib/live-reserves/store-snapshot-state";
import type { ReserveCompositionRecord } from "../../../lib/live-reserves/store-shared";

interface HistoricalFixture {
  reports: {
    main_positions: { pv_usd: Record<string, number>; delta_usd: Record<string, number> };
    assets_by_protocol: { assets: Record<string, number>; equity: Record<string, number> };
    assets_by_protocol_chain: { equity: Record<string, number> };
    asset_values: { pv_usd: Record<string, number> };
  };
}
const coin = TRACKED_SOURCE_COINS.find((candidate) => candidate.id === "mtbill-midas")!;
const config = source.liveReservesConfig as LiveReservesConfig;
const ustb = "('USTB', 'CASH', 'wallet', 'ethereum', 'USTB')";
const registry = fixture.registry;
const fresh = MIDAS_CAPTURE_NOW;
function fetchPacket(networkSpec: AdapterNetworkSpec = midasNetwork(), nowSec = fresh, ctx: Partial<AdapterContext> = {}, signal = AbortSignal.timeout(5_000)) {
  const network = installAdapterNetwork(networkSpec);
  return { network, result: fetchMidasMtbillReserves(coin, config, signal, { chainRpcs: network.chainRpcs, nowSec, ...ctx }) };
}
function book(document: MidasTestDocument): Record<string, unknown> {
  return midasClaimData(document, "onetoken_report");
}
function checkpointMetadata(document: MidasTestDocument): Record<string, unknown> {
  return book(document)._metadata as Record<string, unknown>;
}
afterEach(() => vi.restoreAllMocks());

describe("mTBILL registry-checkpoint issuer portfolio v2", () => {
  it("verifies the recorded UnixFS root rather than the raw gzip/JSON hashes, binds the exact book and retains its original clock", async () => {
    const { result, network } = fetchPacket();
    const output = await result;
    const total = 78_609_324.3164;
    expect(output.metadata).toMatchObject({ sourceTimestamp: MIDAS_CHECKPOINT_SEC, totalReserveUsd: expect.closeTo(total, 4), freshnessMode: "verified" });
    expect(output.slices.map((slice) => slice.coinId)).toEqual(["ustb-superstate", "buidl-blackrock", undefined]);
    expect(output.slices.map((slice) => slice.pct)).toEqual([expect.closeTo(93.8616387326035, 10), expect.closeTo(6.130316017733062, 10), expect.closeTo(0.008045249663451173, 10)]);
    expect(output.slices[2]).toMatchObject({ risk: "high", unclassifiedResidual: true, residualReason: "insufficient-evidence" });
    expect(output.metadata?.details).toMatchObject({
      attestationCid: fixture.attestationCid, attestationHash: "0x47c1850417f4d5ceb1ebe78f0d2b319af6b0bd0b9497f481922f356158c8028c",
      pinHash: fixture.block.hash, registryAddress: registry.toLowerCase(), proofId: fixture.proofId,
      documentJsonSha256: `0x${fixture.jsonSha256}`, compositionEvidence: "issuer-reported-portfolio-with-registry-checkpoint",
      signedCheckpoint: "2026-10-16T10:00", registryPublishedAt: 1792159739,
      namedTotalUsd: 78_603_000, residualUsd: expect.closeTo(6_324.3164, 4),
      baseWalletUsd: expect.closeTo(4_132.8237, 4), chainGapUsd: expect.closeTo(1_081.0803, 4),
      publisherAuthentication: "authorized-registry-publication", signatureValidation: "canonical-signed-content-digest",
    });
    expect(output.metadata?.collateralizationRatio).toBeUndefined();
    expect(output.metadata?.redemption).toBeUndefined();
    expect(output.metadata?.details).not.toHaveProperty("custodyShares");
    expect(output.metadata?.details).not.toHaveProperty("totalSupply");
    expect(output.warnings).toBeUndefined();
    expectValidAdapterOutput("midas-mtbill", output, { now: fresh });
    expect(network.unmatched).toEqual([]);
    const calls = network.rpcCalls.filter((call) => call.method === "eth_call");
    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.block).toBe(fixture.block.number);
      expect(call.data.slice(10)).toBe(fixture.proofId.slice(2));
      expect(call.viaMulticall).toBe(true);
    }
    expect(network.requests.filter(({ method }) => method === "GET").map(({ url }) => url)).toEqual([
      `https://gateway.pinata.cloud/ipfs/${fixture.attestationCid}`,
      "https://api-prod.midas.app/api/transparency/by-timestamp?token=mTBILL&timestamp=2026-10-16T10%3A00",
    ]);
    expect(createHash("sha256").update(Buffer.from(fixture.gzipBase64, "base64")).digest("hex")).toBe(fixture.gzipSha256);
    expect(fixture.gzipSha256).not.toBe("47c1850417f4d5ceb1ebe78f0d2b319af6b0bd0b9497f481922f356158c8028c");
  });

  it("keeps the source cap inclusive at three days and never extends it to document expiry", async () => {
    await expect(fetchPacket(midasNetwork(), MIDAS_CHECKPOINT_SEC + 259_200).result).resolves.toBeDefined();
    await expect(fetchPacket(midasNetwork(), MIDAS_CHECKPOINT_SEC + 259_201).result).rejects.toThrow("midas-mtbill:stale-save-checkpoint");
    await expect(fetchPacket(midasNetwork(), MIDAS_CHECKPOINT_SEC + 6 * 86400).result).rejects.toThrow("stale-save-checkpoint");
    const network = installAdapterNetwork(midasNetwork());
    await expect(fetchMidasMtbillReserves(coin, { ...config, scoring: { maxSourceAgeSec: 1 } }, AbortSignal.timeout(5000), { chainRpcs: network.chainRpcs, nowSec: fresh })).rejects.toThrow("maxAgeSec=1");
    await expect(fetchMidasMtbillReserves(coin, { ...config, scoring: { maxSourceAgeSec: 604800 } }, AbortSignal.timeout(5000), { chainRpcs: network.chainRpcs, nowSec: MIDAS_CHECKPOINT_SEC + 259201 })).rejects.toThrow("maxAgeSec=259200");
  });

  it.each([
    ["wrong proof", (d: MidasTestDocument) => { d.metadata.proofId = `0x${"1".repeat(64)}`; }, "save-document-schema"],
    ["wrong token", (d: MidasTestDocument) => { midasClaimData(d, "ops_claim").token = "mHYPER"; }, "save-token-or-book-identity"],
    ["wrong oracle", (d: MidasTestDocument) => { midasClaimData(d, "oracle_price").oracleAddress = `0x${"1".repeat(40)}`; }, "save-oracle-identity"],
    ["wrong source", (d: MidasTestDocument) => { checkpointMetadata(d).source = "caller"; }, "save-token-or-book-identity"],
    ["duplicate claim", (d: MidasTestDocument) => { d.claims[0].id = "oracle_price"; }, "save-duplicate-claim"],
    ["missing report claim", (d: MidasTestDocument) => { d.claims = d.claims.filter((row) => row.id !== "onetoken_report"); }, "save-document-schema"],
    ["new schema", (d: MidasTestDocument) => { d.metadata.schema = "save-v1"; }, "save-document-schema"],
    ["new version", (d: MidasTestDocument) => { d.metadata.version = "0.2.0"; }, "save-document-schema"],
    ["missing checkpoint", (d: MidasTestDocument) => { delete checkpointMetadata(d).timestamp; }, "save-token-or-book-identity"],
    ["invalid calendar", (d: MidasTestDocument) => { checkpointMetadata(d).timestamp = "2026-02-30T10:00"; }, "save-checkpoint-clock"],
    ["offset checkpoint", (d: MidasTestDocument) => { checkpointMetadata(d).timestamp = "2026-10-16T10:00Z"; }, "save-checkpoint-clock"],
    ["non-hour checkpoint", (d: MidasTestDocument) => { checkpointMetadata(d).timestamp = "2026-10-16T10:30"; }, "save-checkpoint-clock"],
    ["future checkpoint", (d: MidasTestDocument) => { checkpointMetadata(d).timestamp = "2026-10-20T10:00"; }, "future-save-checkpoint"],
    ["fresh publication old holdings", (d: MidasTestDocument) => { checkpointMetadata(d).timestamp = "2026-09-18T10:00"; }, "stale-save-checkpoint"],
    ["wrong anchor rule", (d: MidasTestDocument) => { checkpointMetadata(d).anchorRule = "now_minus_3h"; }, "save-token-or-book-identity"],
    ["inconsistent anchor", (d: MidasTestDocument) => { checkpointMetadata(d).anchorISO = "2026-10-16T11:54:09.725Z"; }, "save-anchor-chronology"],
    ["mismatched hour", (d: MidasTestDocument) => { checkpointMetadata(d).timestamp = "2026-10-16T09:00"; }, "save-anchor-chronology"],
    ["document after registry", (d: MidasTestDocument) => { d.metadata.createdAt = "2026-10-17T14:08:45.429Z"; }, "save-anchor-chronology"],
    ["document before ops", (d: MidasTestDocument) => { d.metadata.createdAt = "2026-10-16T12:08:45.429Z"; }, "save-anchor-chronology"],
    ["expired document", (d: MidasTestDocument) => { d.metadata.expiresAt = "2026-10-18T14:08:45.429Z"; }, "save-document-expired"],
    ["signed liability", (d: MidasTestDocument) => { book(d).liabilities = { total: 1 }; }, "save-token-or-book-identity"],
    ["signed assets mismatch", (d: MidasTestDocument) => { book(d).assets = { total: 79, wallet: 79 }; }, "save-exact-totals-mismatch"],
    ["wrong total pointer", (d: MidasTestDocument) => { d.claims.find((row) => row.id === "onetoken_total_nav")!.pointer = "other#/total"; }, "save-claim-schema"],
  ])("rejects %s", async (_name, change, reason) => {
    const document = structuredClone(fixture.attestation);
    change(document);
    await expect(fetchPacket(midasNetwork({ document })).result).rejects.toThrow(reason);
  });

  it("requires canonical signed-content digest as well as immutable object identity", async () => {
    const document = structuredClone(fixture.attestation);
    document.signature.signedData = `0x${"0".repeat(64)}`;
    await expect(fetchPacket(midasNetwork({ document, preserveSignedData: true })).result).rejects.toThrow("save-signed-content-digest");
  });

  it.each([
    ["zero hash", "proofIdToLatestAttestation(bytes32)", `0x${"0".repeat(64)}${fixture.registryResponses["proofIdToLatestAttestation(bytes32)"].slice(66)}`, "save-zero-hash"],
    ["unauthorized publisher", "proofIdToAuthorizedAttestor(bytes32)", `0x${"1".repeat(64)}`, "save-registry-malformed"],
    ["different authorized publisher", "proofIdToAuthorizedAttestor(bytes32)", `0x${"0".repeat(24)}${"1".repeat(40)}`, "save-unauthorized-publisher"],
    ["missing publisher", "proofIdToAuthorizedAttestor(bytes32)", `0x${"0".repeat(64)}`, "save-unauthorized-publisher"],
    ["malformed words", "proofIdToLatestAttestation(bytes32)", "0x12", "save-registry-malformed"],
    ["nonexistent proof", "proofExists(bytes32)", false, "save-proof-identity"],
    ["wrong proof name", "proofIdToName(bytes32)", encodeAbiParameters(parseAbiParameters("string"), ["mhyper-por"]), "save-proof-identity"],
    ["missing registry response", "proofIdToLatestAttestation(bytes32)", null, "save-registry-unavailable"],
  ] as const)("rejects registry %s", async (_name, fn, value, reason) => {
    await expect(fetchPacket(midasNetwork({ rpc: { [`${registry}:${fn}`]: value } })).result).rejects.toThrow(reason);
  });

  it("rejects CID corruption, raw-file digest substitution and unsupported UnixFS layouts", async () => {
    const file = new Uint8Array(Buffer.from(fixture.gzipBase64, "base64"));
    file[100] ^= 1;
    const hash = "0x47c1850417f4d5ceb1ebe78f0d2b319af6b0bd0b9497f481922f356158c8028c";
    await expect(fetchPacket(midasNetwork({ file, hash })).result).rejects.toThrow("save-cid-layout-or-content-mismatch");
    await expect(fetchPacket(midasNetwork({ hash: `0x${fixture.gzipSha256}` })).result).rejects.toThrow("save-cid-layout-or-content-mismatch");
    await expect(fetchPacket(midasNetwork({ file: new TextEncoder().encode(JSON.stringify(fixture.attestation)) })).result).rejects.toThrow("save-unsupported-compression");
  });

  it("bounds compressed and decompressed objects and fails malformed gzip/JSON", async () => {
    await expect(fetchPacket(midasNetwork({ file: new Uint8Array(128 * 1024 + 1) })).result).rejects.toThrow(/exceed|large|limit/i);
    await expect(fetchPacket(midasNetwork({ file: gzipSync("x".repeat(1024 * 1024 + 1)) })).result).rejects.toThrow("save-decompression-or-document-invalid");
    await expect(fetchPacket(midasNetwork({ file: new Uint8Array([31, 139, 8, 0]) })).result).rejects.toThrow("save-decompression-or-document-invalid");
    await expect(fetchPacket(midasNetwork({ file: gzipSync("not-json") })).result).rejects.toThrow("save-decompression-or-document-invalid");
  });

  it("rechecks the original pin and rejects a changed block hash", async () => {
    let calls = 0;
    const { result } = fetchPacket(midasNetwork({ rpc: { [`eth_getBlockByNumber:${fixture.block.number}`]: () => ({ hash: ++calls > 1 ? `0x${"1".repeat(64)}` : fixture.block.hash }) } }));
    await expect(result).rejects.toThrow("save-pin-changed");
  });

  it("retains cancellation/deadline failures and does not start another source read", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const aborted = fetchPacket(midasNetwork(), fresh, {}, controller.signal);
    await expect(aborted.result).rejects.toThrow("cancelled");
    expect(aborted.network.requests).toHaveLength(0);
    const expired = fetchPacket(midasNetwork(), fresh, { attemptDeadlineMs: Date.now() - 1 });
    await expect(expired.result).rejects.toThrow("save-deadline-exceeded");
    expect(expired.network.requests).toHaveLength(0);
    const signal = new AbortController();
    const network = midasNetwork();
    network.json![`https://gateway.pinata.cloud/ipfs/${fixture.attestationCid}`] = () => { signal.abort(new Error("cancelled-object")); return new Response(Buffer.from(fixture.gzipBase64, "base64")); };
    const pending = fetchPacket(network, fresh, {}, signal.signal);
    await expect(pending.result).rejects.toThrow("cancelled-object");
    expect(pending.network.requests.some(({ url }) => url.includes("by-timestamp"))).toBe(false);
  });

  it.each([
    ["negative position", (p: HistoricalFixture) => { p.reports.main_positions.pv_usd[ustb] = -1; }],
    ["unreviewed position", (p: HistoricalFixture) => { p.reports.main_positions.pv_usd.unknown = 1; }],
    ["missing delta", (p: HistoricalFixture) => { delete p.reports.main_positions.delta_usd[ustb]; }],
    ["leveraged delta", (p: HistoricalFixture) => { p.reports.main_positions.delta_usd[ustb] = 1; }],
    ["assets mismatch", (p: HistoricalFixture) => { p.reports.assets_by_protocol.assets.total += 1; }],
    ["unreviewed protocol", (p: HistoricalFixture) => { p.reports.assets_by_protocol.equity.aave = 1; }],
    ["unreviewed chain", (p: HistoricalFixture) => { p.reports.asset_values.pv_usd.arbitrum = 1; }],
    ["missing positive Base", (p: HistoricalFixture) => { delete p.reports.assets_by_protocol_chain.equity["('wallet', 'base')"]; }],
    ["chain drift", (p: HistoricalFixture) => { p.reports.asset_values.pv_usd.ethereum += 1; }],
    ["negative remainder", (p: HistoricalFixture) => { p.reports.main_positions.pv_usd[ustb] = 80; p.reports.main_positions.delta_usd[ustb] = 80; }],
    ["oversummed chains", (p: HistoricalFixture) => { p.reports.assets_by_protocol_chain.equity["('wallet', 'base')"] = 1; p.reports.asset_values.pv_usd.base = 1; }],
    ["gap outside remainder", (p: HistoricalFixture) => { p.reports.assets_by_protocol_chain.equity["('wallet', 'ethereum')"] -= 1; p.reports.asset_values.pv_usd.ethereum -= 1; }],
  ])("rejects historical %s", async (_name, mutate) => {
    const historical: HistoricalFixture = JSON.parse(fixture.historicalBody);
    mutate(historical);
    await expect(fetchPacket(midasNetwork({ historical })).result).rejects.toThrow("midas-mtbill:save-");
  });

  it("keeps matching display-pair tolerances and rejects October 19's $1,100.932 total drift", async () => {
    const document = structuredClone(fixture.attestation);
    const historical: HistoricalFixture = JSON.parse(fixture.october19Body);
    book(document).assets = structuredClone(historical.reports.assets_by_protocol.assets);
    book(document).equity = structuredClone(historical.reports.assets_by_protocol.equity);
    document.claims.find((row) => row.id === "onetoken_total_nav")!.resolvedValue = historical.reports.assets_by_protocol.equity.total;
    await expect(fetchPacket(midasNetwork({ document, historical })).result).rejects.toThrow("save-rounded-totals-mismatch");
    const matching: HistoricalFixture = JSON.parse(fixture.historicalBody);
    matching.reports.asset_values.pv_usd.ethereum = matching.reports.assets_by_protocol_chain.equity["('wallet', 'ethereum')"] + 0.00099;
    matching.reports.asset_values.pv_usd.total = matching.reports.assets_by_protocol.equity.total - 0.00099;
    await expect(fetchPacket(midasNetwork({ historical: matching })).result).resolves.toBeDefined();
  });

  it("requires both joined sources, never NAV-only, aggregate-only or arbitrary timestamp data", async () => {
    const noHistorical = midasNetwork();
    noHistorical.json = Object.fromEntries(Object.entries(noHistorical.json!).filter(([url]) => !url.includes("by-timestamp")));
    await expect(fetchPacket(noHistorical).result).rejects.toThrow();
    const noRegistry = { json: midasNetwork().json };
    await expect(fetchPacket(noRegistry).result).rejects.toThrow("save-registry-unavailable");
    await expect(fetchPacket(midasNetwork({ historical: { price: 1.0753419 } })).result).rejects.toThrow("save-historical-scope");
    await expect(fetchPacket(midasNetwork({ historical: book(fixture.attestation) })).result).rejects.toThrow("save-historical-scope");
    for (const historical of [septemberCapture, octoberCapture.products.mTBILL.payload, octoberCapture.historical]) {
      await expect(fetchPacket(midasNetwork({ historical })).result).rejects.toThrow("midas-mtbill:save-");
    }
  });

  it.each(["mAPOLLO", "mFONE", "mGLOBAL", "mHYPER", "mRE7"] as const)("rejects the immutable incompatible %s capture", async (product) => {
    await expect(fetchPacket(midasNetwork({ historical: octoberCapture.products[product].payload })).result).rejects.toThrow("midas-mtbill:save-");
  });

  it("admits only current linked v2 snapshots and preserves original clocks through later failed attempts", async () => {
    const output = await fetchPacket().result;
    const snapshot: ReserveCompositionRecord = {
      stablecoinId: coin.id, slices: output.slices, fetchedAt: fresh, source: "midas-mtbill",
      metadata: output.metadata!, warnings: [], warningCount: 0, attemptId: "v2-success",
      adapterEvidenceClass: "independent", adapterSourceModel: "dynamic-mix",
      configFingerprint: computeLiveReserveConfigFingerprint(config),
    };
    const retained = { lastSuccessAt: fresh, lastSuccessAttemptId: "v2-success", lastStatus: "error", lastAttemptedAt: fresh + 1 };
    expect(evaluateLiveReserveAdmission(snapshot, retained, { liveReservesConfig: config }, fresh + 1).eligible).toBe(true);
    expect(evaluateLiveReserveAdmission(snapshot, { ...retained, lastSuccessAttemptId: "different-run" }, { liveReservesConfig: config }, fresh).reasons).toContain("inconsistent-snapshot");
    const v1 = { ...config, version: 1, inputs: { primary: { kind: "http-json" as const, url: "https://api-prod.midas.app/api/transparency?token=mTBILL" } } };
    expect(evaluateLiveReserveAdmission({ ...snapshot, configFingerprint: computeLiveReserveConfigFingerprint(v1) }, retained, { liveReservesConfig: config }, fresh).reasons).toContain("config-mismatch");
    const aged = evaluateLiveReserveAdmission(snapshot, retained, { liveReservesConfig: config }, fresh + 172801);
    expect(aged.freshness).toMatchObject({ fetchBudgetSec: 172800, sourceAgeBudgetSec: 259200, sourceTimestamp: MIDAS_CHECKPOINT_SEC });
    expect(aged.freshness?.staleReasons).toContain("fetch-age");
    expect(snapshot.fetchedAt).toBe(fresh);
    expect(snapshot.metadata.sourceTimestamp).toBe(MIDAS_CHECKPOINT_SEC);
  });

  it("requires the v2 Ethereum/token binding and invalidates retained v1 fingerprints without changing source strength", async () => {
    const network = installAdapterNetwork(midasNetwork());
    const ctx = { chainRpcs: network.chainRpcs, nowSec: fresh };
    await expect(fetchMidasMtbillReserves({ ...coin, id: "mmev-midas" }, config, AbortSignal.timeout(5000), ctx)).rejects.toThrow("save-config-identity");
    await expect(fetchMidasMtbillReserves(coin, { ...config, version: 1 }, AbortSignal.timeout(5000), ctx)).rejects.toThrow("save-config-identity");
    await expect(fetchMidasMtbillReserves(coin, { ...config, inputs: { primary: { kind: "http-json", url: "https://api-prod.midas.app/api/transparency?token=mTBILL" } } }, AbortSignal.timeout(5000), ctx)).rejects.toThrow("save-config-identity");
    expect(computeLiveReserveConfigFingerprint(config)).not.toBe(computeLiveReserveConfigFingerprint({ ...config, version: 1, inputs: { primary: { kind: "http-json", url: "https://api-prod.midas.app/api/transparency?token=mTBILL" } } }));
    expect(LIVE_RESERVE_ADAPTER_DESCRIPTOR_DECLARATIONS["midas-mtbill"]).toMatchObject({ sourceOriginClass: "issuer-attested", evidenceClass: "independent", sourceModel: "dynamic-mix", primaryInputKinds: ["onchain-evm"] });
  });
});
