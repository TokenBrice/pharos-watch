import { z } from "zod";
import { createV9ValueInterner, deepFreeze } from "./safety-score-v9-immutable";
import { normalizeDeploymentId } from "./deployment-id";
import { CHAIN_META } from "./chain-identity";
import { V9ControlCapabilitySchema, V9ControlCapSemanticsSchema, V9ClaimImpairmentSchema, V9EconomicLossScopeSchema } from "./safety-score-v9-fact-input-primitives";

const Text = z.string().trim().min(1);
const Deployment = Text.refine((value) => normalizeDeploymentId(value) !== "", "Expected chain-qualified deployment").transform(normalizeDeploymentId);

/** HyperCore credits and EVM escrow releases are executed by the same L1,
 * not an external bridge quorum. This identity is not a solvency certificate. */
export const V9SameChainSystemTransportSchema = z.object({
  family: z.literal("hypercore-evm-spot"),
  tokenIndex: z.number().int().nonnegative().safe(),
  coreTokenId: z.string().regex(/^0x[0-9a-f]{32}$/),
  evmToken: Deployment,
  systemAddress: z.string().regex(/^0x[0-9a-f]{40}$/),
}).strict().superRefine((transport, ctx) => {
  const expected = `0x20${transport.tokenIndex.toString(16).padStart(38, "0")}`;
  if (transport.systemAddress !== expected) ctx.addIssue({ code: "custom", path: ["systemAddress"], message: "System address must encode the exact HyperCore token index" });
  if (!/^hyperevm:0x[0-9a-f]{40}$/.test(transport.evmToken)) ctx.addIssue({ code: "custom", path: ["evmToken"], message: "Spot transport requires an exact linked HyperEVM ERC20" });
});
export type V9SameChainSystemTransport = z.output<typeof V9SameChainSystemTransportSchema>;
const Pin = z.object({ position: Text, hash: Text.nullable(), runtimeIdentity: Text, signerIdentity: Text }).strict();
export const V9ExactControlPolicySchema = z.object({
  activationStates: z.array(z.enum(["active", "counterfactual", "disabled-reactivatable", "disabled-final", "unknown"])),
  entrypointKinds: z.array(z.enum(["evm-selector", "solana-instruction", "xrpl-transaction"])),
  callModes: z.array(z.enum(["call", "delegatecall", "native"])),
  reachStates: z.array(z.enum(["root", "deployment", "other-liability", "unknown"])),
  moduleImpactStates: z.array(z.enum(["relevant", "verified-noninterfering", "unresolved", "not-applicable"])),
  weightedSchemes: z.array(z.enum(["xrpl", "contract"])),
  admissionRule: z.literal("complete-execution-proof"),
  latentPowerRule: z.literal("reachable-worst-path"),
  moduleRule: z.literal("verified-noninterference-waives-presence-only"),
  weightedRule: z.literal("minimum-signatures-no-independence-credit"),
  issuedCurrencyAmount: z.object({ significantDigits: z.literal(16), minExponent: z.literal(-96), maxExponent: z.literal(80), maxInputLength: z.number().int().positive() }).strict(),
}).strict();
export const V9WeightedQuorumSchema = z.object({
  scheme: V9ExactControlPolicySchema.shape.weightedSchemes.element,
  deployment: Deployment,
  signers: z.array(z.object({ account: Text, weight: z.number().int().positive().safe() }).strict()).min(1),
  quorum: z.number().int().positive().safe(),
  masterKey: z.enum(["disabled", "enabled", "unknown"]).optional(),
  totalWeight: z.number().int().positive().safe().optional(),
  regularKey: z.discriminatedUnion("state", [
    z.object({ state: z.literal("absent") }).strict(),
    z.object({ state: z.literal("enabled"), address: Text }).strict(),
    z.object({ state: z.literal("unknown") }).strict(),
  ]).optional(),
  pin: Pin,
  status: z.enum(["verified", "unknown"]),
  reviewedAt: z.string().date(),
  expiresAt: z.string().date(),
  reviewer: Text,
  sources: z.array(z.object({ label: Text, url: z.string().url() }).strict()).min(1),
}).strict().superRefine((row, ctx) => {
  const xrpl = row.deployment.startsWith("xrpl:");
  if (xrpl !== (row.scheme === "xrpl")) ctx.addIssue({ code: "custom", message: "Weighted scheme/deployment mismatch" });
  if (row.scheme === "contract" && CHAIN_META[row.deployment.split(":")[0]!]?.type !== "evm") ctx.addIssue({ code: "custom", message: "Contract weighted quorum requires an EVM deployment" });
  const accountPattern = row.scheme === "xrpl" ? /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/ : /^0x[0-9a-fA-F]{40}$/;
  if (row.signers.some((signer) => !accountPattern.test(signer.account))) ctx.addIssue({ code: "custom", message: "Signer identity does not match signing scheme" });
  if (!accountPattern.test(row.deployment.slice(row.deployment.indexOf(":") + 1))) ctx.addIssue({ code: "custom", message: "Controller identity does not match signing scheme" });
  if (row.regularKey?.state === "enabled" && !/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(row.regularKey.address)) ctx.addIssue({ code: "custom", message: "RegularKey requires an exact classic account" });
  const keys = row.signers.map((signer) => row.scheme === "contract" ? signer.account.toLowerCase() : signer.account);
  const total = row.signers.reduce((sum, signer) => sum + signer.weight, 0);
  if (row.totalWeight != null && row.totalWeight !== total) ctx.addIssue({ code: "custom", message: "Weighted total must equal signer weights" });
  if (new Set(keys).size !== keys.length || !Number.isSafeInteger(total) || row.quorum > total) ctx.addIssue({ code: "custom", message: "Invalid weighted signer list or unattainable quorum" });
  if (row.scheme === "xrpl" && (row.masterKey == null || row.regularKey == null)) ctx.addIssue({ code: "custom", message: "XRPL quorum requires explicit master and RegularKey observations" });
  if (row.scheme === "contract" && (row.masterKey != null || row.regularKey != null)) ctx.addIssue({ code: "custom", message: "Contract quorum cannot claim XRPL key state" });
  if (row.expiresAt < row.reviewedAt) ctx.addIssue({ code: "custom", message: "Weighted review expiry precedes review" });
}).transform((row) => ({ ...row, signers: row.signers.map((signer) => ({ ...signer, account: row.scheme === "contract" ? signer.account.toLowerCase() : signer.account })).sort((a, b) => a.account.localeCompare(b.account)), totalWeight: row.signers.reduce((sum, signer) => sum + signer.weight, 0) }));
export type V9WeightedQuorum = z.output<typeof V9WeightedQuorumSchema>;

