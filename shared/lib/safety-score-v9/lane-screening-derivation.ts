import { z } from "zod";
import inventory from "../../data/safety-score-v9/lane-screening-emitter-inventory-v1.json";
import {
  V9LaneEmitterDescriptorSchema,
  type V9LaneAdminEventFamily,
  type V9LaneEmitterDescriptor,
} from "../../types/safety-score-v9-incidents";
import { sha256Hex } from "../sha256";
import { stableJsonStringifyV1 } from "../stable-json";
import { compareText } from "./primitives";

/**
 * Runtime-neutral derivation of the bridge-lane screening identity.
 *
 * The offline scoring candidate consumes the reviewed descriptor catalog and the
 * evaluation certificate join; neither may pull the Worker RPC client graph in
 * through the producer module. The frozen topic list and policy digest, the
 * screening-set id and the descriptor normalization live here, so the producer
 * (`bridge-lane-admin-events.ts`) and the catalog adapter import the same pure
 * derivation the screener certifies against.
 */

/**
 * Emitted-event family mapped to its exact frozen ABI signature. Frozen
 * 2026-10-29 against LayerZero-v2 `main` (`IMessageLibManager.sol`,
 * `UlnBase.sol`, `SendLibBase.sol`, `OAppCore.sol`, `IOAppOptionsType3.sol`,
 * `OFTCore.sol`, `IOAppPreCrimeSimulator.sol`, `RateLimiter.sol`) and
 * chainlink-ccip `main` (`pools/TokenPool.sol`). Extended 2026-10-30 with the
 * verified ABIs of the five-lane CCIP screening pilot (FrontierERC20F,
 * BurnMintTokenPool, YieldFi YToken/BridgeCCIP/LockBox); the earlier rows are
 * unchanged, and the whole table is re-digested below.
 */
