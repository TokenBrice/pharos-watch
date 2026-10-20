import { concat, keccak256, pad, parseAbi, parseAbiItem, toHex, type Address, type Hex } from "viem";
import proposerCheckpoint from "../../data/failure-scenarios/cusd-timelock-proposers.json";
import type { ScenarioCheck, ScenarioCheckContext, ScenarioCheckValue } from "./context";
import { memoizeRead, requireScenarioChain, scenarioDocumentWatch } from "./context";

const implementationSlot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const safeGuardSlot = "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8";
const sentinel = "0x0000000000000000000000000000000000000001";

// Evidence pin: Ethereum block 26176412 (2026-10-12), research corpus agents/cusd-research/.
const devSafe = "0xb8fc49402df3ee4f8587268fb89fda4d621a8793" as Address;
const cusd = "0xcccc62962d17b8914c62d74ffb843d73b2a3cccc" as Address;
const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as Address;
const accessControl = "0x7731129a10d51e18cde607c5c115f26503d2c683" as Address;
const delegation = "0xf3e3eae671000612ce3fd15e1019154c1a4d693f" as Address;
const eigenAgentManager = "0xa82f6f9e67e127621f3e5f3953beef926b4b5ba9" as Address;
const yearnFrUsdc = "0x3ed6aa32c930253fc990de58ff882b9186cd0072" as Address;
const curvePool = "0x2d1eb1704d0ee227b7528c5bdb4fd256d6ac5b09" as Address;
const timelock = "0xd8236031d8279d82e615af2bfab5fc0127a329ab" as Address;

const delegationImplAtPin = "0x7e2d738042376bf48bebc49932869eac3d7e38b5";
const eigenAgentManagerImplAtPin = "0x9dd8da3f46d4b5ba1ea1e1e7421e8106e2777692";
const yearnEmergencyEoa = "0xc1ab5a9593e6e1662a9a44f84df4f31fc8a76b52" as Address;
const yearnCloneTargetAtPin = "0xd8063123bba3b480569244ae66bfe72b6c84b00d";

// Yearn V3 role bits held directly by the Safe at the pin (full mask 16383):
// ADD_STRATEGY_MANAGER, DEBT_MANAGER, MAX_DEBT_MANAGER, WITHDRAW_LIMIT_MANAGER.
const requiredRoleBits = [1n, 64n, 128n, 512n];
const safeAbi = parseAbi([
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
]);

const yearnAbi = parseAbi(["function roles(address) view returns (uint256)"]);
const aclAbi = parseAbi(["function hasRole(bytes32 role, address account) view returns (bool)"]);
const capAbi = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function availableBalance(address asset) view returns (uint256)",
  "function totalBorrows(address asset) view returns (uint256)",
]);
const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const curveAbi = parseAbi(["function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)"]);

function verdict(
  holds: boolean,
  observed: ScenarioCheckValue,
  recorded: ScenarioCheckValue,
  reason?: string,
) {
  return holds
    ? { verdict: "holds" as const, observed, recorded, reason }
    : { verdict: "changed" as const, observed, recorded, reason };
}

class ScenarioReadUnavailableError extends Error {
  name = "ScenarioReadUnavailableError";
}

function storageWord(raw: Hex | undefined, address: Address, slot: Hex): Hex {
  if (!raw || !/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new ScenarioReadUnavailableError(`Storage word unavailable at ${address} slot ${slot}: expected 32-byte hex`);
  }
  return raw;
}

async function storageAddress(
  context: ScenarioCheckContext, address: Address, slot: Hex,
): Promise<Address> {
  const chain = requireScenarioChain(context, 1);
  return memoizeRead(context, `eth:${address}:${slot}`, async () => {
    const raw = storageWord(
      await chain.client.getStorageAt({ address, slot, blockNumber: chain.blockNumber }), address, slot,
    );
    return `0x${raw.slice(-40)}` as Address;
  });
}