const V9ControlExecutionPathSchema = z.object({
  id: Text, targetDeployment: Deployment,
  entrypointKind: V9ExactControlPolicySchema.shape.entrypointKinds.element,
  entrypoints: z.array(Text).min(1), callMode: V9ExactControlPolicySchema.shape.callModes.element,
  capabilities: z.array(V9ControlCapabilitySchema).min(1),
  capSemantics: V9ControlCapSemanticsSchema,
  claimImpairment: V9ClaimImpairmentSchema,
  economicLossScope: V9EconomicLossScopeSchema,
  unavoidableDelaySec: z.number().int().nonnegative().nullable(),
  activation: V9ExactControlPolicySchema.shape.activationStates.element,
  affectedLiabilityIds: z.array(Text), affectedDeployments: z.array(Deployment),
  reach: V9ExactControlPolicySchema.shape.reachStates.element,
  controlRefs: z.array(Text),
  reactivationRefs: z.array(Text), permissionChangeRefs: z.array(Text), upgradeRefs: z.array(Text), bypassRefs: z.array(Text),
  counterfactual: z.object({ factoryDeployment: Deployment, factoryRuntimeIdentity: Text, runtimeIdentity: Text, create2Address: Deployment, create2Salt: Text, initializerCalldata: Text, initializationIdentity: Text, fixedInitialization: z.literal(true), owners: z.array(Text).min(1), threshold: z.number().int().positive(), modules: z.array(Text), fallbackHandler: Text.nullable(), accountStatePin: Pin }).strict().optional(),
}).strict();
const Hash = z.string().regex(/^0x[0-9a-f]{64}$/);
const Uint = z.string().regex(/^(0|[1-9][0-9]*)$/);
const Count = z.number().finite().int().nonnegative().safe();
const Refs = z.array(Text).min(1);