export const LANE_ADMIN_EVENT_TOPICS = [
  { family: "OwnershipTransferred", signature: "OwnershipTransferred(address,address)", topic0: "0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0" },
  { family: "RoleGranted", signature: "RoleGranted(bytes32,address,address)", topic0: "0x2f8788117e7eff1d82e926ec794901d17c78024a50270940304540a733656f0d" },
  { family: "RoleRevoked", signature: "RoleRevoked(bytes32,address,address)", topic0: "0xf6391f5c32d9c69d2a47ea670b442974b53935d1edc7fd64eb21e047a839171b" },
  { family: "Paused", signature: "Paused(address)", topic0: "0x62e78cea01bee320cd4e420270b5ea74000d11b0c9f74754ebdbfc544b05a258" },
  { family: "Unpaused", signature: "Unpaused(address)", topic0: "0x5db9ee0a495bf2e6ff9c91a7834c1ba4fdd244a5e8aa4e537bd38aeae4b073aa" },
  { family: "Upgraded", signature: "Upgraded(address)", topic0: "0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b" },
  { family: "AdminChanged", signature: "AdminChanged(address,address)", topic0: "0x7e644d79422f17c01e4894b5f4f588d331ebfa28653d42ae832dc59e38c9798f" },
  { family: "BeaconUpgraded", signature: "BeaconUpgraded(address)", topic0: "0x1cf3b03a6cf19fa2baba4df148e9dcabedea7f8a5c07840e207e5c089be95d3e" },
  // LayerZero OApp admin setters.
  { family: "PeerSet", signature: "PeerSet(uint32,bytes32)", topic0: "0x238399d427b947898edb290f5ff0f9109849b1c3ba196a42e35f00c50a54b98b" },
  { family: "DelegateSet", signature: "DelegateSet(address,address)", topic0: "0x6ee10e9ed4d6ce9742703a498707862f4b00f1396a87195eb93267b3d7983981" },
  // Chainlink CCIP router configuration, rate limits and enforcement.
  { family: "DynamicConfigSet", signature: "DynamicConfigSet(address,address,address)", topic0: "0x3f1036e85d016a93254a0b1415844f79b85424959d90ae5ad51ce8f4533fe701" },
  { family: "RateLimitConfigured", signature: "RateLimitConfigured(uint64,bool,(bool,uint128,uint128),(bool,uint128,uint128))", topic0: "0x41f7c8f7cfdad9350aa495e6c54cbbf750a07ab38a9098aed1256e30dd1682bb" },
  { family: "RateLimitsChanged", signature: "RateLimitsChanged((uint32,uint256,uint256)[])", topic0: "0xe888347665897e637801f36c5129f510657276178c89022bc5fa0246dbc19de1" },
  // LayerZero enforced options, message inspector and pre-crime hook.
  { family: "EnforcedOptionSet", signature: "EnforcedOptionSet((uint32,uint16,bytes)[])", topic0: "0xbe4864a8e820971c0247f5992e2da559595f7bf076a21cb5928d443d2a13b674" },
  { family: "MsgInspectorSet", signature: "MsgInspectorSet(address)", topic0: "0xf0be4f1e87349231d80c36b33f9e8639658eeaf474014dee15a3e6a4d4414197" },
  { family: "PreCrimeSet", signature: "PreCrimeSet(address)", topic0: "0xd48d879cef83a1c0bdda516f27b13ddb1b3f8bbac1c9e1511bb2a659c2427760" },
  // LayerZero send/receive ULN DVN and executor configuration.
  { family: "UlnConfigSet", signature: "UlnConfigSet(address,uint32,(uint64,uint8,uint8,uint8,address[],address[]))", topic0: "0x82118522aa536ac0e96cc5c689407ae42b89d592aa133890a01f1509842f5081" },
  { family: "ExecutorConfigSet", signature: "ExecutorConfigSet(address,uint32,(uint32,address))", topic0: "0x779cb2dd9d2bb1be1737d05435d744facbfb84a2a4912e21379d39beddcdc805" },
  // LayerZero endpoint message-library changes.
  { family: "DefaultSendLibrarySet", signature: "DefaultSendLibrarySet(uint32,address)", topic0: "0x16aa0f528038ab41019e95bae5b418a50ba8532c5800e3b7ea2f517d3fa625f5" },
  { family: "DefaultReceiveLibrarySet", signature: "DefaultReceiveLibrarySet(uint32,address)", topic0: "0xc16891855cffb4a5ac51ac11864a3f3c96ba816cc45fe686c987ae36277de5ec" },
  { family: "SendLibrarySet", signature: "SendLibrarySet(address,uint32,address)", topic0: "0x4cff966ebee29a156dcb34cf72c1d06231fb1777f6bdf6e8089819232f002b1c" },
  { family: "ReceiveLibrarySet", signature: "ReceiveLibrarySet(address,uint32,address)", topic0: "0xcd6f92f5ac6185a5acfa02c92090746cec64d777269cbcd0ed031e396657a1c2" },
  // Chainlink BurnMintTokenPool chain/peer configuration and admin surface.
  { family: "AllowListAdd", signature: "AllowListAdd(address)", topic0: "0x2640d4d76caf8bf478aabfa982fa4e1c4eb71a37f93cd15e80dbc657911546d8" },
  { family: "AllowListRemove", signature: "AllowListRemove(address)", topic0: "0x800671136ab6cfee9fbe5ed1fb7ca417811aca3cf864800d127b927adedf7566" },
  { family: "ChainAdded", signature: "ChainAdded(uint64,bytes,(bool,uint128,uint128),(bool,uint128,uint128))", topic0: "0x8d340f17e19058004c20453540862a9c62778504476f6756755cb33bcd6c38c2" },
  { family: "ChainConfigured", signature: "ChainConfigured(uint64,(bool,uint128,uint128),(bool,uint128,uint128))", topic0: "0x0350d63aa5f270e01729d00d627eeb8f3429772b1818c016c66a588a864f912b" },
  { family: "ChainRemoved", signature: "ChainRemoved(uint64)", topic0: "0x5204aec90a3c794d8e90fded8b46ae9c7c552803e7e832e0c1d358396d859916" },
  { family: "ConfigChanged", signature: "ConfigChanged((bool,uint128,uint128))", topic0: "0x9ea3374b67bf275e6bb9c8ae68f9cae023e1c528b4b27e092f0bb209d3531c19" },
  { family: "OwnershipTransferRequested", signature: "OwnershipTransferRequested(address,address)", topic0: "0xed8889f560326eb138920d842192f0eb3dd22b4f139c87a2c57538e05bae1278" },
  { family: "RateLimitAdminSet", signature: "RateLimitAdminSet(address)", topic0: "0x44676b5284b809a22248eba0da87391d79098be38bb03154be88a58bf4d09174" },
  { family: "RemotePoolAdded", signature: "RemotePoolAdded(uint64,bytes)", topic0: "0x7d628c9a1796743d365ab521a8b2a4686e419b3269919dc9145ea2ce853b54ea" },
  { family: "RemotePoolRemoved", signature: "RemotePoolRemoved(uint64,bytes)", topic0: "0x52d00ee4d9bd51b40168f2afc5848837288ce258784ad914278791464b3f4d76" },
  { family: "RouterUpdated", signature: "RouterUpdated(address,address)", topic0: "0x02dc5c233404867c793b749c6d644beb2277536d18a7e7974d3f238e4c6f1684" },
  // FrontierERC20F access, rescue, freeze and role administration.
  { family: "AccessRegistryUpdated", signature: "AccessRegistryUpdated(address,address,address)", topic0: "0xf30d5b081b4a3016a4b34d3732b94b2b2ccc2d99f6774c8ac47c42d8764fd265" },
  { family: "ContractUriUpdated", signature: "ContractUriUpdated(address,string,string)", topic0: "0xe41f7f53dffb3e1410dab0f9f6a27c670b48ad40ccc47a64537100e1f3809e8a" },
  { family: "GasTokenSalvaged", signature: "GasTokenSalvaged(address,uint256)", topic0: "0x6fe86159012c6b167b88e7b30e7c8ebe172ed05c753231df050bf60e4faf724a" },
  { family: "MintedToFrozen", signature: "MintedToFrozen(address,address,uint256)", topic0: "0x4f937dbafb3fd179c060630d11d9ff712aee9d7de095bdbd9b6766edf18cc6f7" },
  { family: "RoleAdminChanged", signature: "RoleAdminChanged(bytes32,bytes32,bytes32)", topic0: "0xbd79b86ffe0ab8e8776151514217cd7cacd52c909f66475c3af44e129f0b00ff" },
  { family: "TokenSalvaged", signature: "TokenSalvaged(address,address,uint256)", topic0: "0xca9a684d22747bbed3bef704e16858bfa9ac8f5af2d80c70455b298bd7d8d239" },
  { family: "TokensRecovered", signature: "TokensRecovered(address,address,uint256)", topic0: "0x401f439d865a766757ec78675925bd67198d5e78805aa41691b34b5d6a6cbbe6" },
  { family: "TransferredToFrozen", signature: "TransferredToFrozen(address,address,uint256)", topic0: "0xded38740cfc0cbf455a75eaa57f3e05f2f10cb13c63040a2fdc7a116c3e41f9f" },
  // YieldFi YToken administrator, fee, yield and lockbox configuration.
  { family: "AdministratorSet", signature: "AdministratorSet(address,address)", topic0: "0xbc5dab480bc3beb0582944eefba927e4358ed22805ac40b2078d517b8a036ae7" },
  { family: "FeeSet", signature: "FeeSet(address,uint256)", topic0: "0x92e6908704698649c7a3742faeecb2d2cdef5264a5bf9bebbaa5e4b06d367316" },
  { family: "GasFeeSet", signature: "GasFeeSet(address,uint256)", topic0: "0x3366e666c4af187afefcf0acb63f639bc15ca594d553d1bac713edde4342ffe9" },
  { family: "ManagerSet", signature: "ManagerSet(address,address)", topic0: "0xc64707e618a83637fc41ad1e3aa4242bd5fdd353f3d60bc0faf40db0d7d86078" },
  { family: "Rescue", signature: "Rescue(address,address,address,uint256)", topic0: "0xab830ba4cd16fc1dff3f33e70dc839fa56f0303a8a3a61dcb6bba0f789055fbb" },
  { family: "VestingPeriodSet", signature: "VestingPeriodSet(address,uint256)", topic0: "0xdbf2705a882ab3673447ec2203b97aeb0f720b8fd364172c54e04e60893aecd7" },
  { family: "YieldSet", signature: "YieldSet(address,address)", topic0: "0x2fe4e5ef899cc1bf6c10bd764667743de04f9dfe0ad51bbc956f4539b4f8a654" },
  { family: "SetAdministrator", signature: "SetAdministrator(address,address)", topic0: "0x525117b0c654ea4d9950e296eca92b77aa3c6fdeba6217801c6f32a0ed7a0922" },
  { family: "SetLockbox", signature: "SetLockbox(address,address,address)", topic0: "0xc2677273938f50fd26297a86f7c15963e77c4ec9141bbf83f2a7f33cfc2ca163" },
  { family: "SetToken", signature: "SetToken(address,uint64,address)", topic0: "0xffc69ac19640cba1401d95c27b77e155ce08c0a70946fb435fbd7e0bc7b0c65c" },
] as const satisfies readonly {
  family: V9LaneAdminEventFamily;
  signature: string;
  topic0: `0x${string}`;
}[];

