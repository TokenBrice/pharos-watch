import { keccak256, parseAbi, zeroAddress } from "viem";
import type { Address } from "viem";
import type { ScenarioCheck, ScenarioCheckContext, ScenarioCheckValue } from "./index";
import { requireScenarioChain, scenarioDocumentWatch, scenarioSourceAddress } from "./index";

const abi = parseAbi([
  "function owner() view returns (address)",
  "function required() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function deprecated() view returns (bool)",
  "function upgradedAddress() view returns (address)",
  "function basisPointsRate() view returns (uint256)",
  "function maximumFee() view returns (uint256)",
  "function decimals() view returns (uint256)",
]);

function baselineBlock(context: ScenarioCheckContext): bigint {
  const source = context.record.sources.find((entry) => entry.id === "token");
  if (source?.block === undefined) throw new Error("USDT token evidence block is missing");
  return BigInt(source.block);
}

function compare(observed: ScenarioCheckValue, recorded: ScenarioCheckValue, reason?: string) {
  return { verdict: JSON.stringify(observed) === JSON.stringify(recorded) ? "holds" as const : "changed" as const, observed, recorded, reason };
}

async function codeHash(context: ScenarioCheckContext, address: Address, blockNumber: bigint): Promise<string> {
  const { client } = requireScenarioChain(context);
  const code = await client.getBytecode({ address, blockNumber });
  if (!code || code === "0x") throw new Error(`No contract code at ${address}, block ${blockNumber}`);
  return keccak256(code);
}

async function redirectPath(context: ScenarioCheckContext, blockNumber: bigint) {
  const { client } = requireScenarioChain(context);
  const token = scenarioSourceAddress(context.record, "token");
  const owner = await client.readContract({ address: token, abi, functionName: "owner", blockNumber });
  return {
    owner: owner.toLowerCase(),
    tokenCodeHash: await codeHash(context, token, blockNumber),
    ownerCodeHash: await codeHash(context, owner, blockNumber),
  };
}

const checks: readonly ScenarioCheck[] = [
  {
    id: "owner-threshold",
    label: "Ethereum owner, multisig threshold and signer set",
    async run(context) {
      const { client, blockNumber } = requireScenarioChain(context);
      const token = scenarioSourceAddress(context.record, "token");
      const owner = await client.readContract({ address: token, abi, functionName: "owner", blockNumber });
      const recordedOwner = scenarioSourceAddress(context.record, "owner-wallet");
      const thresholdFigure = context.record.keyFigures.find((entry) => entry.sourceIds.includes("owner-wallet") && /^\d+ of \d+$/.test(entry.value));
      const threshold = thresholdFigure?.value.match(/^(\d+) of (\d+)$/);
      if (!threshold) return { verdict: "unavailable", reason: "Recorded Ethereum issuer signing threshold is missing" };
      const recordedSigners = await client.readContract({ address: recordedOwner, abi, functionName: "getOwners", blockNumber: baselineBlock(context) });
      const recorded = { owner: recordedOwner.toLowerCase(), codePresent: true, required: threshold[1], signerCount: Number(threshold[2]), signers: recordedSigners.map((address) => address.toLowerCase()).sort() };
      const code = await client.getBytecode({ address: owner, blockNumber });
      const codePresent = !!code && code !== "0x";
      if (owner.toLowerCase() !== recordedOwner.toLowerCase() || !codePresent) {
        return { verdict: "changed", observed: { owner: owner.toLowerCase(), codePresent }, recorded, reason: "The recorded issuer multisig no longer owns the token, or its code is absent" };
      }
      const required = await client.readContract({ address: owner, abi, functionName: "required", blockNumber });
      const signers = await client.readContract({ address: owner, abi, functionName: "getOwners", blockNumber });
      return compare({ owner: owner.toLowerCase(), codePresent, required: required.toString(), signerCount: signers.length, signers: signers.map((address) => address.toLowerCase()).sort() }, recorded);
    },
  },
  {
    id: "redirect-delay",
    label: "Redirect delay or independent veto",
    async run(context) {
      const { blockNumber } = requireScenarioChain(context);
      // The verified, non-proxy token and legacy wallet execute deprecate on the
      // threshold confirmation. Any owner/code change invalidates that proof.
      return compare(await redirectPath(context, blockNumber), await redirectPath(context, baselineBlock(context)), "Compare the entire immediate redirect path with the source-reviewed evidence pin; code drift needs manual delay/veto review");
    },
  },
  {
    id: "replacement-compatibility",
    label: "Undeprecated token, zero replacement and unchanged settlement logic",
    async run(context) {
      const { client, blockNumber } = requireScenarioChain(context);
      const token = scenarioSourceAddress(context.record, "token");
      const deprecated = await client.readContract({ address: token, abi, functionName: "deprecated", blockNumber });
      const upgradedAddress = await client.readContract({ address: token, abi, functionName: "upgradedAddress", blockNumber });
      const recordedHash = await codeHash(context, token, baselineBlock(context));
      return compare({ deprecated, upgradedAddress: upgradedAddress.toLowerCase(), tokenCodeHash: await codeHash(context, token, blockNumber) }, { deprecated: false, upgradedAddress: zeroAddress, tokenCodeHash: recordedHash }, "The recorded legacy source has no replacement compatibility validation or independent settlement path");
    },
  },
  {
    id: "transfer-fees",
    kind: "figure",
    recordField: { collection: "exposure", label: "Other issuer powers" },
    label: "Transfer fees and deployed-source caps",
    async run(context) {
      const { client, blockNumber } = requireScenarioChain(context);
      const token = scenarioSourceAddress(context.record, "token");
      const detail = context.record.exposure.find((entry) => entry.label === "Other issuer powers")?.detail;
      const caps = detail?.match(/(\d+) basis points and (\d+) USDT/);
      if (!caps) return { verdict: "unavailable", reason: "Recorded transfer-fee caps are missing" };
      async function fees(at: bigint) {
        const rate = await client.readContract({ address: token, abi, functionName: "basisPointsRate", blockNumber: at });
        const maximumFee = await client.readContract({ address: token, abi, functionName: "maximumFee", blockNumber: at });
        const decimals = await client.readContract({ address: token, abi, functionName: "decimals", blockNumber: at });
        const maxRate = BigInt(caps![1]);
        const maxFee = BigInt(caps![2]) * 10n ** decimals;
        return { basisPointsRate: rate.toString(), maximumFee: maximumFee.toString(), decimals: decimals.toString(), maximumRateCap: maxRate.toString(), maximumFeeCap: maxFee.toString(), withinCaps: rate <= maxRate && maximumFee <= maxFee, tokenCodeHash: await codeHash(context, token, at) };
      }
      return compare(await fees(blockNumber), await fees(baselineBlock(context)), "setParams enforces newBasisPoints < 20 and newMaxFee < 50; even within-cap fee changes require review");
    },
  },
  scenarioDocumentWatch("independent-recovery", "Independent guaranteed recovery",
    [{ sourceId: "terms", publisher: "Tether" }],
    "No tested independent recovery guarantee is recorded; RPC reads cannot establish guaranteed timely issuer recovery."),
  scenarioDocumentWatch("universal-redemption", "Universal cash redemption eligibility",
    [{ sourceId: "terms", publisher: "Tether" }, { sourceId: "fees", publisher: "Tether" }],
    "Manual document review required. Chain state does not establish verified-customer eligibility or the direct-redemption minimum."),
];

export default checks;
