import { keccak256, toFunctionSelector } from "viem/utils";
import type { ReserveAdapterCoin } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import {
  LenderBookObservationSchema,
  type LenderBookObservation,
  type LenderBookReason,
  type LenderDeploymentObservation,
  type LenderMarketObservation,
} from "@shared/types/safety-score-v9-lender-book";
import {
  deriveLenderBookObservationIdentity,
  canonicalizeLenderBookObservation,
} from "@shared/lib/safety-score-v9/lender-book-registry";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { WORKER_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import { canonicalEvmAddress } from "@shared/lib/evm-address";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import {
  fetchEvmBlockHeader,
  fetchEvmBlockHeaderAtTag,
  fetchEvmCodeStatusAtBlock,
  fetchEvmMulticall3Aggregate3AtBlock,
  MULTICALL3_ADDRESS,
  type EvmBlockHeader,
  type EvmMulticall3Call,
  type EvmRpcOptions,
} from "../../lib/evm-rpc";
import { encodeBalanceOfCallData, encodeUint256 } from "../../lib/evm-selectors";
import { decodeAbiWordAt, decodeStrictAddressWord, decodeUint256Word } from "./abi-decode";
import { runAdapterIo } from "./concurrency";
import type { AdapterContext } from "./types";
import { getCachedRequest } from "./request";

const ZERO = "0x0000000000000000000000000000000000000000";
const WAD = 10n ** 18n;
const VIRTUAL_SHARES = 1_000_000n;
const UINT256_MAX = (1n << 256n) - 1n;
const BOOK_ALLOWANCE_MS = 20_000;
// Leave room for the adapter's ordinary result to win the runner's outer race.
const BOOK_RETURN_MARGIN_MS = 250;
const bounds = V9_CANDIDATE_POLICY_V1.policy.semantic.backing.lenderCollateralBook;
type Kind = LenderDeploymentObservation["kind"];

class CensusFailure extends Error {
  constructor(readonly reason: LenderBookReason) { super(reason); }
}
function fail(reason: LenderBookReason): never { throw new CensusFailure(reason); }
function uint(raw: string | null | undefined): bigint {
  const value = decodeUint256Word(raw);
  if (value == null) fail("malformed");
  return value;
}
function address(raw: string | null | undefined): string {
  const value = decodeStrictAddressWord(raw);
  if (value == null) fail("malformed");
  return value.toLowerCase();
}
function words(raw: string | null | undefined, length: number): string[] {
  if (!raw || raw.length !== 2 + length * 64) fail("malformed");
  return Array.from({ length }, (_, i) => {
    const word = decodeAbiWordAt(raw, i);
    if (!word) fail("malformed");
    return word;
  });
}
function boundedCount(raw: string | null | undefined, max: number, reason: LenderBookReason = "census-limit"): number {
  const count = uint(raw);
  if (count > BigInt(max)) fail(reason);
  return Number(count);
}
function safeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail("malformed");
  return Number(value);
}
function checked(value: bigint): bigint {
  if (value < 0n || value > UINT256_MAX) fail("malformed");
  return value;
}
function call(target: string, signature: string, args = ""): EvmMulticall3Call {
  const callData = `${toFunctionSelector(signature)}${args}`;
  return { target, callData, label: `${target}:${callData}`, allowFailure: true };
}

function marketCalls(core: string, marketId: string, account: string, direct: boolean): EvmMulticall3Call[] {
  return [
    call(core, "idToMarketParams(bytes32)", marketId.slice(2)),
    call(core, "market(bytes32)", marketId.slice(2)),
    call(core, "position(bytes32,address)", `${marketId.slice(2)}${account.slice(2).padStart(64, "0")}`),
    ...(direct ? [
      call(account, "expectedSupplyAssets(bytes32)", marketId.slice(2)),
      call(account, "supplyShares(bytes32)", marketId.slice(2)),
    ] : []),
  ];
}