async function safeState(context: ScenarioCheckContext) {
  const chain = requireScenarioChain(context, 1);
  const [threshold, owners, modules, guard] = await Promise.all([
    memoizeRead(context, `eth:${devSafe}:threshold`, () => chain.client.readContract({
      address: devSafe, abi: safeAbi, functionName: "getThreshold", blockNumber: chain.blockNumber,
    })),
    memoizeRead(context, `eth:${devSafe}:owners`, () => chain.client.readContract({
      address: devSafe, abi: safeAbi, functionName: "getOwners", blockNumber: chain.blockNumber,
    })),
    memoizeRead(context, `eth:${devSafe}:module-head`, async () => {
      // Gnosis Safe 1.4.x keeps the modules linked-list mapping at storage slot 1;
      // its head is storage[keccak256(pad(sentinel) . pad(slot 1))], equal to the
      // sentinel itself when no module is enabled.
      const headSlot = keccak256(concat([pad(sentinel, { size: 32 }), pad("0x1", { size: 32 })]));
      const raw = await chain.client.getStorageAt({
        address: devSafe, slot: headSlot, blockNumber: chain.blockNumber,
      });
      return BigInt(storageWord(raw, devSafe, headSlot));
    }),
    storageAddress(context, devSafe, safeGuardSlot),
  ]);
  return { threshold, owners, modules, guard };
}

async function aclRole(
  context: ScenarioCheckContext, selector: Hex, target: Address, account: Address,
) {
  const chain = requireScenarioChain(context, 1);
  // Cap's central ACL derives role ids as bytes32(selector) | bytes32(uint160(target)):
  // selector left-aligned in the top four bytes, target right-aligned in the low twenty.
  const role = toHex((BigInt(selector) << 224n) | BigInt(target), { size: 32 });
  return memoizeRead(context, `eth:${accessControl}:hasRole:${role}:${account}`, () =>
    chain.client.readContract({
      address: accessControl, abi: aclAbi, functionName: "hasRole", args: [role, account],
      blockNumber: chain.blockNumber,
    }));
}

async function yearnCloneTarget(context: ScenarioCheckContext): Promise<Address | null> {
  const chain = requireScenarioChain(context, 1);
  return memoizeRead(context, `eth:${yearnFrUsdc}:bytecode`, async () => {
    const code = await chain.client.getBytecode({ address: yearnFrUsdc, blockNumber: chain.blockNumber });
    if (!code || code.length % 2 !== 0 || !/^0x[0-9a-fA-F]+$/.test(code)) {
      throw new ScenarioReadUnavailableError(`Bytecode unavailable at ${yearnFrUsdc}: expected nonempty hex bytes`);
    }
    // Authenticate the complete EIP-1167 runtime, not just its embedded target.
    const target = code.match(/^0x363d3d373d3d3d363d73([0-9a-fA-F]{40})5af43d82803e903d91602b57fd5bf3$/i)?.[1];
    return target ? `0x${target.toLowerCase()}` as Address : null;
  });
}

/** Largest cUSD input whose average get_dy rate stays within one percent of the small-quote rate. */
async function curveOnePercentSize(context: ScenarioCheckContext): Promise<string> {
  const chain = requireScenarioChain(context, 1);
  const quote = (dx: bigint) => memoizeRead(context, `eth:${curvePool}:getdy:${dx}`, () =>
    chain.client.readContract({
      address: curvePool, abi: curveAbi, functionName: "get_dy",
      args: [0n, 1n, dx], blockNumber: chain.blockNumber,
    }));
  const tiny = 10n ** 15n;
  const tinyOut = await quote(tiny);
  if (tinyOut <= 0n) throw new Error("Curve small-quote get_dy returned zero");
  const reference = Number(tinyOut) / Number(tiny);
  const withinOnePercent = async (dx: bigint) => {
    const out = await quote(dx);
    return 1 - Number(out) / Number(dx) / reference <= 0.01;
  };
  if (!(await withinOnePercent(tiny))) return "0";
  let low = tiny;
  let high = tiny;
  while (high < 10n ** 24n && await withinOnePercent(high * 2n)) {
    low = high;
    high *= 2n;
  }
  // The loop exits with `high` still inside the bound and `high * 2` outside it.
  low = high;
  high *= 2n;
  while (high - low > low / 1000n + 1n) {
    const mid = (low + high) / 2n;
    if (await withinOnePercent(mid)) low = mid;
    else high = mid;
  }
  return (Number(low) / 1e18).toFixed(6);
}

