import usdx from "@shared/data/stablecoins/coins/usdx-kava.json";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import m0SolanaCapture from "./m0-solana-local-2026-10-21.json";
import type { AdapterNetworkSpec } from "../reserve-adapter.test-support";
import type { AdapterCorpusCase } from "../adapter-corpus.test-support";
import { MEGAUSD_BACKING, MEGAUSD_URL } from "../megausd-custody.test-support";
import { NOW_SEC as LIQUITY_NOW_SEC, v1Network } from "../liquity-v1.test-support";
import { ARCHIVE_TOTAL_COLLATERAL_URL, BLOCK_TIME_SEC as KAVA_BLOCK_TIME_SEC, TOTAL_COLLATERAL_URL, kavaNetwork } from "../kava-cdp.test-support";
import { BALANCE_SHEET_ENDPOINT, BALANCE_SHEET_SAMPLE } from "../frax.test-support";
import { UNITED_POR_ENDPOINT, UNITED_POR_PAYLOAD } from "../united-por.test-support";
import { ZEPHYR_ENDPOINT, ZEPHYR_CAPTURE } from "../zephyr-scanner.test-support";
import { MONOLITH_LENDER_COIN, MONOLITH_LENDER_NOW_SEC, MONOLITH_LENDER_PIN, pinnedNetwork } from "../monolith-lender.test-support";

const BLAST_YIELD_MANAGER = "0xa230285d5683c74935ad14c446e137c8c8828438";
const BLAST_USDB = "0x4300000000000000000000000000000000000003";
const BLAST_SUPPLY_RPC = { [`${BLAST_USDB}:0x18160ddd`]: 100n * 10n ** 18n, [`${BLAST_USDB}:0x313ce567`]: 18n };
// usdb-blast is frozen; the corpus replays the adapter with its archived config.
const BLAST_USDB_COIN = {
  id: "usdb-blast", name: "USDB Blast", symbol: "USDB",
  liveReservesConfig: {
    adapter: "blast-usdb-yield-manager", version: 1, semantics: "single-asset", breakerScope: "usdb-blast",
    inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" } },
    params: { yieldManagerAddress: BLAST_YIELD_MANAGER, supplyChain: "blast", supplyTokenAddress: BLAST_USDB, rpcUrl: "https://ethereum-rpc.publicnode.com", supplyRpcUrl: "https://rpc.blast.io" },
  },
} as unknown as StablecoinMeta;
export const SUPERSTATE_LIQUIDITY_URL = "https://api.superstate.com/v1/funds/liquidity";
const SUPERSTATE_ORACLE = "0x289B5036cd942e619E1Ee48670F98d214E745AAC";
const SUPERSTATE_TOKEN = "0x43415eB6ff9DB7E26A15b704e7A3eDCe97d31C4e";
const SUPERSTATE_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const SUPERSTATE_LATEST_ROUND = `0x${[1n, 1_015_000_000n, 1_757_000_000n, 1_757_000_000n, 1n].map((w) => w.toString(16).padStart(64, "0")).join("")}`;

// Synthetic RPC values retained from superstate-liquidity.test.ts.
function superstateNetwork(payload: unknown): AdapterNetworkSpec {
  return {
    json: { [SUPERSTATE_LIQUIDITY_URL]: payload },
    rpc: {
      [`${SUPERSTATE_TOKEN}:decimals()`]: 18n, [`${SUPERSTATE_TOKEN}:totalSupply()`]: 1_000_000n * 10n ** 18n,
      [`${SUPERSTATE_ORACLE}:decimals()`]: 8n, [`${SUPERSTATE_ORACLE}:latestRoundData()`]: SUPERSTATE_LATEST_ROUND,
      [`${SUPERSTATE_USDC}:balanceOf(address)`]: 9_310_000_000000n,
    },
    block: { number: 23_000_000, timestamp: 1_757_000_000 },
  };
}

// Replay the original finalized bank through the real registered RPC boundary.
function m0SolanaNetwork(missingGlobal = false): AdapterNetworkSpec {
  const addresses = m0SolanaCapture.request.params[0] as string[];
  const captured = new Map(addresses.map((address, i) => [address, m0SolanaCapture.response.result.value[i]] as const));
  const respond = async (request: Request) => {
    const rpc = await request.json() as { method: string; params: unknown[] };
    if (rpc.method === "getBlockTime") return { result: m0SolanaCapture.block.timestamp };
    if (rpc.method !== "getMultipleAccounts") throw new Error(`Unexpected captured Solana RPC: ${rpc.method}`);
    return {
      result: {
        context: m0SolanaCapture.response.result.context,
        value: (rpc.params[0] as string[]).map((address) =>
          missingGlobal && address === "AiiXk9Rztiv9E72Ying8byGzvxnVmyaeunysYEmvG1NU" ? null : captured.get(address) ?? null),
      },
    };
  };
  return {
    chains: { solana: m0SolanaCapture.rpcUrl },
    json: Object.fromEntries([m0SolanaCapture.rpcUrl, "https://api.mainnet-beta.solana.com", "https://api.mainnet.solana.com", "https://solana-rpc.publicnode.com"].map((url) => [url, respond])),
  };
}

export type NumericCorpusFixture = Omit<AdapterCorpusCase, "coin" | "drift"> & {
  coin?: StablecoinMeta;
  drift: AdapterCorpusCase["drift"] & { error?: RegExp; nowSec?: number };
};