export const V9ControlExecutionScopeObjectSchema = z.object({
  controllerDeployment: Deployment,
  reviewedAt: z.string().date(), observedAt: z.string().date(), expiresAt: z.string().date(), reviewer: Text,
  confidence: z.enum(["verified", "partial", "unknown"]),
  sources: z.array(z.object({ label: Text, url: z.string().url() }).strict()).min(1),
  pin: Pin,
  observedState: Pin,
  inventory: z.enum(["complete", "partial", "unresolved"]),
  closure: z.object({ entrypoints: z.boolean(), mutableTargets: z.boolean(), delegateAndFallback: z.boolean(), permissions: z.boolean(), upgrades: z.boolean(), bypasses: z.boolean(), liabilityInventory: z.boolean() }).strict(),
  paths: z.array(V9ControlExecutionPathSchema).min(1),
  extensions: z.object({ exhaustive: z.boolean(), paginationEnd: Text.nullable(), sourceRuntimeCorrespondence: z.boolean(), entries: z.array(z.object({ deployment: Deployment, runtimeIdentity: Text, kind: z.enum(["module", "guard", "module-guard", "fallback-handler"]), pathRefs: z.array(Text), mutableReachClosed: z.boolean() }).strict()) }).strict().optional(),
  authorityBinding: z.object({ graphId: Text, authorityStateHash: Hash, observedAuthorityStateHash: Hash }).strict().optional(),
}).strict();
export const V9ControlExecutionScopeSchema = V9ControlExecutionScopeObjectSchema.superRefine((scope, ctx) => {
  const ids = new Set(scope.paths.map((path) => path.id));
  if (ids.size !== scope.paths.length) ctx.addIssue({ code: "custom", message: "Duplicate execution path ids" });
  if (scope.expiresAt < scope.reviewedAt || scope.reviewedAt < scope.observedAt) ctx.addIssue({ code: "custom", message: "Inconsistent execution review dates" });
  if (scope.inventory === "complete" && (scope.confidence !== "verified" || Object.values(scope.closure).some((closed) => !closed))) ctx.addIssue({ code: "custom", message: "Complete scope requires execution-complete closure certificate" });
  for (const path of scope.paths) {
    if (scope.inventory === "complete" && (path.reach === "unknown" || path.activation === "unknown")) ctx.addIssue({ code: "custom", message: "Complete scope cannot retain unknown reach or activation" });
    const chain = path.targetDeployment.split(":")[0];
    if ((chain === "xrpl") !== (path.entrypointKind === "xrpl-transaction") || (chain === "solana") !== (path.entrypointKind === "solana-instruction")) ctx.addIssue({ code: "custom", message: "Entrypoint kind does not match target chain" });
    if (path.entrypointKind === "evm-selector" && path.entrypoints.some((selector) => !/^0x[0-9a-fA-F]{8}$/.test(selector))) ctx.addIssue({ code: "custom", message: "Expected exact four-byte selector" });
    const refs = [...path.controlRefs, ...path.reactivationRefs, ...path.permissionChangeRefs, ...path.upgradeRefs, ...path.bypassRefs];
    if (refs.some((ref) => !ids.has(ref))) ctx.addIssue({ code: "custom", message: `Unknown execution control reference on ${path.id}` });
    if (path.activation === "counterfactual" && (!path.counterfactual || path.counterfactual.create2Address !== scope.controllerDeployment || path.counterfactual.factoryDeployment.split(":")[0] !== scope.controllerDeployment.split(":")[0] || path.counterfactual.threshold > path.counterfactual.owners.length)) ctx.addIssue({ code: "custom", message: "Counterfactual path requires fixed same-chain activation proof" });
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored fixed-width hex shapes; byte groups cannot overlap.
    if (path.counterfactual && (!/^0x[0-9a-fA-F]{64}$/.test(path.counterfactual.create2Salt) || !/^0x(?:[0-9a-fA-F]{2})+$/.test(path.counterfactual.initializerCalldata) || path.counterfactual.owners.some((owner) => !/^0x[0-9a-fA-F]{40}$/.test(owner)) || new Set(path.counterfactual.owners.map((owner) => owner.toLowerCase())).size !== path.counterfactual.owners.length)) ctx.addIssue({ code: "custom", message: "Counterfactual initialization requires exact salt, calldata and distinct owners" });
    if (path.activation === "disabled-final" && refs.length > 0) ctx.addIssue({ code: "custom", message: "Final-disabled path cannot retain reactivation or alternate authority" });
    if (path.reach === "deployment" && path.affectedDeployments.length === 0) ctx.addIssue({ code: "custom", message: "Local reach requires exact affected deployments" });
    if ((path.reach === "other-liability" || path.reach === "deployment") && path.affectedLiabilityIds.length === 0) ctx.addIssue({ code: "custom", message: "Scoped reach requires exact liability identities" });
    if ((path.capSemantics.kind === "bounded") !== (path.capSemantics.bound !== null)) ctx.addIssue({ code: "custom", message: "Only a bounded cap can carry an amount bound" });
  }
  if (scope.extensions?.entries.some((entry) => entry.pathRefs.some((ref) => !ids.has(ref)))) ctx.addIssue({ code: "custom", message: "Unknown extension execution path" });
});
export type V9ControlExecutionScope = z.output<typeof V9ControlExecutionScopeSchema>;

const admittedControlExecutionScopes = new WeakSet<object>();

export function isV9AdmittedControlExecutionScope(value: unknown): value is V9ControlExecutionScope {
  return value !== null && typeof value === "object" && Object.isFrozen(value) && admittedControlExecutionScopes.has(value);
}

const ControlExecutionScopeBatchSchema = z.union([
  z.custom<V9ControlExecutionScope>(isV9AdmittedControlExecutionScope),
  V9ControlExecutionScopeSchema,
]).array();

function sealAdmittedControlExecutionScope(scope: V9ControlExecutionScope): V9ControlExecutionScope {
  deepFreeze(scope);
  admittedControlExecutionScopes.add(scope);
  return scope;
}

/** Strictly validate fresh roots; reuse admitted immutable roots and share fresh subtrees within this batch only. */
export function admitV9ControlExecutionScopeBatch(values: unknown[]): V9ControlExecutionScope[] {
  const scopes = ControlExecutionScopeBatchSchema.parse(values);
  const intern = createV9ValueInterner();
  return scopes.map((scope) => isV9AdmittedControlExecutionScope(scope) ? scope : sealAdmittedControlExecutionScope(intern(scope)));
}

/** Same strict scope contract; only immutable, previously admitted in-process identities bypass cloning. */
export const V9InProcessControlExecutionScopeSchema = z.union([
  z.custom<V9ControlExecutionScope>(isV9AdmittedControlExecutionScope),
  V9ControlExecutionScopeSchema.transform(sealAdmittedControlExecutionScope),
]);

