import { encodeFunctionData, keccak256, parseAbi, zeroAddress, type Hex } from "viem";
import {
  memoizeRead,
  requireScenarioChain,
  scenarioSourceAddress,
  type ScenarioCheck,
  type ScenarioCheckContext,
  type ScenarioCheckVerdict,
} from "./index";

const facilitatorAbi = parseAbi([
  "function MINTER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32,address) view returns (bool)",
]);
const stewardAbi = parseAbi([
  "function RISK_COUNCIL() view returns (address)",
  "function getControlledFacilitators() view returns (address[])",
  "function isControlledFacilitator(address) view returns (bool)",
]);
const safeAbi = parseAbi([
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function getModulesPaginated(address,uint256) view returns (address[],address)",
]);
const tokenAbi = parseAbi([
  "function getFacilitatorsList() view returns (address[])",
  "function getFacilitatorBucket(address) view returns (uint256,uint256)",
  "function getFacilitator(address) view returns ((uint128,uint128,string))",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);
const gsmAbi = parseAbi([
  "function UNDERLYING_ASSET() view returns (address)",
  "function getGhoReserve() view returns (address)",
  "function getAvailableLiquidity() view returns (uint256)",
  "function getUsed() view returns (uint256)",
  "function getCurrentBacking() view returns (uint256,uint256)",
  "function getGhoAmountForBuyAsset(uint256) view returns (uint256,uint256,uint256,uint256)",
  "function getIsFrozen() view returns (bool)",
  "function getIsSeized() view returns (bool)",
]);
const vaultAbi = parseAbi([
  "function asset() view returns (address)",
  "function convertToAssets(uint256) view returns (uint256)",
]);
const reserveAbi = parseAbi([
  "function getEntities() view returns (address[])",
  "function getUsage(address) view returns (uint256,uint256)",
]);
const guardSlot = "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8";
const sentinel = "0x0000000000000000000000000000000000000001";
const probeRecipient = "0x00000000000000000000000000000000ca1d0001";

function baselineBlock(context: ScenarioCheckContext, id: string): bigint {
  const block = context.record.falsifiers.find((entry) => entry.id === id)?.checkedAtBlock;
  if (block === undefined) throw new Error(`No recorded baseline block for ${id}`);
  return BigInt(block);
}

// These contracts were verified as immutable, non-proxy contracts in the original
// replay. Equal complete runtime bytecode preserves the recipient forwarding,
// immediate capacity update and lack of a cumulative issuance counter. A code
// change is drift, not proof that the new implementation has the same semantics.
async function compareCode(
  context: ScenarioCheckContext,
  id: string,
  sourceIds: readonly string[],
  reason: string,
): Promise<ScenarioCheckVerdict> {
  const { client, blockNumber } = requireScenarioChain(context);
  const recorded: Record<string, string> = {};
  const observed: Record<string, string> = {};
  for (const sourceId of sourceIds) {
    const address = scenarioSourceAddress(context.record, sourceId);
    const oldCode = await client.getBytecode({ address, blockNumber: baselineBlock(context, id) });
    const newCode = await client.getBytecode({ address, blockNumber });
    if (!oldCode || oldCode === "0x" || !newCode || newCode === "0x") {
      return { verdict: "unavailable", reason: `Missing runtime bytecode for ${sourceId} at the recorded or current block` };
    }
    recorded[sourceId] = keccak256(oldCode);
    observed[sourceId] = keccak256(newCode);
  }
  return {
    verdict: sourceIds.every((id) => recorded[id] === observed[id]) ? "holds" : "changed",
    recorded,
    observed,
    reason,
  };
}

function isExecutionRevert(error: unknown): boolean {
  let current: unknown = error;
  const visited = new Set<unknown>();
  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    const entry = current as { name?: string; code?: number; details?: string; cause?: unknown };
    if (entry.name === "ExecutionRevertedError" || entry.code === 3 || /execution reverted/i.test(entry.details ?? "")) return true;
    current = entry.cause;
  }
  return false;
}

