import { keccak256, parseAbi } from "viem";
import {
  requireScenarioChain, scenarioSourceAddress,
  type ScenarioCheck, type ScenarioCheckContext, type ScenarioCheckValue, type ScenarioCheckVerdict,
} from "./index";

const ABI = parseAbi([
  "function owner() view returns (address)",
  "function admin() view returns (address)",
  "function dao() view returns (address)",
  "function stablecoin() view returns (address)",
  "function minter() view returns (address)",
  "function voteDelegate() view returns (address)",
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function getModulesPaginated(address start, uint256 pageSize) view returns (address[], address)",
  "function operatorCount() view returns (uint256)",
  "function operatorList(uint256 index) view returns (address)",
  "function operators(address account) view returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);
const GUARD_SLOT = "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8";
const SENTINEL = "0x0000000000000000000000000000000000000001";
const ZERO_SLOT = `0x${"0".repeat(64)}`;

function baselineBlock(context: ScenarioCheckContext, id: string): bigint {
  const block = context.record.falsifiers.find((entry) => entry.id === id)?.checkedAtBlock;
  if (block === undefined) throw new Error(`No recorded baseline block for ${id}`);
  return BigInt(block);
}

function compare(observed: ScenarioCheckValue, recorded: ScenarioCheckValue, reason?: string): ScenarioCheckVerdict {
  return { verdict: JSON.stringify(observed) === JSON.stringify(recorded) ? "holds" : "changed", observed, recorded, ...(reason ? { reason } : {}) };
}

/** Runtime identity re-verifies the source/fork-tested path, not a new transaction replay. */
async function codeHashes(context: ScenarioCheckContext, sources: string[], blockNumber: bigint): Promise<Record<string, string>> {
  const { client } = requireScenarioChain(context);
  const hashes: Record<string, string> = {};
  for (const id of sources) {
    const code = await client.getBytecode({ address: scenarioSourceAddress(context.record, id), blockNumber });
    if (!code || code === "0x") throw new Error(`No deployed code for ${id} at block ${blockNumber}`);
    hashes[id] = keccak256(code);
  }
  return hashes;
}

const checks: readonly ScenarioCheck[] = [
  {
    id: "extension-owner",
    label: "Vote-extension owner remains the recorded Safe",
    async run(context) {
      const { client, blockNumber } = requireScenarioChain(context);
      const owner = await client.readContract({ address: scenarioSourceAddress(context.record, "extension"), abi: ABI, functionName: "owner", blockNumber });
      return compare(owner.toLowerCase(), scenarioSourceAddress(context.record, "safe").toLowerCase());
    },
  },
  {
    id: "caster-handoff-delay",
    label: "Both immediate caster hand-offs: code and authority pointers",
    async run(context) {
      const { client, blockNumber } = requireScenarioChain(context);
      const sources = ["extension", "booster", "boosterowner", "boosterowner-secondary"];
      const readPointers = async (pin: bigint) => {
        const booster = scenarioSourceAddress(context.record, "booster");
        const [delegate, owner, secondary, safe] = await Promise.all([
          client.readContract({ address: booster, abi: ABI, functionName: "voteDelegate", blockNumber: pin }),
          client.readContract({ address: booster, abi: ABI, functionName: "owner", blockNumber: pin }),
          client.readContract({ address: scenarioSourceAddress(context.record, "boosterowner"), abi: ABI, functionName: "owner", blockNumber: pin }),
          client.readContract({ address: scenarioSourceAddress(context.record, "boosterowner-secondary"), abi: ABI, functionName: "owner", blockNumber: pin }),
        ]);
        return { delegate: delegate.toLowerCase(), boosterOwner: owner.toLowerCase(), secondaryOwner: secondary.toLowerCase(), safeOwner: safe.toLowerCase() };
      };
      const baseline = baselineBlock(context, "caster-handoff-delay");
      const recorded = { codeHashes: await codeHashes(context, sources, baseline), pointers: await readPointers(baseline) };
      const observed = { codeHashes: await codeHashes(context, sources, blockNumber), pointers: await readPointers(blockNumber) };
      return compare(observed, recorded, "Identical non-proxy runtimes and authority pointers preserve the source-verified no-delay setDaoOperator and revertControl paths; no transaction is broadcast.");
    },
  },
  {
    id: "safe-guard",
    label: "Safe threshold / owners / modules / guard",
    async run(context) {
      const { client, blockNumber } = requireScenarioChain(context);
      const safe = scenarioSourceAddress(context.record, "safe");
      const keyText = context.record.branchPoint?.branches.find((branch) => branch.id === "safe")?.keys;
      const keys = keyText?.match(/^(\d+) of (\d+)$/);
      if (!keys) throw new Error("Safe threshold and owner count missing from recorded branch keys");
      const [threshold, owners, modules, guard] = await Promise.all([
        client.readContract({ address: safe, abi: ABI, functionName: "getThreshold", blockNumber }),
        client.readContract({ address: safe, abi: ABI, functionName: "getOwners", blockNumber }),
        client.readContract({ address: safe, abi: ABI, functionName: "getModulesPaginated", args: [SENTINEL, 100n], blockNumber }),
        client.getStorageAt({ address: safe, slot: GUARD_SLOT, blockNumber }),
      ]);
      if (!guard) throw new Error("Safe guard storage read returned no value");
      // A nonempty first page already proves drift; do not mistake truncation for absence.
      return compare(
        { threshold: threshold.toString(), owners: owners.length, modules: [...modules[0]].map((address) => address.toLowerCase()), nextModule: modules[1].toLowerCase(), guard: guard.toLowerCase() },
        { threshold: keys[1]!, owners: Number(keys[2]), modules: [], nextModule: SENTINEL, guard: ZERO_SLOT },
      );
    },
  },
  {
    id: "core-operators",
    label: "ConvexCore operator set and unrestricted-execute runtime",
    async run(context) {
      const { client, blockNumber } = requireScenarioChain(context);
      const core = scenarioSourceAddress(context.record, "convexcore");
      const readOperators = async (pin: bigint) => {
        const count = await client.readContract({ address: core, abi: ABI, functionName: "operatorCount", blockNumber: pin });
        const operators: string[] = [];
        for (let index = 0n; index < count; index++) {
          const operator = await client.readContract({ address: core, abi: ABI, functionName: "operatorList", args: [index], blockNumber: pin });
          const enabled = await client.readContract({ address: core, abi: ABI, functionName: "operators", args: [operator], blockNumber: pin });
          if (!enabled) throw new Error(`Operator array/mapping disagree for ${operator} at block ${pin}`);
          operators.push(operator.toLowerCase());
        }
        return operators.sort();
      };
      const baseline = baselineBlock(context, "core-operators");
      return compare(
        { operators: await readOperators(blockNumber), codeHashes: await codeHashes(context, ["convexcore"], blockNumber) },
        { operators: await readOperators(baseline), codeHashes: await codeHashes(context, ["convexcore"], baseline) },
      );
    },
  },
  {
    id: "convex-vecrv-share",
    label: "Convex veCRV share stays strictly above 51%",
    async run(context) {
      const { client, blockNumber } = requireScenarioChain(context);
      const vecrv = scenarioSourceAddress(context.record, "vecrv");
      const [balance, supply] = await Promise.all([
        client.readContract({ address: vecrv, abi: ABI, functionName: "balanceOf", args: [scenarioSourceAddress(context.record, "voterproxy")], blockNumber }),
        client.readContract({ address: vecrv, abi: ABI, functionName: "totalSupply", blockNumber }),
      ]);
      if (supply === 0n) throw new Error("veCRV total voting power is zero; share is undefined");
      const recordedShare = context.record.stages.map((stage) => stage.explanation).join(" ").match(/\b(\d+\.\d+)% share/)?.[1];
      if (!recordedShare) throw new Error("Exact recorded veCRV share missing from scenario text");
      const scaled = balance * 1_000_000n / supply;
      const sharePct = `${scaled / 10_000n}.${(scaled % 10_000n).toString().padStart(4, "0")}%`;
      return {
        verdict: balance * 100n > supply * 51n ? "holds" : "changed",
        observed: { sharePct, balance: balance.toString(), totalSupply: supply.toString(), block: blockNumber.toString() },
        recorded: { sharePct: `${recordedShare}%`, boundary: "strictly above 51%", block: baselineBlock(context, "convex-vecrv-share").toString() },
        reason: "Monthly head-state share is not a future vote snapshot; movement above 51% is informational, crossing to 51% or less changes this premise.",
      };
    },
  },
  {
    id: "arbitrary-mint-recipient",
    label: "Factory admin and arbitrary-recipient ceiling path",
    async run(context) {
      const { client, blockNumber } = requireScenarioChain(context);
      const factory = scenarioSourceAddress(context.record, "factory");
      const intermediary = scenarioSourceAddress(context.record, "intermediary");
      const targets = context.record.stages.flatMap((stage) => stage.targets ?? []);
      const token = targets.find((target) => target.label === "crvUSD")?.address;
      const dao = targets.find((target) => target.label === "DAO Agent")?.address;
      if (!token || !dao) throw new Error("Recorded crvUSD mint-chain targets are missing");
      const readPointers = async (pin: bigint) => {
        const [admin, currentDao, stablecoin, minter] = await Promise.all([
          client.readContract({ address: factory, abi: ABI, functionName: "admin", blockNumber: pin }),
          client.readContract({ address: intermediary, abi: ABI, functionName: "dao", blockNumber: pin }),
          client.readContract({ address: factory, abi: ABI, functionName: "stablecoin", blockNumber: pin }),
          client.readContract({ address: token, abi: ABI, functionName: "minter", blockNumber: pin }),
        ]);
        return { admin: admin.toLowerCase(), dao: currentDao.toLowerCase(), token: stablecoin.toLowerCase(), minter: minter.toLowerCase() };
      };
      const tokenCodeHash = async (pin: bigint) => {
        const code = await client.getBytecode({ address: token, blockNumber: pin });
        if (!code || code === "0x") throw new Error(`No crvUSD token runtime at block ${pin}`);
        return keccak256(code);
      };
      const baseline = baselineBlock(context, "arbitrary-mint-recipient");
      return compare(
        { pointers: await readPointers(blockNumber), codeHashes: await codeHashes(context, ["factory", "intermediary"], blockNumber), tokenCodeHash: await tokenCodeHash(blockNumber) },
        { pointers: { admin: intermediary.toLowerCase(), dao: dao.toLowerCase(), token: token.toLowerCase(), minter: factory.toLowerCase() }, codeHashes: await codeHashes(context, ["factory", "intermediary"], baseline), tokenCodeHash: await tokenCodeHash(baseline) },
        "Identical non-proxy factory/admin/token runtimes and mint-chain pointers preserve the arbitrary-recipient set_debt_ceiling path established by the recorded source and fork replay; no mint transaction is sent.",
      );
    },
  },
];

export default checks;
