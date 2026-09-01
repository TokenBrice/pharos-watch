import { describe, expect, it } from "vitest";
import {
  extractCensusRows,
  findDexCensusProviderDrift,
  formatDrift,
} from "../ci/check-dex-census-provider-drift";

const SPIKO_SOROBAN = "CDGSC6BA4TCAOVSFQCUEHDMOIIHYYVNYBT6YEARS4MX3ITAHUINVGQHX";

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
  it("reads both a wrangler --json envelope and a bare row array", () => {
    expect(extractCensusRows(wranglerDump([censusRow()]))).toHaveLength(1);
    expect(extractCensusRows([censusRow()])).toHaveLength(1);
    expect(extractCensusRows({ results: [censusRow()] })).toHaveLength(1);
    expect(extractCensusRows(null)).toEqual([]);
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
        }),
      ]),
    );

    expect(findDexCensusProviderDrift(rows).drift).toEqual([]);
  });

  it("ignores rows for deployments the registry no longer tracks", () => {
    const rows = extractCensusRows(
      wranglerDump([
        censusRow({ contract_address: "CBOOCGZSVRSZFRE4U2NWR2B4RXYVJWRCBTGOUD2JPI2TDJPWMTJX7FZP" }),
      ]),
    );
    const report = findDexCensusProviderDrift(rows, new Set());

    expect(report.scannedRowCount).toBe(1);
    expect(report.trackedRowCount).toBe(0);
    expect(report.drift).toEqual([]);
  });

  it("ignores malformed provider payloads, which the census classifier already quarantines", () => {
    const rows = extractCensusRows(wranglerDump([censusRow({ provider_set_json: "{bad" })]));

    expect(rows[0]?.persistedProviders).toBeNull();
    expect(findDexCensusProviderDrift(rows).drift).toEqual([]);
  });
});