async function awaitPhaseRead<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) fail("aborted");
  let abort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([read(), aborted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** Source: morpho-blue MorphoBalancesLib.expectedMarketBalances / SharesMathLib.
 * The Taylor terms and fee shares deliberately preserve Solidity's integer order.
 */
export function accruedMorphoLenderAssets(input: {
  supplyAssets: bigint; supplyShares: bigint; borrowAssets: bigint; fee: bigint;
  lastUpdateSec: number; timestampSec: number; borrowRate: bigint; positionShares: bigint;
}): bigint {
  if (input.lastUpdateSec > input.timestampSec || input.fee > WAD) fail("malformed");
  const x = checked(input.borrowRate * BigInt(input.timestampSec - input.lastUpdateSec));
  const x2 = checked(x * x) / (2n * WAD);
  const x3 = checked(x2 * x) / (3n * WAD);
  const interest = checked(input.borrowAssets * checked(x + x2 + x3)) / WAD;
  const expectedAssets = checked(input.supplyAssets + interest);
  const feeAssets = checked(interest * input.fee) / WAD;
  const feeShares = checked(feeAssets * checked(input.supplyShares + VIRTUAL_SHARES))
    / checked(expectedAssets - feeAssets + 1n);
  return checked(input.positionShares * checked(expectedAssets + 1n))
    / checked(input.supplyShares + feeShares + VIRTUAL_SHARES);
}

/** One serial I/O phase. Helpers fully consume bounded JSON bodies before return,
 * including provider and direct-call fallbacks. Cache scope is the reserve run only.
 */
class PinnedReader {
  readonly selectors = new Set<string>();
  readonly codeHashes: Record<string, string> = {};
  readonly marketIds = new Set<string>();
  readonly claims = new Set<string>();
  private readonly localReads = new Map<string, Promise<unknown>>();
  private readonly transportCodeHashes: Record<string, string | null> = {};
  constructor(
    readonly chain: string,
    readonly pin: EvmBlockHeader,
    readonly signal: AbortSignal,
    readonly ctx: AdapterContext | undefined,
    readonly deadlineMs: number,
    readonly extraRpcUrls: string[],
  ) {}
  options(): EvmRpcOptions {
    if (this.signal.aborted) fail("aborted");
    const remaining = this.deadlineMs - Date.now();
    if (remaining <= 0) fail("deadline");
    return {
      chainRpcs: this.ctx?.chainRpcs, signal: this.signal,
      extraRpcUrls: this.extraRpcUrls, timeoutMs: Math.min(12_000, remaining),
      deadlineMs: this.deadlineMs, maxRetries: 0, multicallBatchSize: bounds.rpcBatchCalls,
      stateBlockHash: this.pin.hash, multicallFallbackBlockHash: this.pin.hash,
    };
  }
  async io<T>(label: string, work: (options: EvmRpcOptions) => Promise<T>): Promise<T> {
    const result = await awaitPhaseRead(
      () => runAdapterIo(this.ctx, label, () => work(this.options()), { signal: this.signal }),
      this.signal,
    );
    this.options();
    return result;
  }
  async readCodeHash(target: string): Promise<string | null> {
    if (Object.prototype.hasOwnProperty.call(this.transportCodeHashes, target)) return this.transportCodeHashes[target];
    // Only a successful hash-pinned observation is reusable. Null here is
    // observed absent code, never an unavailable RPC or a "latest" assumption.
    const hash = await awaitPhaseRead(() => getCachedRequest(
      `morpho-book-code:${this.chain}:${this.pin.hash}:${target}`,
      async () => {
        const result = await this.io(`lender-book-code:${this.chain}:${target}`, options =>
          fetchEvmCodeStatusAtBlock(this.chain, target, this.pin.number, options));
        if (result.status === "unavailable") fail("rpc-unavailable");
        const value = result.status === "absent" ? null : keccak256(result.code).toLowerCase();
        return { value, cacheBytes: value == null ? 4 : value.length * 2, basis: "declared-estimate" as const };
      },
      this.ctx,
    ), this.signal);
    this.options();
    this.transportCodeHashes[target] = hash;
    return hash;
  }
  async code(target: string): Promise<void> {
    if (this.codeHashes[target]) return;
    const hash = await this.readCodeHash(target);
    if (hash == null) fail("identity-mismatch");
    this.codeHashes[target] = hash;
  }
  async read(calls: EvmMulticall3Call[]): Promise<(string | null)[]> {
    for (const row of calls) this.selectors.add(row.callData.slice(0, 10));
    const cache = this.ctx?.requestCache ?? this.localReads;
    const key = (row: EvmMulticall3Call) => `morpho-book:${this.chain}:${this.pin.hash}:${row.target}:${row.callData}`;
    const missing = [...new Map(calls.filter(row => !cache.has(key(row))).map(row => [key(row), row])).values()];
    const local = new Map<string, string | null>();
    const multicallPresent = missing.length > 0
      ? (await this.readCodeHash(MULTICALL3_ADDRESS)) !== null
      : false;
    for (let start = 0; start < missing.length; start += bounds.rpcBatchCalls) {
      const batch = missing.slice(start, start + bounds.rpcBatchCalls);
      const results = await this.io(`lender-book-batch:${this.chain}`, options =>
        fetchEvmMulticall3Aggregate3AtBlock(this.chain, batch, this.pin.number, {
          ...options,
          // Present code was positively read at this hash. Avoid repeating its
          // eth_getCode before every wave; EIP-1898 state pinning stays enabled.
          // Absent deployments retain the transport's direct-call + recheck path.
          multicallFallbackBlockHash: multicallPresent ? undefined : this.pin.hash,
        }));
      if (!results) fail("rpc-unavailable");
      if (results.length !== batch.length || new Set(results.map(row => row.label)).size !== batch.length) fail("incomplete-census");
      const byLabel = new Map(results.map(row => [row.label, row]));
      for (const row of batch) {
        const result = byLabel.get(row.label);
        if (!result) fail("incomplete-census");
        const value = result.success ? result.returnData.toLowerCase() : null;
        local.set(key(row), value);
        cache.set(key(row), Promise.resolve(value));
      }
    }
    return Promise.all(calls.map(async row => {
      if (local.has(key(row))) return local.get(key(row)) ?? null;
      const cached = await cache.get(key(row));
      if (cached !== null && typeof cached !== "string") fail("malformed");
      return cached;
    }));
  }
  async required(calls: EvmMulticall3Call[], reason: LenderBookReason = "incomplete-census"): Promise<string[]> {
    const results = await this.read(calls);
    return results.map(value => value ?? fail(reason));
  }
  async enumerate(target: string, lengthSignature: string, itemSignature: string, max: number): Promise<string[]> {
    const [length] = await this.required([call(target, lengthSignature)]);
    const count = boundedCount(length, max);
    return this.required(Array.from({ length: count }, (_, i) => call(target, itemSignature, encodeUint256(i))));
  }
  async prefetchMarkets(core: string, ids: string[], account: string, direct: boolean): Promise<void> {
    // Enumeration fixes the complete set first. Read all known independent
    // market/position tuples in bounded waves, then dependent IRM probes.
    // market() still validates every claim and performs the exact accounting.
    const marketKeys = new Set(this.marketIds);
    for (const id of ids) marketKeys.add(`${core}:${id}`);
    if (marketKeys.size > bounds.maxMarketsPerDeployment) fail("census-limit");
    const width = direct ? 5 : 3;
    const results = await this.required(ids.flatMap(id => marketCalls(core, id, account, direct)));
    if (direct) return;
    const rates: EvmMulticall3Call[] = [];
    for (let index = 0; index < ids.length; index++) {
      const paramsRaw = results[index * width];
      const stateRaw = results[index * width + 1];
      const params = words(paramsRaw, 5);
      const state = words(stateRaw, 6).map(uint);
      const irm = address(params[3]);
      if (state[2] > 0n && this.pin.timestamp > safeNumber(state[4]) && irm !== ZERO) {
        rates.push(call(irm,
          "borrowRateView((address,address,address,address,uint256),(uint128,uint128,uint128,uint128,uint128,uint128))",
          `${paramsRaw.slice(2)}${stateRaw.slice(2)}`));
      }
    }
    await this.required(rates, "unsupported-irm");
  }
  async market(core: string, marketId: string, account: string, adapter: string | null, loan: string, direct: boolean): Promise<LenderMarketObservation | null> {
    const key = `${core}:${marketId}`;
    const claimKey = `${key}:${account}`;
    if (this.claims.has(claimKey)) fail("incomplete-census");
    this.claims.add(claimKey);
    this.marketIds.add(key);
    if (this.marketIds.size > bounds.maxMarketsPerDeployment) fail("census-limit");
    await this.code(core);
    const [paramsRaw, stateRaw, positionRaw, expectedRaw, internalSharesRaw] =
      await this.required(marketCalls(core, marketId, account, direct));
    const p = words(paramsRaw, 5);
    const s = words(stateRaw, 6).map(uint);
    const pos = words(positionRaw, 3).map(uint);
    if (s.some(value => value >= (1n << 128n)) || pos[1] >= (1n << 128n) || pos[2] >= (1n << 128n)) fail("malformed");
    const [loanToken, collateralToken, oracle, irm] = p.slice(0, 4).map(address);
    const lltv = uint(p[4]);
    if (loanToken !== loan || lltv > WAD || s[5] > WAD || safeNumber(s[4]) > this.pin.timestamp) fail("identity-mismatch");
    // A default mapping value is not a verified queue sentinel. Real MetaMorpho
    // idle markets keep the loan token and market hash; their lender claim remains
    // a claim, not root wallet cash. A genuine debt-bearing zero-collateral market
    // has no liquidation buffer and must survive as unsecured exposure.
    if (keccak256(paramsRaw as `0x${string}`).toLowerCase() !== marketId) fail("identity-mismatch");
    if (pos[1] !== 0n || pos[2] !== 0n) fail("position-not-lender-only");
    if (pos[0] > s[1]) fail("identity-mismatch");
    let included: bigint;
    if (direct) {
      included = uint(expectedRaw);
      // Legacy and V2 adapters value their internal recorded shares. Donated
      // or burnt-away Blue shares are not automatically NAV-accounted claims.
      const internalShares = uint(internalSharesRaw);
      if (internalShares > pos[0] || (internalShares === 0n && included !== 0n)) fail("identity-mismatch");
    } else {
      let rate = 0n;
      if (s[2] > 0n && this.pin.timestamp > safeNumber(s[4])) {
        if (irm === ZERO) fail("unsupported-irm");
        await this.code(irm);
        const [rateRaw] = await this.required([
          call(irm, "borrowRateView((address,address,address,address,uint256),(uint128,uint128,uint128,uint128,uint128,uint128))", `${paramsRaw.slice(2)}${stateRaw.slice(2)}`),
        ], "unsupported-irm");
        rate = uint(rateRaw);
      }
      included = accruedMorphoLenderAssets({ supplyAssets: s[0], supplyShares: s[1], borrowAssets: s[2],
        fee: s[5], lastUpdateSec: safeNumber(s[4]), timestampSec: this.pin.timestamp, borrowRate: rate, positionShares: pos[0] });
    }
    if (collateralToken === ZERO && s[2] === 0n) {
      // Morpho's loan-token / zero collateral / zero oracle / zero IRM / zero
      // LLTV idle market: source-defined non-borrowable idle supply. The caller
      // carries the exactly measured claim into idle rather than credit exposure.
      if (oracle !== ZERO || irm !== ZERO || lltv !== 0n) fail("incomplete-census");
      return null;
    }
    if (collateralToken === ZERO && (oracle !== ZERO || lltv !== 0n)) fail("malformed");
    return {
      account, adapter, morpho: core, marketId, loanToken, collateralToken, oracle, irm, lltvRaw: lltv.toString(),
      supplySharesRaw: pos[0].toString(), positionBorrowSharesRaw: pos[1].toString(), positionCollateralRaw: pos[2].toString(),
      marketSupplyAssetsRaw: s[0].toString(), marketSupplySharesRaw: s[1].toString(), marketBorrowAssetsRaw: s[2].toString(),
      marketBorrowSharesRaw: s[3].toString(), marketLastUpdateSec: safeNumber(s[4]), marketFeeRaw: s[5].toString(),
      includedAssetsRaw: included.toString(), accruedMethod: direct ? "adapter-expected-supply-assets" : "morpho-blue-expected-balances",
      collateralMode: collateralToken === ZERO ? "unsecured" : "collateralized",
    };
  }
}

interface Partition { idle: bigint; markets: LenderMarketObservation[]; total: bigint }
async function metaMorpho(reader: PinnedReader, vault: string, loan: string, adapter: string | null): Promise<Partition> {
  await reader.code(vault);
  const [assetRaw, coreRaw, totalRaw, cashRaw, withdrawLengthRaw, supplyLengthRaw] = await reader.required([
    call(vault, "asset()"), call(vault, "MORPHO()"), call(vault, "totalAssets()"),
    { target: loan, callData: encodeBalanceOfCallData(vault), label: `${loan}:cash:${vault}`, allowFailure: true },
    call(vault, "withdrawQueueLength()"), call(vault, "supplyQueueLength()"),
  ]);
  if (address(assetRaw) !== loan) fail("identity-mismatch");
  const core = address(coreRaw);
  if (core === ZERO) fail("identity-mismatch");
  const withdrawLength = boundedCount(withdrawLengthRaw, bounds.maxMarketsPerDeployment);
  const supplyLength = boundedCount(supplyLengthRaw, bounds.maxMarketsPerDeployment);
  const queues = await reader.required([
    ...Array.from({ length: withdrawLength }, (_, i) => call(vault, "withdrawQueue(uint256)", encodeUint256(i))),
    ...Array.from({ length: supplyLength }, (_, i) => call(vault, "supplyQueue(uint256)", encodeUint256(i))),
  ]);
  const withdraw = queues.slice(0, withdrawLength);
  const supply = queues.slice(withdrawLength);
  const ids = [...new Set([...withdraw, ...supply])].sort();
  if (new Set(withdraw).size !== withdraw.length || new Set(supply).size !== supply.length) fail("incomplete-census");
  if (ids.length > bounds.maxMarketsPerDeployment) fail("census-limit");
  // MetaMorpho.totalAssets sums the withdraw queue only. Supply-only positions
  // must be successfully read but may not be silently added to that denominator.
  const markets: LenderMarketObservation[] = [];
  // MetaMorpho V1/V1.1 totalAssets includes only withdraw-queue claims.
  // Wallet donations are skimmable (MetaMorpho.sol totalAssets/skim), not NAV.
  // Still require and decode the balance read; it is not book-accounted idle.
  uint(cashRaw);
  let idle = 0n;
  await reader.prefetchMarkets(core, ids, vault, false);
  for (const id of ids) {
    const row = await reader.market(core, id, vault, adapter, loan, false);
    if (row) {
      if (!withdraw.includes(id) && BigInt(row.includedAssetsRaw) !== 0n) fail("unreconciled");
      markets.push(row);
    } else {
      const [p, s, pos] = await reader.required([call(core, "idToMarketParams(bytes32)", id.slice(2)), call(core, "market(bytes32)", id.slice(2)),
        call(core, "position(bytes32,address)", `${id.slice(2)}${vault.slice(2).padStart(64, "0")}`)]);
      const state = words(s, 6).map(uint);
      const position = words(pos, 3).map(uint);
      const amount = accruedMorphoLenderAssets({ supplyAssets: state[0], supplyShares: state[1], borrowAssets: state[2], fee: state[5],
        lastUpdateSec: safeNumber(state[4]), timestampSec: reader.pin.timestamp, borrowRate: 0n, positionShares: position[0] });
      if (!withdraw.includes(id) && amount !== 0n) fail("unreconciled");
      if (address(words(p, 5)[0]) !== loan) fail("identity-mismatch");
      idle += amount;
    }
  }
  const total = uint(totalRaw);
  if (idle + markets.reduce((sum, row) => sum + BigInt(row.includedAssetsRaw), 0n) !== total) fail("unreconciled");
  return { idle, markets, total };
}

async function deployment(reader: PinnedReader, vault: string, kind: Kind, parentTokens: string[]): Promise<LenderDeploymentObservation> {
  await reader.code(vault);
  const [loanRaw, totalRaw, supplyRaw] = await reader.required([
    call(vault, "asset()"), call(vault, "totalAssets()"), call(vault, "totalSupply()"),
    ...(kind === "vault-v2"
      ? [call(vault, "adaptersLength()"), call(vault, "_totalAssets()"), call(vault, "lastUpdate()"), call(vault, "maxRate()")]
      : [call(vault, "MORPHO()"), call(vault, "withdrawQueueLength()"), call(vault, "supplyQueueLength()")]),
  ]);
  const loan = address(loanRaw);
  if (!parentTokens.includes(loan)) fail("identity-mismatch");
  await reader.code(loan);
  const [decimalsRaw, cashRaw] = await reader.required([call(loan, "decimals()"),
    { target: loan, callData: encodeBalanceOfCallData(vault), label: `${loan}:cash:${vault}`, allowFailure: true }]);
  const decimals = boundedCount(decimalsRaw, 36, "malformed");
  const total = uint(totalRaw);
  if (total === 0n) fail("zero-nav");
  let idle = uint(cashRaw);
  let bookTotal = total;
  let v2Accounting: Pick<LenderDeploymentObservation, "realAssetsRaw" | "undistributedAssetsRaw"> = {};
  const markets: LenderMarketObservation[] = [];
  if (kind !== "vault-v2") {
    const inner = await metaMorpho(reader, vault, loan, null);
    idle = inner.idle;
    markets.push(...inner.markets);
  } else {
    const adapters = (await reader.enumerate(vault, "adaptersLength()", "adapters(uint256)", bounds.maxAdapters)).map(address);
    if (new Set(adapters).size !== adapters.length) fail("incomplete-census");
    // These probes depend only on the now-complete adapter enumeration. Keep
    // unsupported-kind disambiguation and parent/amount checks below unchanged.
    await reader.read(adapters.flatMap(adapter => [
      call(adapter, "parentVault()"), call(adapter, "realAssets()"),
      { target: loan, callData: encodeBalanceOfCallData(adapter), label: `${loan}:cash:${adapter}`, allowFailure: true },
      call(adapter, "asset()"), call(adapter, "morpho()"), call(adapter, "marketIdsLength()"), call(adapter, "morphoVaultV1()"),
    ]));
    let realAssets = idle;
    for (const adapter of adapters) {
      await reader.code(adapter);
      const [parentRaw, realRaw, cashRaw] = await reader.required([
        call(adapter, "parentVault()"), call(adapter, "realAssets()"),
        { target: loan, callData: encodeBalanceOfCallData(adapter), label: `${loan}:cash:${adapter}`, allowFailure: true },
      ], "unsupported-adapter");
      // Both supported adapter sources exclude donated wallet cash from their
      // realAssets formula. Read it, but never turn it into NAV-accounted idle.
      uint(cashRaw);
      if (address(parentRaw) !== vault) fail("identity-mismatch");
      const real = uint(realRaw);
      realAssets = checked(realAssets + real);
      const [assetRaw, coreRaw, lengthRaw, innerRaw] = await reader.read([
        call(adapter, "asset()"), call(adapter, "morpho()"), call(adapter, "marketIdsLength()"), call(adapter, "morphoVaultV1()"),
      ]);
      let included = 0n;
      if (assetRaw !== null && coreRaw !== null && lengthRaw !== null && innerRaw === null) {
        if (address(assetRaw) !== loan || address(coreRaw) === ZERO) fail("identity-mismatch");
        const count = boundedCount(lengthRaw, bounds.maxMarketsPerDeployment);
        const ids = await reader.required(Array.from({ length: count }, (_, i) => call(adapter, "marketIds(uint256)", encodeUint256(i))));
        if (new Set(ids).size !== ids.length) fail("incomplete-census");
        await reader.prefetchMarkets(address(coreRaw), ids, adapter, true);
        for (const id of ids) {
          const row = await reader.market(address(coreRaw), id, adapter, adapter, loan, true);
          if (!row) fail("unsupported-adapter");
          included += BigInt(row.includedAssetsRaw);
          markets.push(row);
        }
      } else if (innerRaw !== null && assetRaw === null && coreRaw === null && lengthRaw === null) {
        const innerVault = address(innerRaw);
        if (innerVault === vault || innerVault === adapter || innerVault === ZERO) fail("identity-mismatch");
        const inner = await metaMorpho(reader, innerVault, loan, adapter);
        const [sharesRaw, supplyRaw, offsetRaw, feeRaw, lastRaw, allocationRaw] = await reader.required([
          { target: innerVault, callData: encodeBalanceOfCallData(adapter), label: `${innerVault}:shares:${adapter}`, allowFailure: true },
          call(innerVault, "totalSupply()"), call(innerVault, "DECIMALS_OFFSET()"),
          call(innerVault, "fee()"), call(innerVault, "lastTotalAssets()"), call(adapter, "allocation()"),
        ]);
        const shares = uint(sharesRaw);
        const innerSupply = uint(supplyRaw);
        const offset = boundedCount(offsetRaw, 36, "malformed");
        const fee = uint(feeRaw);
        if (shares > innerSupply || fee > WAD) fail("identity-mismatch");
        const virtualShares = 10n ** BigInt(offset);
        const lastTotal = uint(lastRaw);
        const interest = inner.total > lastTotal ? inner.total - lastTotal : 0n;
        const feeAssets = interest * fee / WAD;
        const feeShares = feeAssets * (innerSupply + virtualShares) / (inner.total - feeAssets + 1n);
        const denominator = innerSupply + feeShares + virtualShares;
        const activeShares = uint(allocationRaw) === 0n ? 0n : shares;
        // Source c034336f82b0415f786fa15fc61fa81bf5256e31:
        // MorphoVaultV1Adapter.realAssets has an allocation-zero accounting gate.
        // MetaMorpho's conversion includes pending fee shares and virtual offsets.
        // previewRedeem only cross-checks that exact convention; no preview is a
        // substitute for the independently accrued, exhaustively read inner book.
        const [previewRaw] = await reader.required([call(innerVault, "previewRedeem(uint256)", encodeUint256(shares))]);
        const expectedPreview = shares * (inner.total + 1n) / denominator;
        if (uint(previewRaw) !== expectedPreview || real !== activeShares * (inner.total + 1n) / denominator) fail("unreconciled");
        const ownedIdle = inner.idle * activeShares / denominator;
        idle += ownedIdle;
        included += ownedIdle;
        for (const row of inner.markets) {
          const owned = BigInt(row.includedAssetsRaw) * activeShares / denominator;
          included += owned;
          markets.push({ ...row, includedAssetsRaw: owned.toString() });
        }
        // Per-claim rounding and virtual-asset residuals are never plugged.
      } else {
        fail("unsupported-adapter");
      }
      if (included !== real) fail("unreconciled");
    }
    const [storedRaw, lastRaw, maxRateRaw] = await reader.required([
      call(vault, "_totalAssets()"), call(vault, "lastUpdate()"), call(vault, "maxRate()"),
    ]);
    const stored = uint(storedRaw);
    const last = uint(lastRaw);
    const maxRate = uint(maxRateRaw);
    if (stored >= (1n << 128n) || last >= (1n << 64n) || maxRate >= (1n << 64n) || last > BigInt(reader.pin.timestamp)) fail("malformed");
    // VaultV2.accrueInterestView distributes at most maxRate. Its measured
    // investment book includes the undistributed buffer; never invent a
    // market-specific deduction or move that buffer into wallet idle.
    const maxTotal = checked(stored + checked(checked(stored * (BigInt(reader.pin.timestamp) - last)) * maxRate) / WAD);
    if (total !== (realAssets < maxTotal ? realAssets : maxTotal)) fail("unreconciled");
    bookTotal = realAssets;
    v2Accounting = { realAssetsRaw: realAssets.toString(), undistributedAssetsRaw: (realAssets - total).toString() };
  }
  const reconciled = idle + markets.reduce((sum, row) => sum + BigInt(row.includedAssetsRaw), 0n);
  if (reconciled !== bookTotal) fail("unreconciled");
  return {
    chain: reader.chain, vault, kind,
    pin: { chain: reader.chain, number: reader.pin.number, hash: reader.pin.hash, timestampSec: reader.pin.timestamp, finality: "finalized" },
    loanToken: loan, loanDecimals: decimals, totalAssetsRaw: total.toString(), totalSupplyRaw: uint(supplyRaw).toString(),
    ...v2Accounting,
    idleAssetsRaw: idle.toString(), reconciledAssetsRaw: reconciled.toString(), reconciliationResidualRaw: (bookTotal - reconciled).toString(),
    codeHashes: reader.codeHashes, selectorsRead: [...reader.selectors].sort(), markets,
  };
}

export async function observeMorphoLenderBook(
  coin: ReserveAdapterCoin,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<LenderBookObservation> {
  const startedMs = Date.now();
  const deadlineMs = Math.min(
    startedMs + BOOK_ALLOWANCE_MS,
    (ctx?.attemptDeadlineMs ?? Infinity) - BOOK_RETURN_MARGIN_MS,
  );
  const timeout = createTimeoutSignal({
    timeoutMs: Math.max(0, deadlineMs - startedMs),
    timeoutReason: new CensusFailure("deadline"),
    parentSignal: AbortSignal.any([signal, ...(ctx?.abortSignal ? [ctx.abortSignal] : [])]),
  });
  const phaseSignal = timeout.signal;
  let failedDeploymentKey: string | null = null;
  const base = { schemaVersion: 1 as const, assetId: coin.id, maxAgeSec: bounds.observationMaxAgeSec };
  try {
    if (signal.aborted || ctx?.abortSignal?.aborted) fail("aborted");
    if (Date.now() >= deadlineMs) fail("deadline");
    const admission = bounds.admittedAssets.find(row => row.assetId === coin.id);
    if (!admission || config.adapter !== "erc4626-single-asset") fail("identity-mismatch");
    const params = parseLiveReserveAdapterParams("erc4626-single-asset", config.params);
    const meta = WORKER_TRACKED_META_BY_ID.get(coin.id);
    const parent = meta?.pegReferenceId ? WORKER_TRACKED_META_BY_ID.get(meta.pegReferenceId) : undefined;
    if (!parent) fail("identity-mismatch");
    const deployments: LenderDeploymentObservation[] = [];
    for (const admitted of admission.deployments) {
      const contracts = coin.contracts?.filter(row => row.chain === admitted.chain) ?? [];
      if (contracts.length !== 1) fail("identity-mismatch");
      const vault = canonicalEvmAddress(contracts[0].address);
      if (!vault) fail("identity-mismatch");
      const catalogVaults = meta?.contracts?.filter(row => row.chain === admitted.chain) ?? [];
      if (catalogVaults.length !== 1 || canonicalEvmAddress(catalogVaults[0].address) !== vault) fail("identity-mismatch");
      failedDeploymentKey = `${admitted.chain}:${vault}`;
      const chainConfig = ctx?.chainRpcs?.get(admitted.chain);
      if (!chainConfig || chainConfig.type !== "evm") fail("unsupported-chain");
      const extraRpcUrls = config.inputs.primary.kind === "onchain-evm" && config.inputs.primary.chain === admitted.chain
        ? [params.rpcUrl, params.fallbackRpcUrl].filter((value): value is string => Boolean(value)) : [];
      const options: EvmRpcOptions = { chainRpcs: ctx?.chainRpcs, signal: phaseSignal, extraRpcUrls,
        timeoutMs: Math.min(12_000, Math.max(1, deadlineMs - Date.now())), deadlineMs, maxRetries: 0 };
      const pinKey = `morpho-book:finalized:${admitted.chain}`;
      let pinPromise = ctx?.requestCache?.get(pinKey) as Promise<EvmBlockHeader | null> | undefined;
      if (!pinPromise) {
        pinPromise = runAdapterIo(ctx, pinKey, () => fetchEvmBlockHeaderAtTag(admitted.chain, "finalized", options), { signal: phaseSignal });
        ctx?.requestCache?.set(pinKey, pinPromise);
      }
      // A shared pending pin may belong to another attempt's longer budget.
      const pin = await awaitPhaseRead(() => pinPromise, phaseSignal);
      if (!pin) fail("rpc-unavailable");
      const reader = new PinnedReader(admitted.chain, pin, phaseSignal, ctx, deadlineMs, extraRpcUrls);
      const parentTokens = (parent.contracts ?? []).filter(row => row.chain === admitted.chain)
        .map(row => canonicalEvmAddress(row.address)).filter((value): value is `0x${string}` => value !== null);
      const observed = await deployment(reader, vault, admitted.kind, parentTokens);
      const header = await reader.io(`lender-book-recheck:${admitted.chain}`, rpcOptions =>
        fetchEvmBlockHeader(admitted.chain, pin.number, rpcOptions));
      if (!header) fail("rpc-unavailable");
      if (header.hash !== pin.hash || header.timestamp !== pin.timestamp) fail("block-changed");
      deployments.push(observed);
    }
    const payload = { ...base, acquiredAtSec: Math.floor(Date.now() / 1000), status: "ok" as const, censusScope: "complete-nav-accounted-current-book" as const, deployments };
    const canonical = canonicalizeLenderBookObservation({ ...payload, ...deriveLenderBookObservationIdentity(payload) });
    return LenderBookObservationSchema.parse(canonical);
  } catch (error) {
    const reason: LenderBookReason = signal.aborted || ctx?.abortSignal?.aborted ? "aborted"
      : phaseSignal.aborted || Date.now() >= deadlineMs ? "deadline"
      : error instanceof CensusFailure ? error.reason : "malformed";
    const payload = { ...base, acquiredAtSec: Math.floor(Date.now() / 1000), status: "unavailable" as const, reason, failedDeploymentKey, deployments: null };
    return LenderBookObservationSchema.parse({ ...payload, ...deriveLenderBookObservationIdentity(payload) });
  } finally {
    timeout.dispose();
  }
}
