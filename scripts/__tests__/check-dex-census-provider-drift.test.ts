import { describe, expect, it } from "vitest";
import {
  extractCensusRows,
  findDexCensusProviderDrift,
  formatDrift,
} from "../ci/check-dex-census-provider-drift";

const SPIKO_SOROBAN = "CDGSC6BA4TCAOVSFQCUEHDMOIIHYYVNYBT6YEARS4MX3ITAHUINVGQHX";
const trackedSpiko = new Set([`safo-spiko-usd|stellar:${SPIKO_SOROBAN}`]);

function wranglerDump(rows: readonly Record<string, unknown>[]): unknown {
  return [{ results: rows, success: true, meta: { rows_read: rows.length } }];
}

function censusRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stablecoin_id: "safo-spiko-usd",
    chain: "stellar",
    contract_address: SPIKO_SOROBAN,
    outcome: "provider_inaccessible",
    provider_set_json: "[]",
    reason: "No registered token-pool provider supports this chain",
    observed_at: 1_787_961_974,
    ...overrides,
  };
}

describe("dex census provider drift check", () => {
  it("normalizes all supported envelopes without losing row fields", () => {
    const expected = [{
      stablecoinId: "safo-spiko-usd",
      chain: "stellar",
      address: SPIKO_SOROBAN,
      outcome: "provider_inaccessible",
      persistedProviders: [],
      reason: "No registered token-pool provider supports this chain",
      observedAt: 1_787_961_974,
    }];
    expect(extractCensusRows(wranglerDump([censusRow()]))).toEqual(expected);
    expect(extractCensusRows([censusRow()])).toEqual(expected);
    expect(extractCensusRows({ results: [censusRow()] })).toEqual(expected);
    expect(extractCensusRows(null)).toEqual([]);
  });

  it("drops invalid identities and quarantines non-array or mixed provider payloads", () => {
    const rows = extractCensusRows([
      null, 12, "row",
      censusRow({ stablecoin_id: null }),
      censusRow({ chain: "" }),
      censusRow({ contract_address: 42 }),
      censusRow({ provider_set_json: '["aquarius"]' }),
      censusRow({ provider_set_json: '{"provider":"aquarius"}', observed_at: "yesterday", reason: null }),
      censusRow({ provider_set_json: '["aquarius",1]' }),
    ]);
    expect(rows).toEqual([
      {
        stablecoinId: "safo-spiko-usd", chain: "stellar", address: SPIKO_SOROBAN,
        outcome: "provider_inaccessible", persistedProviders: ["aquarius"],
        reason: "No registered token-pool provider supports this chain", observedAt: 1_787_961_974,
      },
      {
        stablecoinId: "safo-spiko-usd", chain: "stellar", address: SPIKO_SOROBAN,
        outcome: "provider_inaccessible", persistedProviders: null, reason: "", observedAt: null,
      },
      {
        stablecoinId: "safo-spiko-usd", chain: "stellar", address: SPIKO_SOROBAN,
        outcome: "provider_inaccessible", persistedProviders: null,
        reason: "No registered token-pool provider supports this chain", observedAt: 1_787_961_974,
      },
    ]);
    expect(findDexCensusProviderDrift(rows, trackedSpiko)).toEqual({
      scannedRowCount: 3, trackedRowCount: 3, drift: [],
    });
  });

  it("flags a tracked row whose empty provider set the registry now contradicts", () => {
    const report = findDexCensusProviderDrift(extractCensusRows(wranglerDump([censusRow()])));

    expect(report.trackedRowCount).toBe(1);
    expect(report.drift).toHaveLength(1);
    expect(report.drift[0]).toMatchObject({
      stablecoinId: "safo-spiko-usd",
      chain: "stellar",
      liveProviders: ["aquarius"],
    });
    expect(formatDrift(report.drift[0]!)).toContain("persists [] while the registry resolves [aquarius]");
  });

  it("passes rows that agree with the registry", () => {
    const rows = extractCensusRows(
      wranglerDump([
        censusRow({ provider_set_json: JSON.stringify(["aquarius"]) }),
        censusRow({
          stablecoin_id: "usdx-kava",
          chain: "osmosis",
          contract_address: "ibc/C78F65E1954A47FC1E56B4B34DB2C4B78C40B3A9D0BC6E4E97F00B4A1FF3C1A7",
          provider_set_json: '["osmosis-sqs"]',
        }),
      ]),
    );

    expect(findDexCensusProviderDrift(rows, new Set([
      ...trackedSpiko,
      "usdx-kava|osmosis:ibc/C78F65E1954A47FC1E56B4B34DB2C4B78C40B3A9D0BC6E4E97F00B4A1FF3C1A7",
    ])).drift).toEqual([]);
  });

  it("matches canonical EVM deployments but excludes different addresses and coins", () => {
    const address = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
    const rows = extractCensusRows([
      censusRow({ stablecoin_id: "test-usd", chain: "ethereum", contract_address: address.toUpperCase() }),
      censusRow({ stablecoin_id: "test-usd", chain: "ethereum", contract_address: `ethereum:${address}` }),
      censusRow({ stablecoin_id: "test-usd", chain: "ethereum", contract_address: "0x1111111111111111111111111111111111111111" }),
      censusRow({ stablecoin_id: "other-usd", chain: "ethereum", contract_address: address }),
    ]);
    const report = findDexCensusProviderDrift(rows, new Set([`test-usd|ethereum:${address}`]));
    expect(report.scannedRowCount).toBe(4);
    expect(report.trackedRowCount).toBe(2);
    expect(report.drift.map(({ stablecoinId, address }) => ({ stablecoinId, address }))).toEqual([
      { stablecoinId: "test-usd", address: address.toUpperCase() },
      { stablecoinId: "test-usd", address: `ethereum:${address}` },
    ]);
  });

  it("ignores malformed provider payloads, which the census classifier already quarantines", () => {
    const rows = extractCensusRows(wranglerDump([censusRow({ provider_set_json: "{bad" })]));

    expect(rows[0]?.persistedProviders).toBeNull();
    expect(findDexCensusProviderDrift(rows, trackedSpiko).drift).toEqual([]);
  });
});
