import { keccak256, parseAbi, toHex } from "viem";
import type { Address, Hex } from "viem";
import type { ScenarioCheck, ScenarioCheckContext, ScenarioCheckValue } from "./index";
import { requireScenarioChain, scenarioDocumentWatch, scenarioSourceAddress } from "./index";

const implementationSlot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const adminSlot = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const guardSlot = "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8";
const singletonSlot = toHex(0n, { size: 32 });
const sentinel = "0x0000000000000000000000000000000000000001";
const abi = parseAbi([
  "function owner() view returns (address)",
  "function getToken() view returns (address)",
  "function getChecker() view returns (address)",
  "function defaultAdmin() view returns (address)",
  "function getRoleMembers(bytes32) view returns (address[])",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function getModulesPaginated(address,uint256) view returns (address[],address)",
]);

function baselineBlock(context: ScenarioCheckContext, chainId: number): bigint {
  const sourceId = chainId === 1 ? "roles-eth" : "roles-bsc";
  const source = context.record.sources.find((entry) => entry.id === sourceId);
  if (source?.block === undefined) throw new Error(`USD1 ${sourceId} evidence block is missing`);
  return BigInt(source.block);
}

function tokenAddress(context: ScenarioCheckContext): Address {
  const stages = context.record.branchPoint?.branches.flatMap((branch) => branch.stages) ?? [];
  const token = stages.flatMap((stage) => stage.targets ?? []).find((target) => target.label === "USD1 token proxy");
  if (!token) throw new Error("Recorded USD1 token proxy target is missing");
  return token.address;
}

function compare(observed: ScenarioCheckValue, recorded: ScenarioCheckValue, reason?: string) {
  return { verdict: JSON.stringify(observed) === JSON.stringify(recorded) ? "holds" as const : "changed" as const, observed, recorded, reason };
}

async function storedAddress(context: ScenarioCheckContext, chainId: number, address: Address, slot: Hex, blockNumber: bigint): Promise<Address> {
  const { client } = requireScenarioChain(context, chainId);
  const value = await client.getStorageAt({ address, slot, blockNumber });
  if (!value || value.length !== 66) throw new Error(`Unavailable address storage at ${address}, slot ${slot}`);
  return `0x${value.slice(-40)}`;
}

async function codeHash(context: ScenarioCheckContext, chainId: number, address: Address, blockNumber: bigint): Promise<string> {
  const { client } = requireScenarioChain(context, chainId);
  const code = await client.getBytecode({ address, blockNumber });
  if (!code || code === "0x") throw new Error(`No contract code at ${address}, chain ${chainId}, block ${blockNumber}`);
  return keccak256(code);
}

async function roleMembers(context: ScenarioCheckContext, chainId: number, governor: Address, role: string, blockNumber: bigint) {
  const { client } = requireScenarioChain(context, chainId);
  const members = await client.readContract({ address: governor, abi, functionName: "getRoleMembers", args: [keccak256(toHex(role))], blockNumber });
  return members.map((member) => member.toLowerCase() as Address).sort();
}

async function minters(context: ScenarioCheckContext, chainId: number, blockNumber: bigint) {
  const { client } = requireScenarioChain(context, chainId);
  const governor = await client.readContract({ address: tokenAddress(context), abi, functionName: "owner", blockNumber });
  const members = await roleMembers(context, chainId, governor, "MINTER_ROLE", blockNumber);
  const codeSizes: { address: string; codeBytes: number }[] = [];
  for (const address of members) {
    const code = await client.getBytecode({ address, blockNumber });
    // viem represents an eth_getCode result of 0x as undefined. RPC errors throw.
    codeSizes.push({ address, codeBytes: code ? (code.length - 2) / 2 : 0 });
  }
  return { governor: governor.toLowerCase(), hasPlainEoa: codeSizes.some((entry) => entry.codeBytes === 0), minters: codeSizes };
}

