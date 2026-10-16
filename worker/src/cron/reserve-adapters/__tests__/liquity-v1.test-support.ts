import type { AdapterNetworkSpec, AdapterRpcValue } from "./reserve-adapter.test-support";

export const TROVE_MANAGER = "0xA39739EF8b0231DbFA0DcdA07d7e29faAbCf4bb2";
const PRICE_FEED = "0x4c517D4e2C851CA76d7eC94B805269Df0f2201De";
const COLLATERAL_SELECTOR = "0x887105d3";
const DEBT_SELECTOR = "0x795d26c3";
const MCR_SELECTOR = "0x794e5724";
const GET_TCR_SELECTOR = "0xb82f263d";
const FETCH_PRICE_SELECTOR = "0x0fdb11cf";
const REDEMPTION_RATE_SELECTOR = "0xc52861f2";
export const WAD = 10n ** 18n;
const MCR_RAW = 11n * WAD / 10n;
const WETH_ETHEREUM_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const ETH_PRICE_URL = `https://coins.llama.fi/prices/current/ethereum:${WETH_ETHEREUM_ADDRESS.toLowerCase()}`;
export const NOW_SEC = 1_800_000_000;

interface SystemState {
  collateral: bigint | null;
  debt: bigint | null;
  price: bigint | null;
  mcr: bigint | null;
  tcrReadable: boolean;
}

const DEFAULT_STATE: SystemState = {
  collateral: 200n * WAD,
  debt: 150_000n * WAD,
  price: 2_000n * WAD,
  mcr: MCR_RAW,
  tcrReadable: true,
};

export function v1Network(
  overrides: Partial<SystemState> = {},
  ethPrice: number | null = 2_000,
  rateBps: number | null = 50,
): AdapterNetworkSpec {
  const state = { ...DEFAULT_STATE, ...overrides };
  const rateRaw = rateBps == null ? null : BigInt(rateBps) * WAD / 10_000n;
  const rpc: Record<string, AdapterRpcValue> = {
    [`ethereum:${PRICE_FEED}:${FETCH_PRICE_SELECTOR}`]: state.price,
    [`ethereum:${TROVE_MANAGER}:${COLLATERAL_SELECTOR}`]: state.collateral,
    [`ethereum:${TROVE_MANAGER}:${DEBT_SELECTOR}`]: state.debt,
    [`ethereum:${TROVE_MANAGER}:${MCR_SELECTOR}`]: state.mcr,
    [`ethereum:${TROVE_MANAGER}:${GET_TCR_SELECTOR}`]: (call) => {
      if (!state.tcrReadable || state.collateral == null || state.debt == null || state.debt === 0n) return null;
      const priceArg = BigInt(`0x${call.data.slice(GET_TCR_SELECTOR.length)}`);
      return (state.collateral * priceArg) / state.debt;
    },
    [`ethereum:${TROVE_MANAGER}:${REDEMPTION_RATE_SELECTOR}`]: rateRaw,
  };
  return {
    rpc,
    json: {
      [ETH_PRICE_URL]: ethPrice == null
        ? { coins: {} }
        : {
            coins: {
              [`ethereum:${WETH_ETHEREUM_ADDRESS.toLowerCase()}`]: {
                price: ethPrice,
                timestamp: NOW_SEC,
                confidence: 1,
              },
            },
          },
    },
  };
}
