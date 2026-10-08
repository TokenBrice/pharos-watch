import { parseAbi } from "viem/utils";
import type { EvmRpcOptions } from "../../lib/evm-rpc";
import type { AdapterContext } from "./types";
import { abiObservation } from "./evm-observation-plan";
import { readStateWithPlan, type ExecutableRedemptionObserverDescriptor, type ExecutableRedemptionReadClient, type ExecutableRedemptionObservation } from "./executable-redemption-observers";

const SHARE = "0xd166337499e176bbc38a1fbd113ab144e5bd2df7";
const QUEUE = "0x4bc9fec04f0f95e9b42a3ef18f3c96fb57923d2e";
const USDAT = "0x23238f20b894f29041f48d88ee91131c395aaa71";
const PROXY_HASH = "0x145bff91aef4f63089cb6e628ab5fca4daf8e51619106333ceb291ccf406cd86";
const IDENTITIES = [
  { address: SHARE, codeHash: PROXY_HASH, implementationAddress: "0x2b7074cf6681382b70e239063931ebe83c0f4e0a", implementationCodeHash: "0xec3b77f722a89eec23e7dfb2ddfe63e4d82f37adbc5f75a269ed2c82c3ad0300" },
  { address: QUEUE, codeHash: PROXY_HASH, implementationAddress: "0xdaf6f8523d7a707d173a12041e1523fdf1373f23", implementationCodeHash: "0x537d27c7b1574e4ab94867b9f5719414169c5941387346bca88b84643612256d" },
];
const ABI = parseAbi([
  "function asset() view returns (address)", "function getWithdrawalQueue() view returns (address)",
  "function USDAT() view returns (address)", "function STAKED_USDAT() view returns (address)",
  "function paused() view returns (bool)", "function redemptionFeeBps() view returns (uint16)",
  "function baseRedemptionFeeBps() view returns (uint16)", "function elevatedRedemptionFeeBps() view returns (uint16)",
  "function marketMode() view returns (uint8)", "function regularModeValidUntil() view returns (uint64)",
  "function nextTokenId() view returns (uint256)", "function totalSupply() view returns (uint256)",
  "function usdatBalance() view returns (uint256)", "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)", "function isFrozen(address) view returns (bool)",
  "function isBlacklisted(address) view returns (bool)", "function ownerOf(uint256) view returns (address)",
  "function requests(uint256) view returns (uint256,uint256,uint256,uint256,uint8)",
]);
function field(label: string, contract: string, functionName: string, args?: readonly unknown[]) {
  return abiObservation({ label, contract, abi: ABI, functionName, args });
}
export interface SaturnQueueRequestIdentity { tokenId: bigint; owner: string }

