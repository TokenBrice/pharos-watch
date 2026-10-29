import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, parseAbiParameters } from "viem/utils";
import type { ExitExecutionCanonicalAttempt, ExitExecutionCertificate, ExitExecutionModelReview, ExitExecutionRequestPoint } from "@shared/types/exit-route";
import { requestedExitRawInput, exitRawUsd, exitUsdBoundary } from "@shared/lib/safety-score-v9/exit-execution-units";
import { sha256Hex } from "@shared/lib/sha256";
import { domainDigest } from "@shared/lib/safety-score-v9/primitives";
import { fetchEvmBlockNumber, fetchEvmBlockHeader, fetchEvmCodeAtBlock, fetchEvmStorageAtBlock, fetchEvmRpcBatchDetailed, MULTICALL3_ADDRESS, type EvmRpcOptions } from "../evm-rpc";

const ABI = parseAbi([
  "function asset() view returns (address)", "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)", "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)", "function convertToShares(uint256) view returns (uint256)",
  "function previewRedeem(uint256) view returns (uint256)", "function maxRedeem(address) view returns (uint256)",
  "function maxWithdraw(address) view returns (uint256)",
  "function redeem(uint256,address,address) returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function feeRecipient() view returns (address)",
  "function performanceFeeRecipient() view returns (address)",
  "function managementFeeRecipient() view returns (address)",
]);
const MULTICALL_ABI = parseAbi(["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)"]);
const ZERO_SLOT = `0x${"0".repeat(64)}`;
const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const HOLDER = MULTICALL3_ADDRESS as `0x${string}`;
const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;
const uint = (value: string) => {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error("erc4626-read-invalid");
  return BigInt(value);
};

export class Erc4626CanonicalAttemptError extends Error {
  constructor(public readonly canonicalAttempt: ExitExecutionCanonicalAttempt) {
    super("erc4626-realized-output-inconsistent");
  }
}

/** A read-only counterfactual holder: only its reviewed share balance is changed.
 * Vault assets, totalSupply, liquidity, gates, allowances and underlying balances
 * remain the real pinned state. Multicall measures the transfer and share burn
 * in the SAME eth_call as redeem, not a quote in a separate transaction.
 */