/**
 * Frozen-list identity. Certificates carry this digest so a certificate produced
 * under a different topic list can never be admitted by a reader that uses the
 * current one. Changing the table or the freeze date deliberately changes it.
 */
export const LANE_ADMIN_EVENT_SCREENING_POLICY_DIGEST = sha256Hex(stableJsonStringifyV1({
  domain: "safety-score-v9.lane-admin-event-screening-policy.v1",
  frozenAt: "2026-10-30",
  topics: LANE_ADMIN_EVENT_TOPICS.map((topic) => ({ ...topic })),
}));

export const TOPIC_BY0 = new Map<string, { family: V9LaneAdminEventFamily; signature: string; topic0: string }>(
  LANE_ADMIN_EVENT_TOPICS.map((topic) => [topic.topic0, { ...topic }]),
);
export const TOPICS_BY_FAMILY = new Map<string, { family: V9LaneAdminEventFamily; signature: string; topic0: string }>(
  LANE_ADMIN_EVENT_TOPICS.map((topic) => [topic.family, { ...topic }]),
);

/**
 * Declared fields that identify a lane's screening set. The subject lane (OP-IR
 * 5b) and the sorted contributor control ids are part of the identity: an added
 * contributor, emitter or pin starts a new chain and inherits nothing.
 */
