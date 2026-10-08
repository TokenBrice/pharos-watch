import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as assurance from "@shared/lib/independent-assurance";
import { getIndependentAssuranceManifest, IndependentAssuranceManifestSchema, reconcileIndependentAssuranceManifest } from "@shared/lib/independent-assurance";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS, LiveReservesConfigSchema } from "@shared/lib/live-reserve-adapters";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { ReserveSlice } from "@shared/types/reserves";
import { buildIndependentAssuranceReserveResult } from "../independent-assurance";
import { BLOX_INDEPENDENT_ASSURANCE_PROFILE, fetchBloxIndependentAssuranceReserves, verifyBloxAttestationIndex } from "../blox-independent-assurance";
import { expectValidAdapterOutput, installAdapterNetwork } from "./reserve-adapter.test-support";
import { PDF_BYTES } from "./independent-assurance.test-support";
import { BLOX_ATTESTATIONS } from "./fixtures/blox-attestations";
import boundedFacts from "@shared/data/safety-score-v9/reserve-bound-facts-v1.json";
import sidecar from "@shared/data/stablecoins/domains/reserves/myrc-blox.json";
import { computeSafetyScoreV9ReserveExposureKey } from "../../../lib/safety-score-v9/fact-set-schema";

const reviewed = getIndependentAssuranceManifest("MYRC");
const config: LiveReservesConfig = {
  adapter: "blox-independent-assurance", version: 2, semantics: "attestation-mix",
  inputs: { primary: { kind: "http-json", url: reviewed.officialIndexUrl } },
  params: { product: "MYRC", profile: "myrc-v1", indexHost: "api.blox.my", reportHosts: ["cdn.blox.my"] },
};
const coin = ACTIVE_STABLECOINS.find((item) => item.id === "myrc-blox")!;

function installReport(pdf = PDF_BYTES, redirectedUrl?: string) {
  const fixture = { ...reviewed, reportByteLength: PDF_BYTES.length, reportSha256: createHash("sha256").update(PDF_BYTES).digest("hex") };
  vi.spyOn(assurance, "getIndependentAssuranceManifest").mockReturnValue(fixture);
  installAdapterNetwork({ html: {
    [reviewed.officialIndexUrl]: { body: JSON.stringify(BLOX_ATTESTATIONS), headers: { "content-type": "application/json" } },
    [reviewed.reportUrl]: { body: new TextDecoder().decode(pdf), headers: { "content-type": "application/pdf" }, ...(redirectedUrl ? { url: redirectedUrl } : {}) },
  } });
  return fixture;
}

