import type { StablecoinMeta } from "@shared/types/core";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { LiveReservesConfig, LiveReserveWarning } from "@shared/types/live-reserves";
import { fetchEvmRpcBatch, parseUint256Hex, type EvmRpcBatchCall } from "../../lib/evm-rpc";
import { decimalNumberFromBigInt, notApplicableFreshnessMetadata, requireOnchainInput, reserveDegradedWarning } from "./helpers";
import { EIP1967_IMPLEMENTATION_SLOT, implementationAddressFromSlot } from "./onchain-identity";
import { runAdapterIo } from "./concurrency";
import type { AdapterContext, AdapterResult } from "./types";

const KEY = "moc-doc";
const WAD = 10n ** 18n;
const MOC = "0xf773b590af754d597770937fa8ea7abdf2668370";
const STATE = "0xb9c42efc8ec54490a37ca91c423f7285fa01e257";
const CONNECTOR = "0xce2a128cc73e5d98355aafb2595647f2d3171faa";
const DOC = "0xe700691da7b9851f2f35f8b8182c69c53ccad9db";
const ORACLE = "0xe2927a0620b82a66d67f678fc9b826b0e01b1bfd";
const LEGACY_IMPLEMENTATION_SLOT = "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3";
const IMPLEMENTATIONS = [
  [MOC, LEGACY_IMPLEMENTATION_SLOT, "0x8cf0035b1d1bcd6821f563b3db0530ef59c5d226"],
  [STATE, LEGACY_IMPLEMENTATION_SLOT, "0xf65be577b252a41887e2f1a19b576a0925201186"],
  [CONNECTOR, LEGACY_IMPLEMENTATION_SLOT, "0x437221b50b0066186e58412b0ba940441a7b7df5"],
  [ORACLE, EIP1967_IMPLEMENTATION_SLOT, "0xa7e86af8eb19e3dab8e7353cb27d286372aac87d"],
] as const;
const SOURCE_URLS = [
  "https://docs.moneyonchain.com/main-rbtc-contract/integration-with-moc-platform/introduction-to-moc/the-moc-state-contract",
  "https://rootstock.blockscout.com/address/0xf65BE577b252A41887e2f1a19b576A0925201186?tab=contract",
];

function uint(value: unknown, label: string): bigint {
  const parsed = parseUint256Hex(value);
  if (parsed == null) throw new Error(`${KEY}: invalid ${label}`);
  return parsed;
}

function header(value: unknown): { number: string; hash: string; timestamp: number } {
  const block = value as { number?: unknown; hash?: unknown; timestamp?: unknown } | null;
  if (!block || typeof block.number !== "string" || !/^0x[0-9a-f]+$/i.test(block.number)
    || typeof block.hash !== "string" || !/^0x[0-9a-f]{64}$/i.test(block.hash)) {
    throw new Error(`${KEY}: malformed block header`);
  }
  const timestamp = Number(uint(block.timestamp, "block timestamp"));
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new Error(`${KEY}: invalid block timestamp`);
  return { number: block.number, hash: block.hash, timestamp };
}

