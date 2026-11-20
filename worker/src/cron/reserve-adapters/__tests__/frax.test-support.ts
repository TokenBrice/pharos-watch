import type { FraxBalanceSheetResponse } from "../frax";

export const BALANCE_SHEET_ENDPOINT = "https://api.frax.finance/v2/frax/balance-sheet/latest";

const ETHEREUM_FRAX = "0x853d955acef822db058eb8505911ed77f175b99e";

export const FERRY_ROWS = [
  ["arbitrum", "0x5a9bef8cea603aac78a523fb245c1a9264d50706", "0x17fc002b466eec40dae837fc4be5c67993ddbd6f"],
  ["avalanche", "0x5dff474cea8a1fa929ac9a3ce2550376af11d2a8", "0xd24c2ad096400b6fbcd2ad8b24e7acbc21a1da64"],
  ["boba", "0x5cba95f0c97cf281c37ca7a24d68578ea60d0dd0", "0x7562f525106f5d54e891e005867bf489b5988cd9"],
  ["bsc", "0x10ef54f944639764d2d5efa272262f06cfaf09ae", "0x90c97f71e18723b0cf0dfa30ee176ab653e89f40"],
  ["ethereum", "0x06fa869caa1160754c6a0b744da6454c5ea325d4", ETHEREUM_FRAX],
  ["ethereum", "0x32ddf80508cfd8fed8abe375582fc7cfd20372c4", ETHEREUM_FRAX],
  ["ethereum", "0x3ef1d856ea62a2292b8690855042095a7ac48b4b", ETHEREUM_FRAX],
  ["ethereum", "0x43959a388603dcb6b02ca084a55d4c7f3b442c57", ETHEREUM_FRAX],
  ["ethereum", "0x6ac96f65156281a9383455d704b58a74ea9c9ec4", ETHEREUM_FRAX],
  ["ethereum", "0x85c5f05ae4cb68190c695a22b292c3ba90696128", ETHEREUM_FRAX],
  ["ethereum", "0x86e71075e55f0aad27d700017e0783458310c98a", ETHEREUM_FRAX],
  ["ethereum", "0xa381d58e96ec3818c825e1fb264099448945cf8b", ETHEREUM_FRAX],
  ["ethereum", "0xdae210bfb0cf8c81edb4b459e2e0ba14d553e2d9", ETHEREUM_FRAX],
  ["ethereum", "0xfb788f9e20ef426a32a67986654750172a6c1788", ETHEREUM_FRAX],
  ["fantom", "0x088be716eca24b143fcc9ed06c6ae9977a469cce", "0xdc301622e621166bd8e82f2ca0a26c13ad0be355"],
  ["optimism", "0xb781fcac4b8ef06891f9bad7db9c178b1ce67967", "0x2e3d870790dc77a83dd1d18184acc7439a53f475"],
  ["polygon", "0x6f7f18c15b97dc9fac48ae7f986989f97d25dbc7", "0x45c32fa6df82ead1e2ef74d17b76547eddfaff89"],
  ["polygon_zkevm", "0xeabd7625056bbd2c260f90d0b08759c69d971a5b", "0xff8544fed5379d9ffa8d47a74ce6b91e632ac44d"],
  ["zksync", "0x31cda619b96c96bd7ed8463418e0f65c1ffc8d0a", "0xb4c1544cb4163f4c2eca1ae9ce999f63892d912a"],
].map(([chain, address, tokenAddress]) => ({
  chain, address, tokenAddress, tokenSymbol: "FRAX", category: "asset:owned:frax", totalValueUsd: 0, tokenQuantity: 0, tokenQuantityE18: "0",
}));

export const BALANCE_SHEET_SAMPLE: FraxBalanceSheetResponse = {
  asOfTimestamp: "2026-04-04T13:03:47.000Z",
  totalAssets: 123_010_191,
  assets: [
    ...FERRY_ROWS,
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