async function mintPath(context: ScenarioCheckContext, chainId: number, blockNumber: bigint) {
  const { client } = requireScenarioChain(context, chainId);
  const token = tokenAddress(context);
  const governor = await client.readContract({ address: token, abi, functionName: "owner", blockNumber });
  const implementation = await storedAddress(context, chainId, token, implementationSlot, blockNumber);
  const checker = await client.readContract({ address: governor, abi, functionName: "getChecker", blockNumber });
  const governedToken = await client.readContract({ address: governor, abi, functionName: "getToken", blockNumber });
  return {
    governor: governor.toLowerCase(),
    governedToken: governedToken.toLowerCase(),
    implementation: implementation.toLowerCase(),
    checker: checker.toLowerCase(),
    proxyCodeHash: await codeHash(context, chainId, token, blockNumber),
    governorCodeHash: await codeHash(context, chainId, governor, blockNumber),
    implementationCodeHash: await codeHash(context, chainId, implementation, blockNumber),
  };
}

async function safeState(context: ScenarioCheckContext, chainId: number, safe: Address, blockNumber: bigint) {
  const { client } = requireScenarioChain(context, chainId);
  const threshold = await client.readContract({ address: safe, abi, functionName: "getThreshold", blockNumber });
  const owners = await client.readContract({ address: safe, abi, functionName: "getOwners", blockNumber });
  const guard = await client.getStorageAt({ address: safe, slot: guardSlot, blockNumber });
  if (!guard || guard.length !== 66) throw new Error(`Safe guard storage unavailable at ${safe}`);
  const modules: string[] = [];
  let cursor: Address = sentinel;
  const seen = new Set<string>();
  do {
    if (seen.has(cursor.toLowerCase())) throw new Error(`Safe module pagination cycles at ${safe}`);
    seen.add(cursor.toLowerCase());
    const [page, next] = await client.readContract({ address: safe, abi, functionName: "getModulesPaginated", args: [cursor, 100n], blockNumber });
    modules.push(...page.map((module) => module.toLowerCase()));
    cursor = next;
  } while (cursor.toLowerCase() !== sentinel);
  const singleton = await storedAddress(context, chainId, safe, singletonSlot, blockNumber);
  const ownerCodeSizes: { address: string; codeBytes: number }[] = [];
  for (const address of [...owners].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))) {
    const code = await client.getBytecode({ address, blockNumber });
    ownerCodeSizes.push({ address: address.toLowerCase(), codeBytes: code ? (code.length - 2) / 2 : 0 });
  }
  return {
    threshold: threshold.toString(),
    ownerCount: owners.length,
    owners: ownerCodeSizes,
    modules: modules.sort(),
    guard: guard.toLowerCase(),
    safeCodeHash: await codeHash(context, chainId, safe, blockNumber),
    singleton: singleton.toLowerCase(),
    singletonCodeHash: await codeHash(context, chainId, singleton, blockNumber),
  };
}

async function upgradeOwner(context: ScenarioCheckContext, chainId: number, blockNumber: bigint) {
  const { client } = requireScenarioChain(context, chainId);
  const admin = await storedAddress(context, chainId, tokenAddress(context), adminSlot, blockNumber);
  const safe = await client.readContract({ address: admin, abi, functionName: "owner", blockNumber });
  return { admin, safe };
}

async function operationalControls(context: ScenarioCheckContext, chainId: number, blockNumber: bigint) {
  const { client } = requireScenarioChain(context, chainId);
  const path = await mintPath(context, chainId, blockNumber);
  const governor = path.governor as Address;
  const adminSafe = await client.readContract({ address: governor, abi, functionName: "defaultAdmin", blockNumber });
  const roles: Record<string, ScenarioCheckValue> = {};
  let adminSafeState: ScenarioCheckValue | undefined;
  for (const role of ["MINTER_ROLE", "FREEZER_ROLE", "PAUSER_ROLE"]) {
    const members = await roleMembers(context, chainId, governor, role, blockNumber);
    const holders: ScenarioCheckValue[] = [];
    for (const address of members) {
      const code = await client.getBytecode({ address, blockNumber });
      if (!code || code === "0x") {
        holders.push({ address, codeBytes: 0 });
      } else if (address === adminSafe.toLowerCase()) {
        adminSafeState ??= await safeState(context, chainId, address, blockNumber);
        holders.push({ address, safe: adminSafeState });
      } else {
        // WalletSimple is an immutable EIP-1167 clone. Compare its delegated
        // implementation as well, rather than treating clone code as its logic.
        const cloneTarget = code.match(/^0x363d3d373d3d3d363d73([0-9a-fA-F]{40})5af43d82803e903d91602b57fd5bf3$/)?.[1];
        holders.push({ address, codeHash: keccak256(code), ...(cloneTarget ? { implementation: `0x${cloneTarget.toLowerCase()}`, implementationCodeHash: await codeHash(context, chainId, `0x${cloneTarget}`, blockNumber) } : {}) });
      }
    }
    roles[role] = holders;
  }
  // AccessControlDefaultAdminRules' three-day defaultAdminDelay delays admin
  // handover, not mint/freeze/pause. The reviewed operational functions call the
  // token immediately; their code, checker and caller protections are the proof.
  return { path, roles };
}

