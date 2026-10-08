import { decodeFunctionData, keccak256, parseAbi, toFunctionSelector, toHex, type Address, type Hex } from "viem";
import timelockHistory from "../../data/failure-scenarios/usde-timelock-history.json";
import {
  memoizeRead,
  requireScenarioChain,
  scenarioSourceAddress,
  type ScenarioCheck,
  type ScenarioCheckContext,
  type ScenarioCheckVerdict,
} from "./index";

const ABI = parseAbi([
  "function owner() view returns (address)",
  "function getMinDelay() view returns (uint256)",
  "function PROPOSER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)",
  "function allowedSafes(address safe) view returns (bool)",
]);
const HISTORY_EVENTS = parseAbi([
  "event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)",
  "event CallExecuted(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data)",
  "event Cancelled(bytes32 indexed id)",
  "event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)",
  "event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)",
  "event RoleAdminChanged(bytes32 indexed role, bytes32 indexed previousAdminRole, bytes32 indexed newAdminRole)",
]);
const CANCEL_ABI = parseAbi(["function cancel(bytes32 id)"]);
const ROLES = {
  PROPOSER_ROLE: keccak256(toHex("PROPOSER_ROLE")),
  CANCELLER_ROLE: keccak256(toHex("CANCELLER_ROLE")),
  EXECUTOR_ROLE: keccak256(toHex("EXECUTOR_ROLE")),
};
const MINTER_SELECTOR = toFunctionSelector("setMinter(address)");
const MINTER_ABI = parseAbi(["function setMinter(address newMinter)"]);
const SENTINEL = "0x0000000000000000000000000000000000000001";
const GUARD_SLOT = "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8";

function baseline(context: ScenarioCheckContext, id: string): bigint {
  const block = context.record.falsifiers.find((entry) => entry.id === id)?.checkedAtBlock;
  if (block == null) throw new Error(`No recorded baseline block for ${id}`);
  return BigInt(block);
}

function delay(context: ScenarioCheckContext): bigint {
  const figure = context.record.keyFigures.find((entry) => entry.label === "Public delay before execution");
  const hours = figure?.value.match(/^(\d+) hours$/)?.[1];
  if (!hours) throw new Error("No exact recorded timelock delay in hours");
  return BigInt(hours) * 3600n;
}

async function code(context: ScenarioCheckContext, sourceId: string, blockNumber: bigint): Promise<`0x${string}`> {
  const { client } = requireScenarioChain(context);
  const bytecode = await client.getBytecode({ address: scenarioSourceAddress(context.record, sourceId), blockNumber });
  if (!bytecode || bytecode === "0x") throw new Error(`No runtime bytecode for ${sourceId} at ${blockNumber}`);
  return keccak256(bytecode);
}

type RoleChange = { event: string; block: number; transaction: string; role: string; account: string; sender: string };
type Operation = { id: string; scheduledBlock: number; scheduleTransaction: string; minterChanges: { index: string; data: string }[] };
type Cancellation = Operation & { block: number; transaction: string; sender: string; transactionSender: string; independent: boolean; senderEvidence: string };
type History = {
  roles: RoleChange[];
  counts: Record<string, number>;
  minterSchedules: number;
  cancellations: Cancellation[];
};

function liveRoles(changes: readonly RoleChange[], role: string, throughBlock: bigint): string[] {
  const live = new Set<string>();
  for (const change of changes) {
    if (change.role !== role || BigInt(change.block) > throughBlock) continue;
    if (change.event === "RoleGranted") live.add(change.account);
    else if (change.event === "RoleRevoked") live.delete(change.account);
  }
  return [...live].sort();
}

