import { parseAbi } from "viem/utils";
import { abiObservation } from "./evm-observation-plan";
import { readStateWithPlan, type ExecutableRedemptionObserverDescriptor, type ExecutableRedemptionReadClient } from "./executable-redemption-observers";
import type { EvmRpcOptions } from "../../lib/evm-rpc";
import type { AdapterContext } from "./types";

const VAULT = "0x5586c2c8223c73ec0b41d6352748e6c173372e11";
const CONFIG = "0x01313e95c0dd7fd4ad67edc39823b079f6734cee";
const ESCROW = "0xa118b1dbeb940944d071dbec787a2d2e8d3b6578";
const USDM = "0xe2d2959f89b6389deb624bf076fe7d9e5401f377";
const USDC = "0xb88339cb7199b77e23db6e890353e22632ba630f";
const PROXY_HASH = "0xb381e24c1264d42ae3f3f65621d5730936fb3f4825608a7981f3369e0f9e3721";
// All identities are numbered HyperEVM 47935956 observations, not July's historical deployment fixture.
const IDENTITIES = [
  { address: VAULT, codeHash: PROXY_HASH, implementationAddress: "0x08f69c88c47ef1c5274fc11bfe350561252c77f2", implementationCodeHash: "0xcc230cec3e8011dfcdfbf519196e2433e903678aca13aa40be16bd7a02b38c69" },
  { address: CONFIG, codeHash: PROXY_HASH, implementationAddress: "0x1cc4c32f029cfec5c47b0d0850632231992059bc", implementationCodeHash: "0x4131d5aa64d63933e5dbf15d99114225c602848b5ce9f465e2c9566595c40d9e" },
  { address: ESCROW, codeHash: PROXY_HASH, implementationAddress: "0x17100f8cafd727550bb32e6f1496d463da6d978f", implementationCodeHash: "0x26469b46c93dff03d63430bf6b6e89b546897622d60a1f5dfb951947271aee7e" },
  { address: USDM, codeHash: PROXY_HASH, implementationAddress: "0x05faf9cfa7143804e7fb0db423fde8330cd586df", implementationCodeHash: "0x180d4c7daa0c8306c78cfd23d9d25b0f788ffb8023f2d711f3007c1e3f0af86a" },
];
const ABI = parseAbi([
  "function usdc() view returns (address)", "function usdm() view returns (address)",
  "function redeemEscrow() view returns (address)", "function config() view returns (address)",
  "function vault() view returns (address)", "function paused() view returns (bool)",
  "function operatorPaused() view returns (bool)", "function redemptionShortfall() view returns (uint256)",
  "function redeemCooldown() view returns (uint256)", "function totalOwed() view returns (uint256)",
  "function shortfall() view returns (uint256)", "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function redeemRequests(uint256) view returns (address,uint64,uint256)",
]);
function field(label: string, contract: string, functionName: string, args?: readonly unknown[]) {
  return abiObservation({ label, contract, abi: ABI, functionName, args });
}
export const MONETRIX_FUNDED_QUEUE_OBSERVER: ExecutableRedemptionObserverDescriptor = {
  observerId: "monetrix-funded-queue", coinId: "usdm-monetrix", chain: "hyperevm", inputContract: USDM,
  outputAssetKeys: ["usdc-circle"], capacityCapability: "diagnostic-only", sourceLane: "direct",
  async observe(blockNumber, blockTimestamp, rpcOptions, client, ctx, signal) {
    const { values: s } = await readStateWithPlan("usdm-monetrix", "monetrix-queue-state", [
      field("usdc", VAULT, "usdc"), field("usdm", VAULT, "usdm"),
      field("escrow", VAULT, "redeemEscrow"), field("config", VAULT, "config"),
      field("escrow-vault", ESCROW, "vault"), field("escrow-usdc", ESCROW, "usdc"),
      field("paused", VAULT, "paused"), field("operator-paused", VAULT, "operatorPaused"),
      field("vault-shortfall", VAULT, "redemptionShortfall"), field("escrow-shortfall", ESCROW, "shortfall"),
      field("cooldown", CONFIG, "redeemCooldown"), field("owed", ESCROW, "totalOwed"),
      field("balance", USDC, "balanceOf", [ESCROW]), field("usdc-decimals", USDC, "decimals"), field("usdm-decimals", USDM, "decimals"),
    ], IDENTITIES, blockNumber, rpcOptions, client, ctx, signal);
    for (const [key, expected] of Object.entries({ usdc: USDC, usdm: USDM, escrow: ESCROW, config: CONFIG, "escrow-vault": VAULT, "escrow-usdc": USDC })) {
      if ((s[key] as string).toLowerCase() !== expected) throw new Error(`Monetrix ${key} identity drift`);
    }
    if (s["usdc-decimals"] !== 6 || s["usdm-decimals"] !== 6) throw new Error("Monetrix decimal identity drift");
    const balance = s.balance as bigint, owed = s.owed as bigint;
    const shortfall = owed > balance ? owed - balance : 0n;
    if (s["vault-shortfall"] !== shortfall || s["escrow-shortfall"] !== shortfall) throw new Error("Monetrix escrow funding arithmetic mismatch");
    const cooldown = s.cooldown as bigint;
    if (cooldown < 60n || cooldown > 30n * 86400n) throw new Error("Monetrix cooldown outside verified config bounds");
    return {
      capacityRaw: 0n, capacityState: "unquantified", capacitySource: "monetrix-existing-obligations-diagnostic-only",
      settlementBoundUnproven: true, underlyingDecimals: 6, capacityKind: "live-direct-bounded",
      freshnessKind: "same-run-onchain", routeStatusSource: "onchain", routeStatus: s.paused ? "paused" : "open",
      routeStatusReason: s.paused ? "Holder request/claim lane paused" : "Request/claim open; pooled escrow requires operator replenishment and proves no new-holder completion bound",
      feeBps: null, holderEligibility: "any-holder", outputAssetKeys: ["usdc-circle"], blockNumber, sourceTimestamp: blockTimestamp,
      sourceUrls: ["https://doc.monetrix.xyz/guide/getting-started/redeem", "https://sourcify.dev/server/v2/contract/999/0x08f69c88c47ef1c5274fc11bfe350561252c77f2?fields=sources,abi,compilation", "https://hyperevmscan.io/address/0x17100f8cafd727550bb32e6f1496d463da6d978f#code"],
      diagnostics: { vault: VAULT, escrow: ESCROW, config: CONFIG, outputAssetAddress: USDC,
        escrowBalanceRaw: balance.toString(), totalOwedRaw: owed.toString(), shortfallRaw: shortfall.toString(),
        currentNewRequestCooldownSec: Number(cooldown), cooldownAppliesTo: "new-requests-only",
        existingRequestCooldownEnd: "stored-per-request", requestAction: "transfer-usdm-to-vault", claimAction: "burn-usdm-then-escrow-payout",
        userPaused: s.paused, operatorPaused: s["operator-paused"], looseVaultCashUsedAsCapacity: false,
        escrowFundsUsedAsNewHolderCapacity: false, observedBlockHash: rpcOptions.stateBlockHash ?? null },
    };
  },
};