export interface LaneIncidentCertificateScreeningSetInput {
  subjectDeploymentKey: string;
  screeningPolicyDigest: string;
  contributorControlIds: readonly string[];
  emitters: readonly { address: string; expectedRuntimeCodeSha256: string }[];
}

/**
 * Identity of one emitter set under one frozen screening policy. A new emitter
 * (or code pin) or a new topic list starts a fresh chain: certificates produced
 * under different screening policies never chain with each other (R3/R5).
 */
export function laneIncidentCertificateScreeningSetId(
  screeningSet: LaneIncidentCertificateScreeningSetInput,
): string {
  return sha256Hex(stableJsonStringifyV1({
    domain: "safety-score-v9.lane-incident-certificate.screening-set.v2",
    subjectDeploymentKey: screeningSet.subjectDeploymentKey,
    screeningPolicyDigest: screeningSet.screeningPolicyDigest,
    contributorControlIds: [...screeningSet.contributorControlIds].sort(compareText),
    emitters: screeningSet.emitters
      .map(({ address, expectedRuntimeCodeSha256 }) => ({ address, expectedRuntimeCodeSha256 }))
      .sort((left, right) => compareText(left.address, right.address)),
  }));
}

const sourceSchema = z.object({
  subjectDeploymentKey: z.string(),
  emitters: z.array(z.object({
    address: z.string(), expectedRuntimeCodeSha256: z.string().regex(/^[0-9a-f]{64}$/),
    families: z.array(z.string()).min(1),
  }).strict()).min(1),
  lookbackBlocks: z.number().int().min(50_000),
  provenance: z.object({
    assetIds: z.array(z.string()).min(1), controlIds: z.array(z.string()).min(1),
    rail: z.string(), reviewedAt: z.string(),
    contributors: z.array(z.object({ controlId: z.string(), emitterAddresses: z.array(z.string()).min(1) }).strict()).min(1),
    emitters: z.array(z.object({
      address: z.string(), role: z.enum(["route-deployment", "governed-contract"]),
      label: z.string(), chain: z.string(), observedBlock: z.number().int().nonnegative(), observedAt: z.string(),
      abiBasis: z.object({ kind: z.enum(["verified-source", "same-runtime-code", "same-verified-type"]),
        chain: z.string(), address: z.string(), runtimeIdentity: z.string(), verifiedSourceUrl: z.string().url(),
      }).strict(),
    }).strict()).min(1),
  }).strict(),
}).strict();

