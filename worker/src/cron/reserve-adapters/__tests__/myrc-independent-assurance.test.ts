import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as assurance from "@shared/lib/independent-assurance";
import { IndependentAssuranceManifestSchema, getIndependentAssuranceManifest, reconcileIndependentAssuranceManifest } from "@shared/lib/independent-assurance";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { getReserveAdapter } from "../index";
import { MYRC_INDEPENDENT_ASSURANCE_PROFILE, verifyMyrcIndexJson } from "../myrc-independent-assurance";
import { validateAdapterOutput } from "../validate";
import index from "./fixtures/myrc-index-2026-10-07.json";
import { computeLiveReserveConfigFingerprint } from "@shared/lib/live-reserve-adapters";
import { evaluateLiveReserveAdmission } from "../../../lib/live-reserves/store-snapshot-state";

const manifest = getIndependentAssuranceManifest("MYRC");
// Transport verification uses self-contained bytes; all examined quantities and
// dates remain those of the real reviewed manifest and compiler text fixture.
const bytes = new TextEncoder().encode("%PDF-1.7 MYRC assurance transport fixture\n");
const artifactManifest = {
  ...manifest,
  reportByteLength: bytes.length,
  reportSha256: createHash("sha256").update(bytes).digest("hex"),
};
const coin = ACTIVE_STABLECOINS.find((candidate) => candidate.id === "myrc-blox")!;
const adapter = getReserveAdapter("myrc-independent-assurance")!;

function installReport(options: { index?: unknown; pdf?: Uint8Array; finalUrl?: string } = {}) {
  return mockFetch([{ match: () => true, respond: (request) => {
    const url = request.url;
    if (url === manifest.officialIndexUrl) return new Response(JSON.stringify(options.index ?? index));
    if (url === manifest.reportUrl) {
      const response = new Response(new Uint8Array(options.pdf ?? bytes), { headers: { "content-type": "application/pdf" } });
      if (options.finalUrl) Object.defineProperty(response, "url", { value: options.finalUrl });
      return response;
    }
    throw new Error(`Unexpected fixture URL: ${url}`);
  } }]);
}

async function fetchReport() {
  return adapter.fetch(coin, coin.liveReservesConfig!, new AbortController().signal);
}

