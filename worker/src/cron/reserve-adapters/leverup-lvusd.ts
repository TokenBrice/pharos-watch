import type { ReserveAdapterCoin } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { decodeStrictAddressWord } from "./abi-decode";
import { createAdapterIoLimiter } from "./concurrency";
import { pinnedBlockPlan } from "./evm-observation-plan";
import { fetchEvmBranchBalancesReserves } from "./evm-branch-balances";
import { makeOnchainCallers, requireOnchainInput } from "./helpers";
import type { AdapterContext, AdapterResult } from "./types";

const ADAPTER_KEY = "leverup-lvusd";
const TOKEN = "0xfd44b35139ae53fff7d8f2a9869c503d987f00d1";
const ISSUER = "0x135951057cfccca7e8ef87ee41318d670f723f68";
const TRANSPARENCY = "0x0ef8fd8f36cae470aff8b9d9bbd2e5f44fb23d51";
const VAULT = "0xc69d584b3118e94b3443cc6c67076281242fa704";
const USDC = "0x754704bc059f8c67012fed69bc8a327a5aafb603";
const RPC_URL = "https://rpc.monad.xyz";
const BRANCH_PARAMS = {
  rpcUrl: RPC_URL,
  // The designated-vault registry is verified at the same pinned block as the
  // reserve-token identities and balances; it is not a date-only roster proof.
  census: {
    kind: "onchain-registry",
    contract: TRANSPARENCY,
    selector: "0x97331bf9",
    maxAssets: 1,
    identity: "holder",
  },
  branches: [{
    name: "USDC liquidity-layer collateral",
    holder: VAULT,
    token: { chain: "monad", address: USDC, decimals: 6 },
    risk: "low",
    coinId: "usdc-circle",
    depType: "collateral",
  }],
  debtContract: TOKEN,
  debtSelector: "0x18160ddd",
  debtDecimals: 18,
};

/** The LVUSD-only registry is authoritative; LVMON and MON staking are excluded. */
export async function fetchLeverupLvusdReserves(
  coin: ReserveAdapterCoin,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  parseLiveReserveAdapterParams(ADAPTER_KEY, config.params);
  const input = requireOnchainInput(config.inputs.primary, ADAPTER_KEY);
  if (coin.id !== "lvusd-leverup" || input.chain !== "monad" ||
      !coin.contracts?.some((entry) => entry.chain === "monad" && entry.address.toLowerCase() === TOKEN)) {
    throw new Error(`${ADAPTER_KEY}: tracked token identity mismatch`);
  }
  const plan = await pinnedBlockPlan({
    chain: input.chain,
    signal,
    rpcUrl: RPC_URL,
    ctx: { ...ctx, ioLimiter: ctx?.ioLimiter ?? createAdapterIoLimiter(2) },
  });
  const calls = makeOnchainCallers(input, { signal, ctx: plan.ctx, rpcUrl: RPC_URL, timeoutMs: 12_000 });
  for (const [contract, selector, expected, label] of [
    [TOKEN, "0x8da5cb5b", ISSUER, "owner"],
    [ISSUER, "0x7ccd12d5", TRANSPARENCY, "transparency"],
    [VAULT, "0xf4325d67", USDC, "reserveToken"],
  ]) {
    if (decodeStrictAddressWord(await calls.raw(contract, selector)) !== expected) {
      throw new Error(`${ADAPTER_KEY}: ${label} identity mismatch or unreadable`);
    }
  }
  if (await calls.uint256(USDC, "0x313ce567") !== 6n ||
      await calls.uint256(TOKEN, "0x313ce567") !== 18n) {
    throw new Error(`${ADAPTER_KEY}: reserve or liability decimals changed or unreadable`);
  }
  // Shared branch accounting retains current market valuation and the real
  // undercollateralized warning; no redemption capacity is inferred from TVL.
  const result = await fetchEvmBranchBalancesReserves(coin, { ...config, params: BRANCH_PARAMS }, signal, plan.ctx);
  return {
    ...result,
    metadata: {
      ...result.metadata,
      details: { ...result.metadata?.details, reserveIssuer: ISSUER, transparency: TRANSPARENCY, designatedVault: VAULT },
    },
  };
}
