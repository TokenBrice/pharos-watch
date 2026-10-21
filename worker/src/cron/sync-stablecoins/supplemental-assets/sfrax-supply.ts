import type { StablecoinMeta } from "@shared/types/core";
import {
  SFRAX_STOCK_PERIMETER,
  isSfraxStockContractRoster,
} from "@shared/lib/onchain-supply-probe";
import { deriveSfraxStockPerimeter } from "@shared/lib/sfrax-supply";
import {
  SFRAX_STOCK_MAX_AGE_SEC,
  SFRAX_STOCK_PERIMETER_METHOD,
  type SfraxStockPerimeterObservation,
} from "@shared/types/sfrax-supply";
import { CHAIN_META } from "@shared/types/chain-identity";
import {
  fetchEvmBlockNumber, fetchEvmBlockHeader, fetchEvmRpcBatch,
  type EvmBlockHeader, type EvmRpcOptions,
} from "../../../lib/evm-rpc";
import { DECIMALS_SELECTOR, TOTAL_SUPPLY_SELECTOR, encodeAddress, encodeBalanceOfCallData } from "../../../lib/evm-selectors";
import { fetchSolanaAccounts, readSolanaMint, solanaPublicKey, SOLANA_TOKEN_PROGRAM } from "../../reserve-adapters/solana";
import type { ChainRpcConfig } from "../../../lib/chain-registry";
import { rethrowIfAborted, throwIfAborted } from "../../../lib/abort";
import { logWorkerEvent } from "../../../lib/structured-log";
import type { OnChainMcapResult } from "./onchain-supply";

const TOKEN = "0xfc0c546a";
const TARGET_TOKEN = "0x327107f7";
const TARGET_CHAIN = "0x8304e6d2";
const SOURCE_CHAIN = "0xcd84980e";
const MIGRATED_DEPOSITS = "0x8f601f66";
const L1_TOKEN = "0xd6c0b2c4";
const REMOTE_TOKEN = "0xc01e1bd6";
const RPC_BATCH_SIZE = 10;
const OFT_CONFIG_DISCRIMINATOR = [50, 97, 89, 128, 99, 15, 107, 27]; // account:OftConfig
interface WordRead { label: string; target: string; data: string; expected?: bigint }

