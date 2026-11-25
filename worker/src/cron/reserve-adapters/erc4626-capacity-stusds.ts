import { decodeAbiWordAt, decodeStrictAddressWord, decodeUint256Word } from "./abi-decode";
import { fetchOnchainMulticall3 } from "./helpers";
import { multicallResultOrNull } from "./erc4626";
import { MULTICALL3_ADDRESS } from "../../lib/evm-rpc";
import {
  probeFailure, routeForSource, type CapacityProbeResult, type Erc4626RedemptionLiquidityConfig,
  type ObserveConfiguredErc4626CapacityInput,
} from "./erc4626-capacity-observation";

type StusdsConfig = Extract<Erc4626RedemptionLiquidityConfig, { source: "stusds-unused-funds" }>;
type StusdsProbeInput = Pick<ObserveConfiguredErc4626CapacityInput,
  "coinId" | "contractAddress" | "signal" | "ctx" | "chain" | "rpcUrl" | "fallbackRpcUrl" | "timeoutMs"> & {
  config: StusdsConfig;
};

const RAY = 10n ** 27n;
const MAX_UINT256 = (1n << 256n) - 1n;
const TOTAL_ASSETS = "0x01e1d114";
const VAT = "0x36569e77";
const JUG = "0x84718d89";
const CLIP = "0x39b00e41";
const ILK = "0xc5ce281e";
const ILKS = "0xd9638d36";
const DUE = "0x08bf162f";
const BLOCK_TIMESTAMP = "0x0f28c97d";
// Jug accrual older than this is implausible for a live Lockstake ilk (drip runs
// on every stUSDS deposit/withdraw); refuse it rather than exponentiate it.
const MAX_ACCRUAL_AGE_SEC = 365n * 86_400n;

/**
 * Maker DSMath rpow over RAY, matching StUsds/Jug rounding. Returns null where
 * the Solidity version would revert on uint256 overflow, which also bounds the
 * BigInt size a corrupt duty word could otherwise grow to.
 */
export function rpowRay(x: bigint, n: bigint): bigint | null {
  if (x === 0n) return n === 0n ? RAY : 0n;
  let z = n % 2n === 1n ? x : RAY;
  const half = RAY / 2n;
  let base = x;
  for (let k = n / 2n; k > 0n; k /= 2n) {
    const squared = base * base + half;
    if (squared > MAX_UINT256) return null;
    base = squared / RAY;
    if (k % 2n === 1n) {
      const product = z * base + half;
      if (product > MAX_UINT256) return null;
      z = product / RAY;
    }
  }
  return z;
}

/**
 * Same-block stUSDS withdrawable USDS: totalAssets() (chi accrued to the block)
 * minus Lockstake debt (Art × Jug-accrued rate) and USDS still owed in auction.
 * A read or wiring failure fails closed; the caller never substitutes the
 * encumbered idle balance (ADR-29).
 */
export async function fetchStusdsUnusedFundsCapacity(input: StusdsProbeInput): Promise<CapacityProbeResult> {
  const { config } = input;
  const ilk = config.ilk.slice(2).toLowerCase();
  const results = await fetchOnchainMulticall3({
    calls: [
      { label: "total-assets", contract: input.contractAddress, data: TOTAL_ASSETS },
      { label: "vat", contract: input.contractAddress, data: VAT },
      { label: "jug", contract: input.contractAddress, data: JUG },
      { label: "clip", contract: input.contractAddress, data: CLIP },
      { label: "ilk", contract: input.contractAddress, data: ILK },
      { label: "vat-ilks", contract: config.vatAddress, data: `${ILKS}${ilk}` },
      { label: "jug-ilks", contract: config.jugAddress, data: `${ILKS}${ilk}` },
      { label: "due", contract: config.clipperAddress, data: DUE },
      { label: "timestamp", contract: MULTICALL3_ADDRESS, data: BLOCK_TIMESTAMP },
    ],
    signal: input.signal,
    ctx: input.ctx,
    chain: input.chain,
    rpcUrl: input.rpcUrl,
    fallbackRpcUrl: input.fallbackRpcUrl,
    timeoutMs: input.timeoutMs,
  });
  const read = (label: string) => multicallResultOrNull(results, label);
  const wiring = [
    [decodeStrictAddressWord(read("vat")), config.vatAddress],
    [decodeStrictAddressWord(read("jug")), config.jugAddress],
    [decodeStrictAddressWord(read("clip")), config.clipperAddress],
    [decodeUint256Word(read("ilk")) == null ? null : read("ilk")!.toLowerCase(), config.ilk.toLowerCase()],
  ] as const;
  if (wiring.some(([observed]) => observed == null)) {
    return probeFailure("stusds-unused-funds-unavailable", `stUSDS Vat/Jug/Clipper/ilk wiring could not be read for ${input.coinId}`);
  }
  if (wiring.some(([observed, expected]) => observed !== expected.toLowerCase())) {
    return probeFailure("stusds-wiring-mismatch", `stUSDS Vat/Jug/Clipper/ilk wiring did not match the reviewed values for ${input.coinId}`);
  }
  const totalAssetsRaw = decodeUint256Word(read("total-assets"));
  const vatIlks = read("vat-ilks");
  const jugIlks = read("jug-ilks");
  const art = decodeUint256Word(decodeAbiWordAt(vatIlks, 0));
  const rate = decodeUint256Word(decodeAbiWordAt(vatIlks, 1));
  const duty = decodeUint256Word(decodeAbiWordAt(jugIlks, 0));
  const rho = decodeUint256Word(decodeAbiWordAt(jugIlks, 1));
  const due = decodeUint256Word(read("due"));
  const now = decodeUint256Word(read("timestamp"));
  if (totalAssetsRaw == null || art == null || rate == null || duty == null || rho == null || due == null || now == null ||
    duty < RAY || rate < RAY || rho === 0n || rho > now || now - rho > MAX_ACCRUAL_AGE_SEC) {
    return probeFailure("stusds-unused-funds-unavailable", `stUSDS unused-funds probe could not read Vat/Jug/Clipper state for ${input.coinId}`);
  }
  const growth = now > rho ? rpowRay(duty, now - rho) : RAY;
  const accruedRate = growth === null ? null : growth * rate / RAY;
  if (accruedRate === null || accruedRate > MAX_UINT256) {
    return probeFailure("stusds-unused-funds-unavailable", `stUSDS Jug accrual overflowed uint256 for ${input.coinId}`);
  }
  const encumberedRad = art * accruedRate + due;
  const assetsRad = totalAssetsRaw * RAY;
  const withdrawableRaw = assetsRad > encumberedRad ? (assetsRad - encumberedRad) / RAY : 0n;
  return {
    capacityRaw: withdrawableRaw,
    warnings: [],
    route: routeForSource("stusds-unused-funds"),
    diagnostics: {},
    telemetry: { stusdsUnusedFundsRaw: withdrawableRaw.toString() },
  };
}