/** Pure admission of the producer's reviewed catalog; bad rows never grant closure. */
export function adaptLaneEmitterCatalog(rows: readonly unknown[], policyDigest = LANE_ADMIN_EVENT_SCREENING_POLICY_DIGEST): {
  descriptors: V9LaneEmitterDescriptor[]; reasons: string[];
} {
  const descriptors: V9LaneEmitterDescriptor[] = [];
  const reasons: string[] = [];
  for (const [index, raw] of rows.entries()) {
    const parsed = sourceSchema.safeParse(raw);
    if (!parsed.success) { reasons.push(`lane-descriptor-unmappable:${index}`); continue; }
    const row = parsed.data;
    const fail = (reason: string) => reasons.push(`${reason}:${row.subjectDeploymentKey}`);
    if (policyDigest !== LANE_ADMIN_EVENT_SCREENING_POLICY_DIGEST) { fail("lane-descriptor-policy-mismatch"); continue; }
    const controls = new Set(row.provenance.controlIds);
    const reviewed = inventory.lanes.find((lane) => lane.subjectDeploymentKey === row.subjectDeploymentKey);
    if (reviewed === undefined || row.emitters.some((emitter) =>
      reviewed.emitters.find((entry) => entry.address === emitter.address)?.runtimeIdentity !==
        `sha256-decoded-runtime-bytes:${emitter.expectedRuntimeCodeSha256}`)) {
      fail("lane-descriptor-pin-mismatch"); continue;
    }
    const addresses = new Set(row.emitters.map((emitter) => emitter.address));
    if (addresses.size !== row.emitters.length || reviewed.emitters.length !== addresses.size ||
        reviewed.emitters.some((entry) => {
          const emitter = row.emitters.find((candidate) => candidate.address === entry.address);
          return emitter === undefined || entry.adminEvents.some((family) => !emitter.families.includes(family));
        })) {
      fail("lane-descriptor-inventory-mismatch"); continue;
    }
    if (controls.size !== row.provenance.controlIds.length ||
        row.provenance.contributors.length !== controls.size ||
        new Set(row.provenance.contributors.map((entry) => entry.controlId)).size !== controls.size ||
        row.provenance.contributors.some((entry) => !controls.has(entry.controlId) || entry.emitterAddresses.some((address) => !addresses.has(address))) ||
        row.provenance.emitters.length !== addresses.size ||
        new Set(row.provenance.emitters.map((entry) => entry.address)).size !== addresses.size ||
        row.provenance.emitters.some((entry) => !addresses.has(entry.address) || entry.chain !== row.subjectDeploymentKey.split(":")[0])) {
      fail("lane-descriptor-provenance-mismatch"); continue;
    }
    const screeningSetId = laneIncidentCertificateScreeningSetId({
      subjectDeploymentKey: row.subjectDeploymentKey, screeningPolicyDigest: policyDigest,
      contributorControlIds: row.provenance.controlIds, emitters: row.emitters,
    });
    const mapped = row.provenance.assetIds.map((assetId) => V9LaneEmitterDescriptorSchema.safeParse({
      schemaVersion: 1, assetId, subjectDeploymentKey: row.subjectDeploymentKey,
      contributorControlIds: row.provenance.controlIds, screeningPolicyDigest: policyDigest, screeningSetId,
      emitters: row.emitters.map((emitter) => ({ address: emitter.address,
        reviewedRuntimePin: `sha256-decoded-runtime-bytes:${emitter.expectedRuntimeCodeSha256}`, families: emitter.families })),
    }));
    if (mapped.some((entry) => !entry.success)) { fail("lane-descriptor-unmappable"); continue; }
    for (const entry of mapped) if (entry.success) descriptors.push(entry.data);
  }
  return { descriptors, reasons };
}