export const NUMERIC_CORPUS_FIXTURES = {
  "monolith-lender": {
    coinId: "swanusd-swan", coin: MONOLITH_LENDER_COIN, nowSec: MONOLITH_LENDER_NOW_SEC, network: pinnedNetwork(),
    drift: { label: "the Lender's own PSM sell accounting read is dropped", network: pinnedNetwork({ [`ethereum:${MONOLITH_LENDER_PIN.lender}:freePsmAssets()`]: null }), outcome: "error" as const, error: /free-psm-assets/ },
  },
  "m0-solana-wrapper": {
    coinId: "usdk-kast", nowSec: m0SolanaCapture.block.timestamp, network: m0SolanaNetwork(),
    drift: { label: "the identity-bound local extension global account disappears", network: m0SolanaNetwork(true), outcome: "error" as const, error: /global/ },
  },
  "blast-usdb-yield-manager": {
    coinId: "usdb-blast", coin: BLAST_USDB_COIN, nowSec: 1_788_912_032,
    network: { rpc: { [`ethereum:${BLAST_YIELD_MANAGER}:0xd4c3eea0`]: 120n * 10n ** 18n, ...BLAST_SUPPLY_RPC } },
    drift: { label: "the manager totalValue read is unavailable", network: { rpc: { [`ethereum:${BLAST_YIELD_MANAGER}:0xd4c3eea0`]: null, ...BLAST_SUPPLY_RPC } }, outcome: "error" as const, error: /totalValue/ },
  },
  "megausd-custody": {
    coinId: "usdm-mega",
    coin: { id: "usdm-mega", name: "MegaUSD", ticker: "USDM", liveReservesConfig: { adapter: "megausd-custody", version: 1, semantics: "collateral-mix", inputs: { primary: { kind: "http-json", url: MEGAUSD_URL } } } } as unknown as StablecoinMeta,
    nowSec: Math.floor(Date.parse("2026-09-09T16:00:00Z") / 1000),
    network: { json: { [MEGAUSD_URL]: MEGAUSD_BACKING } },
    drift: { label: "the custody endpoint returns HTTP 500", network: { json: { [MEGAUSD_URL]: { status: 500, body: "upstream unavailable" } } }, outcome: "error" as const, error: /500/ },
  },
  "liquity-v1": {
    coinId: "lusd-liquity", nowSec: LIQUITY_NOW_SEC, network: v1Network(),
    drift: { label: "the batched TroveManager read is unavailable", network: { ...v1Network(), multicall: false }, outcome: "error" as const },
  },
  "kava-cdp": {
    coinId: "usdx-kava",
    coin: { id: "usdx-kava", name: "USDX", symbol: "USDX", liveReservesConfig: structuredClone(usdx.liveReservesConfig) } as unknown as StablecoinMeta,
    nowSec: KAVA_BLOCK_TIME_SEC, network: kavaNetwork(),
    drift: {
      label: "the required totalCollateral endpoint returns HTTP 503 on every configured LCD origin",
      network: kavaNetwork({ [TOTAL_COLLATERAL_URL]: { status: 503, body: "upstream unavailable" }, [ARCHIVE_TOTAL_COLLATERAL_URL]: { status: 503, body: "upstream unavailable" } }),
      outcome: "error" as const, error: /503/,
    },
  },
  "frax-balance-sheet": {
    coinId: "frax-frax", nowSec: 1_775_307_827 + 3_600, network: { json: { [BALANCE_SHEET_ENDPOINT]: BALANCE_SHEET_SAMPLE } },
    drift: { label: "the balance-sheet response loses its asset rows", nowSec: 1_775_657_027, network: { json: { [BALANCE_SHEET_ENDPOINT]: { ...BALANCE_SHEET_SAMPLE, assets: [] } } }, outcome: "error" as const, error: /missing or empty assets/ },
  },
  "united-por": {
    coinId: "u-united-stables", nowSec: Math.floor(Date.parse("2026-07-09T16:10:01.559Z") / 1000) + 3_600,
    network: { json: { [UNITED_POR_ENDPOINT]: UNITED_POR_PAYLOAD } },
    drift: { label: "the required catalog PoR endpoint returns HTTP 503", network: { json: { [UNITED_POR_ENDPOINT]: { status: 503, body: "upstream down" } } }, outcome: "error" as const, error: /503/ },
  },
  "superstate-liquidity": {
    coinId: "ustb-superstate", nowSec: 1_757_000_100,
    network: superstateNetwork({ USTB: { circle_usd_available_amount: "2696887.17", usdc_redemption_idle_balance: "3412248.944618" } }),
    drift: { label: "the optional liquidity payload renames circle_usd_available_amount", network: superstateNetwork({ USTB: { usdc_redemption_idle_balance: "3412248.944618" } }), outcome: "info" as const, warningCode: "superstate-liquidity-unavailable" },
  },
  "zephyr-scanner": {
    coinId: "zsd-zephyr-protocol", nowSec: 1_710_003_600, network: { json: { [ZEPHYR_ENDPOINT]: ZEPHYR_CAPTURE } },
    drift: {
      label: "the snapshot drops every circulating-supply encoding",
      network: { json: { [ZEPHYR_ENDPOINT]: { ...ZEPHYR_CAPTURE, results: [{ ...ZEPHYR_CAPTURE.results[0]!, on_chain: { ...ZEPHYR_CAPTURE.results[0]!.on_chain, zsd_circ: undefined, zsd_circ_atoms: undefined }, raw: { ...ZEPHYR_CAPTURE.results[0]!.raw, num_stables: undefined, liabilities: undefined } }] } } },
      outcome: "error" as const, error: /ZSD supply USD|zsd_circ/,
    },
  },
} satisfies Record<string, NumericCorpusFixture>;
