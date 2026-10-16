import type { FraxBalanceSheetResponse } from "../frax";

export const BALANCE_SHEET_ENDPOINT = "https://api.frax.finance/v2/frax/balance-sheet/latest";

export const BALANCE_SHEET_SAMPLE: FraxBalanceSheetResponse = {
  asOfTimestamp: "2026-04-04T13:03:47.000Z",
  totalAssets: 123_010_191,
  assets: [
    { tokenSymbol: "USDC", totalValueUsd: 415_981.93, category: "asset:owned:usd" },
    { tokenSymbol: "USTB", totalValueUsd: 17_676.98, category: "asset:owned:usd" },
    { tokenSymbol: "WTGXX", totalValueUsd: 51_149_947.74, category: "asset:owned:usd" },
    { tokenSymbol: "WTGXX", totalValueUsd: 65_022.57, category: "asset:owned:usd" },
    { tokenSymbol: "BUIDL", totalValueUsd: 10_000, category: "asset:owned:usd" },
    { tokenSymbol: "USTB", totalValueUsd: 45_504_345.53, category: "asset:owned:usd" },
    { tokenSymbol: "WTGXX", totalValueUsd: 8_265_342.81, category: "asset:owned:usd" },
    { tokenSymbol: "BUIDL", totalValueUsd: 15_581_870.39, category: "asset:owned:usd" },
    { tokenSymbol: "USDB", totalValueUsd: 2_000_003.7, category: "asset:owned:usd" },
  ],
};