const checks: readonly ScenarioCheck[] = [1, 56].flatMap((chainId): ScenarioCheck[] => {
  const chainLabel = chainId === 1 ? "Ethereum" : "BNB Chain";
  return [
    {
      id: "single-key-minter",
      label: `${chainLabel} MINTER_ROLE plain EOAs`,
      async run(context) {
        const { blockNumber } = requireScenarioChain(context, chainId);
        return compare(await minters(context, chainId, blockNumber), await minters(context, chainId, baselineBlock(context, chainId)));
      },
    },
    {
      id: "supply-cap",
      label: `${chainLabel} supply-cap logic and mint checker`,
      async run(context) {
        const { blockNumber } = requireScenarioChain(context, chainId);
        return compare(await mintPath(context, chainId, blockNumber), await mintPath(context, chainId, baselineBlock(context, chainId)), "The source-reviewed governor and implementation have no supply cap; implementation, ownership, bytecode or checker drift requires review, not an inferred new cap");
      },
    },
    {
      id: "proxyadmin-safe-guard",
      label: `${chainLabel} ProxyAdmin owner Safe threshold, modules, guard and upgrade path`,
      async run(context) {
        const { blockNumber } = requireScenarioChain(context, chainId);
        const baseline = baselineBlock(context, chainId);
        const recordedPath = await upgradeOwner(context, chainId, baseline);
        const observedPath = await upgradeOwner(context, chainId, blockNumber);
        const expectedSafe = scenarioSourceAddress(context.record, "safe-proxyadmin");
        const figure = context.record.keyFigures.find((entry) => entry.label === "Keys replace token logic")?.value.match(/^(\d+) of (\d+)$/);
        if (!figure) return { verdict: "unavailable", reason: "Recorded ProxyAdmin Safe signing threshold is missing" };
        const recorded = { admin: recordedPath.admin.toLowerCase(), safe: expectedSafe.toLowerCase(), adminCodeHash: await codeHash(context, chainId, recordedPath.admin, baseline), state: { ...await safeState(context, chainId, recordedPath.safe, baseline), threshold: figure[1], ownerCount: Number(figure[2]) } };
        if (observedPath.admin.toLowerCase() !== recorded.admin || observedPath.safe.toLowerCase() !== recorded.safe) {
          return { verdict: "changed", observed: { admin: observedPath.admin.toLowerCase(), safe: observedPath.safe.toLowerCase() }, recorded, reason: "ProxyAdmin or its owner changed; the recorded immediate Safe upgrade path no longer matches" };
        }
        return compare({ admin: observedPath.admin.toLowerCase(), safe: observedPath.safe.toLowerCase(), adminCodeHash: await codeHash(context, chainId, observedPath.admin, blockNumber), state: await safeState(context, chainId, observedPath.safe, blockNumber) }, recorded);
      },
    },
    {
      id: "control-delay",
      label: `${chainLabel} mint, freeze and pause execution protections`,
      async run(context) {
        const { blockNumber } = requireScenarioChain(context, chainId);
        return compare(await operationalControls(context, chainId, blockNumber), await operationalControls(context, chainId, baselineBlock(context, chainId)), "Unchanged immediate governor/token logic and role-holder protections imply no newly introduced operational delay; changed code or caller protections require human review");
      },
    },
  ];
});

export default [
  ...checks,
  scenarioDocumentWatch("universal-redemption", "Universal issuer cash redemption eligibility",
    [{ sourceId: "bitgo-terms", publisher: "BitGo" }, { sourceId: "bitgo-services-terms", publisher: "BitGo" }],
    "Manual document review required. RPC reads cannot establish Accountholder eligibility, issuer transaction limits or redemption suspension rights."),
] satisfies readonly ScenarioCheck[];
