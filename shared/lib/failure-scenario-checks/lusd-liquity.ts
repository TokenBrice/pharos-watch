import { formatUnits, keccak256, parseAbi } from "viem";
import {
  requireScenarioChain,
  scenarioSourceAddress,
  type ScenarioCheck,
  type ScenarioCheckContext,
  type ScenarioChainContext,
  type ScenarioCheckValue,
} from "./index";

const ADDRESS_ABI = parseAbi([
  "function owner() view returns (address)",
  "function priceAggregator() view returns (address)",
  "function tellorCaller() view returns (address)",
  "function tellor() view returns (address)",
  "function priceFeed() view returns (address)",
  "function borrowerOperationsAddress() view returns (address)",
  "function stabilityPool() view returns (address)",
  "function lusdToken() view returns (address)",
]);
const UINT_ABI = parseAbi([
  "function TIMEOUT() view returns (uint256)",
  "function MAX_PRICE_DEVIATION_FROM_PREVIOUS_ROUND() view returns (uint256)",
  "function MAX_PRICE_DIFFERENCE_BETWEEN_ORACLES() view returns (uint256)",
  "function ETHUSD_TELLOR_REQ_ID() view returns (uint256)",
  "function MCR() view returns (uint256)",
  "function CCR() view returns (uint256)",
  "function lastGoodPrice() view returns (uint256)",
  "function getEntireSystemColl() view returns (uint256)",
  "function getEntireSystemDebt() view returns (uint256)",
  "function getTroveOwnersCount() view returns (uint256)",
  "function getTotalLUSDDeposits() view returns (uint256)",
  "function getETH() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);
const ABI = parseAbi([
  "function status() view returns (uint8)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  "function getRoundData(uint80) view returns (uint80,int256,uint256,uint256,uint80)",
  "function decimals() view returns (uint8)",
  "function getTellorCurrentValue(uint256) view returns (bool,uint256,uint256)",
  "function getTCR(uint256) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function getPool(address,address,uint24) view returns (address)",
  "function get_dy_underlying(int128,int128,uint256) view returns (uint256)",
]);
const ZERO = "0x0000000000000000000000000000000000000000";
const WAD = 10n ** 18n;
// The same bounded venue census as the reviewed exit-depth probe. Not a global census.
const PAIRS = [
  { label: "USDC", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" },
  { label: "USDT", address: "0xdac17f958d2ee523a2206206994597c13d831ec7" },
  { label: "WETH", address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2" },
] as const;

function sourcePin(context: ScenarioCheckContext, sourceId: string): bigint {
  const block = context.record.sources.find((entry) => entry.id === sourceId)?.block;
  if (block == null) throw new Error(`No recorded source block for ${sourceId}`);
  return BigInt(block);
}

async function addressValue(context: ScenarioCheckContext, sourceId: string, functionName: typeof ADDRESS_ABI[number]["name"]) {
  const { client, blockNumber } = requireScenarioChain(context);
  return (await client.readContract({ address: scenarioSourceAddress(context.record, sourceId), abi: ADDRESS_ABI, functionName, blockNumber })).toLowerCase();
}

async function uintValue(context: ScenarioCheckContext, sourceId: string, functionName: typeof UINT_ABI[number]["name"], blockNumber = requireScenarioChain(context).blockNumber) {
  const { client } = requireScenarioChain(context);
  return client.readContract({ address: scenarioSourceAddress(context.record, sourceId), abi: UINT_ABI, functionName, blockNumber });
}

async function runtime(context: ScenarioCheckContext, sourceId: string, blockNumber: bigint) {
  const { client } = requireScenarioChain(context);
  const code = await client.getBytecode({ address: scenarioSourceAddress(context.record, sourceId), blockNumber });
  if (!code || code === "0x") throw new Error(`No runtime bytecode for ${sourceId} at ${blockNumber}`);
  return keccak256(code);
}

async function reviewedRuntimes(context: ScenarioCheckContext, sources: readonly string[]) {
  const { blockNumber } = requireScenarioChain(context);
  const recorded: Record<string, ScenarioCheckValue> = {};
  const observed: Record<string, ScenarioCheckValue> = {};
  for (const id of sources) {
    recorded[id] = await runtime(context, id, sourcePin(context, id));
    observed[id] = await runtime(context, id, blockNumber);
  }
  return { recorded, observed, unchanged: JSON.stringify(recorded) === JSON.stringify(observed) };
}

function percent(value: bigint): string {
  return formatUnits((value * 1_000n + WAD / 2n) / WAD, 1);
}

interface SystemState {
  debt: bigint;
  supply: bigint;
  collateral: bigint;
  troves: bigint;
  lastGoodPrice: bigint;
  tcr: bigint;
  deposits: bigint;
  poolEth: bigint;
}
const systems = new WeakMap<ScenarioChainContext, Map<bigint, Promise<SystemState>>>();
function system(context: ScenarioCheckContext, blockNumber: bigint): Promise<SystemState> {
  const chain = requireScenarioChain(context);
  let pins = systems.get(chain);
  if (!pins) { pins = new Map(); systems.set(chain, pins); }
  let state = pins.get(blockNumber);
  if (!state) {
    state = (async () => {
      const lastGoodPrice = await uintValue(context, "price-feed", "lastGoodPrice", blockNumber);
      const debt = await uintValue(context, "trove-manager", "getEntireSystemDebt", blockNumber);
      if (debt === 0n) throw new Error("Zero entire system debt; no collateral or Stability Pool coverage denominator");
      return {
        debt, lastGoodPrice,
        supply: await uintValue(context, "lusd-token", "totalSupply", blockNumber),
        collateral: await uintValue(context, "trove-manager", "getEntireSystemColl", blockNumber),
        troves: await uintValue(context, "trove-manager", "getTroveOwnersCount", blockNumber),
        tcr: await chain.client.readContract({ address: scenarioSourceAddress(context.record, "trove-manager"), abi: ABI, functionName: "getTCR", args: [lastGoodPrice], blockNumber }),
        deposits: await uintValue(context, "stability-pool", "getTotalLUSDDeposits", blockNumber),
        poolEth: await uintValue(context, "stability-pool", "getETH", blockNumber),
      };
    })();
    pins.set(blockNumber, state);
  }
  return state;
}

interface Venue { label: string; address: `0x${string}`; balance: bigint }
const venuePins = new WeakMap<ScenarioChainContext, Map<bigint, Promise<Venue[]>>>();
function venues(context: ScenarioCheckContext, blockNumber: bigint): Promise<Venue[]> {
  const chain = requireScenarioChain(context);
  let pins = venuePins.get(chain);
  if (!pins) { pins = new Map(); venuePins.set(chain, pins); }
  let result = pins.get(blockNumber);
  if (!result) {
    result = (async () => {
      const lusd = scenarioSourceAddress(context.record, "lusd-token");
      const found: Venue[] = [];
      const add = async (label: string, address: `0x${string}`) => {
        if (address.toLowerCase() === ZERO || found.some((entry) => entry.address === address.toLowerCase())) return;
        const balance = await chain.client.readContract({ address: lusd, abi: ABI, functionName: "balanceOf", args: [address], blockNumber });
        found.push({ label, address: address.toLowerCase() as `0x${string}`, balance });
      };
      await add("Curve LUSD/3CRV", scenarioSourceAddress(context.record, "curve-lusd-3crv"));
      await add("Curve BOLD/LUSD", scenarioSourceAddress(context.record, "curve-bold-lusd"));
      for (const pair of PAIRS) {
        for (const fee of [100, 500, 3000, 10000]) {
          const pool = await chain.client.readContract({ address: scenarioSourceAddress(context.record, "uniswap-v3-factory"), abi: ABI, functionName: "getPool", args: [lusd, pair.address, fee], blockNumber });
          await add(`Uniswap v3 LUSD/${pair.label} fee ${fee}`, pool);
        }
      }
      return found;
    })();
    pins.set(blockNumber, result);
  }
  return result;
}

function venueEvidence(entries: Venue[]) {
  return entries.map((entry) => ({ label: entry.label, address: entry.address, balanceLusd: formatUnits(entry.balance, 18), atLeast500000Lusd: entry.balance >= 500_000n * WAD }));
}

const checks: readonly ScenarioCheck[] = [
  {
    id: "primary-feed-healthy",
    label: "Reviewed primary and fallback address wiring",
    async run(context) {
      const primary = await addressValue(context, "price-feed", "priceAggregator");
      const fallback = await addressValue(context, "price-feed", "tellorCaller");
      const recorded = { primary: scenarioSourceAddress(context.record, "chainlink-eth-usd").toLowerCase(), fallback: scenarioSourceAddress(context.record, "tellor-caller").toLowerCase() };
      return {
        verdict: primary === recorded.primary && fallback === recorded.fallback ? "holds" : "changed",
        recorded, observed: { primary, fallback },
        reason: "Oracle wiring is decisive. Current status and feed freshness are informational observations, not evidence that the hypothetical outage cannot occur.",
      };
    },
  },
  {
    id: "primary-feed-state",
    kind: "observation",
    label: "Current Chainlink response validity and freshness",
    async run(context) {
      const { client, blockNumber } = requireScenarioChain(context);
      const primary = scenarioSourceAddress(context.record, "chainlink-eth-usd");
      const status = await client.readContract({ address: scenarioSourceAddress(context.record, "price-feed"), abi: ABI, functionName: "status", blockNumber });
      const timestamp = (await client.getBlock({ blockNumber })).timestamp;
      const timeout = await uintValue(context, "price-feed", "TIMEOUT");
      const latest = await client.readContract({ address: primary, abi: ABI, functionName: "latestRoundData", blockNumber });
      if (latest[0] === 0n) {
        const brokenRound: ScenarioCheckValue = { status, roundId: "0" };
        const expected: ScenarioCheckValue = { status: 0, validCurrentAndPreviousRounds: true };
        return { verdict: "changed", recorded: expected, observed: brokenRound, reason: "A zero Chainlink round is broken under the deployed response predicate." };
      }
      const previous = await client.readContract({ address: primary, abi: ABI, functionName: "getRoundData", args: [latest[0] - 1n], blockNumber });
      // Matches _badChainlinkResponse, not an invented answeredInRound requirement.
      const valid = (round: typeof latest) => round[0] !== 0n && round[1] > 0n && round[3] > 0n && round[3] <= timestamp;
      const healthy = status === 0 && valid(latest) && valid(previous) && timestamp - latest[3] <= timeout;
      return {
        verdict: healthy ? "holds" : "changed",
        recorded: { status: 0, validCurrentAndPreviousRounds: true, currentRoundWithinTimeout: true },
        observed: { status, healthy, roundId: latest[0].toString(), answer: latest[1].toString(), updatedAt: latest[3].toString(), blockTimestamp: timestamp.toString(), timeoutSeconds: timeout.toString(), previousRoundValid: valid(previous) },
        reason: "Reports status, response validity and freshness only; this is not the full fetchPrice selection predicate, which also compares consecutive-round prices. Failed RPC/round reads are unavailable, never proof of health.",
      };
    },
  },
  {
    id: "fallback-within-freshness",
    label: "Deployed fallback freshness rule, request id and immutable caller",
    async run(context) {
      const codes = await reviewedRuntimes(context, ["price-feed", "tellor-caller"]);
      const timeout = await uintValue(context, "price-feed", "TIMEOUT");
      const requestId = await uintValue(context, "price-feed", "ETHUSD_TELLOR_REQ_ID");
      const tellor = await addressValue(context, "tellor-caller", "tellor");
      return {
        verdict: codes.unchanged && timeout === 14400n && requestId === 1n && tellor === scenarioSourceAddress(context.record, "tellor-master").toLowerCase() ? "holds" : "changed",
        recorded: { runtimeHashes: codes.recorded, timeoutSeconds: "14400", requestId: "1", tellor: scenarioSourceAddress(context.record, "tellor-master").toLowerCase() },
        observed: { runtimeHashes: codes.observed, timeoutSeconds: timeout.toString(), requestId: requestId.toString(), tellor },
        reason: "Reviewed source rejects a fallback age strictly greater than TIMEOUT, zero/future timestamps or zero values. The caller reads the newest request-1 value without a dispute buffer. Current age/freshness is an informational figure; Tellor master governance and reporter economics are not proved immutable.",
      };
    },
  },
  {
    id: "fallback-deviation-bound",
    label: "Reviewed ownerless deployments and unbounded fallback-adoption path",
    async run(context) {
      const sources = ["price-feed", "tellor-caller", "trove-manager", "borrower-operations", "stability-pool", "lusd-token"];
      const codes = await reviewedRuntimes(context, sources);
      const owners: Record<string, string> = {};
      for (const id of ["price-feed", "trove-manager", "borrower-operations", "stability-pool"]) owners[id] = await addressValue(context, id, "owner");
      const previousDeviation = await uintValue(context, "price-feed", "MAX_PRICE_DEVIATION_FROM_PREVIOUS_ROUND");
      const recoveryDifference = await uintValue(context, "price-feed", "MAX_PRICE_DIFFERENCE_BETWEEN_ORACLES");
      return {
        verdict: codes.unchanged && Object.values(owners).every((owner) => owner === ZERO) && previousDeviation === 5n * 10n ** 17n && recoveryDifference === 5n * 10n ** 16n ? "holds" : "changed",
        recorded: { runtimeHashes: codes.recorded, owners: Object.fromEntries(Object.keys(owners).map((id) => [id, ZERO])), previousRoundDeviationWad: "500000000000000000", recoveryDifferenceWad: "50000000000000000", fallbackVsLastGoodBound: false },
        observed: { runtimeHashes: codes.observed, owners, previousRoundDeviationWad: previousDeviation.toString(), recoveryDifferenceWad: recoveryDifference.toString() },
        reason: "Same runtimes as the source-reviewed/fork-replayed deployments preserve the no-admin/no-pause/no-upgrade price route and the verbatim fallback adoption on primary failure. The 50% consecutive-Chainlink-round and 5% oracle-recovery rules are NOT bounds against lastGoodPrice. A runtime change requires renewed source/fork review; hashing arbitrary code alone would not prove these properties.",
      };
    },
  },
  {
    id: "collateral-buffer-above-200",
    label: "Immutable mint/redemption route and deployed MCR/CCR boundaries",
    async run(context) {
      const codes = await reviewedRuntimes(context, ["trove-manager", "borrower-operations", "lusd-token"]);
      const mcr = await uintValue(context, "trove-manager", "MCR");
      const ccr = await uintValue(context, "trove-manager", "CCR");
      const priceFeed = await addressValue(context, "trove-manager", "priceFeed");
      const borrowerOperations = await addressValue(context, "trove-manager", "borrowerOperationsAddress");
      const lusdToken = await addressValue(context, "trove-manager", "lusdToken");
      return {
        verdict: codes.unchanged && mcr === 11n * 10n ** 17n && ccr === 15n * 10n ** 17n && priceFeed === scenarioSourceAddress(context.record, "price-feed").toLowerCase() && borrowerOperations === scenarioSourceAddress(context.record, "borrower-operations").toLowerCase() && lusdToken === scenarioSourceAddress(context.record, "lusd-token").toLowerCase() ? "holds" : "changed",
        recorded: { runtimeHashes: codes.recorded, mcrWad: "1100000000000000000", ccrWad: "1500000000000000000", priceFeed: scenarioSourceAddress(context.record, "price-feed").toLowerCase(), borrowerOperations: scenarioSourceAddress(context.record, "borrower-operations").toLowerCase(), lusdToken: scenarioSourceAddress(context.record, "lusd-token").toLowerCase() },
        observed: { runtimeHashes: codes.observed, mcrWad: mcr.toString(), ccrWad: ccr.toString(), priceFeed, borrowerOperations, lusdToken },
        reason: "110% MCR and 150% recovery-mode CCR are deployed boundaries. A live TCR crossing 200% is informational market drift, not a change to the contract or proof of future solvency.",
      };
    },
  },
  {
    id: "stability-pool-covers-quarter",
    label: "Reviewed liquidation-offset/redistribution route and Stability Pool binding",
    async run(context) {
      const codes = await reviewedRuntimes(context, ["trove-manager", "stability-pool"]);
      const stabilityPool = await addressValue(context, "trove-manager", "stabilityPool");
      return {
        verdict: codes.unchanged && stabilityPool === scenarioSourceAddress(context.record, "stability-pool").toLowerCase() ? "holds" : "changed",
        recorded: { runtimeHashes: codes.recorded, stabilityPool: scenarioSourceAddress(context.record, "stability-pool").toLowerCase() },
        observed: { runtimeHashes: codes.observed, stabilityPool },
        reason: "The reviewed runtime offsets eligible liquidations against available deposits before redistribution, subject to the normal/recovery-mode rules. 25% coverage is not a deployed threshold; deposits and debt are figures and crossing it never fails this check.",
      };
    },
  },
  {
    id: "exit-concentration",
    label: "Reviewed exit-venue and factory runtimes",
    async run(context) {
      const codes = await reviewedRuntimes(context, ["curve-lusd-3crv", "curve-bold-lusd", "uniswap-v3-factory"]);
      return {
        verdict: codes.unchanged ? "holds" : "changed",
        recorded: { runtimeHashes: codes.recorded },
        observed: { runtimeHashes: codes.observed },
        reason: "Decisive only for runtime identity of the two cited Curve pools and Uniswap factory. The measured-exit figure reports the bounded two-Curve-pool and twelve-pair/fee census; balances, quotes and qualifying-venue counts are informational, not proof of a global absence of alternatives.",
      };
    },
  },
  {
    id: "fallback-age",
    kind: "figure",
    recordField: { collection: "keyFigures", label: "Fallback age at the pin" },
    label: "Current Tellor age and eligibility under the deployed timeout",
    async run(context) {
      const { client, blockNumber } = requireScenarioChain(context);
      const timestamp = (await client.getBlock({ blockNumber })).timestamp;
      const [retrieved, value, updatedAt] = await client.readContract({ address: scenarioSourceAddress(context.record, "tellor-caller"), abi: ABI, functionName: "getTellorCurrentValue", args: [1n], blockNumber });
      const timeout = await uintValue(context, "price-feed", "TIMEOUT");
      const valid = value > 0n && updatedAt > 0n && updatedAt <= timestamp;
      const age = updatedAt <= timestamp ? timestamp - updatedAt : null;
      const published = context.record.keyFigures.find((entry) => entry.label === "Fallback age at the pin")!.value;
      const match = published.match(/^(\d+)h (\d+)m$/);
      if (!match) throw new Error(`Cannot parse recorded fallback age: ${published}`);
      const recordedMinutes = BigInt(match[1]) * 60n + BigInt(match[2]);
      return {
        verdict: valid && age !== null && age / 60n === recordedMinutes ? "holds" : "changed",
        recorded: published,
        observed: { retrieved, valueUsd6: value.toString(), updatedAt: updatedAt.toString(), blockTimestamp: timestamp.toString(), ageSeconds: age?.toString() ?? null, timeoutSeconds: timeout.toString(), validResponse: valid, eligibleIfPrimaryBreaks: valid && age !== null && age <= timeout },
        reason: "Age uses the pinned canonical block timestamp, not wall clock or fork genesis time. Ordinary publication cycles, including crossing the four-hour budget, are informational; only the deployed freshness rule is decisive.",
      };
    },
  },
  {
    id: "collateral-ratio",
    kind: "figure",
    recordField: { collection: "keyFigures", label: "Collateral ratio at last-good price" },
    label: "Live total collateral ratio at PriceFeed.lastGoodPrice",
    async run(context) {
      const current = await system(context, requireScenarioChain(context).blockNumber);
      const published = context.record.keyFigures.find((entry) => entry.label === "Collateral ratio at last-good price")!.value;
      return { verdict: `${percent(current.tcr)}%` === published ? "holds" : "changed", recorded: published, observed: { collateralRatioPercent: percent(current.tcr), lastGoodPriceUsd: formatUnits(current.lastGoodPrice, 18), above200Percent: current.tcr > 2n * WAD }, reason: "Matches the published last-good-price basis, not a silently substituted current Chainlink price. Crossing 200% is informational." };
    },
  },
  {
    id: "system-debt",
    kind: "figure",
    recordField: { collection: "exposure", label: "LUSD outstanding" },
    label: "LUSD supply and entire system debt",
    async run(context) {
      const current = await system(context, requireScenarioChain(context).blockNumber);
      const previous = await system(context, sourcePin(context, "trove-manager"));
      return { verdict: current.debt === previous.debt && current.supply === previous.supply ? "holds" : "changed", recorded: { published: context.record.exposure.find((entry) => entry.label === "LUSD outstanding")!.detail, sourceBlock: sourcePin(context, "trove-manager").toString(), debtLusd: formatUnits(previous.debt, 18), supplyLusd: formatUnits(previous.supply, 18) }, observed: { debtLusd: formatUnits(current.debt, 18), supplyLusd: formatUnits(current.supply, 18), supplyMatchesDebt: current.supply === current.debt }, reason: "Outstanding supply/debt drift is informational, not an unbacked-mint conclusion." };
    },
  },
  {
    id: "system-collateral",
    kind: "figure",
    recordField: { collection: "exposure", label: "Collateral behind it" },
    label: "System ETH collateral, Trove count and last-good price",
    async run(context) {
      const current = await system(context, requireScenarioChain(context).blockNumber);
      const previous = await system(context, sourcePin(context, "trove-manager"));
      return { verdict: current.collateral === previous.collateral && current.troves === previous.troves && current.lastGoodPrice === previous.lastGoodPrice ? "holds" : "changed", recorded: { published: context.record.exposure.find((entry) => entry.label === "Collateral behind it")!.detail, collateralEth: formatUnits(previous.collateral, 18), troves: previous.troves.toString(), lastGoodPriceUsd: formatUnits(previous.lastGoodPrice, 18) }, observed: { collateralEth: formatUnits(current.collateral, 18), troves: current.troves.toString(), lastGoodPriceUsd: formatUnits(current.lastGoodPrice, 18), collateralRatioPercent: percent(current.tcr) }, reason: "Collateral and price changes are informational. No hypothetical mint or liquidation is replayed against live chain state." };
    },
  },
  {
    id: "stability-pool-depth",
    kind: "figure",
    recordField: { collection: "exposure", label: "Stability Pool depth" },
    label: "Stability Pool deposits, ETH and share of outstanding protocol debt",
    async run(context) {
      const current = await system(context, requireScenarioChain(context).blockNumber);
      const previous = await system(context, sourcePin(context, "stability-pool"));
      const describe = (state: SystemState) => ({ depositsLusd: formatUnits(state.deposits, 18), poolEth: formatUnits(state.poolEth, 18), debtLusd: formatUnits(state.debt, 18), debtCoveragePercent: percent(state.deposits * WAD / state.debt), below25Percent: state.deposits * 4n < state.debt });
      return { verdict: current.deposits === previous.deposits && current.poolEth === previous.poolEth && current.debt === previous.debt ? "holds" : "changed", recorded: { published: context.record.exposure.find((entry) => entry.label === "Stability Pool depth")!.detail, ...describe(previous) }, observed: describe(current), reason: "Coverage divides by entire system debt, not a DEX float estimate. Crossing 25% is ordinary market drift and does not fail the run." };
    },
  },
  {
    id: "measured-exit",
    kind: "figure",
    recordField: { collection: "exposure", label: "Measured exit" },
    label: "Known-venue LUSD balances and static Curve five-million-LUSD USDC quote",
    async run(context) {
      const { client, blockNumber } = requireScenarioChain(context);
      const pin = sourcePin(context, "curve-lusd-3crv");
      const current = await venues(context, blockNumber);
      const previous = await venues(context, pin);
      const quote = (block: bigint) => client.readContract({ address: scenarioSourceAddress(context.record, "curve-lusd-3crv"), abi: ABI, functionName: "get_dy_underlying", args: [0n, 2n, 5_000_000n * WAD], blockNumber: block });
      const recordedQuote = await quote(pin);
      const currentQuote = await quote(blockNumber);
      return {
        verdict: JSON.stringify(venueEvidence(current)) === JSON.stringify(venueEvidence(previous)) && currentQuote === recordedQuote ? "holds" : "changed",
        recorded: { published: context.record.exposure.find((entry) => entry.label === "Measured exit")!.detail, sourceBlock: pin.toString(), venues: venueEvidence(previous), fiveMillionLusdQuoteUsdc: formatUnits(recordedQuote, 6) },
        observed: { venues: venueEvidence(current), fiveMillionLusdQuoteUsdc: formatUnits(currentQuote, 6), staticPoolAssumption: true },
        reason: "Pinned static-pool quote only: no arbitrage replenishment, multi-hop routing or execution guarantee. Known-venue balances/quotes are informational; failed reads are unavailable, never zero depth. The bounded census cannot establish global exit concentration.",
      };
    },
  },
];

export default checks;