interface ReserveInventory {
  blockNumber: bigint;
  totalSupply: bigint;
  buckets: { address: string; label: string; capacity: bigint; level: bigint }[];
  modules: {
    sourceId: string; address: string; wrapper: string; asset: string; symbol: string; decimals: number;
    shares: bigint; assets: bigint; assetsAtPar: bigint; liquidity: bigint; used: bigint;
    excess: bigint; deficit: bigint; reserve: string; frozen: boolean; seized: boolean; redemptionGho: bigint;
  }[];
  reserves: { address: string; ghoBalance: bigint; usage: { address: string; limit: bigint; used: bigint }[] }[];
  bucketLevelSum: bigint;
  bucketCapacitySum: bigint;
  mainnetLevel: bigint;
  reserveAccountedGho: bigint;
  resolvableAssetsAtPar: bigint;
  mainnetUnresolvedAtPar: bigint;
  protocolPositionRemainderAtPar: bigint;
  redemptionGho: bigint;
}

// The runner reuses its chain pin across checks. Share those exact reads, including
// rejected reads; a figure must not silently retry into a different measurement.
function reserveInventory(context: ScenarioCheckContext, blockNumber = requireScenarioChain(context).blockNumber) {
  return memoizeRead(context, `gho-reserve-inventory:1:${blockNumber}`, () => readReserveInventory(context, blockNumber));
}

async function readReserveInventory(context: ScenarioCheckContext, blockNumber: bigint): Promise<ReserveInventory> {
  const { client } = requireScenarioChain(context);
  const gho = scenarioSourceAddress(context.record, "gho");
  const totalSupply = await client.readContract({ address: gho, abi: tokenAbi, functionName: "totalSupply", blockNumber });
  if (totalSupply === 0n) throw new Error("Zero GHO supply cannot establish a backing share");
  const addresses = await client.readContract({ address: gho, abi: tokenAbi, functionName: "getFacilitatorsList", blockNumber });
  const buckets: ReserveInventory["buckets"] = [];
  for (const address of addresses) {
    const [capacity, level] = await client.readContract({ address: gho, abi: tokenAbi, functionName: "getFacilitatorBucket", args: [address], blockNumber });
    const info = await client.readContract({ address: gho, abi: tokenAbi, functionName: "getFacilitator", args: [address], blockNumber });
    buckets.push({ address: address.toLowerCase(), label: info[2], capacity, level });
  }
  const modules: ReserveInventory["modules"] = [];
  for (const sourceId of ["gsm-usdc", "gsm-usdt"]) {
    const address = scenarioSourceAddress(context.record, sourceId);
    const wrapper = await client.readContract({ address, abi: gsmAbi, functionName: "UNDERLYING_ASSET", blockNumber });
    const asset = await client.readContract({ address: wrapper, abi: vaultAbi, functionName: "asset", blockNumber });
    // Canonical token identity, not a recorded quantitative baseline or a symbol
    // assertion. A new collateral token needs an explicit valuation review.
    const canonicalAsset = sourceId === "gsm-usdc"
      ? "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
      : "0xdac17f958d2ee523a2206206994597c13d831ec7";
    if (asset.toLowerCase() !== canonicalAsset) throw new Error(`${sourceId} now resolves to ${asset}; token-par GHO backing attribution requires review`);
    const symbol = await client.readContract({ address: asset, abi: tokenAbi, functionName: "symbol", blockNumber });
    const decimals = await client.readContract({ address: asset, abi: tokenAbi, functionName: "decimals", blockNumber });
    if (decimals > 18) throw new Error(`Unsupported underlying decimals for ${sourceId}: ${decimals}`);
    const shares = await client.readContract({ address: wrapper, abi: tokenAbi, functionName: "balanceOf", args: [address], blockNumber });
    const assets = await client.readContract({ address: wrapper, abi: vaultAbi, functionName: "convertToAssets", args: [shares], blockNumber });
    const liquidity = await client.readContract({ address, abi: gsmAbi, functionName: "getAvailableLiquidity", blockNumber });
    const used = await client.readContract({ address, abi: gsmAbi, functionName: "getUsed", blockNumber });
    const [excess, deficit] = await client.readContract({ address, abi: gsmAbi, functionName: "getCurrentBacking", blockNumber });
    const reserve = await client.readContract({ address, abi: gsmAbi, functionName: "getGhoReserve", blockNumber });
    const frozen = await client.readContract({ address, abi: gsmAbi, functionName: "getIsFrozen", blockNumber });
    const seized = await client.readContract({ address, abi: gsmAbi, functionName: "getIsSeized", blockNumber });
    const quote = liquidity === 0n || frozen || seized ? undefined
      : await client.readContract({ address, abi: gsmAbi, functionName: "getGhoAmountForBuyAsset", args: [liquidity], blockNumber });
    modules.push({
      sourceId, address: address.toLowerCase(), wrapper: wrapper.toLowerCase(), asset: asset.toLowerCase(),
      symbol, decimals, shares, assets, assetsAtPar: assets * 10n ** BigInt(18 - decimals),
      liquidity, used, excess, deficit, reserve: reserve.toLowerCase(), frozen, seized,
      // Quote includes the buy fee; it is exit inventory, never reserve collateral.
      redemptionGho: quote?.[1] ?? 0n,
    });
  }
  const reserves: ReserveInventory["reserves"] = [];
  for (const reserve of [...new Set(modules.map((entry) => entry.reserve))]) {
    const address = reserve as `0x${string}`;
    const entities = await client.readContract({ address, abi: reserveAbi, functionName: "getEntities", blockNumber });
    const usage: ReserveInventory["reserves"][number]["usage"] = [];
    for (const entity of entities) {
      const [limit, used] = await client.readContract({ address, abi: reserveAbi, functionName: "getUsage", args: [entity], blockNumber });
      usage.push({ address: entity.toLowerCase(), limit, used });
    }
    const ghoBalance = await client.readContract({ address: gho, abi: tokenAbi, functionName: "balanceOf", args: [address], blockNumber });
    reserves.push({ address: reserve, ghoBalance, usage });
  }
  const mainnetBucket = buckets.find((entry) => entry.address === scenarioSourceAddress(context.record, "facilitator").toLowerCase());
  if (!mainnetBucket) throw new Error("Recorded mainnet GSM facilitator is absent from the GHO registry");
  const resolvableAssetsAtPar = modules.reduce((sum, entry) => sum + entry.assetsAtPar, 0n);
  return {
    blockNumber, totalSupply, buckets, modules, reserves,
    bucketLevelSum: buckets.reduce((sum, entry) => sum + entry.level, 0n),
    bucketCapacitySum: buckets.reduce((sum, entry) => sum + entry.capacity, 0n),
    mainnetLevel: mainnetBucket.level, resolvableAssetsAtPar,
    reserveAccountedGho: reserves.reduce((sum, entry) => sum + entry.ghoBalance + entry.usage.reduce((used, entity) => used + entity.used, 0n), 0n),
    mainnetUnresolvedAtPar: mainnetBucket.level - resolvableAssetsAtPar,
    protocolPositionRemainderAtPar: totalSupply - resolvableAssetsAtPar,
    redemptionGho: modules.reduce((sum, entry) => sum + entry.redemptionGho, 0n),
  };
}