async function readWords(chain: string, block: EvmBlockHeader, reads: WordRead[], options: EvmRpcOptions) {
  const words = new Map<string, bigint>();
  for (let start = 0; start < reads.length; start += RPC_BATCH_SIZE) {
    const batch = reads.slice(start, start + RPC_BATCH_SIZE);
    const values = await fetchEvmRpcBatch(chain, batch.map((read) => ({
      method: "eth_call", params: [{ to: read.target, data: read.data }, { blockHash: block.hash, requireCanonical: true }],
    })), { ...options, stateBlockHash: block.hash, requireNonNullResults: true });
    if (!values || values.length !== batch.length) throw new Error(`${chain}: stock batch unavailable`);
    values.forEach((value, index) => {
      const read = batch[index];
      if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${chain}:${read.label}: malformed word`);
      const word = BigInt(value);
      if (read.expected != null && word !== read.expected) throw new Error(`${chain}:${read.label}: identity mismatch`);
      if (words.has(read.label)) throw new Error(`${chain}:${read.label}: duplicate read`);
      words.set(read.label, word);
    });
  }
  return (label: string): bigint => {
    const value = words.get(label);
    if (value == null) throw new Error(`${chain}:${label}: missing observation`);
    return value;
  };
}

function ferryReads(label: string, ferry: string, token: string, targetToken: string, sourceChain: string, targetChain: string): WordRead[] {
  const sourceId = CHAIN_META[sourceChain]?.evmChainId;
  const targetId = CHAIN_META[targetChain]?.evmChainId;
  if (sourceId == null || targetId == null) throw new Error("sFRAX ferry chain identity unavailable");
  return [
    { label: `${label}:token`, target: ferry, data: TOKEN, expected: BigInt(token) },
    { label: `${label}:target`, target: ferry, data: TARGET_TOKEN, expected: BigInt(targetToken) },
    { label: `${label}:source-chain`, target: ferry, data: SOURCE_CHAIN, expected: BigInt(sourceId) },
    { label: `${label}:target-chain`, target: ferry, data: TARGET_CHAIN, expected: BigInt(targetId) },
    { label, target: token, data: encodeBalanceOfCallData(ferry) },
  ];
}

/** Current minted token stocks, not a certificate that pending or migrated-holder claims are extinguished. */
export async function fetchSfraxStockSupply(
  meta: StablecoinMeta, priceUsd: number, chainRpcs?: Map<string, ChainRpcConfig>, signal?: AbortSignal,
): Promise<OnChainMcapResult | null> {
  const readStartedAt = Math.floor(Date.now() / 1000);
  const supplySignal = signal ?? AbortSignal.timeout(120_000);
  try {
    throwIfAborted(supplySignal);
    if (!isSfraxStockContractRoster(meta) || !Number.isFinite(priceUsd) || priceUsd <= 0) throw new Error("unbound stock roster or valuation");
    const profile = SFRAX_STOCK_PERIMETER;
    const nativeToken = profile.contracts[0].address;
    const custodyAddresses = [profile.oftAdapter, profile.migratedStandardBridge,
      ...profile.ferries.map((ferry) => ferry.native), ...profile.historicalNativeFerries.map((ferry) => ferry.native)];
    if (new Set(custodyAddresses).size !== custodyAddresses.length) throw new Error("overlapping native custody exclusions");
    const blocks: Partial<SfraxStockPerimeterObservation["blocks"]> = {};
    const grossSupplyRaw: Partial<SfraxStockPerimeterObservation["grossSupplyRaw"]> = {};
    const remotePrefundedRaw: Partial<SfraxStockPerimeterObservation["remotePrefundedRaw"]> = {};
    let nativeCustodyRaw: SfraxStockPerimeterObservation["nativeCustodyRaw"] | undefined;
    let migratedDepositsRaw: string | undefined;
    let compoundHolderBalanceRaw: string | undefined;
    for (const contract of profile.contracts) {
      throwIfAborted(supplySignal);
      if (contract.chain === "solana") continue;
      const rpcUrl = "rpcUrl" in contract ? contract.rpcUrl : undefined;
      const fallbackRpcUrl = "fallbackRpcUrl" in contract ? contract.fallbackRpcUrl : undefined;
      const options: EvmRpcOptions = {
        signal: supplySignal, timeoutMs: 10_000,
        chainRpcs: rpcUrl ? undefined : chainRpcs,
        extraRpcUrls: [rpcUrl, fallbackRpcUrl].filter((url): url is string => !!url),
      };
      const number = await fetchEvmBlockNumber(contract.chain, options);
      if (number == null) throw new Error(`${contract.chain}: head unavailable`);
      const block = await fetchEvmBlockHeader(contract.chain, number, options);
      const now = Math.floor(Date.now() / 1000);
      if (!block || block.number !== number || block.timestamp > now || now - block.timestamp > SFRAX_STOCK_MAX_AGE_SEC) {
        throw new Error(`${contract.chain}: stock header unavailable, stale or future`);
      }
      const reads: WordRead[] = [
        { label: "decimals", target: contract.address, data: DECIMALS_SELECTOR, expected: BigInt(contract.decimals) },
        { label: "gross", target: contract.address, data: TOTAL_SUPPLY_SELECTOR },
      ];
      if (contract.chain === "ethereum") {
        reads.push(
          { label: "oft-token", target: profile.oftAdapter, data: TOKEN, expected: BigInt(nativeToken) },
          { label: "oftAdapter", target: nativeToken, data: encodeBalanceOfCallData(profile.oftAdapter) },
          { label: "migratedStandardBridge", target: nativeToken, data: encodeBalanceOfCallData(profile.migratedStandardBridge) },
          { label: "migratedDeposits", target: profile.migratedStandardBridge, data: MIGRATED_DEPOSITS + encodeAddress(nativeToken) + encodeAddress(profile.migratedRemoteToken) },
          { label: "compound", target: nativeToken, data: encodeBalanceOfCallData(profile.compoundHolder) },
        );
        for (const ferry of profile.ferries) {
          const remote = profile.contracts.find((entry) => entry.chain === ferry.chain)!;
          reads.push(...ferryReads(ferry.key, ferry.native, nativeToken, remote.address, "ethereum", ferry.chain));
        }
        for (const ferry of profile.historicalNativeFerries) {
          reads.push(...ferryReads(ferry.key, ferry.native, nativeToken, ferry.targetToken, "ethereum", ferry.chain));
        }
      } else {
        const ferry = profile.ferries.find((entry) => entry.chain === contract.chain);
        if (ferry) reads.push(...ferryReads("prefunded", ferry.remote, contract.address, nativeToken, contract.chain, "ethereum"));
        if (contract.chain === "fraxtal") {
          reads.push(
            { label: "migrated-l1-token", target: profile.migratedRemoteToken, data: L1_TOKEN, expected: BigInt(profile.migratedL1Token) },
            { label: "migrated-remote-token", target: profile.migratedRemoteToken, data: REMOTE_TOKEN, expected: BigInt(profile.migratedL1Token) },
          );
        }
      }
      const word = await readWords(contract.chain, block, reads, options);
      const closing = await fetchEvmBlockHeader(contract.chain, number, options);
      if (!closing || closing.number !== block.number || closing.hash !== block.hash || closing.timestamp !== block.timestamp) {
        throw new Error(`${contract.chain}: canonical stock header changed`);
      }
      blocks[contract.chain] = block;
      grossSupplyRaw[contract.chain] = word("gross").toString();
      if (contract.chain === "ethereum") {
        nativeCustodyRaw = {
          migratedStandardBridge: word("migratedStandardBridge").toString(), oftAdapter: word("oftAdapter").toString(),
          arbitrumFerry: word("arbitrumFerry").toString(), avalancheFerry: word("avalancheFerry").toString(),
          bscFerry: word("bscFerry").toString(), optimismFerry: word("optimismFerry").toString(),
          historicalFraxtalFerry: word("historicalFraxtalFerry").toString(), retiredZkevmFerry: word("retiredZkevmFerry").toString(),
        };
        migratedDepositsRaw = word("migratedDeposits").toString();
        compoundHolderBalanceRaw = word("compound").toString();
      } else {
        const ferry = profile.ferries.find((entry) => entry.chain === contract.chain);
        if (ferry) remotePrefundedRaw[ferry.chain] = word("prefunded").toString();
      }
    }
    const solana = profile.contracts.find((contract) => contract.chain === "solana")!;
    const census = await fetchSolanaAccounts([solana.address, profile.solanaMintAuthority], supplySignal, { chainRpcs });
    const mint = readSolanaMint(census.accounts.get(solana.address), census.observedBlock.timestamp);
    const store = census.accounts.get(profile.solanaMintAuthority);
    if (!store || store.owner !== profile.solanaProgram || mint.decimals !== solana.decimals || mint.mintAuthority !== profile.solanaMintAuthority || mint.scaledUi) {
      throw new Error("solana: mint/program/unit identity mismatch");
    }
    const data = store.data;
    if (data.length !== 179 || !OFT_CONFIG_DISCRIMINATOR.every((byte, index) => data[index] === byte)
      || new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(8, true) !== 1000n
      || solanaPublicKey(data.subarray(16, 48)) !== solana.address
      || solanaPublicKey(data.subarray(48, 80)) !== SOLANA_TOKEN_PROGRAM || data[145] !== 0
      || (data[146] !== 0 && data[146] !== 1)) throw new Error("solana: unbound or unsupported legacy OFT stock layout");
    grossSupplyRaw.solana = mint.rawSupply.toString();
    blocks.solana = { slot: census.observedBlock.number, timestamp: census.observedBlock.timestamp };
    const derived = deriveSfraxStockPerimeter({
      method: SFRAX_STOCK_PERIMETER_METHOD, assetId: profile.assetId, readStartedAt,
      readCompletedAt: Math.floor(Date.now() / 1000), priceUsd, blocks, grossSupplyRaw,
      nativeCustodyRaw, migratedDepositsRaw, remotePrefundedRaw, compoundHolderBalanceRaw,
    });
    if (!derived) throw new Error("stock conservation, completeness or freshness failed");
    return {
      mcap: derived.mcap, supplySource: "onchain-circulating-supply", observedAt: derived.observedAt,
      chainCirculating: derived.chainCirculating, supplyPerimeter: derived.observation,
    };
  } catch (error) {
    rethrowIfAborted(error, signal);
    logWorkerEvent({
      scope: "lib", job: "sync-stablecoins", level: "warn", event: "onchain-supply-aggregate-withheld",
      message: "sFRAX current token-stock perimeter unavailable",
      metadata: { stablecoinId: meta.id, reason: "economic-float-unreconciled", rule: "R4" }, error,
    });
    return null;
  }
}