beforeEach(() => {
  vi.spyOn(assurance, "getIndependentAssuranceManifest").mockReturnValue(artifactManifest);
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("MYRC hash-pinned examination", () => {
  it("publishes actual examined cash/fund quantities and clock, retaining the three-cent disclosure difference", async () => {
    installReport();
    const result = await fetchReport();
    expect(result.slices.map((slice) => slice.sourceKey)).toEqual([
      "myrc-independent-assurance:myrc:cash", "myrc-independent-assurance:myrc:halogen-myr-liquid-fund",
    ]);
    expect(result.slices[1]).toMatchObject({ assetClass: "money-market-fund", issuerOrObligor: "Halogen Capital" });
    expect(result.metadata?.sourceTimestamp).toBe(Date.parse("2026-08-31T15:59:00Z") / 1000);
    expect(result.metadata?.details?.assurance).toMatchObject({
      unit: "MYR", verifiedByteLength: bytes.length, reportSha256: artifactManifest.reportSha256,
      computedAssetTotal: "1800903.77", reportedAssetTotal: "1800903.74", reportedAssetDifference: "0.03",
      computedLiabilityTotal: "1800903.74",
    });
    expect(result.metadata?.details?.examinerRelianceCaveat).toBeTypeOf("string");
    expect(result.metadata).not.toHaveProperty("totalReserveUsd");
    expect(result.metadata).not.toHaveProperty("supplyUsd");
    expect(result.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "report-rounding-difference", effect: "info" })]));
    expect(manifest).not.toHaveProperty("reportIssuedAt");
    const stale = validateAdapterOutput(result, { adapter, now: Date.parse("2026-10-07T21:01:31Z") / 1000 });
    expect(stale.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "stale-source-data", effect: "degraded" }),
    ]));
    expect(validateAdapterOutput(result, { adapter, now: Date.parse("2026-09-01T00:00:00Z") / 1000 }).valid).toBe(true);
  });

  it("rejects a freshly fetched stale examination at scoring admission under the unchanged 33-day cap", async () => {
    installReport();
    const result = await fetchReport();
    const config = coin.liveReservesConfig!;
    const now = Date.parse("2026-10-07T21:01:31Z") / 1000;
    const snapshot = {
      stablecoinId: coin.id, slices: result.slices,
      fetchedAt: now, attemptId: "myrc-report-success", source: config.adapter,
      metadata: result.metadata ?? {}, warnings: result.warnings ?? [],
      warningCount: result.warnings?.length ?? 0,
      adapterSourceModel: adapter.sourceModel, adapterEvidenceClass: adapter.evidenceClass,
      configFingerprint: computeLiveReserveConfigFingerprint(config),
    };
    const admission = evaluateLiveReserveAdmission(snapshot, {
      lastSuccessAt: now, lastSuccessAttemptId: snapshot.attemptId,
    }, coin, now);
    expect(admission.eligible).toBe(false);
    expect(admission.reasons).toContain("stale");
    expect(admission.freshness).toMatchObject({ stale: true, sourceAgeBudgetSec: 33 * 86400 });
    const timely = Date.parse("2026-09-01T00:00:00Z") / 1000;
    expect(evaluateLiveReserveAdmission({ ...snapshot, fetchedAt: timely }, {
      lastSuccessAt: timely, lastSuccessAttemptId: snapshot.attemptId,
    }, coin, timely).eligible).toBe(true);
  });

  it("ignores upload/signature clocks and index ordering without renewing the examined instant", async () => {
    installReport({ index: [...index].reverse().map((row) => ({ ...row, createdAt: "2026-10-08T00:00:00Z" })) });
    expect((await fetchReport()).metadata?.sourceTimestamp).toBe(Date.parse(manifest.reportAsOf) / 1000);
  });

  it.each([
    null, {}, [], [{ year: 2026 }],
    [index[0], index[0]],
    index.slice(1),
    [{ ...index[0], reservedAmount: 180090374 }],
    [{ ...index[0], product: "OTHER" }],
    [{ ...index[0], fileUrl: index[0].fileUrl.replace("August", "September") }],
    [{ ...index[0], fileUrl: index[0].fileUrl.replace("cdn.blox.my", "evil.example") }],
    [...index, { ...index[0], month: 9, fileUrl: "https://cdn.blox.my/attestations/2026/Blox Attestation Report-2026-09-September.pdf" }],
  ])("rejects changed, ambiguous, malformed or newer unreviewed discovery: %j", async (payload) => {
    await expect(verifyMyrcIndexJson(JSON.stringify(payload), manifest)).rejects.toThrow();
  });

  it("rejects altered PDF content even at the reviewed length", async () => {
    const altered = new Uint8Array(bytes);
    altered[altered.length - 1] ^= 1;
    installReport({ pdf: altered });
    await expect(fetchReport()).rejects.toThrow(/SHA-256/);
  });

  it("rejects an artifact length mismatch and a redirect to an unreviewed host", async () => {
    installReport({ pdf: bytes.subarray(0, bytes.length - 1) });
    await expect(fetchReport()).rejects.toThrow(/byte length/);
    installReport({ finalUrl: "https://evil.example/report.pdf" });
    await expect(fetchReport()).rejects.toThrow();
  });

  it("allows exactly three cents, not four cents or a relative-tolerance escape", () => {
    const options = MYRC_INDEPENDENT_ASSURANCE_PROFILE.reconciliation;
    expect(reconcileIndependentAssuranceManifest(manifest, options).reportedAssetDifference).toBe("0.03");
    expect(() => reconcileIndependentAssuranceManifest({ ...manifest, reportedAssetTotal: "1800903.73" }, options)).toThrow();
    expect(() => reconcileIndependentAssuranceManifest({
      ...manifest, assets: [{ code: "cash", label: "cash", amount: "1.03" }], computedAssetTotal: "1.03", reportedAssetTotal: "1.00",
    }, options)).toThrow();
  });

  it("rejects aggregate liability mismatch and retains observed reserve shortfall as measured bad state", async () => {
    expect(() => reconcileIndependentAssuranceManifest({ ...manifest, liabilities: [{ ...manifest.liabilities[0], amount: "1800903.75" }] }, MYRC_INDEPENDENT_ASSURANCE_PROFILE.reconciliation)).toThrow();
    vi.spyOn(assurance, "getIndependentAssuranceManifest").mockReturnValue({ ...artifactManifest,
      liabilities: [{ ...manifest.liabilities[0], amount: "1801000" }], reportedLiabilityTotal: "1801000",
    });
    installReport();
    const result = await fetchReport();
    expect(result.metadata?.collateralizationRatio).toBeLessThan(1);
    expect(result.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "reserve-undercollateralized", effect: "degraded" })]));
  });

  it("rejects a new unclassified positive asset and an AUP report through the independent binding", async () => {
    vi.spyOn(assurance, "getIndependentAssuranceManifest").mockReturnValue({ ...artifactManifest,
      assets: [...manifest.assets, { code: "unreviewed", label: "New asset", amount: "1" }],
      computedAssetTotal: "1800904.77", reportedAssetTotal: "1800904.77",
    });
    installReport({ index: index.map((row, i) => i === 0 ? { ...row, reservedAmount: 180090477 } : row) });
    await expect(fetchReport()).rejects.toThrow(/unknown positive asset/);
    vi.spyOn(assurance, "getIndependentAssuranceManifest").mockReturnValue({ ...artifactManifest, assuranceTier: "agreed-upon-procedures", conclusion: "agreed-upon-procedures" });
    await expect(fetchReport()).rejects.toThrow();
    expect(IndependentAssuranceManifestSchema.safeParse({ ...manifest, assuranceTier: "independent-assurance", conclusion: "agreed-upon-procedures" }).success).toBe(false);
  });
});