export type V9ControlExecutionScopeRootReuse = (scope: V9ControlExecutionScope) => V9ControlExecutionScope;

function sameScopeValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && left.length !== (right as unknown[]).length) return false;
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(b, key) || !sameScopeValue(a[key], b[key])) return false;
  }
  return true;
}

/** Call-local book reuse: immutable admission and exact structure, never a digest-only substitution. */
export function createV9ControlExecutionScopeRootReuse(): V9ControlExecutionScopeRootReuse {
  const roots = new Map<string, V9ControlExecutionScope[]>();
  return (scope) => {
    if (!isV9AdmittedControlExecutionScope(scope)) throw new Error("Scope root reuse requires immutable admission");
    const matches = roots.get(scope.controllerDeployment);
    if (matches) {
      for (const root of matches) if (sameScopeValue(root, scope)) return root;
      matches.push(scope);
    } else {
      roots.set(scope.controllerDeployment, [scope]);
    }
    return scope;
  };
}
export type V9ModuleImpact = z.output<typeof V9ExactControlPolicySchema>["moduleImpactStates"][number];

const V1005PinSchema = z.object({
  chain: Text, position: Uint, hash: Hash, timestamp: z.string().datetime({ offset: true }),
}).strict();
const V1005ReviewSchema = z.object({
  observedAt: z.string().date(), reviewedAt: z.string().date(), expiresAt: z.string().date(),
  reviewer: Text, pin: V1005PinSchema,
}).strict().superRefine((row, ctx) => {
  if (row.reviewedAt < row.observedAt || row.expiresAt < row.reviewedAt) ctx.addIssue({ code: "custom", message: "Inconsistent process review dates" });
});
/** `0x`-prefixed whole bytes (even hex digit count) with at least `minBytes` bytes. */
function isHexBytes(value: string, minBytes: number): boolean {
  return value.length >= 2 + minBytes * 2 && value.length % 2 === 0 && /^0x[0-9a-fA-F]*$/.test(value);
}

