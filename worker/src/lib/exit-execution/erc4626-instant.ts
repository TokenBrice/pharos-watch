import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, parseAbiParameters } from "viem/utils";
import type { ExitExecutionCertificate, ExitExecutionModelReview, ExitExecutionRequestPoint } from "@shared/types/exit-route";
import { requestedExitRawInput, exitRawUsd } from "@shared/lib/safety-score-v9/exit-execution-units";
import { sha256Hex } from "@shared/lib/sha256";
import { fetchEvmBlockNumber, fetchEvmBlockHeader, fetchEvmCodeAtBlock, fetchEvmStorageAtBlock, fetchEvmRpcBatchDetailed, MULTICALL3_ADDRESS, type EvmRpcOptions } from "../evm-rpc";

const ABI = parseAbi([
  "function asset() view returns (address)", "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)", "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)", "function convertToShares(uint256) view returns (uint256)",
  "function previewRedeem(uint256) view returns (uint256)", "function maxRedeem(address) view returns (uint256)",
  "function maxWithdraw(address) view returns (uint256)",
  "function redeem(uint256,address,address) returns (uint256)",
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

/** A read-only counterfactual holder: only its reviewed share balance is changed.
 * Vault assets, totalSupply, liquidity, gates, allowances and underlying balances
 * remain the real pinned state. Multicall measures the transfer and share burn
 * in the SAME eth_call as redeem, not a quote in a separate transaction.
 */
export async function observeErc4626InstantExit(args: {
  review: ExitExecutionModelReview;
  inputReference: ExitExecutionCertificate["inputReference"];
  outputReference: ExitExecutionCertificate["inputReference"];
  requests: readonly { requestedNotionalUsd: number; maxCostBps: number }[];
  rpcOptions?: EvmRpcOptions;
  blockNumber?: number;
}) {
  if (args.review.producer.kind !== "erc4626-instant") throw new Error("erc4626-model-mismatch");
  const config = args.review.producer;
  const vault = config.contract as `0x${string}`;
  const underlying = config.outputToken as `0x${string}`;
  const deployment = `${config.chain}:${vault.toLowerCase()}`;
  if (args.review.holder !== "any-holder" || args.review.identity.deployment !== deployment ||
      args.review.identity.endpoint !== deployment || args.inputReference.assetKey !== args.review.identity.assetId ||
      args.inputReference.deployment !== deployment || args.inputReference.decimals !== config.inputDecimals ||
      args.outputReference.deployment !== `${config.chain}:${underlying.toLowerCase()}` ||
      args.outputReference.decimals !== config.outputDecimals ||
      args.review.identity.outputAssetKeys.length !== 1 || args.review.identity.outputAssetKeys[0] !== args.outputReference.assetKey) {
    throw new Error("erc4626-route-identity-mismatch");
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
  const balanceKey = keccak256(encodeAbiParameters(parseAbiParameters("bytes32,bytes32"), config.balanceStorage.keyOrder === "account-slot"
    ? [word(BigInt(HOLDER)) as `0x${string}`, config.balanceStorage.slot as `0x${string}`]
    : [config.balanceStorage.slot as `0x${string}`, word(BigInt(HOLDER)) as `0x${string}`]));
  const override = (shares: bigint) => ({ [vault]: { stateDiff: { [balanceKey]: word(shares) } } });
  const calldata = (functionName: string, inputs: readonly unknown[] = []) => encodeFunctionData({ abi: ABI, functionName, args: inputs } as Parameters<typeof encodeFunctionData>[0]);
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
    { to: vault, data: calldata("asset") }, { to: vault, data: calldata("decimals") },
    { to: underlying, data: calldata("decimals") }, { to: vault, data: calldata("totalSupply") },
    ...config.unrestrictedGateSelectors.map((data) => ({ to: vault, data })),
    ...(config.pausedSelector ? [{ to: vault, data: config.pausedSelector }] : []),
  ]);
  if (uint(identity[0]!) !== BigInt(underlying) || uint(identity[1]!) !== BigInt(config.inputDecimals) || uint(identity[2]!) !== BigInt(config.outputDecimals)) throw new Error("erc4626-asset-identity-mismatch");
  if (identity.slice(4, 4 + config.unrestrictedGateSelectors.length).some((value) => uint(value) !== 0n)) throw new Error("erc4626-holder-gate-active");
  const totalSupply = uint(identity[3]!);
  const paused = config.pausedSelector ? uint(identity[identity.length - 1]!) !== 0n : false;
  // Two distinct sentinels detect ignored overrides as well as wrong mapping layouts.
  const probe = await batch([{ to: vault, data: calldata("balanceOf", [HOLDER]) }], 37n);
  const probe2 = await batch([{ to: vault, data: calldata("balanceOf", [HOLDER]) }], 71n);
  if (uint(probe[0]!) !== 37n || uint(probe2[0]!) !== 71n) throw new Error("erc4626-state-override-unsupported");
  overrideVerified = true;
  const points: ExitExecutionRequestPoint[] = [];
  for (const request of args.requests) {
    const requested = requestedExitRawInput(request.requestedNotionalUsd, args.inputReference.unitValueUsd, config.inputDecimals);
    const empty = (reason: string, certification: ExitExecutionRequestPoint["certification"] = "diagnostic"): ExitExecutionRequestPoint => ({ ...request, requestedRawInput: requested.toString(), executedRawInput: "0", executableUsd: 0, executionCostBps: 0, allInCostBps: 0, fees: [], outputs: [], certification, reason });
    if (requested > totalSupply) { points.push(empty("erc4626-request-exceeds-issued-shares")); continue; }
    const bounds = await batch([
      { to: vault, data: calldata("maxRedeem", [HOLDER]) }, { to: vault, data: calldata("maxWithdraw", [HOLDER]) },
      { to: vault, data: calldata("convertToAssets", [requested]) },
    ], requested);
    const maxRedeem = uint(bounds[0]!); const maxWithdraw = uint(bounds[1]!); const grossRequest = uint(bounds[2]!);
    if (config.maxFunctions === "reviewed-non-binding-zero" && (maxRedeem !== 0n || maxWithdraw !== 0n)) throw new Error("erc4626-reviewed-max-behavior-changed");
    if (config.maxFunctions === "binding" && maxRedeem > requested) throw new Error("erc4626-max-redeem-inconsistent");
    if (paused) {
      points.push(empty("erc4626-paused", "exact-lower-bound")); continue;
    }
    const inverse = await batch([
      { to: vault, data: calldata("convertToShares", [grossRequest]) },
      { to: vault, data: calldata("convertToShares", [grossRequest + 1n]) },
    ]);
    // One underlying base unit can span many share base units (e.g. USDC vaults).
    if (grossRequest === 0n || uint(inverse[0]!) > requested || uint(inverse[1]!) < requested) throw new Error("erc4626-conversion-inconsistent");
    // ERC-4626 max functions may conservatively underestimate. Only successful
    // redemption of the ENTIRE requested balance establishes exact-complete.
    let amount = requested;
    let quote = await batch([{ to: vault, data: calldata("convertToAssets", [amount]) }, { to: vault, data: calldata("previewRedeem", [amount]) }]);
    let gross = uint(quote[0]!); let preview = uint(quote[1]!);
    if (preview === 0n || preview > gross) throw new Error("erc4626-preview-max-inconsistent");
    const calls = [
      { target: underlying, allowFailure: false, callData: calldata("balanceOf", [HOLDER]) },
      { target: vault, allowFailure: false, callData: calldata("balanceOf", [HOLDER]) },
      { target: vault, allowFailure: true, callData: calldata("redeem", [amount, HOLDER, HOLDER]) },
      { target: underlying, allowFailure: false, callData: calldata("balanceOf", [HOLDER]) },
      { target: vault, allowFailure: false, callData: calldata("balanceOf", [HOLDER]) },
    ];
    const simulation = await batch([{ to: HOLDER, data: encodeFunctionData({ abi: MULTICALL_ABI, functionName: "aggregate3", args: [calls] }) }], requested);
    let results = decodeFunctionResult({ abi: MULTICALL_ABI, functionName: "aggregate3", data: simulation[0] as `0x${string}` });
    if (results.length !== calls.length || results.some((entry, index) => index !== 2 && !entry.success)) throw new Error("erc4626-simulation-invalid");
    if (!results[2]!.success) {
      // One bounded fallback: a reported ordinary max, or independently read
      // idle assets for V2. Neither bound earns credit without another redeem.
      let candidate = maxRedeem;
      if (config.maxFunctions === "reviewed-non-binding-zero") {
        const idle = await batch([{ to: underlying, data: calldata("balanceOf", [vault]) }]);
        const idleShares = await batch([{ to: vault, data: calldata("convertToShares", [uint(idle[0]!)]) }]);
        candidate = uint(idleShares[0]!);
      }
      if (candidate > 0n && candidate < requested) {
        amount = candidate;
        quote = await batch([{ to: vault, data: calldata("convertToAssets", [amount]) }, { to: vault, data: calldata("previewRedeem", [amount]) }]);
        gross = uint(quote[0]!); preview = uint(quote[1]!);
        if (preview === 0n || preview > gross || (config.maxFunctions === "binding" && preview > maxWithdraw)) throw new Error("erc4626-preview-max-inconsistent");
        calls[2]!.callData = calldata("redeem", [amount, HOLDER, HOLDER]);
        const retry = await batch([{ to: HOLDER, data: encodeFunctionData({ abi: MULTICALL_ABI, functionName: "aggregate3", args: [calls] }) }], requested);
        results = decodeFunctionResult({ abi: MULTICALL_ABI, functionName: "aggregate3", data: retry[0] as `0x${string}` });
        if (results.length !== calls.length || results.some((entry, index) => index !== 2 && !entry.success)) throw new Error("erc4626-simulation-invalid");
      }
    }
    if (!results[2]!.success) {
      const disabled = config.maxFunctions === "binding" && (maxRedeem === 0n || maxWithdraw === 0n);
      points.push(empty(disabled ? "erc4626-withdrawal-disabled" : "erc4626-redeem-reverted", disabled ? "exact-lower-bound" : "diagnostic")); continue;
    }
    const before = uint(results[0]!.returnData); const after = uint(results[3]!.returnData);
    const sharesBefore = uint(results[1]!.returnData); const sharesAfter = uint(results[4]!.returnData);
    const received = uint(results[2]!.returnData);
    if (sharesBefore !== requested || sharesAfter > sharesBefore || sharesBefore - sharesAfter !== amount ||
        after < before || after - before !== received || received < preview || received === 0n) throw new Error("erc4626-realized-output-inconsistent");
    const inputUsd = exitRawUsd(amount, config.inputDecimals, args.inputReference.unitValueUsd);
    const outputUsd = exitRawUsd(received, config.outputDecimals, args.outputReference.unitValueUsd);
    const expectedUsd = exitRawUsd(received, config.outputDecimals, args.outputReference.expectedUnitValueUsd);
    const haircutBps = Number((gross > received ? gross - received : 0n) * 1_000_000n / gross) / 100;
    const cost = (outputValue: bigint) => Math.max(haircutBps, Number(((inputUsd > outputValue ? inputUsd - outputValue : 0n) * 1_000_000n + inputUsd - 1n) / inputUsd) / 100);
    const executionCostBps = cost(expectedUsd); const allInCostBps = cost(outputUsd);
    const aboveBudget = allInCostBps > request.maxCostBps || executionCostBps > request.maxCostBps;
    points.push({ ...request, requestedRawInput: requested.toString(), executedRawInput: amount.toString(),
      executableUsd: Number(amount * 1_000_000_000n / requested) / 1_000_000_000 * request.requestedNotionalUsd,
      executionCostBps, allInCostBps, fees: [{ kind: "vault-withdrawal-haircut", rawUnits: (gross > received ? gross - received : 0n).toString(), assetKey: args.outputReference.assetKey }],
      outputs: [{ ...args.outputReference, rawUnits: received.toString() }], certification: aboveBudget ? "diagnostic" : amount === requested ? "exact-complete" : "exact-lower-bound",
      reason: aboveBudget ? "erc4626-cost-exceeds-request" : amount === requested ? null : "erc4626-liquidity-limited" });
  }
  const confirmed = await fetchEvmBlockHeader(config.chain, block, options);
  if (!confirmed || confirmed.hash !== header.hash) throw new Error("erc4626-source-reorg");
  return { points, source: { kind: "block" as const, number: block, hash: header.hash, timestamp: header.timestamp, complete: true, truncated: false }, paused };
}
