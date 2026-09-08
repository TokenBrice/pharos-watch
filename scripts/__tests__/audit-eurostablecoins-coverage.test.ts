import { expect, it } from "vitest";
import { buildAudit, loadSupportedChains } from "../maintenance/audit-eurostablecoins-coverage";

it("loads supported deployments from the real chain registry", () => {
  expect(loadSupportedChains().has("polygon-zkevm")).toBe(true);
  expect(loadSupportedChains().has("fixture-unsupported")).toBe(false);
});

it("normalizes symbols and partitions readable, pre-launch and cemetery matches", () => {
  const audit = buildAudit({
    generatedAt: "2026-09-01T00:00:00.000Z", apiUrl: "fixture",
    supportedChains: new Set(["ethereum", "polygon"]),
    externalCoins: [
      { ticker: " eur ", chains: [" Ethereum ", "POLYGON", "fixture-unsupported"], market_status: "market_traded", treasury_held: 10, total_supply: 100 },
      { ticker: "PRE" }, { ticker: "DEAD" }, { ticker: "ABSENT" },
      { ticker: "SAME", market_status: "limited_trading", treasury_held: 0 },
    ],
    localCoins: [
      { id: "eur-pre", symbol: "EUR", status: "pre-launch" },
      { id: "eur-live", symbol: " eur ", status: "active", marketAvailability: "limited-trading", contracts: [{ chain: "ETHEREUM" }] },
      { id: "pre", symbol: "pre", status: "pre-launch" },
      { id: "same", symbol: "same", marketAvailability: "limited-trading" },
    ],
    deadCoins: [{ id: "dead", symbol: " dead " }],
  });
  expect(audit.summary).toEqual({ externalCoinCount: 5, localReadableMatchCount: 2, missingReadableCount: 2, cemeteryOnlyCount: 1, marketAvailabilityGapCount: 1, supportedContractGapCount: 1, unsupportedContractGapCount: 1, treasuryHeldSignalCount: 1 });
  expect(audit.missingReadable.map((row) => row.ticker)).toEqual(["PRE", "ABSENT"]);
  expect(audit.cemeteryOnly.map((row) => row.deadIds)).toEqual([["dead"]]);
  expect(audit.duplicateLocalSymbols).toEqual([{ ticker: " eur ", localIds: ["eur-pre", "eur-live"] }]);
  expect(audit.marketAvailabilityGaps).toEqual([{ ticker: " eur ", localId: "eur-live", localValue: "limited-trading", externalValue: "market-traded" }]);
  expect(audit.supportedContractGaps).toEqual([{ ticker: " eur ", localId: "eur-live", chains: ["polygon"] }]);
  expect(audit.unsupportedContractGaps).toEqual([{ ticker: " eur ", localId: "eur-live", chains: ["fixture-unsupported"] }]);
  expect(audit.treasuryHeldRows).toEqual([{ ticker: " eur ", localId: "eur-live", treasuryHeld: 10, totalSupply: 100 }]);
});
