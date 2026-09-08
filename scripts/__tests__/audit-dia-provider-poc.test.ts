import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse } from "@shared/test-utils/mock-fetch";
import {
  parseDiaQuotation,
  parseArgs,
  runDiaProviderPocAudit,
  runCli,
  selectDiaProbeTargets,
  type DiaAuditReport,
} from "../maintenance/audit-dia-provider-poc";
import type { PriceSourceDepthAudit } from "../maintenance/audit-price-source-depth";
import { createTempRepoTracker } from "./helpers/test-state";
import { diaAuditRow } from "./audit-dia-provider-poc.test-support";

const { makeRoot, cleanup } = createTempRepoTracker("dia-provider-poc");
afterEach(cleanup);

function makeAudit(): Pick<PriceSourceDepthAudit, "rows"> {
  return { rows: [
    diaAuditRow(),
    diaAuditRow({ coinId: "beta-usd", symbol: "BETA", name: "Beta USD", marketCapUsd: 250,
      priceConfidence: "high", primaryTrust: "high", consensusSources: ["coingecko", "pyth", "kraken"] }),
  ] };
}

describe("audit-dia-provider-poc", () => {
  it.each([
    {
      argv: [],
      expected: { inputPath: null, limit: 100, maxContractsPerCoin: 1, format: "markdown", reportPath: null },
    },
    {
      argv: ["--input", "audit.json", "--limit", "12", "--max-contracts-per-coin", "3", "--json", "--report", "reports/dia.json"],
      expected: { inputPath: "audit.json", limit: 12, maxContractsPerCoin: 3, format: "json", reportPath: "reports/dia.json" },
    },
  ])("accepts probe/output option combination %#", ({ argv, expected }) => {
    expect(parseArgs(argv)).toMatchObject(expected);
  });

  it("preserves legacy optional values and strict format flags", () => {
    expect(parseArgs(["--input"])).toMatchObject({ inputPath: null });
    expect(parseArgs(["--report"])).toMatchObject({ reportPath: null });
    expect(() => parseArgs(["--markdown"])).toThrow("Unknown argument: --markdown");
    expect(() => parseArgs(["--unknown"])).toThrow("Unknown argument: --unknown");
  });

  it("writes JSON through the shared report runner", async () => {
    const cwd = makeRoot();
    writeFileSync(join(cwd, "audit.json"), JSON.stringify(makeAudit()), "utf8");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    let writes: string[] = [];
    try {
      await expect(
        runCli(["--input", "audit.json", "--json", "--report", "reports/dia.json"], cwd),
      ).resolves.toBe(0);
      writes = stdout.mock.calls.map(([value]) => String(value));
    } finally {
      stdout.mockRestore();
    }

    expect(JSON.parse(readFileSync(join(cwd, "reports/dia.json"), "utf8"))).toMatchObject({
      source: "dia-audit-only",
      targetCount: 0,
      checkedCount: 0,
    });
    expect(writes).toEqual([`Wrote DIA provider POC audit to ${join(cwd, "reports/dia.json")}\n`]);
  });

  it("selects below-target rows by market cap and exact supported contracts only", () => {
    const coinMetaById = new Map([
      ["alpha-usd", {
        contracts: [
          { chain: "ethereum", address: "0xAlpha", decimals: 18 },
          { chain: "near", address: "alpha.near", decimals: 24 },
        ],
      }],
      ["beta-usd", {
        contracts: [{ chain: "ethereum", address: "0xBeta", decimals: 18 }],
      }],
    ]);

    expect(selectDiaProbeTargets(makeAudit(), { coinMetaById })).toEqual({
      skippedNoSupportedContractCount: 0,
      targets: [{
        stablecoinId: "alpha-usd",
        symbol: "ALPHA",
        name: "Alpha USD",
        marketCapUsd: 500,
        pharosPrice: 1,
        currentSourceCount: 2,
        currentSources: ["coingecko", "pyth"],
        chain: "ethereum",
        diaBlockchain: "Ethereum",
        address: "0xAlpha",
      }],
    });
  });

  it("parses DIA quotation payloads without symbol fallback", () => {
    expect(parseDiaQuotation({
      Symbol: "USDC",
      Name: "USD Coin",
      Address: "0xA0b",
      Blockchain: "Ethereum",
      Price: 0.9999,
      PriceYesterday: 1,
      VolumeYesterdayUSD: 123,
      Time: "2026-05-12T00:00:00Z",
      Source: "diadata.org",
      Signature: "0xsig",
    })).toEqual({
      symbol: "USDC",
      name: "USD Coin",
      address: "0xA0b",
      blockchain: "Ethereum",
      price: 0.9999,
      priceYesterday: 1,
      volumeYesterdayUsd: 123,
      time: "2026-05-12T00:00:00Z",
      source: "diadata.org",
      signature: "0xsig",
    });
  });

  it("runs an audit-only probe with mocked DIA responses", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      Symbol: "ALPHA",
      Name: "Alpha USD",
      Address: "0xAlpha",
      Blockchain: "Ethereum",
      Price: 0.998,
      VolumeYesterdayUSD: 100_000,
      Time: "2026-05-12T00:00:00Z",
      Source: "diadata.org",
      Signature: "0xsig",
    }));

    const report = await runDiaProviderPocAudit({
      audit: makeAudit() as PriceSourceDepthAudit,
      nowMs: Date.parse("2026-05-12T00:30:00Z"),
      fetchImpl: fetchImpl as typeof fetch,
      coinMetaById: new Map([
        ["alpha-usd", {
          contracts: [{ chain: "ethereum", address: "0xAlpha", decimals: 18 }],
        }],
      ]),
    });

    expect(report).toMatchObject<Partial<DiaAuditReport>>({
      source: "dia-audit-only",
      targetCount: 1,
      checkedCount: 1,
      hitCount: 1,
      freshHitCount: 1,
      agreementWithin50BpsCount: 1,
      skippedNoSupportedContractCount: 0,
    });
    expect(report.results[0]).toMatchObject({
      stablecoinId: "alpha-usd",
      ok: true,
      diaPrice: 0.998,
      diaAgeSec: 1800,
      timestampQuality: "fresh",
      sourceMetadata: {
        source: "diadata.org",
        signaturePresent: true,
      },
    });
    expect(report.results[0]?.agreementBps).toBeCloseTo(20);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.diadata.org/v1/assetQuotation/Ethereum/0xAlpha",
      expect.objectContaining({
        headers: { Accept: "application/json" },
      }),
    );
  });

  it("records HTTP, transport and JSON failures while continuing to later targets", async () => {
    const rows = ["http", "transport", "json", "valid"].map((coinId) => diaAuditRow({ coinId }));
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockRejectedValueOnce(new Error("transport failed"))
      .mockResolvedValueOnce(new Response("{", { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({ Price: 1, Time: "2026-05-12T00:00:00Z" }));
    const report = await runDiaProviderPocAudit({
      audit: { rows } as PriceSourceDepthAudit, fetchImpl, nowMs: Date.parse("2026-05-12T00:00:00Z"),
      coinMetaById: new Map(rows.map((row) => [row.coinId, { contracts: [{ chain: "ethereum", address: row.coinId, decimals: 18 }] }])),
    });
    expect(report).toMatchObject({ targetCount: 4, checkedCount: 4, hitCount: 1, freshHitCount: 1, agreementWithin50BpsCount: 1 });
    expect(report.results.map((row) => [row.stablecoinId, row.ok, row.httpStatus])).toEqual([
      ["http", false, 503], ["transport", false, null], ["json", false, null], ["valid", true, 200],
    ]);
    expect(report.results[1].error).toBe("transport failed");
    expect(report.results[2].error).toEqual(expect.any(String));
    expect(report.results[2].error).not.toBe("");
  });

  it("separates missing and invalid timestamps from the exact freshness boundary", async () => {
    const rows = ["missing", "invalid", "boundary", "stale"].map((coinId) => diaAuditRow({ coinId }));
    const times = [undefined, "not-a-date", "2026-05-12T00:00:00Z", "2026-05-11T23:59:59Z"];
    const fetchImpl = vi.fn<typeof fetch>();
    for (const Time of times) fetchImpl.mockResolvedValueOnce(jsonResponse({ Price: 1, Time }));
    const report = await runDiaProviderPocAudit({
      audit: { rows } as PriceSourceDepthAudit, fetchImpl, nowMs: Date.parse("2026-05-12T01:00:00Z"),
      coinMetaById: new Map(rows.map((row) => [row.coinId, { contracts: [{ chain: "ethereum", address: row.coinId, decimals: 18 }] }])),
    });
    expect(report).toMatchObject({ checkedCount: 4, hitCount: 4, freshHitCount: 1 });
    expect(report.results.map((row) => [row.timestampQuality, row.diaAgeSec])).toEqual([
      ["missing", null], ["invalid", null], ["fresh", 3600], ["stale", 3601],
    ]);
  });

  it("excludes unusable prices and includes only agreement at or below 50 bps", async () => {
    // A reference price of 200 makes the 50-bps boundary exactly representable.
    const rows = ["zero", "missing", "boundary", "outside"].map((coinId) => diaAuditRow({ coinId, price: 200 }));
    const fetchImpl = vi.fn<typeof fetch>();
    for (const Price of [0, undefined, 201, 201.01]) fetchImpl.mockResolvedValueOnce(jsonResponse({ Price, Time: "2026-05-12T00:00:00Z" }));
    const report = await runDiaProviderPocAudit({
      audit: { rows } as PriceSourceDepthAudit, fetchImpl, nowMs: Date.parse("2026-05-12T00:00:00Z"),
      coinMetaById: new Map(rows.map((row) => [row.coinId, { contracts: [{ chain: "ethereum", address: row.coinId, decimals: 18 }] }])),
    });
    expect(report).toMatchObject({ checkedCount: 4, hitCount: 2, freshHitCount: 2, agreementWithin50BpsCount: 1 });
    expect(report.results.map((row) => row.ok)).toEqual([false, false, true, true]);
    expect(report.results[2].agreementBps).toBe(50);
    expect(report.results[3].agreementBps).toBeGreaterThan(50);
  });
});