export interface MonetrixRequestObservationInput {
  requestId: bigint;
  owner: string;
  blockNumber: number;
  blockTimestamp: number;
  rpcOptions: EvmRpcOptions;
  client: ExecutableRedemptionReadClient;
  ctx?: AdapterContext;
  signal: AbortSignal;
}

/** Exact request diagnostics use its stored deadline, never today's new-request config. */
export async function observeMonetrixRedeemRequest(input: MonetrixRequestObservationInput) {
  if (input.requestId < 0n || !/^0x[0-9a-fA-F]{40}$/.test(input.owner)) throw new Error("Invalid Monetrix request identity");
  const { values: s } = await readStateWithPlan("usdm-monetrix", "monetrix-exact-request", [
    field("request", VAULT, "redeemRequests", [input.requestId]),
    field("cooldown", CONFIG, "redeemCooldown"), field("paused", VAULT, "paused"),
  ], IDENTITIES, input.blockNumber, input.rpcOptions, input.client, input.ctx, input.signal);
  const [owner, cooldownEnd, amount] = s.request as readonly [string, bigint, bigint];
  const present = owner.toLowerCase() !== "0x0000000000000000000000000000000000000000" && amount > 0n;
  if (present && owner.toLowerCase() !== input.owner.toLowerCase()) throw new Error("Monetrix request owner identity mismatch");
  return {
    requestId: input.requestId.toString(), owner: present ? owner.toLowerCase() : null,
    status: present ? "outstanding" : "absent-or-completed",
    storedCooldownEnd: present ? cooldownEnd.toString() : null,
    currentNewRequestCooldownSec: Number(s.cooldown as bigint),
    cooldownMatured: present && cooldownEnd <= BigInt(input.blockTimestamp),
    holderLanePaused: s.paused as boolean,
    amountRaw: amount.toString(), capacityState: "unquantified" as const,
    claimCompletionGuaranteed: false, blockNumber: input.blockNumber, sourceTimestamp: input.blockTimestamp,
  };
}
