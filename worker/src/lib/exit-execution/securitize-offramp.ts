import type { ExitExecutionCertificate, ExitExecutionModelReview, ExitExecutionRequestPoint } from "@shared/types/exit-route";
import { domainDigest } from "@shared/lib/safety-score-v9/primitives";
import { requestedExitRawInput, exitRawUsd } from "@shared/lib/safety-score-v9/exit-execution-units";
import { sha256Hex } from "@shared/lib/sha256";
import { fetchEvmBlockNumber, fetchEvmBlockHeader, fetchEvmCodeAtBlock, fetchEvmStorageAtBlock, fetchEvmRpcBatchDetailed, type EvmRpcOptions } from "../evm-rpc";
import { encodeAddress, encodeUint256 } from "../evm-selectors";

const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
// Selectors from the verified SecuritizeOffRamp implementation ABI (R2F5).
const SELECTORS = { asset: "0x1ba46cfd", provider: "0x5b8bec55", liquidityToken: "0x43cd8f7e", paused: "0x5c975abb", liquidity: "0x74375359", twoStep: "0x571a06ff", burn: "0xbfbd008e", quote: "0x5e345e73", beforeFee: "0xa18d74b0", redeem: "0x7cbc2373" };

/** No signing, submissions, KYC overrides or synthetic token funding. */
export async function observeSecuritizeOffRampExit(args: {
  review: ExitExecutionModelReview;
  inputReference: ExitExecutionCertificate["inputReference"];
  outputReference: ExitExecutionCertificate["inputReference"];
  nativeReference?: ExitExecutionCertificate["inputReference"];
  requests: readonly { requestedNotionalUsd: number; maxCostBps: number }[];
  holderAddress?: string;
  rpcOptions?: EvmRpcOptions;
}) {
  if (args.review.producer.kind !== "securitize-offramp") throw new Error("wrong-offramp-model");
  const config = args.review.producer;
  const options = args.rpcOptions;
  const block = await fetchEvmBlockNumber(config.chain, options);
  if (block === null) throw new Error("offramp-block-unavailable");
  const header = await fetchEvmBlockHeader(config.chain, block, options);
  if (!header) throw new Error("offramp-header-unavailable");
  const code = await fetchEvmCodeAtBlock(config.chain, config.contract, block, options);
  const implementation = await fetchEvmStorageAtBlock(config.chain, config.contract, IMPLEMENTATION_SLOT, block, options);
  const implementationCode = await fetchEvmCodeAtBlock(config.chain, config.implementation, block, options);
  const beacon = await fetchEvmStorageAtBlock(config.chain, config.contract, BEACON_SLOT, block, options);
  if (!beacon || !/^0x[0-9a-fA-F]{64}$/.test(beacon) || BigInt(beacon) !== 0n) throw new Error("offramp-beacon-implementation-unsupported");
  if (!code || !implementationCode || !implementation || `0x${implementation.slice(-40)}`.toLowerCase() !== config.implementation.toLowerCase() || sha256Hex(code) !== config.codeSha256 || sha256Hex(implementationCode) !== config.implementationCodeSha256) throw new Error("offramp-implementation-unreviewed");
  const blockTag = `0x${block.toString(16)}`;
  async function call(to: string, data: string, from?: string): Promise<string> {
    const result = await fetchEvmRpcBatchDetailed(config.chain, [{ method: "eth_call", params: [{ to, data, ...(from ? { from } : {}) }, blockTag] }], options);
    const value = result?.results[0];
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored whole-byte hex shape; byte groups cannot overlap.
    if (!result || result.errors.length || typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) throw new Error("offramp-call-unavailable");
    return value;
  }
  const asset = await call(config.contract, SELECTORS.asset);
  const provider = await call(config.contract, SELECTORS.provider);
  const output = await call(config.provider, SELECTORS.liquidityToken);
  if (`0x${asset.slice(-40)}`.toLowerCase() !== config.inputToken.toLowerCase() || `0x${provider.slice(-40)}`.toLowerCase() !== config.provider.toLowerCase() || `0x${output.slice(-40)}`.toLowerCase() !== config.outputToken.toLowerCase()) throw new Error("offramp-route-identity-mismatch");
  const nav = `0x${(await call(config.contract, "0x9d8af759")).slice(-40)}`;
  const feeManager = `0x${(await call(config.contract, "0xd0fb0203")).slice(-40)}`;
  const reviewedAddresses = config.dependencyCodeIdentities.map((entry) => entry.address.toLowerCase());
  if (new Set(reviewedAddresses).size !== reviewedAddresses.length ||
      [config.provider, config.inputToken, config.outputToken, nav, feeManager].some((address) => !reviewedAddresses.includes(address.toLowerCase()))) {
    throw new Error("offramp-dependency-code-unreviewed");
  }
  for (const address of reviewedAddresses) {
    const reviewedCode = config.dependencyCodeIdentities.find((entry) => entry.address.toLowerCase() === address.toLowerCase());
    const dependencyCode = await fetchEvmCodeAtBlock(config.chain, address, block, options);
    if (!reviewedCode || !dependencyCode || sha256Hex(dependencyCode) !== reviewedCode.codeSha256) throw new Error("offramp-dependency-code-unreviewed");
    const pointer = await fetchEvmStorageAtBlock(config.chain, address, IMPLEMENTATION_SLOT, block, options);
    const dependencyBeacon = await fetchEvmStorageAtBlock(config.chain, address, BEACON_SLOT, block, options);
    if (!dependencyBeacon || !/^0x[0-9a-fA-F]{64}$/.test(dependencyBeacon) || BigInt(dependencyBeacon) !== 0n) throw new Error("offramp-dependency-beacon-unsupported");
    if (!pointer || !/^0x[0-9a-fA-F]{64}$/.test(pointer)) throw new Error("offramp-dependency-implementation-unavailable");
    if (BigInt(pointer) !== 0n) {
      const implementationAddress = `0x${pointer.slice(-40)}`.toLowerCase();
      const implementationReview = config.dependencyCodeIdentities.find((entry) => entry.address.toLowerCase() === implementationAddress);
      const implementationCode = await fetchEvmCodeAtBlock(config.chain, implementationAddress, block, options);
      if (reviewedCode.implementationAddress?.toLowerCase() !== implementationAddress || !implementationReview ||
          !implementationCode || sha256Hex(implementationCode) !== implementationReview.codeSha256) {
        throw new Error("offramp-dependency-implementation-unreviewed");
      }
    } else if (reviewedCode.implementationAddress) {
      throw new Error("offramp-dependency-implementation-changed");
    }
  }
  const paused = BigInt(await call(config.contract, SELECTORS.paused)) !== 0n;
  const assetBurn = BigInt(await call(config.contract, SELECTORS.burn)) !== 0n;
  const twoStep = BigInt(await call(config.contract, SELECTORS.twoStep)) !== 0n;
  const inventory = BigInt(await call(config.contract, SELECTORS.liquidity));
  const points: ExitExecutionRequestPoint[] = [];
  for (const request of args.requests) {
    const requested = requestedExitRawInput(request.requestedNotionalUsd, args.inputReference.unitValueUsd, config.inputDecimals);
    const diagnostic = (reason: string): ExitExecutionRequestPoint => ({ ...request, requestedRawInput: requested.toString(), executedRawInput: "0", executableUsd: 0, executionCostBps: 0, allInCostBps: 0, fees: [], outputs: [], certification: "diagnostic", reason });
    if (!args.holderAddress) { points.push(diagnostic("approved-holder-context-unavailable")); continue; }
    if (paused) { points.push(diagnostic("offramp-paused-holder-scenario-unproven")); continue; }
    const quoted = BigInt(await call(config.contract, SELECTORS.quote + encodeUint256(requested)));
    // Inventory is a bound, not proof; the passing amount still needs its own quote and holder execution.
    const amount = quoted > inventory && quoted > 0n ? requested * inventory / quoted : requested;
    if (amount === 0n) { points.push(diagnostic("offramp-inventory-zero-holder-scenario-unproven")); continue; }
    const balance = BigInt(await call(config.inputToken, "0x70a08231" + encodeAddress(args.holderAddress)));
    const allowance = BigInt(await call(config.inputToken, "0xdd62ed3e" + encodeAddress(args.holderAddress) + encodeAddress(config.contract)));
    if (balance < amount || allowance < amount) { points.push(diagnostic("holder-balance-or-approval-unavailable")); continue; }
    const actualOutput = BigInt(await call(config.contract, SELECTORS.quote + encodeUint256(amount)));
    const grossOutput = BigInt(await call(config.contract, SELECTORS.beforeFee + encodeUint256(amount)));
    if (actualOutput === 0n || grossOutput < actualOutput) { points.push(diagnostic("offramp-output-unavailable")); continue; }
    try {
      await call(config.contract, SELECTORS.redeem + encodeUint256(amount) + encodeUint256(actualOutput), args.holderAddress);
    } catch { points.push(diagnostic("holder-execution-failed")); continue; }
    // A view quote plus successful holder eth_call proves this reviewed fixed-state path, not unrestricted access.
    if (!args.nativeReference) { points.push(diagnostic("execution-gas-valuation-unavailable")); continue; }
    const gasResult = await fetchEvmRpcBatchDetailed(config.chain, [
      { method: "eth_estimateGas", params: [{ to: config.contract, from: args.holderAddress, data: SELECTORS.redeem + encodeUint256(amount) + encodeUint256(actualOutput) }, blockTag] },
      { method: "eth_gasPrice", params: [] },
    ], options);
    if (!gasResult || gasResult.errors.length || gasResult.results.some((value) => typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value))) {
      points.push(diagnostic("execution-gas-observation-unavailable")); continue;
    }
    const gasRaw = BigInt(gasResult.results[0] as string) * BigInt(gasResult.results[1] as string);
    const gasUsd = exitRawUsd(gasRaw, args.nativeReference.decimals, args.nativeReference.unitValueUsd);
    const inputUsd = exitRawUsd(amount, config.inputDecimals, args.inputReference.unitValueUsd);
    const actualUsd = exitRawUsd(actualOutput, config.outputDecimals, args.outputReference.unitValueUsd);
    const expectedUsd = exitRawUsd(actualOutput, config.outputDecimals, args.outputReference.expectedUnitValueUsd);
    const cost = Number((((inputUsd > actualUsd ? inputUsd - actualUsd : 0n) + gasUsd) * 1_000_000n + inputUsd - 1n) / inputUsd) / 100;
    const executionCost = Number((((inputUsd > expectedUsd ? inputUsd - expectedUsd : 0n) + gasUsd) * 1_000_000n + inputUsd - 1n) / inputUsd) / 100;
    points.push({ ...request, requestedRawInput: requested.toString(), executedRawInput: amount.toString(), executableUsd: Number(amount * 1_000_000_000n / requested) / 1_000_000_000 * request.requestedNotionalUsd,
      executionCostBps: executionCost, allInCostBps: cost, fees: [
        { kind: "issuer-and-provider", rawUnits: (grossOutput - actualOutput).toString(), assetKey: args.outputReference.assetKey },
        { kind: "gas", rawUnits: gasRaw.toString(), assetKey: args.nativeReference.assetKey },
      ],
      outputs: [{ ...args.outputReference, rawUnits: actualOutput.toString() }],
      certification: cost <= request.maxCostBps ? "exact-lower-bound" : "diagnostic",
      reason: cost <= request.maxCostBps ? null : "execution-cost-exceeds-request" });
  }
  const confirmedHeader = await fetchEvmBlockHeader(config.chain, block, options);
  if (!confirmedHeader || confirmedHeader.hash !== header.hash) throw new Error("offramp-source-reorg");
  return { points, source: { kind: "block" as const, number: block, hash: header.hash, timestamp: header.timestamp, complete: true, truncated: false },
    paused, assetBurn, twoStep, inventoryRaw: inventory.toString(), responseHash: domainDigest("exit-offramp-state.v1", { code, implementation, implementationCode, asset, provider, output, points }) };
}