export async function fetchMocDocReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, KEY);
  if (coin.id !== "doc-money-on-chain" || input.chain !== "rootstock"
    || !coin.contracts?.some((c) => c.chain === "rootstock" && c.address.toLowerCase() === DOC && c.decimals === 18)) {
    throw new Error(`${KEY}: canonical DOC identity mismatch`);
  }
  const params = parseLiveReserveAdapterParams(KEY, config.params);
  const options = { extraRpcUrls: [params.rpcUrl], signal, timeoutMs: 12_000, maxRetries: 1 };
  const read = (label: string, calls: EvmRpcBatchCall[]) => runAdapterIo(ctx, `${KEY}:${label}`, () =>
    fetchEvmRpcBatch(undefined, calls, options));
  const head = await read("head", [{ method: "eth_getBlockByNumber", params: ["latest", false] }]);
  const block = header(head?.[0]);
  const now = ctx?.nowSec ?? Math.floor(Date.now() / 1000);
  if (block.timestamp > now + 60 || now - block.timestamp > 600) throw new Error(`${KEY}: stale/future RPC block`);
  const call = (to: string, data: string): EvmRpcBatchCall => ({ method: "eth_call", params: [{ to, data }, block.number] });
  const calls = [
    ...IMPLEMENTATIONS.map(([address, slot]) => ({ method: "eth_getStorageAt", params: [address, slot, block.number] })),
    call(STATE, "0x83f3084f"), // connector()
    call(CONNECTOR, "0x53428253"), // moc()
    call(CONNECTOR, "0x12529f1f"), // mocState()
    call(CONNECTOR, "0x99c6fe73"), // docToken()
    call(STATE, "0xd298d9c9"), // getBtcPriceProvider()
    call(STATE, "0x96e4a037"), // collateralRbtcInSystem(): excludes retired leveraged positions
    call(STATE, "0x8bd11355"), // rbtcInSystem(): protocol accounting, not raw wallet balance
    { method: "eth_getBalance", params: [MOC, block.number] },
    call(STATE, "0xdf3d90b3"), // docTotalSupply()
    call(DOC, "0x18160ddd"), // totalSupply()
    call(STATE, "0x8300df49"), // getBitcoinPrice(): reverts if oracle invalid
    call(ORACLE, "0x330227bf"), // getPriceInfo(): price, validity, publication block
    call(STATE, "0x118fe752"), // globalLockedBitcoin(): senior DOC claim in rBTC
    call(STATE, "0xc94750a8"), // getRbtcRemainder(): residual junior BPRO buffer
    call(STATE, "0xc4ee19ea"), // globalCoverage()
    call(STATE, "0xc19d93fb"), // state(): Liquidated=0
    call(MOC, "0x5c975abb"), // paused()
    call(STATE, "0xa8ba1d18"), // freeDoc(): current fee-bearing redemption bound
    call(STATE, "0x7f19c56f"), // getLiq(): liquidation threshold
    call(STATE, "0x9214fa4d"), // getPeg()
    call(STATE, "0x06bdce8c"), // reserve precision
    call(STATE, "0xf715e293"), // MoC precision
    call(STATE, `0x04bda17f${"5832".padEnd(64, "0")}`), // X2 nBPro must remain zero
    call(STATE, "0xe480e5b9"), // getProtected(): free DOC redemption requires coverage strictly above this
  ];
  const values = await read("accounting", calls);
  if (!values || values.length !== calls.length) throw new Error(`${KEY}: incomplete accounting reads`);
  for (const [i, [, , expected]] of IMPLEMENTATIONS.entries()) {
    if (typeof values[i] !== "string" || implementationAddressFromSlot(values[i] as `0x${string}`) !== expected) {
      throw new Error(`${KEY}: unreviewed implementation ${i}`);
    }
  }
  for (const [offset, expected] of [CONNECTOR, MOC, STATE, DOC, ORACLE].entries()) {
    if (uint(values[4 + offset], "identity").toString(16).padStart(40, "0") !== expected.slice(2)) {
      throw new Error(`${KEY}: contract identity mismatch`);
    }
  }
  const nums = values.map((value, i) => i === 15 ? 0n : uint(value, `read ${i}`));
  const [, , , , , , , , , collateral, accounted, wallet, liability, supply, price, , locked, remainder,
    coverage, state, paused, freeDoc, liquidationThreshold, peg, reservePrecision, mocPrecision, leveraged, protectedThreshold] = nums;
  const oracleRaw = values[15];
  if (typeof oracleRaw !== "string" || !/^0x[0-9a-f]{192}$/i.test(oracleRaw)) throw new Error(`${KEY}: malformed oracle info`);
  const oracleWords = oracleRaw.slice(2).match(/.{64}/g)!.map((word) => BigInt(`0x${word}`));
  if (oracleWords[0] !== price || oracleWords[1] !== 1n || oracleWords[2] <= 0n || oracleWords[2] > BigInt(block.number)) {
    throw new Error(`${KEY}: invalid oracle price/publication`);
  }
  if (liability <= 0n || price <= 0n || supply !== liability || collateral !== accounted || leveraged !== 0n
    || peg !== 1n || reservePrecision !== WAD || mocPrecision !== WAD || state > 3n || paused > 1n
    || freeDoc > supply || liquidationThreshold < WAD || protectedThreshold < WAD) throw new Error(`${KEY}: unsupported accounting state`);
  const expectedLocked = liability * WAD / price;
  const expectedRemainder = accounted > locked ? accounted - locked : 0n;
  if (locked <= 0n || locked !== expectedLocked || remainder !== expectedRemainder
    || coverage !== collateral * WAD / locked) throw new Error(`${KEY}: DOC/BPRO accounting does not reconcile`);
  const closing = await read("closing-header", [{ method: "eth_getBlockByNumber", params: [block.number, false] }]);
  if (header(closing?.[0]).hash !== block.hash) throw new Error(`${KEY}: pinned block changed`);

  const warnings: LiveReserveWarning[] = [];
  // A custody deficit remains visible and caps collateral; unaccounted donations never inflate backing.
  const admitted = wallet < collateral ? wallet : collateral;
  if (wallet < collateral) warnings.push(reserveDegradedWarning("moc-doc-custody-deficit", "MoC rBTC balance is below accounted collateral"));
  const collateralizationRatio = Number(admitted * price) / Number(liability * WAD);
  if (collateralizationRatio < 1) warnings.push(reserveDegradedWarning("reserve-undercollateralized", "MoC rBTC collateral does not cover senior DOC liabilities"));
  if (state === 0n || paused === 1n || coverage < liquidationThreshold) {
    warnings.push(reserveDegradedWarning("moc-doc-protocol-state", "MoC is liquidated, paused, or below its liquidation coverage threshold"));
  }
  if (coverage <= protectedThreshold) {
    warnings.push(reserveDegradedWarning("moc-doc-protection-mode", "MoC free DOC redemption is disabled at or below the protection coverage threshold"));
  }
  const routeOpen = paused === 0n && state !== 0n && warnings.length === 0;
  return {
    slices: [{ sourceKey: "moc-doc:rbtc", name: "Rootstock BTC (rBTC) collateral", pct: 100, risk: "medium" }],
    ...(warnings.length ? { warnings } : {}),
    metadata: {
      ...notApplicableFreshnessMetadata(),
      totalReservesUsd: decimalNumberFromBigInt(admitted * price / WAD, 18),
      supplyUsd: decimalNumberFromBigInt(liability, 18),
      collateralizationRatio,
      details: {
        proofKind: "moc-v1-pinned-accounted-rbtc",
        blockNumber: Number(BigInt(block.number)), blockHash: block.hash, blockTimestamp: block.timestamp,
        oraclePublicationBlock: Number(oracleWords[2]), protocolBtcPriceUsd: decimalNumberFromBigInt(price, 18),
        accountedRbtcRaw: accounted.toString(), custodyRbtcRaw: wallet.toString(),
        docLockedRbtcRaw: locked.toString(), juniorBproResidualRbtcRaw: remainder.toString(),
        protocolCoverageRatio: Number(coverage) / 1e18,
        protectionCoverageRatio: Number(protectedThreshold) / 1e18,
        basis: "Protocol-oracle-valued accounted rBTC for senior DOC claims; BPRO is residual risk capital, not a second par liability",
      },
      redemption: {
        capacityUsd: routeOpen ? decimalNumberFromBigInt(freeDoc, 18) : 0,
        capacityKind: "live-direct", freshnessKind: "same-run-onchain", holderEligibility: "any-holder",
        settlementDelaySec: 0, routeStatus: paused === 1n ? "paused" : routeOpen ? "open" : "degraded",
        routeStatusSource: "onchain", routeStatusReason: "Pinned canonical MoC freeDoc(), pause and accounting health checks",
        sourceUrls: SOURCE_URLS,
      },
    },
  };
}