function supplyShare(amount: bigint, supply: bigint): number {
  return Number(amount * 100_000_000n / supply) / 1_000_000;
}

function inventoryEvidence(inventory: ReserveInventory) {
  return {
    blockNumber: inventory.blockNumber.toString(),
    totalSupplyGho: inventory.totalSupply.toString(),
    bucketLevelSumGho: inventory.bucketLevelSum.toString(),
    bucketCapacitySumGho: inventory.bucketCapacitySum.toString(),
    buckets: inventory.buckets.map((entry) => ({ ...entry, capacity: entry.capacity.toString(), level: entry.level.toString() })),
    modules: inventory.modules.map((entry) => ({
      ...entry, shares: entry.shares.toString(), assets: entry.assets.toString(), assetsAtPar: entry.assetsAtPar.toString(),
      liquidity: entry.liquidity.toString(), used: entry.used.toString(), excess: entry.excess.toString(),
      deficit: entry.deficit.toString(), redemptionGho: entry.redemptionGho.toString(),
    })),
    reserves: inventory.reserves.map((entry) => ({
      address: entry.address, ghoBalance: entry.ghoBalance.toString(),
      entities: entry.usage.map((entity) => ({ ...entity, limit: entity.limit.toString(), used: entity.used.toString() })),
    })),
    mainnetBucketLevelGho: inventory.mainnetLevel.toString(),
    reserveAccountedGho: inventory.reserveAccountedGho.toString(),
    mainnetReserveAllocationDifferenceGho: (inventory.mainnetLevel - inventory.reserveAccountedGho).toString(),
    resolvableAssetsAtPar: inventory.resolvableAssetsAtPar.toString(),
    resolvableSupplyPctAtPar: supplyShare(inventory.resolvableAssetsAtPar, inventory.totalSupply),
    mainnetUnresolvedAtPar: inventory.mainnetUnresolvedAtPar.toString(),
    mainnetUnresolvedSupplyPctAtPar: supplyShare(inventory.mainnetUnresolvedAtPar, inventory.totalSupply),
    protocolPositionRemainderAtPar: inventory.protocolPositionRemainderAtPar.toString(),
    protocolPositionRemainderPctAtPar: supplyShare(inventory.protocolPositionRemainderAtPar, inventory.totalSupply),
  };
}