const checks: readonly ScenarioCheck[] = [
  {
    id: "safe-composition",
    label: "Developer Safe threshold, owner count, guard and modules",
    async run(context) {
      const state = await safeState(context);
      const observed = {
        threshold: Number(state.threshold),
        ownerCount: state.owners.length,
        guard: state.guard,
        moduleHead: state.modules === 0n || state.modules === BigInt(sentinel) ? "none" : "present",
      };
      const recorded = { threshold: 3, ownerCount: 5, guard: "0x0000000000000000000000000000000000000000", moduleHead: "none" };
      return verdict(
        observed.threshold === recorded.threshold
        && observed.ownerCount === recorded.ownerCount
        && observed.guard === recorded.guard
        && observed.moduleHead === recorded.moduleHead,
        observed,
        recorded,
        "A different threshold or owner set, an enabled guard, or any enabled module changes who must collude or what can screen the captured calls.",
      );
    },
  },
  {
    id: "fr-vault-roles",
    label: "Safe Yearn role bits and clone runtime on the USDC fractional-reserve vault",
    async run(context) {
      const chain = requireScenarioChain(context, 1);
      const mask = await memoizeRead(context, `eth:${yearnFrUsdc}:roles:${devSafe}`, () =>
        chain.client.readContract({
          address: yearnFrUsdc, abi: yearnAbi, functionName: "roles", args: [devSafe],
          blockNumber: chain.blockNumber,
        }));
      const cloneTarget = await yearnCloneTarget(context);
      const missing = requiredRoleBits.filter((bit) => (mask & bit) !== bit).map(String);
      const observed = { roleMask: mask.toString(), missingRequiredBits: missing, cloneTarget };
      const recorded = { roleMask: "16383", missingRequiredBits: [] as string[], cloneTarget: yearnCloneTargetAtPin };
      return verdict(
        missing.length === 0 && cloneTarget === recorded.cloneTarget,
        observed,
        recorded,
        "Losing ADD_STRATEGY_MANAGER, DEBT_MANAGER, MAX_DEBT_MANAGER or WITHDRAW_LIMIT_MANAGER, or a vault runtime change, removes or re-reviews the zero-delay freeze and reallocation route.",
      );
    },
  },
  {
    id: "central-direct-roles",
    label: "Direct Safe grants for Delegation.registerNetwork and EigenAgentManager.setServiceManager",
    async run(context) {
      const [registerNetwork, setServiceManager, delegationImpl, eigenImpl] = await Promise.all([
        aclRole(context, "0x184aa723", delegation, devSafe),
        aclRole(context, "0x9b41bf23", eigenAgentManager, devSafe),
        storageAddress(context, delegation, implementationSlot),
        storageAddress(context, eigenAgentManager, implementationSlot),
      ]);
      const observed = {
        safeHoldsRegisterNetwork: registerNetwork,
        safeHoldsSetServiceManager: setServiceManager,
        delegationImpl,
        eigenAgentManagerImpl: eigenImpl,
      };
      const recorded = {
        safeHoldsRegisterNetwork: true,
        safeHoldsSetServiceManager: true,
        delegationImpl: delegationImplAtPin,
        eigenAgentManagerImpl: eigenAgentManagerImplAtPin,
      };
      return verdict(
        observed.safeHoldsRegisterNetwork && observed.safeHoldsSetServiceManager
        && observed.delegationImpl === delegationImplAtPin
        && observed.eigenAgentManagerImpl === eigenAgentManagerImplAtPin,
        observed,
        recorded,
        "Removing either direct grant, or a Delegation or EigenAgentManager runtime change, closes or re-reviews the fictitious-coverage entry this scenario records.",
      );
    },
  },
  {
    id: "redemption-capacity-share",
    label: "Synchronous USDC redemption capacity and idle share of cUSD supply",
    async run(context) {
      const chain = requireScenarioChain(context, 1);
      const [supply, available, idle] = await Promise.all([
        memoizeRead(context, `eth:${cusd}:totalSupply`, () => chain.client.readContract({
          address: cusd, abi: capAbi, functionName: "totalSupply", blockNumber: chain.blockNumber,
        })),
        memoizeRead(context, `eth:${cusd}:availableBalance:usdc`, () => chain.client.readContract({
          address: cusd, abi: capAbi, functionName: "availableBalance", args: [usdc],
          blockNumber: chain.blockNumber,
        })),
        memoizeRead(context, `eth:${usdc}:balanceOf:${cusd}`, () => chain.client.readContract({
          address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [cusd],
          blockNumber: chain.blockNumber,
        })),
      ]);
      if (supply <= 0n) return { verdict: "unavailable", reason: "cUSD totalSupply read returned zero" };
      // USDC carries six decimals against cUSD's eighteen; scale before dividing.
      const observed = {
        availableSharePct: Number((available * 10n ** 12n * 10000n) / supply) / 100,
        idleSharePct: Number((idle * 10n ** 12n * 1000000n) / supply) / 10000,
      };
      const recorded = { availableSharePct: 23.81, idleSharePct: 0.0041 };
      return verdict(
        observed.availableSharePct < 50 && observed.idleSharePct < 5,
        observed,
        recorded,
        "Capacity at or above half of supply, or idle cash at or above five percent, restores a runnable exit and breaks the thin-exit premise; the recorded percentages are pin values, not the hold condition.",
      );
    },
  },
  {
    id: "operator-lending-share",
    label: "Operator USDC borrows as a share of cUSD supply",
    async run(context) {
      const chain = requireScenarioChain(context, 1);
      const [supply, borrows] = await Promise.all([
        memoizeRead(context, `eth:${cusd}:totalSupply`, () => chain.client.readContract({
          address: cusd, abi: capAbi, functionName: "totalSupply", blockNumber: chain.blockNumber,
        })),
        memoizeRead(context, `eth:${cusd}:totalBorrows:usdc`, () => chain.client.readContract({
          address: cusd, abi: capAbi, functionName: "totalBorrows", args: [usdc],
          blockNumber: chain.blockNumber,
        })),
      ]);
      if (supply <= 0n) return { verdict: "unavailable", reason: "cUSD totalSupply read returned zero" };
      const observed = { borrowSharePct: Number((borrows * 10n ** 12n * 10000n) / supply) / 100 };
      const recorded = { borrowSharePct: 76.08 };
      return verdict(
        borrows * 10n ** 12n * 4n > supply,
        observed,
        recorded,
        "Operator borrows at or below a quarter of supply would mean backing is mostly liquid again; the premise that holders hold operator claims instead of cash would no longer hold.",
      );
    },
  },
  {
    id: "curve-depth",
    label: "Curve cUSD pool sale size at one percent average slippage",
    async run(context) {
      const size = await curveOnePercentSize(context);
      const observed = { cusdAtOnePercentSlippage: size };
      const recorded = { cusdAtOnePercentSlippage: "3.592" };
      return verdict(
        size !== ">=1000000" && Number(size) < 1000000,
        observed,
        recorded,
        "A one-percent sale size of one million cUSD or more restores a meaningful secondary exit; the recorded 3.592 cUSD is the pinned reading, and smaller drift within the bound still holds the premise.",
      );
    },
  },
  {
    id: "timelock-proposer",
    label: "Timelock proposer sole-membership and minimum delay",
    async run(context) {
      const chain = requireScenarioChain(context, 1);
      const proposerRole = `0x${proposerCheckpoint.proposerRole.slice(2)}` as Hex;
      const events = [
        parseAbiItem("event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)"),
        parseAbiItem("event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)"),
      ];
      const start = BigInt(proposerCheckpoint.throughBlock);
      if (proposerCheckpoint.timelock !== timelock) {
        throw new Error("Proposer checkpoint names a different timelock; regenerate the committed history");
      }
      if (chain.blockNumber < start) {
        throw new Error(`Head ${chain.blockNumber} precedes the proposer checkpoint ${start}`);
      }
      const pin = await chain.client.getBlock({ blockNumber: start });
      if (pin.hash !== proposerCheckpoint.blockHash) {
        throw new Error(`Proposer checkpoint block hash mismatch at ${start}; deployment-to-${start} must be rescanned`);
      }
      // The committed summary covers deployment through `throughBlock`; every run
      // replays the entire suffix, so grants and revokes never go unseen.
      const members = new Set<string>(proposerCheckpoint.proposers.map((account) => account.toLowerCase()));
      for (let fromBlock = start + 1n; fromBlock <= chain.blockNumber; fromBlock += 10_000n) {
        const toBlock = fromBlock + 9_999n < chain.blockNumber ? fromBlock + 9_999n : chain.blockNumber;
        const logs = await chain.client.getLogs({ address: timelock, events, fromBlock, toBlock, strict: true });
        for (const log of logs.sort((a, b) => Number(a.blockNumber - b.blockNumber))) {
          if ((log.args.role ?? "") !== proposerRole || !log.args.account) continue;
          if (log.eventName === "RoleGranted") members.add(log.args.account.toLowerCase());
          else members.delete(log.args.account.toLowerCase());
        }
      }
      const [safeHolds, delay] = await Promise.all([
        memoizeRead(context, `eth:${timelock}:hasRole:proposer:${devSafe}`, () =>
          chain.client.readContract({
            address: timelock, abi: aclAbi, functionName: "hasRole", args: [proposerRole, devSafe],
            blockNumber: chain.blockNumber,
          })),
        memoizeRead(context, `eth:${timelock}:minDelay`, () =>
          chain.client.readContract({
            address: timelock, abi: parseAbi(["function getMinDelay() view returns (uint256)"]),
            functionName: "getMinDelay", blockNumber: chain.blockNumber,
          })),
      ]);
      const observed = {
        safeHoldsProposer: safeHolds,
        minDelaySec: Number(delay),
        replayedProposers: [...members],
        cachedThroughBlock: proposerCheckpoint.throughBlock,
      };
      const recorded = { safeHoldsProposer: true, minDelaySec: 86400, replayedProposers: [devSafe], cachedThroughBlock: proposerCheckpoint.throughBlock };
      return verdict(
        observed.safeHoldsProposer
        && observed.minDelaySec >= 86400
        && observed.replayedProposers.length === 1
        && observed.replayedProposers[0] === devSafe,
        observed,
        recorded,
        "A second proposer or a shorter delay changes the notice economics this scenario records; deployment-to-checkpoint membership is committed, and every run replays the full suffix.",
      );
    },
  },
  {
    id: "vault-reserve-roles",
    label: "Direct Safe grants for vault reserve controls",
    async run(context) {
      const [setReserve, rescueErc20, pauseProtocol] = await Promise.all([
        aclRole(context, "0x78250b63", cusd, devSafe),
        aclRole(context, "0x5d799f87", cusd, devSafe),
        aclRole(context, "0xdbf62489", cusd, devSafe),
      ]);
      const observed = { safeHoldsSetReserve: setReserve, safeHoldsRescueErc20: rescueErc20, safeHoldsPauseProtocol: pauseProtocol };
      const recorded = { safeHoldsSetReserve: true, safeHoldsRescueErc20: true, safeHoldsPauseProtocol: true };
      return verdict(
        setReserve && rescueErc20 && pauseProtocol,
        observed,
        recorded,
        "Losing the direct reserve-control grants moves those actions behind another authority and re-reviews the zero-delay premise.",
      );
    },
  },
  {
    id: "add-eigen-agent",
    label: "Direct Safe grant for agent onboarding on the EigenAgentManager",
    async run(context) {
      const holds = await aclRole(context, "0x512e110e", eigenAgentManager, devSafe);
      const observed = { safeHoldsAddEigenAgent: holds };
      const recorded = { safeHoldsAddEigenAgent: true };
      return verdict(
        holds,
        observed,
        recorded,
        "Without the direct onboarding grant, the fictitious-coverage branch needs a different entry and this record must be re-reviewed.",
      );
    },
  },
  {
    kind: "observation",
    id: "eoa-yearn-roles",
    label: "Single-key Yearn role bits on the USDC fractional-reserve vault",
    async run(context) {
      const chain = requireScenarioChain(context, 1);
      const mask = await memoizeRead(context, `eth:${yearnFrUsdc}:roles:${yearnEmergencyEoa}`, () =>
        chain.client.readContract({
          address: yearnFrUsdc, abi: yearnAbi, functionName: "roles", args: [yearnEmergencyEoa],
          blockNumber: chain.blockNumber,
        }));
      return {
        verdict: "holds",
        observed: { roleMask: mask.toString() },
        recorded: { roleMask: "6512" },
        reason: "The timelock-executor EOA holds debt-management role bits on the fractional vault; a single key can recall strategy allocations even though it cannot add strategies or install a withdrawal limit.",
      };
    },
  },
  scenarioDocumentWatch(
    "docs-timelock-scope",
    "Cap access-controls and addresses documentation",
    [
      { sourceId: "docs-access-controls", publisher: "Cap Labs" },
      { sourceId: "docs-addresses", publisher: "Cap Labs" },
    ],
    "Confirm the documentation still presents the one-day timelock as the control surface while the fractional-reserve vault roles, Delegation network registration and agent-manager configuration remain outside it.",
  ),
];

export default checks;