async function cancellationSender(context: ScenarioCheckContext, transaction: Hex, id: string, changes: RoleChange[], block: bigint) {
  const { client } = requireScenarioChain(context);
  const address = scenarioSourceAddress(context.record, "timelock").toLowerCase();
  let tx;
  try {
    tx = await client.getTransaction({ hash: transaction });
  } catch (error) {
    throw new Error(`Missing cancellation transaction ${transaction} in block range ${block}-${block}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const cancellers = liveRoles(changes, ROLES.CANCELLER_ROLE, block);
  // Verified TimelockController.cancel is onlyRole(CANCELLER_ROLE), not an open
  // role. The transaction origin is NOT the caller when a Safe relays the call.
  if (cancellers.length === 1) {
    return { sender: cancellers[0]!, transactionSender: tx.from.toLowerCase(), senderEvidence: "Only live CANCELLER_ROLE at this event's log position" };
  }
  let sender: string | undefined;
  if (tx.to?.toLowerCase() === address) {
    try {
      const decoded = decodeFunctionData({ abi: CANCEL_ABI, data: tx.input });
      if (decoded.args[0].toLowerCase() === id) sender = tx.from.toLowerCase();
    } catch { /* A different entrypoint needs an internal-call trace. */ }
  }
  if (!sender || !cancellers.includes(sender)) {
    throw new Error(`Missing internal cancellation caller for transaction ${transaction}, operation ${id}, block range ${block}-${block}; multiple live cancellers and no attributable direct call (transaction origin ${tx.from} is not sufficient)`);
  }
  return { sender, transactionSender: tx.from.toLowerCase(), senderEvidence: "Decoded direct transaction to TimelockController.cancel" };
}

async function scanHistory(context: ScenarioCheckContext): Promise<History> {
  const { client, blockNumber } = requireScenarioChain(context);
  const address = scenarioSourceAddress(context.record, "timelock");
  const token = scenarioSourceAddress(context.record, "token").toLowerCase();
  const safe = scenarioSourceAddress(context.record, "safe").toLowerCase();
  const start = BigInt(timelockHistory.throughBlock);
  if (address.toLowerCase() !== timelockHistory.timelock || token !== timelockHistory.token) {
    throw new Error(`Historical summary does not cover recorded contracts; missing deployment-to-${blockNumber} history`);
  }
  if (blockNumber < start) throw new Error(`Historical summary is through ${start}; missing replay for requested block range ${timelockHistory.deploymentBlock}-${blockNumber}`);
  const pin = await client.getBlock({ blockNumber: start });
  if (pin.hash !== timelockHistory.blockHash) throw new Error(`Historical summary block hash mismatch at ${start}; deployment-to-${start} must be rescanned`);
  if (await code(context, "timelock", blockNumber) !== timelockHistory.runtimeHash) {
    throw new Error(`Timelock runtime differs from the verified history; cancellation and role semantics unavailable for ${start + 1n}-${blockNumber}`);
  }
  const history: History = {
    roles: timelockHistory.roles.map((entry) => ({ ...entry })),
    counts: { ...timelockHistory.counts },
    minterSchedules: timelockHistory.minterSchedules,
    cancellations: [...timelockHistory.cancellations],
  };
  const pending = new Map<string, Operation>(timelockHistory.pendingOperations.map((entry) => [entry.id, { ...entry, minterChanges: [...entry.minterChanges] }]));
  // The committed summary covers every log from deployment, not a spot-read
  // seed. Only its immutable prefix is cached; every run scans the entire suffix.
  for (let fromBlock = start + 1n; fromBlock <= blockNumber; fromBlock += 10_000n) {
    const toBlock = fromBlock + 9_999n < blockNumber ? fromBlock + 9_999n : blockNumber;
    let logs;
    try {
      logs = await client.getLogs({ address, events: HISTORY_EVENTS, fromBlock, toBlock, strict: true });
    } catch (error) {
      throw new Error(`Missing CallScheduled/CallExecuted/Cancelled/role-management history in block range ${fromBlock}-${toBlock}: ${error instanceof Error ? error.message : String(error)}`);
    }
    logs.sort((a, b) => a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : a.logIndex - b.logIndex);
    for (const log of logs) {
      history.counts[log.eventName] = (history.counts[log.eventName] ?? 0) + 1;
      switch (log.eventName) {
        case "RoleGranted":
        case "RoleRevoked":
          history.roles.push({ event: log.eventName, block: Number(log.blockNumber), transaction: log.transactionHash, role: log.args.role.toLowerCase(), account: log.args.account.toLowerCase(), sender: log.args.sender.toLowerCase() });
          break;
        case "CallScheduled": {
          let operation = pending.get(log.args.id);
          if (!operation) {
            operation = { id: log.args.id, scheduledBlock: Number(log.blockNumber), scheduleTransaction: log.transactionHash, minterChanges: [] };
            pending.set(operation.id, operation);
          }
          if (log.args.target.toLowerCase() === token && log.args.data.slice(0, 10) === MINTER_SELECTOR) {
            // Validate the full payload, not just its selector.
            decodeFunctionData({ abi: MINTER_ABI, data: log.args.data });
            operation.minterChanges.push({ index: log.args.index.toString(), data: log.args.data });
            history.minterSchedules++;
          }
          break;
        }
        case "CallExecuted":
          pending.delete(log.args.id);
          break;
        case "Cancelled": {
          const operation = pending.get(log.args.id);
          if (!operation) throw new Error(`Missing schedule for cancellation ${log.transactionHash}, operation ${log.args.id}, block ${log.blockNumber}; cannot classify a partial history`);
          const caller = await cancellationSender(context, log.transactionHash, log.args.id, history.roles, log.blockNumber);
          history.cancellations.push({ ...operation, block: Number(log.blockNumber), transaction: log.transactionHash, ...caller, independent: caller.sender !== safe });
          pending.delete(log.args.id);
          break;
        }
      }
    }
  }
  return history;
}

function history(context: ScenarioCheckContext): Promise<History> {
  const { blockNumber } = requireScenarioChain(context);
  const key = `usde-history:1:${blockNumber}:${scenarioSourceAddress(context.record, "timelock")}:${scenarioSourceAddress(context.record, "token")}:${scenarioSourceAddress(context.record, "safe")}`;
  return memoizeRead(context, key, () => scanHistory(context));
}

const checks: readonly ScenarioCheck[] = [
  {
    id: "token-owner-timelock",
    label: "USDe owner remains the recorded timelock",
    async run(context) {
      const { client, blockNumber } = requireScenarioChain(context);
      const recorded = scenarioSourceAddress(context.record, "timelock").toLowerCase();
      const observed = (await client.readContract({ address: scenarioSourceAddress(context.record, "token"), abi: ABI, functionName: "owner", blockNumber })).toLowerCase();
      return { verdict: observed === recorded ? "holds" : "changed", observed, recorded };
    },
  },
  {
    id: "timelock-delay-proposers",
    label: "Timelock minimum delay remains at least the recorded delay",
    async run(context) {
      const { client, blockNumber } = requireScenarioChain(context);
      const recorded = delay(context);
      const observed = await client.readContract({ address: scenarioSourceAddress(context.record, "timelock"), abi: ABI, functionName: "getMinDelay", blockNumber });
      return { verdict: observed >= recorded ? "holds" : "changed", observed: observed.toString(), recorded: recorded.toString() };
    },
  },
  {
    id: "timelock-delay-proposers",
    label: "Full proposer, canceller and executor grant inventory",
    async run(context): Promise<ScenarioCheckVerdict> {
      const { client, blockNumber } = requireScenarioChain(context);
      const address = scenarioSourceAddress(context.record, "timelock");
      const safe = scenarioSourceAddress(context.record, "safe").toLowerCase();
      const pin = baseline(context, "timelock-delay-proposers");
      const recordedCode = await code(context, "timelock", pin);
      const observedCode = await code(context, "timelock", blockNumber);
      if (recordedCode !== observedCode) return { verdict: "changed", recorded: recordedCode, observed: observedCode, reason: "Timelock runtime changed; proposer-role semantics require source review" };
      if (blockNumber < pin) return { verdict: "unavailable", reason: "Run block predates the recorded proposer inventory" };
      const scanned = await history(context);
      const grants = scanned.roles.filter((entry) => entry.event === "RoleGranted" && Object.values(ROLES).includes(entry.role as Hex));
      const inventory = await Promise.all(grants.map(async (grant) => {
        const role = Object.entries(ROLES).find(([, hash]) => hash === grant.role)![0];
        const [liveAtRecordedBlock, liveAtRunBlock] = await Promise.all([
          client.readContract({ address, abi: ABI, functionName: "hasRole", args: [grant.role as Hex, grant.account as Address], blockNumber: pin }),
          client.readContract({ address, abi: ABI, functionName: "hasRole", args: [grant.role as Hex, grant.account as Address], blockNumber }),
        ]);
        if (liveAtRecordedBlock !== liveRoles(scanned.roles, grant.role, pin).includes(grant.account)
          || liveAtRunBlock !== liveRoles(scanned.roles, grant.role, blockNumber).includes(grant.account)) {
          throw new Error(`Role replay disagrees with hasRole for ${role}/${grant.account} at ${pin} or ${blockNumber}; historical inventory is incomplete`);
        }
        return { role, account: grant.account, grantedAtBlock: grant.block, grantTransaction: grant.transaction, liveAtRecordedBlock, liveAtRunBlock };
      }));
      const proposers = liveRoles(scanned.roles, ROLES.PROPOSER_ROLE!, blockNumber);
      return {
        verdict: proposers.length === 1 && proposers[0] === safe ? "holds" : "changed",
        recorded: { proposers: [safe], block: pin.toString() },
        observed: { proposers, inventory, throughBlock: blockNumber.toString() },
        reason: "Every historical grant is included, including revoked accounts; pinned hasRole reads reconcile the complete event replay",
      };
    },
  },
  {
    id: "safe-signature-threshold",
    kind: "figure",
    recordField: { collection: "keyFigures", label: "Signatures to repoint the minter" },
    label: "Governance Safe signature threshold and owner count",
    async run(context) {
      const { client, blockNumber } = requireScenarioChain(context);
      const figure = context.record.keyFigures.find((entry) => entry.label === "Signatures to repoint the minter");
      const match = figure?.value.match(/^(\d+) of (\d+)$/);
      if (!match) throw new Error("No exact recorded Safe threshold and owner count");
      const address = scenarioSourceAddress(context.record, "safe");
      const threshold = await client.readContract({ address, abi: ABI, functionName: "getThreshold", blockNumber });
      const owners = await client.readContract({ address, abi: ABI, functionName: "getOwners", blockNumber });
      const recorded = { threshold: match[1], owners: Number(match[2]) };
      const observed = { threshold: threshold.toString(), owners: owners.length };
      return { verdict: observed.threshold === recorded.threshold && observed.owners === recorded.owners ? "holds" : "changed", recorded, observed };
    },
  },
  {
    id: "safe-independent-veto",
    label: "Governance Safe has no enabled modules",
    async run(context) {
      const { client, blockNumber } = requireScenarioChain(context);
      const [modules, next] = await client.readContract({ address: scenarioSourceAddress(context.record, "safe"), abi: ABI, functionName: "getModulesPaginated", args: [SENTINEL, 1n], blockNumber });
      return { verdict: modules.length === 0 && next.toLowerCase() === SENTINEL ? "holds" : "changed", recorded: { modules: [], next: SENTINEL }, observed: { modules: [...modules], next }, reason: "One enabled module is enough to require review; nonempty inventories are not claimed complete" };
    },
  },
  {
    id: "safe-independent-veto",
    label: "Safe guard, guard runtime and guard owner remain unchanged",
    async run(context): Promise<ScenarioCheckVerdict> {
      const { client, blockNumber } = requireScenarioChain(context);
      const address = scenarioSourceAddress(context.record, "safe");
      const guard = scenarioSourceAddress(context.record, "guard");
      const storage = await client.getStorageAt({ address, slot: GUARD_SLOT, blockNumber });
      if (!storage) throw new Error("Safe guard storage unavailable");
      const observedGuard = `0x${storage.slice(-40)}`.toLowerCase();
      if (observedGuard !== guard.toLowerCase()) return { verdict: "changed", recorded: guard.toLowerCase(), observed: observedGuard, reason: "Safe guard changed; review its veto capabilities" };
      const pin = baseline(context, "safe-independent-veto");
      const recorded = {
        guard: guard.toLowerCase(),
        code: await code(context, "guard", pin),
        owner: (await client.readContract({ address: guard, abi: ABI, functionName: "owner", blockNumber: pin })).toLowerCase(),
        allowedSafe: true,
      };
      const observed = {
        guard: observedGuard,
        code: await code(context, "guard", blockNumber),
        owner: (await client.readContract({ address: guard, abi: ABI, functionName: "owner", blockNumber })).toLowerCase(),
        allowedSafe: await client.readContract({ address: guard, abi: ABI, functionName: "allowedSafes", args: [address], blockNumber }),
      };
      return { verdict: observed.code === recorded.code && observed.owner === recorded.owner && observed.allowedSafe ? "holds" : "changed", recorded, observed, reason: "Unchanged recorded guard is an executor-policy guard, not an independent intent veto" };
    },
  },
  {
    id: "token-mint-limit",
    label: "Token's uncapped mint implementation remains unchanged",
    async run(context) {
      const { blockNumber } = requireScenarioChain(context);
      const recorded = await code(context, "token", baseline(context, "token-mint-limit"));
      const observed = await code(context, "token", blockNumber);
      return { verdict: observed === recorded ? "holds" : "changed", recorded, observed, reason: "Compare USDe token runtime, not the separate EthenaMinting per-block limit; changed code requires mint-path source review" };
    },
  },
  {
    id: "minter-change-veto-history",
    label: "Historical cancellation outside the proposing Safe",
    async run(context) {
      const { blockNumber } = requireScenarioChain(context);
      const scanned = await history(context);
      const falsifier = context.record.falsifiers.find((entry) => entry.id === "minter-change-veto-history");
      if (!falsifier) throw new Error("Missing recorded minter-change-veto-history condition");
      const independent = scanned.cancellations.filter((entry) => entry.independent && entry.minterChanges.length > 0);
      return {
        verdict: independent.length > 0 ? "changed" : "holds",
        recorded: { condition: falsifier.condition, status: falsifier.status },
        observed: {
          fromBlock: timelockHistory.deploymentBlock,
          cachedThroughBlock: timelockHistory.throughBlock,
          throughBlock: blockNumber.toString(),
          events: scanned.counts,
          minterSchedules: scanned.minterSchedules,
          cancellations: scanned.cancellations,
          independentMinterCancellations: independent,
        },
        reason: "Complete deployment-to-run CallScheduled/CallExecuted/Cancelled and role history. Sender means the timelock caller, not the EOA relaying a Safe transaction. No off-chain review or rejected pre-schedule intent is inferred",
      };
    },
  },
];

export default checks;