/** Optional exact owner claim diagnostics; never an aggregate or new-holder throughput certificate. */
export async function observeSaturnV2Queue(
  blockNumber: number, blockTimestamp: number, rpcOptions: EvmRpcOptions, client: ExecutableRedemptionReadClient,
  ctx: AdapterContext | undefined, signal: AbortSignal, request?: SaturnQueueRequestIdentity,
): Promise<ExecutableRedemptionObservation> {
  const { values: s } = await readStateWithPlan("susdat-saturn", "saturn-v2-queue-state", [
    field("asset", SHARE, "asset"), field("queue", SHARE, "getWithdrawalQueue"),
    field("queue-asset", QUEUE, "USDAT"), field("queue-share", QUEUE, "STAKED_USDAT"),
    field("share-paused", SHARE, "paused"), field("queue-paused", QUEUE, "paused"),
    field("fee", SHARE, "redemptionFeeBps"), field("base-fee", SHARE, "baseRedemptionFeeBps"),
    field("elevated-fee", SHARE, "elevatedRedemptionFeeBps"), field("mode", SHARE, "marketMode"),
    field("mode-expiry", SHARE, "regularModeValidUntil"), field("next-id", QUEUE, "nextTokenId"),
    field("nfts", QUEUE, "totalSupply"), field("share-balance", SHARE, "usdatBalance"),
    field("queue-balance", USDAT, "balanceOf", [QUEUE]), field("decimals", USDAT, "decimals"),
    field("queue-frozen", USDAT, "isFrozen", [QUEUE]),
  ], IDENTITIES, blockNumber, rpcOptions, client, ctx, signal);
  for (const [key, expected] of Object.entries({ asset: USDAT, queue: QUEUE, "queue-asset": USDAT, "queue-share": SHARE })) {
    if ((s[key] as string).toLowerCase() !== expected) throw new Error(`Saturn ${key} identity drift`);
  }
  if (s.decimals !== 6) throw new Error("Saturn USDat decimal drift");
  const mode = s.mode as number, expiry = s["mode-expiry"] as bigint;
  const fee = s.fee as number, base = s["base-fee"] as number, elevated = s["elevated-fee"] as number;
  if ((mode !== 0 && mode !== 1) || base > elevated || elevated > 500 || fee !== (mode === 0 ? base : elevated) || (mode === 0 && BigInt(blockTimestamp) >= expiry)) {
    throw new Error("Saturn effective process-time fee/mode inconsistency");
  }
  const diagnostics: Record<string, unknown> = {
    share: SHARE, queue: QUEUE, outputAssetAddress: USDAT, sharePaused: s["share-paused"], queuePaused: s["queue-paused"],
    currentEffectiveFeeBps: fee, baseFeeBps: base, elevatedFeeBps: elevated, effectiveMarketMode: mode,
    regularModeValidUntil: expiry.toString(), nextTokenId: (s["next-id"] as bigint).toString(),
    outstandingNfts: (s.nfts as bigint).toString(), shareUsdatBalanceRaw: (s["share-balance"] as bigint).toString(),
    queueUsdatBalanceRaw: (s["queue-balance"] as bigint).toString(), inventoriesSummedAsCapacity: false,
    queueInventoryBelongsToProcessedRequests: true, processing: "operator-role-may-skip", completionBound: null,
    feeFixedAt: "process-time", observedBlockHash: rpcOptions.stateBlockHash ?? null,
  };
  if (request) {
    if (request.tokenId < 0n || !/^0x[0-9a-fA-F]{40}$/.test(request.owner)) throw new Error("Invalid exact Saturn request identity");
    const { values: r } = await readStateWithPlan("susdat-saturn", "saturn-v2-exact-request", [
      field("owner", QUEUE, "ownerOf", [request.tokenId]), field("request", QUEUE, "requests", [request.tokenId]),
      field("owner-blacklisted", SHARE, "isBlacklisted", [request.owner]), field("owner-frozen", USDAT, "isFrozen", [request.owner]),
    ], [], blockNumber, rpcOptions, client, ctx, signal);
    if ((r.owner as string).toLowerCase() !== request.owner.toLowerCase()) throw new Error("Saturn request owner identity mismatch");
    const data = r.request as readonly [bigint, bigint, bigint, bigint, number];
    if (data[4] > 5) throw new Error("Saturn request status outside verified V2 enum");
    diagnostics.exactRequest = { tokenId: request.tokenId.toString(), owner: request.owner.toLowerCase(), status: data[4],
      usdatOwedRaw: data[1].toString(), requestTimestamp: data[2].toString(),
      ownerClaimable: data[4] === 3 && data[1] > 0n && !r["owner-blacklisted"] && !r["owner-frozen"] && !s["queue-paused"] && !s["queue-frozen"] && (s["queue-balance"] as bigint) >= data[1],
      newHolderCapacity: false };
  }
  const paused = Boolean(s["share-paused"] || s["queue-paused"] || s["queue-frozen"]);
  return {
    capacityRaw: 0n, capacityState: "unquantified", capacitySource: "saturn-v2-operator-queue-diagnostic-only",
    settlementBoundUnproven: true, underlyingDecimals: 6, capacityKind: "live-direct-bounded", freshnessKind: "same-run-onchain",
    routeStatusSource: "onchain", routeStatus: paused ? "paused" : "open",
    routeStatusReason: paused ? "Saturn request/claim lane has an observed pause or frozen paying queue" : "Operator-priced processing has no new-holder completion bound",
    feeBps: fee, holderEligibility: "any-holder", outputAssetKeys: ["usdat-saturn"], blockNumber, sourceTimestamp: blockTimestamp,
    sourceUrls: ["https://saturncredit.gitbook.io/saturn-docs/solution/susdat-overview", "https://sourcify.dev/server/v2/contract/1/0x2b7074cf6681382b70e239063931ebe83c0f4e0a?fields=sources,abi,runtimeMatch", "https://sourcify.dev/server/v2/contract/1/0xdaf6f8523d7a707d173a12041e1523fdf1373f23?fields=sources,abi,runtimeMatch"], diagnostics,
  };
}
export const SATURN_V2_QUEUE_OBSERVER: ExecutableRedemptionObserverDescriptor = {
  observerId: "saturn-v2-queue", coinId: "susdat-saturn", chain: "ethereum", inputContract: SHARE,
  outputAssetKeys: ["usdat-saturn"], capacityCapability: "diagnostic-only", sourceLane: "direct", observe: observeSaturnV2Queue,
};