function recordedInventoryBlock(context: ScenarioCheckContext): bigint {
  const pin = context.record.evidencePin;
  if (!pin || pin.chainId !== 1) throw new Error("No recorded Ethereum evidence pin for the reserve inventory baseline");
  return BigInt(pin.block);
}

function roundedMillions(amount: bigint): number {
  return Number((amount + 5_000n * 10n ** 18n) / (10_000n * 10n ** 18n)) / 100;
}

const checks: readonly ScenarioCheck[] = [
  {
    id: "council-minter-role",
    label: "Council facilitator MINTER_ROLE",
    async run(context) {
      const { client, blockNumber } = requireScenarioChain(context);
      const address = scenarioSourceAddress(context.record, "facilitator");
      const role = await client.readContract({ address, abi: facilitatorAbi, functionName: "MINTER_ROLE", blockNumber });
      const holds = await client.readContract({
        address, abi: facilitatorAbi, functionName: "hasRole",
        args: [role, scenarioSourceAddress(context.record, "council")], blockNumber,
      });
      return { verdict: holds ? "holds" : "changed", observed: holds, recorded: true };
    },
  },
  {
    id: "steward-risk-council",
    label: "Bucket Steward council and controlled list",
    async run(context) {
      const { client, blockNumber } = requireScenarioChain(context);
      const address = scenarioSourceAddress(context.record, "steward");
      const council = scenarioSourceAddress(context.record, "council");
      const facilitator = scenarioSourceAddress(context.record, "facilitator");
      const riskCouncil = await client.readContract({ address, abi: stewardAbi, functionName: "RISK_COUNCIL", blockNumber });
      const list = await client.readContract({ address, abi: stewardAbi, functionName: "getControlledFacilitators", blockNumber });
      const controlled = await client.readContract({ address, abi: stewardAbi, functionName: "isControlledFacilitator", args: [facilitator], blockNumber });
      const listed = list.some((entry) => entry.toLowerCase() === facilitator.toLowerCase());
      return {
        verdict: riskCouncil.toLowerCase() === council.toLowerCase() && controlled && listed ? "holds" : "changed",
        observed: { riskCouncil: riskCouncil.toLowerCase(), controlled, listed },
        recorded: { riskCouncil: council.toLowerCase(), controlled: true, listed: true },
      };
    },
  },
  {
    id: "council-safe-guard",
    label: "Council Safe threshold, modules and guard",
    async run(context) {
      const { client, blockNumber } = requireScenarioChain(context);
      const address = scenarioSourceAddress(context.record, "council");
      const figure = context.record.keyFigures.find((entry) => entry.label === "Keys that mint GHO")?.value.match(/^(\d+) of (\d+)$/);
      if (!figure) return { verdict: "unavailable", reason: "Recorded Council threshold and owner count could not be read from keyFigures" };
      const threshold = await client.readContract({ address, abi: safeAbi, functionName: "getThreshold", blockNumber });
      const owners = await client.readContract({ address, abi: safeAbi, functionName: "getOwners", blockNumber });
      const [modules, next] = await client.readContract({ address, abi: safeAbi, functionName: "getModulesPaginated", args: [sentinel, 100n], blockNumber });
      const guard = await client.getStorageAt({ address, slot: guardSlot, blockNumber });
      if (guard === undefined) return { verdict: "unavailable", reason: "Council Safe guard storage is unavailable" };
      const guardAddress = `0x${guard.slice(-40)}`;
      const unchanged = threshold === BigInt(figure[1]) && owners.length === Number(figure[2]) && modules.length === 0 && next.toLowerCase() === sentinel && BigInt(guard) === 0n;
      return {
        verdict: unchanged ? "holds" : "changed",
        observed: { threshold: threshold.toString(), owners: owners.length, modules: [...modules], modulesNext: next, guard: guardAddress },
        recorded: { threshold: figure[1], owners: Number(figure[2]), modules: [], modulesNext: sentinel, guard: zeroAddress },
      };
    },
  },
  {
    id: "fixed-mint-recipient",
    label: "Arbitrary mint recipient semantics",
    run: (context) => compareCode(context, "fixed-mint-recipient", ["facilitator", "gho"],
      "Compare both immutable contracts to the verified replay: facilitator forwards the chosen recipient and GHO has no fixed-recipient gate. A capacity-rejected mint alone would not establish a recipient restriction."),
  },
  {
    id: "capacity-increase-delay",
    label: "Immediate capacity increase semantics",
    run: (context) => compareCode(context, "capacity-increase-delay", ["steward", "gho"],
      "Verified immutable steward updates token capacity in the same call. Its one-day debounce limits repeated calls, not execution of an accepted increase; it is not a queued governance-veto delay."),
  },
  {
    id: "gho-holder-controls",
    label: "GHO pause, freeze and recovery selector probes",
    async run(context) {
      const comparison = await compareCode(context, "gho-holder-controls", ["gho"],
        "Bytecode comparison protects against treating an authorization revert as absence of a newly added control.");
      if (comparison.verdict === "unavailable") return comparison;
      const { client, blockNumber } = requireScenarioChain(context);
      const probes = parseAbi([
        "function pause()", "function unpause()", "function blacklist(address)",
        "function freeze(address)", "function seize(address)", "function burnFrom(address,uint256)",
      ]);
      const observed: Record<string, string> = {};
      const recorded: Record<string, string> = {};
      for (const functionName of ["pause", "unpause", "blacklist", "freeze", "seize", "burnFrom"] as const) {
        const data: Hex = functionName === "pause" || functionName === "unpause"
          ? encodeFunctionData({ abi: probes, functionName })
          : functionName === "burnFrom"
            ? encodeFunctionData({ abi: probes, functionName, args: [probeRecipient, 10n ** 18n] })
            : encodeFunctionData({ abi: probes, functionName, args: [probeRecipient] });
        recorded[functionName] = "execution reverted";
        try {
          await client.call({ to: scenarioSourceAddress(context.record, "gho"), account: scenarioSourceAddress(context.record, "executor"), data, blockNumber });
          observed[functionName] = "call succeeded";
        } catch (error) {
          if (!isExecutionRevert(error)) throw error;
          observed[functionName] = "execution reverted";
        }
      }
      return {
        verdict: comparison.verdict === "holds" && Object.keys(observed).every((id) => observed[id] === recorded[id]) ? "holds" : "changed",
        observed: { code: comparison.observed, probes: observed },
        recorded: { code: comparison.recorded, probes: recorded },
        reason: "Only unchanged verified immutable bytecode plus execution-revert probes supports absence; changed code requires source review even if every probe still reverts.",
      };
    },
  },
  {
    id: "lifetime-issuance-budget",
    label: "No lifetime issuance counter",
    run: (context) => compareCode(context, "lifetime-issuance-budget", ["facilitator", "steward", "gho"],
      "Verified immutable contracts track current bucket level and per-call doubling/debounce, not cumulative lifetime issuance. A changed implementation needs a new replay."),
  },
  {
    id: "gsm-reserve-backing",
    label: "Facilitator census and tracked GSM accounting (partial chain check)",
    async run(context) {
      const current = await reserveInventory(context);
      const baseline = await reserveInventory(context, recordedInventoryBlock(context));
      const census = (inventory: ReserveInventory) => inventory.buckets.map((entry) => entry.address).sort().join(",");
      const moduleIdentity = (inventory: ReserveInventory) => inventory.modules.map((entry) =>
        `${entry.address}:${entry.wrapper}:${entry.asset}:${entry.reserve}`).sort().join(",");
      const reserveEntities = (inventory: ReserveInventory) => inventory.reserves.map((entry) =>
        `${entry.address}:${entry.usage.map((entity) => entity.address).sort().join(",")}`).sort().join(";");
      const unchanged = census(current) === census(baseline)
        && moduleIdentity(current) === moduleIdentity(baseline)
        && reserveEntities(current) === reserveEntities(baseline)
        && current.bucketLevelSum === current.totalSupply
        && current.reserveAccountedGho === current.mainnetLevel
        && current.modules.every((entry) => entry.shares >= entry.liquidity && entry.deficit === 0n);
      return {
        verdict: unchanged ? "holds" : "changed",
        observed: inventoryEvidence(current),
        recorded: { blockNumber: baseline.blockNumber.toString(), facilitators: census(baseline), modules: moduleIdentity(baseline), reserveEntities: reserveEntities(baseline), bucketsReconcile: true, mainnetReserveAllocationDifferenceGho: (baseline.mainnetLevel - baseline.reserveAccountedGho).toString(), trackedModuleDeficits: "0" },
        reason: "Tests the recorded facilitator/module/entity census, bucket-level sum against supply, mainnet reserve-held GHO plus entity usage against its bucket, actual wrapper inventory and module-reported deficits only. New addresses or accounting drift need review; holds does not decide the disclosure falsifier or establish backing of the remaining protocol positions.",
      };
    },
  },
  {
    id: "gsm-reserve-backing",
    label: "Unresolved stablecoin-module disclosure reconciliation",
    async run(context) {
      const inventory = await reserveInventory(context);
      const docs = context.record.sources.find((entry) => entry.id === "aave-docs-gho")?.url;
      return {
        verdict: "unavailable",
        observed: inventoryEvidence(inventory),
        reason: `At Ethereum block ${inventory.blockNumber}, named USDC/USDT receipt claims resolve ${supplyShare(inventory.resolvableAssetsAtPar, inventory.totalSupply)}% of supply at underlying-token par; the mainnet GSM bucket still has ${supplyShare(inventory.mainnetUnresolvedAtPar, inventory.totalSupply)}% of supply not reconciled to external assets. Read Aave/TokenLogic's GHO reserve and facilitator dashboard (https://aave.tokenlogic.xyz/gho) and the facilitator/GSM disclosures (${docs ?? "no recorded Aave GHO documentation source"}) to reconcile this residual plus non-mainnet facilitator allocations. Reserve-held GHO is self-issued inventory, not external backing. Wrapper convertToAssets establishes an Aave receipt claim, not immediate issuer-token liquidity, borrower collateral quality, or publication of a reconciled disclosure.`,
      };
    },
  },
  {
    id: "gsm-redemption-inventory",
    label: "Tracked mainnet GSM redemption inventory",
    kind: "figure",
    recordField: { collection: "exposure", label: "Redemption inventory" },
    async run(context) {
      const detail = context.record.exposure.find((entry) => entry.label === "Redemption inventory")?.detail;
      const value = detail?.match(/redeem ([\d.]+) million GHO/);
      if (!value) return { verdict: "unavailable", reason: "No published million-GHO redemption inventory in exposure: Redemption inventory" };
      const inventory = await reserveInventory(context);
      const observed = roundedMillions(inventory.redemptionGho);
      const recorded = Number(value[1]);
      return {
        verdict: observed === recorded ? "holds" : "changed",
        observed: { millionGho: observed, rawGho: inventory.redemptionGho.toString(), reserveLookThrough: inventoryEvidence(inventory) },
        recorded: { millionGho: recorded, detail: detail ?? "" },
        reason: "Same-block getGhoAmountForBuyAsset(getAvailableLiquidity()) sums live, unfrozen, unseized modules and includes the buy fee, matching the published exit-inventory method. Separate underlying assets and their supply share exclude that fee and value USDC/USDT at token par; no DEX exit depth is inferred.",
      };
    },
  },
  {
    id: "gho-outstanding-supply",
    label: "GHO supply and facilitator bucket reconciliation",
    kind: "figure",
    recordField: { collection: "exposure", label: "GHO holders" },
    async run(context) {
      const detail = context.record.exposure.find((entry) => entry.label === "GHO holders")?.detail;
      const value = detail?.match(/([\d.]+) million GHO was outstanding/);
      if (!value) return { verdict: "unavailable", reason: "No published million-GHO supply in exposure: GHO holders" };
      const inventory = await reserveInventory(context);
      const observed = roundedMillions(inventory.totalSupply);
      const recorded = Number(value[1]);
      return {
        verdict: observed === recorded && inventory.bucketLevelSum === inventory.totalSupply ? "holds" : "changed",
        observed: { millionGho: observed, rawGho: inventory.totalSupply.toString(), bucketLevelSumGho: inventory.bucketLevelSum.toString(), bucketCapacitySumGho: inventory.bucketCapacitySum.toString(), facilitatorCount: inventory.buckets.length },
        recorded: { millionGho: recorded, detail: detail ?? "" },
        reason: "Every registered facilitator's level and capacity is read at the same block. Levels, not unused capacity, reconcile to outstanding supply.",
      };
    },
  },
];

export default checks;
