import type { MintBurnBridgeClassifiableRow, MintBurnTxContext } from "../mint-burn-pipeline/mint-burn-bridge-classifier";
import type { MintBurnContractConfig } from "../mint-burn-pipeline/mint-burn-contracts";
import { BRIDGE_TOPICS } from "../mint-burn-pipeline/mint-burn-bridge-classifier-protocols";
import receipts from "./fixtures/mint-burn-bridge-receipts.json";
import { decodeAbiParameters, encodeAbiParameters, keccak256, parseAbiParameters } from "viem/utils";

/** Real RPC observations, trimmed by emitter; hashes and blocks retain provenance. */
export const BRIDGE_RECEIPTS = receipts;
export type BridgeReceipt = typeof receipts[number];
export function receiptContext(fixture: BridgeReceipt): MintBurnTxContext {
  return {
    to: fixture.to, inputSelector: fixture.inputSelector,
    logTopics: fixture.logs.flatMap((log) => log.topics), logAddresses: fixture.logs.map((log) => log.address),
    receiptLogs: fixture.logs,
  };
}
export function makeBridgeRow(overrides: Partial<MintBurnBridgeClassifiableRow> = {}): MintBurnBridgeClassifiableRow {
  return { id: "row-1", tx_hash: "0xtx", direction: "burn", flow_type: "standard",
    counterparty: null, burn_type: null, burn_review_reason: null, ...overrides };
}
export function receiptRows(fixture: BridgeReceipt, config: MintBurnContractConfig): MintBurnBridgeClassifiableRow[] {
  const zero = `0x${"0".repeat(64)}`;
  return fixture.logs.filter((log) => log.address.toLowerCase() === config.contractAddress.toLowerCase()
    && log.topics[0] === BRIDGE_TOPICS.transfer && (log.topics[1] === zero || log.topics[2] === zero))
    .map((log) => {
      const direction = log.topics[1] === zero ? "mint" : "burn";
      return makeBridgeRow({ id: `${config.chain.chainId}-${fixture.transactionHash}-${Number(log.logIndex)}`,
        tx_hash: fixture.transactionHash, direction, counterparty: `0x${log.topics[direction === "mint" ? 2 : 1].slice(-40)}` });
    });
}
export function receiptConfig(fixture: BridgeReceipt, configs: MintBurnContractConfig[]): MintBurnContractConfig {
  const config = configs.find((config) => config.bridgeDetection && config.chain.chainId === fixture.chain
    && fixture.logs.some((log) => log.address.toLowerCase() === config.contractAddress.toLowerCase()));
  if (!config) throw new Error(`No bridge config for receipt ${fixture.name}`);
  return config;
}

/** Explicitly synthetic deployment substitution; never represent this as a captured receipt. */
export function rebindReceipt(original: BridgeReceipt, source: MintBurnContractConfig, target: MintBurnContractConfig): BridgeReceipt {
  const fixture = structuredClone(original), from = source.bridgeDetection!, to = target.bridgeDetection!;
  fixture.name = `synthetic:${target.stablecoinId}:${original.name}`;
  for (const log of fixture.logs) {
    if (log.address.toLowerCase() === source.contractAddress.toLowerCase()) log.address = target.contractAddress;
    log.topics = log.topics.map((word) => word.replace(source.contractAddress.slice(2).toLowerCase(), target.contractAddress.slice(2).toLowerCase()));
    if (from.protocol !== "layerzero-oft" || to.protocol !== "layerzero-oft") continue;
    if (log.address === from.knownBridgeContractAddresses[0]) log.address = to.knownBridgeContractAddresses[0];
    if (log.topics[0] !== BRIDGE_TOPICS.packetSent) continue;
    const abi = parseAbiParameters("bytes,bytes,address");
    const [payload, options, library] = decodeAbiParameters(abi, log.data as `0x${string}`);
    let rebound = payload.slice(0, 20) + to.endpointId.toString(16).padStart(8, "0")
      + to.oappAddress.slice(2).toLowerCase().padStart(64, "0") + payload.slice(92);
    const guid = keccak256(`0x${rebound.slice(4, 164)}`);
    rebound = rebound.slice(0, 164) + guid.slice(2) + rebound.slice(228);
    log.data = encodeAbiParameters(abi, [rebound as `0x${string}`, options, library]);
    fixture.logs.find((entry) => entry.topics[0] === BRIDGE_TOPICS.oftSent)!.topics[1] = guid;
  }
  return fixture;
}