describe("Blox offline assurance and gated runtime verifier", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("keeps the active static tier while the independently verified key is staged and unbound", () => {
    expect(coin.liveReservesConfig?.adapter).toBe("blox-attestation-index");
    expect(coin.liveReservesConfig?.version).toBe(2);
    expect(LIVE_RESERVE_ADAPTER_DEFINITIONS["blox-attestation-index"].evidenceClass).toBe("static-validated");
    expect(LIVE_RESERVE_ADAPTER_DEFINITIONS["blox-independent-assurance"].provenance.status).toBe("staged");
    expect(ACTIVE_STABLECOINS.some((item) => item.liveReservesConfig?.adapter === "blox-independent-assurance")).toBe(false);
    expect(reviewed.assuranceTier).toBe("independent-assurance");
    expect(reviewed.reportAsOf).toBe("2026-08-31T23:59:00+08:00");
    expect(LiveReservesConfigSchema.safeParse({ ...coin.liveReservesConfig, version: 1 }).success).toBe(false);
    const fund = (sidecar.reserves as ReserveSlice[]).find((slice) => slice.sourceKey === "blox-independent-assurance:myrc:halogen-myr-liquid-fund")!;
    expect(boundedFacts.assets["myrc-blox"][0].scope.exposureKey).toBe(computeSafetyScoreV9ReserveExposureKey(fund));
    expect(computeSafetyScoreV9ReserveExposureKey(fund)).not.toBe("reserve:159bb5cd984bd7b0423ab087");
  });

  it("preserves the bounded MYR 0.03 assertion/itemization discrepancy and full nominal liability scope", () => {
    expect(reconcileIndependentAssuranceManifest(reviewed, BLOX_INDEPENDENT_ASSURANCE_PROFILE.reconciliation)).toMatchObject({
      computedAssetTotal: "1800903.77", liabilityTotal: "1800903.74", reportedAssetDifference: "0.03",
    });
    expect(() => reconcileIndependentAssuranceManifest({ ...reviewed, reportedAssetTotal: "1800903.73" }, BLOX_INDEPENDENT_ASSURANCE_PROFILE.reconciliation)).toThrow();
    expect(() => reconcileIndependentAssuranceManifest({ ...reviewed, reportedLiabilityTotal: "1800903.73" }, BLOX_INDEPENDENT_ASSURANCE_PROFILE.reconciliation)).toThrow();
    expect(IndependentAssuranceManifestSchema.safeParse({ ...reviewed, nativeQuantityBasis: { ...reviewed.nativeQuantityBasis, nominalValuePerToken: 2 } }).success).toBe(false);
    expect(IndependentAssuranceManifestSchema.safeParse({ ...reviewed, nativeQuantityBasis: { ...reviewed.nativeQuantityBasis, supplyToken: "OTHER" } }).success).toBe(false);
    expect(IndependentAssuranceManifestSchema.safeParse({ ...reviewed, assuranceTier: "independent-assurance", conclusion: "agreed-upon-procedures" }).success).toBe(false);
  });

  it("requires unique dated exact JSON membership and rejects newer, regressed, malformed or drifted reports", () => {
    expect(() => verifyBloxAttestationIndex(JSON.stringify([...BLOX_ATTESTATIONS].reverse()), reviewed)).not.toThrow();
    const latest = BLOX_ATTESTATIONS[0];
    for (const rows of [
      [latest, latest], BLOX_ATTESTATIONS.slice(1), [{ ...latest, month: undefined }],
      [{ ...latest, reservedAmount: 180090374 }],
      [{ ...latest, fileUrl: latest.fileUrl.replace("cdn.blox.my", "example.com") }],
      [{ ...latest, fileUrl: `${latest.fileUrl}?changed=1` }],
      [{ ...latest, month: 9, fileUrl: "https://cdn.blox.my/attestations/2026/Blox Attestation Report-2026-09-September.pdf" }],
    ]) expect(() => verifyBloxAttestationIndex(JSON.stringify(rows), reviewed)).toThrow();
    expect(() => verifyBloxAttestationIndex("not json", reviewed)).toThrow();
    expect(() => verifyBloxAttestationIndex(JSON.stringify(Array.from({ length: 1201 }, () => latest)), reviewed)).toThrow();
  });

  it("verifies PDF identity and emits migrated native-only quantities with the original report clock", async () => {
    installReport();
    const result = await fetchBloxIndependentAssuranceReserves(coin, config, new AbortController().signal);
    expect(result.slices.map((slice) => slice.sourceKey)).toEqual([
      "blox-independent-assurance:myrc:cash", "blox-independent-assurance:myrc:halogen-myr-liquid-fund",
    ]);
    expect(result.metadata).toMatchObject({
      sourceTimestamp: Date.parse(reviewed.reportAsOf) / 1000, totalReserveQuantity: 1800903.77, supplyTokens: 1800903.74,
      nativeQuantityBasis: { reserveUnit: { kind: "currency", unit: "MYR" }, supplyToken: "MYRC", nominalValuePerToken: 1 },
      details: { assurance: { reportedAssetDifference: "0.03", reportAsOf: reviewed.reportAsOf, unit: "MYR" } },
    });
    expect(result.metadata).not.toHaveProperty("totalReserveUsd");
    expect(result.metadata).not.toHaveProperty("supplyUsd");
    expect(result.metadata).not.toHaveProperty("redemption");
    const validation = expectValidAdapterOutput("blox-independent-assurance", result, { now: Date.parse("2026-10-08T00:00:00Z") / 1000 });
    expect(validation.warnings).toContainEqual(expect.objectContaining({ code: "stale-source-data", effect: "degraded" }));
  });

  it.each(["magic", "hash", "host"])("rejects the %s artifact fence", async (fence) => {
    const pdf = fence === "magic" ? new TextEncoder().encode("NOTPDF-fixture\n")
      : fence === "hash" ? new TextEncoder().encode("%PDF-1.7\nchanged\n") : PDF_BYTES;
    installReport(pdf, fence === "host" ? "https://example.com/report.pdf" : undefined);
    await expect(fetchBloxIndependentAssuranceReserves(coin, config, new AbortController().signal)).rejects.toThrow();
  });

  it("withholds a MYR/MYRC ratio when the manifest has no supported nominal basis", () => {
    const { nativeQuantityBasis: _basis, ...unsupported } = reviewed;
    const result = buildIndependentAssuranceReserveResult({
      slices: [{ name: "Cash", pct: 100, risk: "low" }], manifest: unsupported,
      reconciliation: reconcileIndependentAssuranceManifest(unsupported, BLOX_INDEPENDENT_ASSURANCE_PROFILE.reconciliation),
      verifiedResponseUrl: reviewed.reportUrl, verifiedByteLength: reviewed.reportByteLength,
      sourceTimestamp: Date.parse(reviewed.reportAsOf) / 1000,
    });
    expect(result.metadata).not.toHaveProperty("collateralizationRatio");
    expect(result.metadata).not.toHaveProperty("supplyUsd");
  });
});