export async function observeErc4626InstantExit(args: {
  review: ExitExecutionModelReview;
  inputReference?: ExitExecutionCertificate["inputReference"];
  outputReference: ExitExecutionCertificate["inputReference"];
  requests: readonly { requestedNotionalUsd: number; maxCostBps: number }[];
  rpcOptions?: EvmRpcOptions;
  blockNumber?: number;
  refreshInputFromOutput?: boolean;
}) {
  if (args.review.producer.kind !== "erc4626-instant") throw new Error("erc4626-model-mismatch");
  const config = args.review.producer;
  const vault = config.contract as `0x${string}`;
  const underlying = config.outputToken as `0x${string}`;
  const deployment = `${config.chain}:${vault.toLowerCase()}`;
  const externalShares = config.externalShareToken;
  const shareToken = (externalShares?.address ?? vault) as `0x${string}`;
  const shareDeployment = `${config.chain}:${shareToken.toLowerCase()}`;
  if (args.review.holder !== "any-holder" || args.review.identity.deployment !== shareDeployment ||
      args.review.identity.endpoint !== deployment ||
      (args.inputReference && (args.inputReference.assetKey !== args.review.identity.assetId ||
        args.inputReference.deployment !== shareDeployment || args.inputReference.decimals !== config.inputDecimals)) ||
      args.outputReference.deployment !== `${config.chain}:${underlying.toLowerCase()}` ||
      args.outputReference.decimals !== config.outputDecimals ||
      args.review.identity.outputAssetKeys.length !== 1 || args.review.identity.outputAssetKeys[0] !== args.outputReference.assetKey) {
    throw new Error("erc4626-route-identity-mismatch");
  }
  if ((!args.inputReference && !args.refreshInputFromOutput) || (args.refreshInputFromOutput && externalShares)) {
    throw new Error("erc4626-input-reference-unavailable");
  }
  const block = args.blockNumber ?? await fetchEvmBlockNumber(config.chain, args.rpcOptions);
  if (block === null) throw new Error("erc4626-block-unavailable");
  const header = await fetchEvmBlockHeader(config.chain, block, args.rpcOptions);
  if (!header) throw new Error("erc4626-header-unavailable");
  const options = { ...args.rpcOptions, stateBlockHash: header.hash };
  const pin = { blockHash: header.hash, requireCanonical: true };
  const code = await fetchEvmCodeAtBlock(config.chain, vault, block, options);
  const multicallCode = await fetchEvmCodeAtBlock(config.chain, HOLDER, block, options);
  if (!code || sha256Hex(code) !== config.codeSha256 || !multicallCode || sha256Hex(multicallCode) !== config.multicallCodeSha256) throw new Error("erc4626-code-identity-mismatch");
  const implementation = await fetchEvmStorageAtBlock(config.chain, vault, config.implementation?.slot ?? IMPLEMENTATION_SLOT, block, options);
  const beacon = await fetchEvmStorageAtBlock(config.chain, vault, BEACON_SLOT, block, options);
  if (!implementation || !beacon || uint(beacon) !== 0n) throw new Error("erc4626-proxy-identity-unavailable");
  if (config.implementation) {
    const implementationCode = await fetchEvmCodeAtBlock(config.chain, config.implementation.address, block, options);
    const implementationAddress = config.implementation.slot
      ? `0x${implementation.slice(-40)}`
      : /^0x363d3d373d3d3d363d73[0-9a-fA-F]{40}5af43d82803e903d91602b57fd5bf3$/.test(code) ? `0x${code.slice(22, 62)}` : null;
    if (implementationAddress?.toLowerCase() !== config.implementation.address.toLowerCase() ||
        !implementationCode || sha256Hex(implementationCode) !== config.implementation.codeSha256) throw new Error("erc4626-implementation-mismatch");
  } else if (implementation.toLowerCase() !== ZERO_SLOT) throw new Error("erc4626-implementation-unreviewed");
  for (const dependency of config.dependencyCodeIdentities ?? []) {
    const dependencyCode = await fetchEvmCodeAtBlock(config.chain, dependency.address, block, options);
    if (!dependencyCode || sha256Hex(dependencyCode) !== dependency.codeSha256) throw new Error("erc4626-dependency-identity-mismatch");
  }
  if (externalShares) {
    if (config.chain !== "ethereum" || config.maxFunctions !== "binding") throw new Error("erc4626-external-share-model-unsupported");
    const shareCode = await fetchEvmCodeAtBlock(config.chain, shareToken, block, options);
    const shareImplementation = await fetchEvmStorageAtBlock(config.chain, shareToken, IMPLEMENTATION_SLOT, block, options);
    const shareBeacon = await fetchEvmStorageAtBlock(config.chain, shareToken, BEACON_SLOT, block, options);
    if (!shareCode || sha256Hex(shareCode) !== externalShares.codeSha256 || !shareImplementation ||
        !shareBeacon || uint(shareBeacon) !== 0n) throw new Error("erc4626-share-token-identity-mismatch");
    if (externalShares.implementation) {
      const implementationCode = await fetchEvmCodeAtBlock(config.chain, externalShares.implementation.address, block, options);
      if (`0x${shareImplementation.slice(-40)}`.toLowerCase() !== externalShares.implementation.address.toLowerCase() ||
          !implementationCode || sha256Hex(implementationCode) !== externalShares.implementation.codeSha256) throw new Error("erc4626-share-implementation-mismatch");
    } else if (shareImplementation.toLowerCase() !== ZERO_SLOT) throw new Error("erc4626-share-implementation-unreviewed");
  }
  const balanceKey = keccak256(encodeAbiParameters(parseAbiParameters("bytes32,bytes32"), config.balanceStorage.keyOrder === "account-slot"
    ? [word(BigInt(HOLDER)) as `0x${string}`, config.balanceStorage.slot as `0x${string}`]
    : [config.balanceStorage.slot as `0x${string}`, word(BigInt(HOLDER)) as `0x${string}`]));
  const override = (shares: bigint) => ({ [shareToken]: { stateDiff: { [balanceKey]: word(shares) } } });
  const calldata = (functionName: string, inputs: readonly unknown[] = []) => encodeFunctionData({ abi: ABI, functionName, args: inputs } as Parameters<typeof encodeFunctionData>[0]);
  // The external token's allowance is never overridden. The same simulated
  // transaction performs ordinary approval and redemption, then verifies burn
  // and transfer. Nested Multicall preserves the existing receipt indices.
  const redeemCalldata = (amount: bigint) => externalShares
    ? encodeFunctionData({ abi: MULTICALL_ABI, functionName: "aggregate3", args: [[
        { target: shareToken, allowFailure: false, callData: calldata("approve", [vault, amount]) },
        { target: vault, allowFailure: false, callData: calldata("redeem", [amount, HOLDER, HOLDER]) },
      ]] })
    : calldata("redeem", [amount, HOLDER, HOLDER]);
  let overrideVerified = false;
  async function batch(calls: readonly { to: string; data: string }[], shares?: bigint) {
    const response = await fetchEvmRpcBatchDetailed(config.chain, calls.map((call) => ({ method: "eth_call", params: [{ ...call, from: HOLDER, gas: "0x989680" }, pin, ...(shares === undefined ? [] : [override(shares)])] })), options);
    if (!response || response.errors.length || response.results.some((value) => typeof value !== "string")) {
      if (shares !== undefined && !overrideVerified) throw new Error("erc4626-state-override-unsupported");
      const failedIndex = response?.errors[0]?.index ?? 0;
      throw new Error(`erc4626-read-unavailable:${calls[failedIndex]?.data.slice(0, 10) ?? "batch"}`);
    }
    return response.results as string[];
  }
  const chainResult = await fetchEvmRpcBatchDetailed(config.chain, [{ method: "eth_chainId", params: [] }], options);
  if (!chainResult || chainResult.errors.length || typeof chainResult.results[0] !== "string" || BigInt(chainResult.results[0]) !== BigInt(config.chainId)) throw new Error("erc4626-chain-identity-mismatch");
  const identity = await batch([
    { to: vault, data: calldata("asset") }, { to: shareToken, data: calldata("decimals") },
    { to: underlying, data: calldata("decimals") }, { to: vault, data: calldata("totalSupply") },
    ...config.unrestrictedGateSelectors.map((data) => ({ to: vault, data })),
    ...(config.pausedSelector ? [{ to: vault, data: config.pausedSelector }] : []),
  ]);
  if (uint(identity[0]!) !== BigInt(underlying) || uint(identity[1]!) !== BigInt(config.inputDecimals) || uint(identity[2]!) !== BigInt(config.outputDecimals)) throw new Error("erc4626-asset-identity-mismatch");
  if (identity.slice(4, 4 + config.unrestrictedGateSelectors.length).some((value) => uint(value) !== 0n)) throw new Error("erc4626-holder-gate-active");
  const totalSupply = uint(identity[3]!);
  const paused = config.pausedSelector ? uint(identity[identity.length - 1]!) !== 0n : false;
  let nativeReference: ExitExecutionCertificate["inputReference"] | undefined;
  if (externalShares) {
    const shareIdentity = await batch([{ to: vault, data: externalShares.identitySelector }]);
    if (uint(shareIdentity[0]!) !== BigInt(shareToken)) throw new Error("erc4626-external-share-identity-mismatch");
    const feed = externalShares.nativeUsdFeed;
    const feedCode = await fetchEvmCodeAtBlock(config.chain, feed.address, block, options);
    if (!feedCode || sha256Hex(feedCode) !== feed.codeSha256) throw new Error("erc4626-native-feed-identity-mismatch");
    const oracleAbi = parseAbi(["function decimals() view returns (uint8)", "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"]);
    const oracleReads = await batch((["decimals", "latestRoundData"] as const).map((functionName) => ({
      to: feed.address, data: encodeFunctionData({ abi: oracleAbi, functionName }),
    })));
    const decimals = uint(oracleReads[0]!);
    const [roundId, answer, , updatedAt, answeredInRound] = decodeFunctionResult({
      abi: oracleAbi, functionName: "latestRoundData", data: oracleReads[1] as `0x${string}`,
    });
    if (decimals > 18n || answer <= 0n || updatedAt <= 0n || updatedAt > BigInt(header.timestamp) ||
        answeredInRound < roundId || BigInt(header.timestamp) - updatedAt > BigInt(feed.maxAgeSec)) throw new Error("erc4626-native-price-unavailable");
    const unitValueUsd = Number(answer) / 10 ** Number(decimals);
    if (!Number.isFinite(unitValueUsd) || unitValueUsd <= 0) throw new Error("erc4626-native-price-unavailable");
    nativeReference = {
      assetKey: "asset:eth", deployment: "ethereum:native:eth", rawUnits: "0", decimals: 18,
      unitValueUsd, expectedUnitValueUsd: unitValueUsd, sourceId: `chainlink:${feed.address.toLowerCase()}`,
      sourceGenerationId: domainDigest("safety-score-v10.exit-native-price.v1", {
        blockHash: header.hash, roundId: roundId.toString(), answer: answer.toString(), updatedAt: updatedAt.toString(),
      }), observedAtSec: Number(updatedAt),
    };
  }
  let inputReference = args.inputReference;
  if (args.refreshInputFromOutput) {
    // Missing or stale share-market prices cannot price a current request.
    // Reviewed pinned gross NAV and a separately observed underlying USD price
    // can, without inventing a seed price or dollar par.
    const nav = await batch([{ to: vault, data: calldata("convertToAssets", [10n ** BigInt(config.inputDecimals)]) }]);
    const navRaw = uint(nav[0]!);
    const navUsd = exitRawUsd(navRaw, config.outputDecimals, args.outputReference.unitValueUsd);
    if (navUsd / 10n ** 12n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("erc4626-nav-reference-unavailable");
    const unitValueUsd = exitUsdBoundary(navUsd);
    if (navRaw === 0n || !Number.isFinite(unitValueUsd) || unitValueUsd <= 0) throw new Error("erc4626-nav-reference-unavailable");
    inputReference = {
      assetKey: args.review.identity.assetId, deployment: shareDeployment, rawUnits: "0", decimals: config.inputDecimals,
      unitValueUsd, expectedUnitValueUsd: unitValueUsd,
      sourceId: `erc4626-nav:${args.outputReference.sourceId}`,
      sourceGenerationId: domainDigest("safety-score-v10.erc4626-nav-reference.v1", {
        deployment, blockHash: header.hash, navRaw: navRaw.toString(),
        outputReference: args.outputReference,
      }),
      observedAtSec: Math.min(header.timestamp, args.outputReference.observedAtSec),
    };
  }
  if (!inputReference) throw new Error("erc4626-input-reference-unavailable");
  // Two distinct sentinels detect ignored overrides as well as wrong mapping layouts.
  const probe = await batch([{ to: shareToken, data: calldata("balanceOf", [HOLDER]) }], 37n);
  const probe2 = await batch([{ to: shareToken, data: calldata("balanceOf", [HOLDER]) }], 71n);
  if (uint(probe[0]!) !== 37n || uint(probe2[0]!) !== 71n) throw new Error("erc4626-state-override-unsupported");
  overrideVerified = true;
  async function proveFeeShareMint(
    calls: readonly { target: `0x${string}`; allowFailure: boolean; callData: `0x${string}` }[],
    receipt: readonly { success: boolean; returnData: `0x${string}` }[],
    requested: bigint,
    amount: bigint,
  ) {
    // Do not relax the burn invariant on a quote or a separate accrual read.
    // Discover optional getters, then re-execute the IDENTICAL receipt with
    // configured-recipient identities and balances surrounding the redeem.
    if (externalShares) return false;
    const getters = ["feeRecipient", "performanceFeeRecipient", "managementFeeRecipient"].map((name) => ({
      target: vault, allowFailure: true, callData: calldata(name),
    }));
    const discovery = await batch([{ to: HOLDER, data: encodeFunctionData({
      abi: MULTICALL_ABI, functionName: "aggregate3", args: [getters],
    }) }]);
    const discovered = decodeFunctionResult({
      abi: MULTICALL_ABI, functionName: "aggregate3", data: discovery[0] as `0x${string}`,
    });
    if (discovered.length !== getters.length) return false;
    const configured = discovered.flatMap((entry, index) => {
      if (!entry.success || !/^0x0{24}[0-9a-fA-F]{40}$/.test(entry.returnData)) return [];
      const address = `0x${entry.returnData.slice(-40)}`.toLowerCase() as `0x${string}`;
      if (BigInt(address) === 0n || address === HOLDER.toLowerCase()) return [];
      return [{ getter: { ...getters[index]!, allowFailure: false }, address }];
    });
    if (configured.length === 0) return false;
    const recipients = [...new Set(configured.map((entry) => entry.address))];
    const identities = configured.map((entry) => entry.getter);
    const balances = recipients.map((address) => ({
      target: shareToken, allowFailure: false, callData: calldata("balanceOf", [address]),
    }));
    const prefix = [...identities, ...balances, {
      target: shareToken, allowFailure: false, callData: calldata("totalSupply"),
    }];
    const proofCalls = [...prefix, ...calls, ...identities, ...balances];
    const proof = await batch([{ to: HOLDER, data: encodeFunctionData({
      abi: MULTICALL_ABI, functionName: "aggregate3", args: [proofCalls],
    }) }], requested);
    const result = decodeFunctionResult({
      abi: MULTICALL_ABI, functionName: "aggregate3", data: proof[0] as `0x${string}`,
    });
    if (result.length !== proofCalls.length || result.some((entry) => !entry.success)) return false;
    const suffix = prefix.length + calls.length;
    if (configured.some((entry, index) => uint(result[index]!.returnData) !== BigInt(entry.address) ||
        uint(result[suffix + index]!.returnData) !== BigInt(entry.address)) ||
        uint(result[prefix.length - 1]!.returnData) !== totalSupply ||
        receipt.some((entry, index) => entry.success !== result[prefix.length + index]!.success ||
          entry.returnData.toLowerCase() !== result[prefix.length + index]!.returnData.toLowerCase())) return false;
    let minted = 0n;
    for (const [index] of recipients.entries()) {
      const before = uint(result[identities.length + index]!.returnData);
      const after = uint(result[suffix + identities.length + index]!.returnData);
      if (after < before) return false;
      minted += after - before;
    }
    return minted > 0n && uint(receipt[5]!.returnData) + amount === totalSupply + minted;
  }
  const points: ExitExecutionRequestPoint[] = [];
  let provenShares = 0n;
  for (const request of args.requests) {
    const requested = requestedExitRawInput(request.requestedNotionalUsd, inputReference.unitValueUsd, config.inputDecimals);
    const empty = (reason: string, certification: ExitExecutionRequestPoint["certification"] = "diagnostic"): ExitExecutionRequestPoint => ({ requestedNotionalUsd: request.requestedNotionalUsd, maxCostBps: request.maxCostBps, requestedRawInput: requested.toString(), executedRawInput: "0", executableUsd: 0, executionCostBps: 0, allInCostBps: 0, fees: [], outputs: [], certification, reason });
    // An ask larger than the whole issuance describes a holder that cannot
    // exist: the counterfactual balance exceeds every share the vault issued.
    // Simulate the largest holder the vault can burn, while requestedRawInput
    // and requestedNotionalUsd keep describing the stress ask, so executableUsd
    // stays the fraction of that ask the vault serves. A clamped measurement can
    // only be a lower bound, and a vault without issued shares proves nothing.
    const clamped = requested > totalSupply;
    const simulated = clamped ? totalSupply : requested;
    if (simulated === 0n) { points.push(empty("erc4626-request-exceeds-issued-shares")); continue; }
    const bounds = await batch([
      { to: vault, data: calldata("maxRedeem", [HOLDER]) }, { to: vault, data: calldata("maxWithdraw", [HOLDER]) },
      { to: vault, data: calldata("convertToAssets", [simulated]) },
    ], simulated);
    const maxRedeem = uint(bounds[0]!); const maxWithdraw = uint(bounds[1]!); const grossRequest = uint(bounds[2]!);
    if (config.maxFunctions === "reviewed-non-binding-zero" && (maxRedeem !== 0n || maxWithdraw !== 0n)) throw new Error("erc4626-reviewed-max-behavior-changed");
    if (config.maxFunctions === "binding" && maxRedeem > simulated) throw new Error("erc4626-max-redeem-inconsistent");
    if (paused) {
      points.push(empty("erc4626-paused", "exact-lower-bound")); continue;
    }
    const inverse = await batch([
      { to: vault, data: calldata("convertToShares", [grossRequest]) },
    ]);
    // Conversion views can use opposite conservative exchange-rate rounding
    // (sBOLD does); gross + one asset unit need not round-trip to these shares.
    // Only the exact holder burn and realized transfer below prove execution.
    if (grossRequest === 0n || uint(inverse[0]!) > simulated) throw new Error("erc4626-conversion-inconsistent");
    // ERC-4626 max functions may conservatively underestimate. Only successful
    // redemption of the ENTIRE simulated balance establishes exact-complete;
    // when that balance is the clamp no point can be exact-complete.
    let amount = simulated;
    let quote = await batch([{ to: vault, data: calldata("convertToAssets", [amount]) }, { to: vault, data: calldata("previewRedeem", [amount]) }]);
    let gross = uint(quote[0]!); let preview = uint(quote[1]!);
    if (preview === 0n || preview > gross) throw new Error("erc4626-preview-max-inconsistent");
    const calls = [
      { target: underlying, allowFailure: false, callData: calldata("balanceOf", [HOLDER]) },
      { target: shareToken, allowFailure: false, callData: calldata("balanceOf", [HOLDER]) },
      { target: externalShares ? HOLDER : vault, allowFailure: true, callData: redeemCalldata(amount) },
      { target: underlying, allowFailure: false, callData: calldata("balanceOf", [HOLDER]) },
      { target: shareToken, allowFailure: false, callData: calldata("balanceOf", [HOLDER]) },
      { target: shareToken, allowFailure: false, callData: calldata("totalSupply") },
    ];
    const simulation = await batch([{ to: HOLDER, data: encodeFunctionData({ abi: MULTICALL_ABI, functionName: "aggregate3", args: [calls] }) }], simulated);
    let results = decodeFunctionResult({ abi: MULTICALL_ABI, functionName: "aggregate3", data: simulation[0] as `0x${string}` });
    if (results.length !== calls.length || results.some((entry, index) => index !== 2 && !entry.success)) throw new Error("erc4626-simulation-invalid");
    const canonicalResults = results;
    const canonicalNested = externalShares && results[2]!.success ? decodeFunctionResult({
      abi: MULTICALL_ABI, functionName: "aggregate3", data: results[2]!.returnData,
    }) : null;
    if (canonicalNested && (canonicalNested.length !== 2 || canonicalNested.some((entry) => !entry.success) ||
        uint(canonicalNested[0]!.returnData) !== 1n)) throw new Error("erc4626-approval-receipt-invalid");
    const canonicalBefore = uint(results[0]!.returnData);
    const canonicalAfter = uint(results[3]!.returnData);
    const canonicalAttempt: ExitExecutionCanonicalAttempt = {
      outcome: "inconsistent-receipt",
      block: { number: block, hash: header.hash, timestamp: header.timestamp },
      requestedRawInput: simulated.toString(),
      shareBalanceBefore: uint(results[1]!.returnData).toString(),
      shareBalanceAfter: uint(results[4]!.returnData).toString(),
      totalSupplyBefore: totalSupply.toString(),
      totalSupplyAfter: uint(results[5]!.returnData).toString(),
      returnedRawOutput: results[2]!.success ? uint(canonicalNested ? canonicalNested[1]!.returnData : results[2]!.returnData).toString() : null,
      receivedRawOutput: canonicalAfter >= canonicalBefore ? (canonicalAfter - canonicalBefore).toString() : null,
      revertData: results[2]!.success ? null : results[2]!.returnData,
      reason: "erc4626-realized-output-inconsistent",
    };
    if (!results[2]!.success) {
      if (canonicalAttempt.shareBalanceBefore !== simulated.toString() ||
          canonicalAttempt.shareBalanceAfter !== canonicalAttempt.shareBalanceBefore ||
          canonicalAttempt.receivedRawOutput !== "0" || canonicalAttempt.totalSupplyAfter !== canonicalAttempt.totalSupplyBefore) {
        throw new Erc4626CanonicalAttemptError(canonicalAttempt);
      }
      canonicalAttempt.outcome = "reverted";
      canonicalAttempt.reason = "erc4626-redeem-reverted";
    } else if (canonicalAttempt.receivedRawOutput === "0") {
      // A successful queue acceptance is classified only after proving the
      // original full burn, zero return and same-call supply/fee reconciliation.
      const canonicalSupplyAfter = BigInt(canonicalAttempt.totalSupplyAfter);
      if (canonicalAttempt.shareBalanceBefore !== simulated.toString() || canonicalAttempt.shareBalanceAfter !== "0" ||
          canonicalAttempt.returnedRawOutput !== "0" ||
          (canonicalSupplyAfter + simulated !== totalSupply &&
            !(canonicalSupplyAfter + simulated > totalSupply && await proveFeeShareMint(calls, results, simulated, simulated)))) {
        throw new Erc4626CanonicalAttemptError(canonicalAttempt);
      }
      canonicalAttempt.outcome = "accepted-but-unfunded";
      canonicalAttempt.reason = "erc4626-canonical-accepted-but-unfunded";
    }
    // Some vaults accept an illiquid redeem into a queue and burn shares but
    // transfer no assets. That is not synchronous execution. A smaller fresh
    // simulation may prove an instant lower bound, never the queued balance.
    const deferredReceipt = canonicalAttempt.outcome === "accepted-but-unfunded";
    if (!results[2]!.success || deferredReceipt) {
      // One ordinary-max/idle fallback, then at most five smaller probes with
      // the ORIGINAL holder balance. Each retained point still requires exact
      // redeem, transfer and burn proof; no failed probe proves exhaustion.
      let candidate = maxRedeem;
      if (config.maxFunctions === "reviewed-non-binding-zero") {
        const idle = await batch([{ to: underlying, data: calldata("balanceOf", [vault]) }]);
        const idleShares = await batch([{ to: vault, data: calldata("convertToShares", [uint(idle[0]!)]) }]);
        candidate = uint(idleShares[0]!);
        if (candidate >= simulated) candidate = 0n;
        if (provenShares < simulated && provenShares > candidate) candidate = provenShares;
      }
      if (candidate > 0n && candidate < simulated) {
        amount = candidate;
        quote = await batch([{ to: vault, data: calldata("convertToAssets", [amount]) }, { to: vault, data: calldata("previewRedeem", [amount]) }]);
        gross = uint(quote[0]!); preview = uint(quote[1]!);
        if (preview === 0n || preview > gross || (config.maxFunctions === "binding" && preview > maxWithdraw)) throw new Error("erc4626-preview-max-inconsistent");
        calls[2]!.callData = redeemCalldata(amount);
        const retry = await batch([{ to: HOLDER, data: encodeFunctionData({ abi: MULTICALL_ABI, functionName: "aggregate3", args: [calls] }) }], simulated);
        results = decodeFunctionResult({ abi: MULTICALL_ABI, functionName: "aggregate3", data: retry[0] as `0x${string}` });
        if (results.length !== calls.length || results.some((entry, index) => index !== 2 && !entry.success)) throw new Error("erc4626-simulation-invalid");
      }
      if (config.maxFunctions === "reviewed-non-binding-zero" ||
          (deferredReceipt && !externalShares && maxRedeem > 0n && maxWithdraw > 0n)) {
        // V2 zero maxima and accepted-but-unfunded redemptions do not describe
        // the instant executable boundary. Keep only an actual asset receipt.
        let lower = results[2]!.success && uint(results[3]!.returnData) > uint(results[0]!.returnData) ? amount : 0n;
        let upper = simulated;
        for (let attempt = 0; attempt < 5 && lower * 100n < simulated * 95n; attempt++) {
          const candidate = (lower + upper) / 2n;
          if (candidate === lower || candidate >= simulated) break;
          const candidateQuote = await batch([
            { to: vault, data: calldata("convertToAssets", [candidate]) },
            { to: vault, data: calldata("previewRedeem", [candidate]) },
          ]);
          const candidateGross = uint(candidateQuote[0]!);
          const candidatePreview = uint(candidateQuote[1]!);
          if (candidatePreview === 0n) { upper = candidate; continue; }
          if (candidatePreview > candidateGross) throw new Error("erc4626-preview-max-inconsistent");
          calls[2]!.callData = redeemCalldata(candidate);
          const probe = await batch([{ to: HOLDER, data: encodeFunctionData({ abi: MULTICALL_ABI, functionName: "aggregate3", args: [calls] }) }], simulated);
          const candidateResults = decodeFunctionResult({ abi: MULTICALL_ABI, functionName: "aggregate3", data: probe[0] as `0x${string}` });
          if (candidateResults.length !== calls.length || candidateResults.some((entry, index) => index !== 2 && !entry.success)) throw new Error("erc4626-simulation-invalid");
          if (candidateResults[2]!.success && uint(candidateResults[3]!.returnData) > uint(candidateResults[0]!.returnData)) {
            lower = candidate;
            amount = candidate;
            gross = candidateGross;
            preview = candidatePreview;
            results = candidateResults;
          } else {
            upper = candidate;
          }
        }
      }
    }
    if (!results[2]!.success) {
      const disabled = config.maxFunctions === "binding" && (maxRedeem === 0n || maxWithdraw === 0n);
      const point = empty(disabled ? "erc4626-withdrawal-disabled" : "erc4626-redeem-reverted", disabled ? "exact-lower-bound" : "diagnostic");
      point.canonicalAttempt = canonicalAttempt;
      points.push(point); continue;
    }
    const before = uint(results[0]!.returnData); const after = uint(results[3]!.returnData);
    const sharesBefore = uint(results[1]!.returnData); const sharesAfter = uint(results[4]!.returnData);
    const nestedReceipt = externalShares ? results === canonicalResults ? canonicalNested : decodeFunctionResult({
      abi: MULTICALL_ABI, functionName: "aggregate3", data: results[2]!.returnData,
    }) : null;
    if (nestedReceipt && (nestedReceipt.length !== 2 || nestedReceipt.some((entry) => !entry.success) ||
        uint(nestedReceipt[0]!.returnData) !== 1n)) throw new Error("erc4626-approval-receipt-invalid");
    const returned = uint(nestedReceipt ? nestedReceipt[1]!.returnData : results[2]!.returnData);
    const received = after >= before ? after - before : 0n;
    const supplyAfter = uint(results[5]!.returnData);
    if (sharesBefore !== simulated || sharesAfter > sharesBefore || sharesBefore - sharesAfter !== amount ||
        after < before || received > gross || received === 0n ||
        (config.redeemReturns === "gross-before-fee" ? returned !== gross : returned !== received) ||
        (config.previewRedeem !== "gross-before-fee" && received < preview)) {
      if (amount === simulated) throw new Erc4626CanonicalAttemptError(canonicalAttempt);
      throw new Error("erc4626-realized-output-inconsistent");
    }
    // Later failed/queued probes may have changed the descriptor without
    // replacing the winning receipt. Replay and gas must use that exact amount.
    calls[2]!.callData = redeemCalldata(amount);
    if (supplyAfter + amount !== totalSupply &&
        !(supplyAfter + amount > totalSupply && await proveFeeShareMint(calls, results, simulated, amount))) {
      if (amount === simulated) throw new Erc4626CanonicalAttemptError(canonicalAttempt);
      throw new Error("erc4626-realized-output-inconsistent");
    }
    if (amount === simulated) {
      canonicalAttempt.outcome = "completed";
      canonicalAttempt.reason = null;
    }
    let gasRaw = 0n;
    if (externalShares) {
      // Both the execution and fee-history quote refer to this exact block.
      // This is an expiring gas observation, not a published future fee bound.
      const blockTag = `0x${block.toString(16)}`;
      const gasCalls = calls.map((call, index) => index === 2 ? { ...call, allowFailure: false } : call);
      const gas = await fetchEvmRpcBatchDetailed(config.chain, [
        { method: "eth_estimateGas", params: [{
          to: HOLDER, from: "0x0000000000000000000000000000000000000001", gasPrice: "0x0",
          data: encodeFunctionData({ abi: MULTICALL_ABI, functionName: "aggregate3", args: [gasCalls] }),
        }, blockTag, override(simulated)] },
        { method: "eth_feeHistory", params: ["0x1", blockTag, [100]] },
      ], options);
      const estimate = gas?.results[0];
      const history = gas?.results[1] as { oldestBlock?: string; baseFeePerGas?: string[]; reward?: string[][] } | undefined;
      const hexUint = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value);
      if (!gas || gas.errors.length || !hexUint(estimate) || !hexUint(history?.oldestBlock) ||
          BigInt(history.oldestBlock) !== BigInt(block) || !hexUint(history.baseFeePerGas?.[0]) ||
          !hexUint(history.reward?.[0]?.[0]) || BigInt(estimate) <= 0n) throw new Error("erc4626-pinned-gas-unavailable");
      gasRaw = BigInt(estimate) * (BigInt(history.baseFeePerGas[0]!) + BigInt(history.reward[0]![0]!));
      if (gasRaw <= 0n || !nativeReference) throw new Error("erc4626-pinned-gas-unavailable");
    }
    const inputUsd = exitRawUsd(amount, config.inputDecimals, inputReference.unitValueUsd);
    const outputUsd = exitRawUsd(received, config.outputDecimals, args.outputReference.unitValueUsd);
    const expectedUsd = exitRawUsd(received, config.outputDecimals, args.outputReference.expectedUnitValueUsd);
    const haircutBps = Number((gross > received ? gross - received : 0n) * 1_000_000n / gross) / 100;
    const gasUsd = nativeReference ? exitRawUsd(gasRaw, nativeReference.decimals, nativeReference.unitValueUsd) : 0n;
    const cost = (outputValue: bigint) => Math.max(haircutBps, Number((((inputUsd > outputValue ? inputUsd - outputValue : 0n) + gasUsd) * 1_000_000n + inputUsd - 1n) / inputUsd) / 100);
    const executionCostBps = cost(expectedUsd); const allInCostBps = cost(outputUsd);
    const aboveBudget = allInCostBps > request.maxCostBps || executionCostBps > request.maxCostBps;
    points.push({ requestedNotionalUsd: request.requestedNotionalUsd, maxCostBps: request.maxCostBps, requestedRawInput: requested.toString(), executedRawInput: amount.toString(),
      executableUsd: Number(amount * 1_000_000_000n / requested) / 1_000_000_000 * request.requestedNotionalUsd,
      executionCostBps, allInCostBps, fees: [
        { kind: "vault-withdrawal-haircut", rawUnits: (gross > received ? gross - received : 0n).toString(), assetKey: args.outputReference.assetKey },
        ...(nativeReference ? [{ kind: "gas", rawUnits: gasRaw.toString(), assetKey: nativeReference.assetKey }] : []),
      ],
      outputs: [{ ...args.outputReference, rawUnits: received.toString() }], certification: aboveBudget ? "diagnostic" : amount === requested && !clamped ? "exact-complete" : "exact-lower-bound",
      reason: aboveBudget ? "erc4626-cost-exceeds-request" : amount === requested && !clamped ? null : clamped && amount === simulated ? "erc4626-request-clamped-to-issued-shares" : "erc4626-liquidity-limited",
      canonicalAttempt });
    if (!aboveBudget && amount > provenShares) provenShares = amount;
  }
  const confirmed = await fetchEvmBlockHeader(config.chain, block, options);
  if (!confirmed || confirmed.hash !== header.hash) throw new Error("erc4626-source-reorg");
  return { points, inputReference, nativeReference, source: { kind: "block" as const, number: block, hash: header.hash, timestamp: header.timestamp, complete: true, truncated: false }, paused };
}