const V1005EvidenceSchema = z.object({
  id: Text, pin: V1005PinSchema, deployment: Deployment,
  kind: z.enum(["onchain-read", "verified-source", "controller-attribution"]),
  readType: z.enum(["evm-call", "storage", "code", "event-history", "read-bundle"]).nullable(),
  function: Text, selector: z.string().regex(/^0x[0-9a-f]{8}$/).nullable(),
  calldata: z.string().nullable(), rawResult: z.string().max(514).nullable(),
  rawResultHash: Hash.optional(), codeHash: Hash.optional(), codeSize: Count.optional(),
  fromBlock: Uint.optional(), toBlock: Uint.optional(), topics: z.array(z.union([Hash, z.array(Hash), z.null()])).optional(),
  logCount: Count.optional(), logsHash: Hash.optional(), captureHash: Hash.optional(),
  fieldReads: z.array(z.object({
    field: Text, function: Text, selector: z.string().regex(/^0x[0-9a-f]{8}$/).nullable(),
    readType: z.enum(["evm-call", "storage", "code"]), target: z.enum(["row-deployment", "bundle-deployment"]),
    arguments: z.enum(["none", "row-deployment"]), returnKind: z.enum(["uint", "deployment", "bool", "hash", "code-hash"]),
  }).strict()).optional(),
  sourceUrl: z.string().url(), sourceLocation: Text, statement: Text, artificial: z.boolean(),
}).strict().superRefine((row, ctx) => {
  const issue = (field: string, message: string) => ctx.addIssue({ code: "custom", path: [field], message });
  if (row.kind !== "onchain-read") {
    if (row.readType !== null || row.selector !== null || row.calldata !== null) issue("readType", "Source evidence is not an on-chain read");
    return;
  }
  if (row.readType === "evm-call") {
    if (row.selector === null || row.calldata === null || !isHexBytes(row.calldata, 4) || row.calldata.slice(0, 10).toLowerCase() !== row.selector) issue("calldata", "Call requires exact selector and matching calldata");
    if (row.rawResult === null ? row.rawResultHash == null : !isHexBytes(row.rawResult, 0)) issue("rawResult", "Call requires returned bytes or their hash");
  } else if (row.readType === "read-bundle") {
    if (!row.captureHash || !row.fieldReads?.length) issue("fieldReads", "Read bundle requires a capture hash and field reads");
    if (row.rawResult !== null || row.selector !== null || row.calldata !== null) issue("rawResult", "Read bundle stores captured values in its referenced member table");
    for (const field of row.fieldReads ?? []) {
      if (field.readType === "evm-call" ? field.selector === null : field.selector !== null ||
          field.function !== (field.readType === "code" ? "eth_getCode" : "eth_getStorageAt")) issue("fieldReads", "Field read requires exact typed function and selector");
    }
  } else {
    const method = row.readType === "storage" ? "eth_getStorageAt" : row.readType === "code" ? "eth_getCode" : row.readType === "event-history" ? "eth_getLogs" : null;
    if (method === null || row.function !== method || row.selector !== null || row.calldata !== null) issue("function", "Selectorless read requires its exact RPC method");
    if (row.readType === "code" && (row.rawResult !== null || row.codeHash == null || row.codeSize == null)) issue("codeHash", "Code read requires compact runtime hash and size");
    if (row.readType === "event-history" && (row.rawResult !== null || row.fromBlock == null || row.toBlock == null || row.topics == null || row.logCount == null || row.logsHash == null)) issue("logsHash", "Event history requires compact pinned bounds and digest");
  }
});
const V1005ProofSchema = z.object({
  id: Text, conclusion: z.enum(["closed", "open", "unknown"]),
  statement: z.string().trim().min(40), evidenceRefIds: Refs,
}).strict();
const V1005RuntimeSchema = z.object({
  deployment: Deployment, runtimeHash: Hash.nullable(), normalizedRuntimeHash: Hash.nullable(),
  proxyKind: z.enum(["none", "eip1967", "uups", "custom", "unknown"]),
  implementation: Deployment.nullable(), implementationRuntimeHash: Hash.nullable(),
  normalizedImplementationRuntimeHash: Hash.nullable(),
  sourceRuntimeMatch: z.enum(["exact", "metadata-normalized", "immutable-normalized", "unmatched", "unknown"]),
  normalization: z.array(z.object({
    byteOffset: Count, byteLength: z.number().int().positive().safe(),
    kind: z.enum(["compiler-metadata", "compiler-immutable"]), observedBytes: Text, sourceBytes: Text, evidenceRefIds: Refs,
  }).strict()),
  matchProofRef: Text, evidenceRefIds: Refs,
}).strict();
const V1005RuntimeIdentitySchema = V1005RuntimeSchema.omit({
  deployment: true, matchProofRef: true, evidenceRefIds: true, normalization: true,
}).extend({
  normalization: z.array(V1005RuntimeSchema.shape.normalization.element.omit({ evidenceRefIds: true })),
}).strict();
const V1005PathRefSchema = z.object({ controlRef: Deployment, pathId: Text }).strict();
const ConditionSchema = z.object({
  id: Text, kind: z.enum(["immutable", "storage", "authorization", "target", "selector", "accounting"]), description: Text,
  field: Text.optional(),
  test: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("equal"), value: Text }).strict(),
    z.object({ kind: z.literal("one-of"), values: z.array(Text).min(1) }).strict(),
    z.object({ kind: z.literal("uint-range"), min: Uint, max: Uint }).strict(),
  ]), proofRef: Text,
}).strict();
const PathTemplateSchema = V9ControlExecutionPathSchema.omit({
  targetDeployment: true, activation: true, unavoidableDelaySec: true, affectedLiabilityIds: true, affectedDeployments: true,
}).extend({ proofRef: Text }).strict();
const MemberConditionSchema = z.object({ conditionId: Text, observedValue: Text.nullable(), proofRef: Text }).strict();
const PathBindingSchema = z.object({
  templateId: Text, targetDeployment: Deployment,
  activation: V9ExactControlPolicySchema.shape.activationStates.element, unavoidableDelaySec: Count.nullable(),
  affectedLiabilityIds: Refs, affectedDeployments: z.array(Deployment),
  authorityNodeIds: Refs, provenanceNodeIds: z.array(Text), proofRef: Text,
}).strict();
const MemberRuntimeTemplateSchema = V1005RuntimeSchema.omit({ deployment: true });
const MemberTemplateFields = {
  censusIds: Refs, review: V1005ReviewSchema, runtime: MemberRuntimeTemplateSchema,
  conditions: z.array(MemberConditionSchema), extensions: V9ControlExecutionScopeObjectSchema.shape.extensions,
};
const PathBindingTemplateSchema = PathBindingSchema.omit({ targetDeployment: true }).extend({
  targetDeployment: Deployment.nullable(), targetIsMember: z.boolean(), affectedIncludesMember: z.boolean(),
}).strict().superRefine((row, ctx) => {
  if (row.targetIsMember !== (row.targetDeployment === null)) ctx.addIssue({ code: "custom", path: ["targetDeployment"], message: "Member-target templates require a null fixed target; fixed targets require a deployment" });
});
const ClassSchema = z.object({
  id: Text, review: V1005ReviewSchema, runtimeVariants: z.array(V1005RuntimeSchema).min(1),
  cloneRuntimeVariants: z.array(z.object({
    runtimeHash: Hash, proxyKind: z.literal("eip1167"),
    implementationIdentityRef: Deployment, matchProofRef: Text,
  }).strict()).min(1).optional(),
  invariants: Refs, requiredConditions: z.array(ConditionSchema), memberRefs: z.array(Deployment).min(1),
  closure: V9ControlExecutionScopeObjectSchema.shape.closure, paths: z.array(PathTemplateSchema).min(1),
  sourcePathRefs: z.array(V1005PathRefSchema).min(1).optional(),
  compactMembers: z.array(z.object({
    deployment: Deployment, codeHash: Hash.nullable(), codeSize: Count.optional(),
    immutables: z.record(Text, Text.nullable()), state: z.record(Text, z.union([Text, z.boolean(), z.null()])),
    evidenceRefIds: Refs,
  }).strict()).min(1).optional(),
  memberTemplates: z.array(z.object({ id: Text, ...MemberTemplateFields }).strict()).optional(),
  pathBindingTemplates: z.array(PathBindingTemplateSchema).min(1).optional(),
}).strict().superRefine((row, ctx) => {
  if ((row.sourcePathRefs !== undefined) !== (row.compactMembers !== undefined)) ctx.addIssue({ code: "custom", path: ["compactMembers"], message: "Compact members require source path bindings" });
  if (row.compactMembers) {
    const refs = row.compactMembers.map((member) => member.deployment);
    if (new Set(refs).size !== refs.length || refs.length !== row.memberRefs.length || row.memberRefs.some((ref) => !refs.includes(ref))) ctx.addIssue({ code: "custom", path: ["compactMembers"], message: "Compact table must exactly equal the class member census" });
    if (row.requiredConditions.some((condition) => !condition.field || !/^(immutables|state)\.[^.]+$/.test(condition.field))) ctx.addIssue({ code: "custom", path: ["requiredConditions"], message: "Compact conditions require explicit instance field bindings" });
  }
});
export const V1005ExecutionMemberSchema = z.object({
  memberRef: Deployment, classId: Text, ...MemberTemplateFields, runtime: V1005RuntimeSchema,
  pathBindings: z.array(PathBindingSchema).min(1),
}).strict();
const ReferencedMemberSchema = z.object({
  deployment: Deployment, classId: Text, templateRef: Text,
  overrides: z.object(MemberTemplateFields).partial().extend({ runtime: MemberRuntimeTemplateSchema.partial().optional() }).strict().optional(),
  pathBindingOverrides: z.array(PathBindingSchema.partial().required({ templateId: true })).optional(),
}).strict();
const CensusSchema = z.object({
  id: Text, review: V1005ReviewSchema, targetDeployment: Deployment,
  kind: z.enum(["ward", "role", "owner", "admin", "facilitator", "reachable-instance"]), role: Text,
  coverage: z.enum(["complete", "partial", "unknown"]), authoritativeMembers: z.array(Deployment),
  discovery: z.object({
    kind: z.enum(["full-history-and-constructor", "exhaustive-getter", "source-fixed-set"]),
    fromPosition: Uint, throughPosition: Uint, paginationEnd: Text.nullable(), proofRef: Text,
  }).strict(),
  observations: z.array(z.object({ memberRef: Deployment, authorized: z.union([z.boolean(), z.literal("unknown")]), evidenceRefIds: Refs }).strict()),
  completenessProofRef: Text,
  compactClassRef: Text.optional(),
}).strict();
export const V1005ExecutionCertificatesSchema = z.object({
  schemaVersion: z.literal(1), liabilityBookId: Text,
  sharedBookRef: z.object({ assetId: Text, liabilityBookId: Text, authorityGraphId: Text, authorityStateHash: Hash }).strict().optional(),
  evidence: z.array(V1005EvidenceSchema), proofs: z.array(V1005ProofSchema),
  censuses: z.array(CensusSchema), classes: z.array(ClassSchema), members: z.array(z.union([V1005ExecutionMemberSchema, ReferencedMemberSchema])),
}).strict().superRefine((row, ctx) => {
  if (!row.sharedBookRef && (row.evidence.length === 0 || row.proofs.length === 0 || row.censuses.length === 0)) ctx.addIssue({ code: "custom", message: "A local authority book requires evidence, proofs and an authoritative census" });
  if (row.sharedBookRef && row.sharedBookRef.liabilityBookId !== row.liabilityBookId) ctx.addIssue({ code: "custom", path: ["sharedBookRef", "liabilityBookId"], message: "Shared and local liability book ids must match" });
});
export const V1005ExecutionClassRefSchema = z.object({ classId: Text, memberRef: Deployment }).strict();
const V1005GraphEdgeKindSchema = z.enum([
  "owner", "ward", "role", "admin", "upgrade", "delegatecall", "execution-hop", "vote-origin",
  "reactivation", "permission-change", "envelope-raise", "credit-origin", "recipient-hop",
  "claim-transfer", "liability-conversion", "delegate", "operator", "vote-cast", "vote-replacement",
]);
export const V1005AuthorityGraphSchema = z.object({
  id: Text, review: V1005ReviewSchema, liabilityBookId: Text, governorNodeId: Text,
  nodes: z.array(z.object({
    id: Text, deployment: Deployment.nullable(),
    kind: z.enum(["contract", "timelock", "token-governor", "multisig", "eoa", "issuer-backend", "public-trigger", "fixed-program", "unknown"]),
    terminal: z.boolean(), authorityCensusIds: z.array(Text),
    runtime: z.object({ ref: Hash }).strict().nullable(), proofRef: Text,
  }).strict()).min(1),
  runtimeIdentities: z.array(z.object({
    id: Hash,
    identity: V1005RuntimeIdentitySchema,
    proofRef: Text, evidenceRefIds: Refs,
  }).strict()).optional(),
  edges: z.array(z.object({
    id: Text, from: Text, to: Text, kind: V1005GraphEdgeKindSchema, pathRefs: z.array(V1005PathRefSchema).min(1),
    selectors: z.array(z.string().regex(/^0x[0-9a-f]{8}$/)), role: Text.nullable(),
    activation: V9ExactControlPolicySchema.shape.activationStates.element,
    publicDelaySec: Count.nullable(), calldataBound: z.union([z.boolean(), z.literal("unknown")]), proofRef: Text,
  }).strict()),
  pathBindings: z.array(z.object({
    path: V1005PathRefSchema, authorityNodeIds: Refs, provenanceNodeIds: z.array(Text), closureProofRef: Text,
  }).strict()).min(1), closureProofRef: Text,
}).strict();
export const V1005VotingControllerSchema = z.object({
  id: Text, accounts: z.array(Deployment).min(1), votingPowerRaw: Uint.nullable(),
  affiliation: z.enum(["issuer", "council", "team", "independent", "unknown"]),
  beneficialControl: z.enum(["identified", "uncertain", "unknown"]), voteAuthorityNodeIds: Refs,
  holderRevocation: z.enum(["onchain-at-will", "not-revocable", "unknown"]), revocationProofRef: Text,
  ownedPositionIds: z.array(Text), ownVoteOwnershipProofRef: Text, otherHolderVoteAuthorityProofRef: Text,
  voteReplacementApproval: z.enum(["not-applicable", "onchain-token-holder-approval", "key-discretion", "unknown"]),
  attributionProofRef: Text,
}).strict();
const Comparator = z.enum(["gte", "gt", "not-applicable"]);
export const V1005VotingControlSchema = z.object({
  id: Text, governorNodeId: Text, review: V1005ReviewSchema, votingToken: Deployment, totalVotingPowerRaw: Uint.nullable(),
  pinnedVotingSupply: z.object({ deployment: Deployment, function: Text, raw: Uint.nullable(), proofRef: Text }).strict(),
  controllerCensusProofRef: Text,
  holderCensus: z.array(z.object({
    id: Text, deployment: Deployment, balanceRaw: Uint.nullable(), votingPowerRaw: Uint.nullable(),
    delegate: Deployment.nullable(), ownerControllerId: Text.nullable(), evidenceRefIds: Refs,
    controllerId: Text.optional(), provenance: z.enum(["own", "other", "unknown"]).optional(),
  }).strict()),
  controllerTemplates: z.array(V1005VotingControllerSchema.partial().required({ id: true })).optional(),
  controllers: z.array(z.union([V1005VotingControllerSchema, V1005VotingControllerSchema.partial().extend({
    id: Text, templateRef: Text, holderRowRef: Text.optional(),
  }).strict()])),
  routes: z.array(z.object({
    id: Text, path: V1005PathRefSchema, kind: z.enum(["affirmative-approval", "veto-neutralization", "public-minority-admission"]),
    totalVotingPowerRaw: Uint.nullable(), unilateralThresholdRaw: Uint.nullable(), thresholdComparator: Comparator,
    thresholdProofRef: Text,
    holderCensusRef: z.literal("holderCensus"),
    controllerPowers: z.array(z.object({
      controllerId: Text, ownHolderRowIds: z.array(Text), otherHolderRowIds: z.array(Text),
      unknownProvenanceHolderRowIds: z.array(Text),
      unilateralThresholdRaw: Uint.nullable(), thresholdComparator: Comparator, thresholdProofRef: Text,
    }).strict()),
    residualUpperRaw: Uint.nullable(), residualProofRef: Text, affiliatedControllerIds: z.array(Text),
    affiliatedAggregatePowerRaw: Uint.nullable(), affiliatedAggregateUnilateralThresholdRaw: Uint.nullable(),
    affiliatedAggregateThresholdComparator: Comparator, affiliatedAggregateThresholdProofRef: Text,
    minorityProtectionProofRef: Text.nullable(),
  }).strict()).min(1),
  privilegedVoteCreation: z.object({ state: z.enum(["none", "governor-only", "independent", "unknown"]), pathRefs: z.array(V1005PathRefSchema), proofRef: Text }).strict(),
  forcedDelegation: z.object({ state: z.enum(["none", "governor-only", "independent", "unknown"]), pathRefs: z.array(V1005PathRefSchema), proofRef: Text }).strict(),
}).strict();
const EnvelopeSchema = z.object({
  setterNodeIds: Refs, raisePathRefs: z.array(V1005PathRefSchema).min(1), enforcementProofRef: Text, raiseClosureProofRef: Text,
}).strict();
const FormulaSchema = z.object({
  kind: z.literal("formula-interest"), path: V1005PathRefSchema,
  principal: z.object({
    kind: z.enum(["deposited-principal", "recorded-debt", "claim-shares"]), sourceDeployment: Deployment,
    getter: Text, units: Text, claimIdentity: Text, observedPrincipalRaw: Uint.nullable(), proofRef: Text,
  }).strict(),
  time: z.object({ clock: z.enum(["timestamp", "block"]), getter: Text, proofRef: Text }).strict(),
  beneficiaryProofRef: Text, accountingProofRef: Text,
  rate: z.object({
    rawCap: Uint.nullable(), rawUnits: Text, convention: z.enum(["simple-apr", "per-second-compound", "refresh-compound", "other"]),
    yearSec: z.number().int().positive().safe(), operationalAnnualRatePpmUpper: Count.nullable(),
    conversionFormula: Text, capProofRef: Text, unitsCompoundingProofRef: Text,
  }).strict(), envelope: EnvelopeSchema,
}).strict();
const KeeperSchema = z.object({
  kind: z.literal("keeper-incentive"), path: V1005PathRefSchema,
  lifecycle: z.enum(["initial-kick", "repeat", "other-activity"]), liabilityBookId: Text,
  principalProvenanceProofRef: Text, eligibilityProofRef: Text, debtBookChargeProofRef: Text,
  proportionalRewardPpm: Count.nullable(), fixedRewardRaw: Uint.nullable(), rewardUnits: Text,
  minimumRepeatSec: Count.nullable(), repeatScope: Text,
  initialCompensation: z.object({
    newDebtAdmission: z.enum(["immediate", "governor-only", "unknown"]),
    minimumNewPositionDebtRaw: Uint.nullable(), rewardDebtRawAtMinimum: Uint.nullable(), liquidationPenaltyChargeRawAtMinimum: Uint.nullable(),
    historicalStockDebtRaw: Uint.nullable(), historicalDebtPositionCountUpper: Uint.nullable(),
    historicalPaidLiquidationCountUpper: Uint.nullable(), historicalStockKickRewardRawUpper: Uint.nullable(),
    newDebtReachProofRef: Text, minimumAndPenaltyProofRef: Text, historicalStockProofRef: Text, oncePerLiquidationProofRef: Text,
  }).strict().nullable(),
  chosenRecipient: z.boolean(), sameActivityMayRepeat: z.union([z.boolean(), z.literal("unknown")]),
  lifetimeBudgetEnforced: z.union([z.boolean(), z.literal("unknown")]), envelope: EnvelopeSchema,
}).strict();
export const V1005OperationalIssuanceSchema = z.object({
  review: V1005ReviewSchema, liabilityBookId: Text,
  paths: z.array(z.union([FormulaSchema, KeeperSchema, z.object({
    kind: z.enum(["bounded-stock", "collateral-gated", "fixed-sink", "restriction-only", "atomic-flash", "paired-accounting", "no-issuance"]),
    path: V1005PathRefSchema, invariantProofRef: Text, economicReachProofRef: Text, envelope: EnvelopeSchema.nullable(),
    externalAccountingTrust: z.literal("strategy-reported-assets").optional(),
  }).strict().superRefine((row, ctx) => {
    if (row.externalAccountingTrust && row.kind !== "paired-accounting") ctx.addIssue({ code: "custom", path: ["externalAccountingTrust"], message: "External accounting trust is a paired-accounting Backing fact" });
  })])).min(1),
  keeperAggregate: z.object({
    liabilityBookId: Text, pathRefs: z.array(V1005PathRefSchema).min(1), denominatorRaw: Uint.nullable(),
    denominatorUnits: Text, denominatorEvidenceRefIds: Refs, windowSec: z.number().int().positive().safe(),
    denominatorTerms: z.array(z.object({
      evidenceRefId: Text, deployment: Deployment, function: Text,
      scaleNumerator: Uint, scaleDenominator: Uint, unitsProofRef: Text,
    }).strict()).min(1).optional(),
    upperRepeatRewardRaw: Uint.nullable(), rewardUnits: Text,
    repeatGroups: z.array(z.object({
      id: Text, pathRefs: z.array(V1005PathRefSchema).min(1), inFlightCapRaw: Uint.nullable(), minimumPaidAuctionRaw: Uint.nullable(),
      fixedRewardRawUpper: Uint.nullable(), proportionalRewardPpmUpper: Count.nullable(), maxRepeatsPerWindow: Count.nullable(),
      capAndMultiplicityProofRef: Text, repeatAndBoundaryProofRef: Text,
    }).strict()),
    repeatCouplingGroups: z.array(z.object({
      id: Text, repeatGroupIds: Refs, sharedInFlightCapRaw: Uint.nullable(), capAndSlackProofRef: Text,
    }).strict()),
    formula: Text, activityAntiFarmingProofRef: Text, deduplicationProofRef: Text, initialAndBoundaryProofRef: Text, scopeProofRef: Text,
  }).strict().nullable(),
  interestAggregate: z.object({
    liabilityBookId: Text, pathRefs: z.array(V1005PathRefSchema).min(1), principalClaimIds: Refs,
    principalRaw: Uint.nullable(), principalUnits: Text, annualGrowthPpmUpper: Count.nullable(),
    formula: Text, deduplicationProofRef: Text, compoundingProofRef: Text, scopeProofRef: Text,
  }).strict().nullable(),
}).strict();
export type V1005ExecutionCertificates = z.output<typeof V1005ExecutionCertificatesSchema>;
export type V1005ExecutionMember = z.output<typeof V1005ExecutionMemberSchema>;
export type V1005AuthorityGraph = z.output<typeof V1005AuthorityGraphSchema>;
export type V1005OperationalIssuance = z.output<typeof V1005OperationalIssuanceSchema>;
