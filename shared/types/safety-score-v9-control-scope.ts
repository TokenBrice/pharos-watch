import { z } from "zod";
import { normalizeDeploymentId } from "../lib/deployment-id";
import { CHAIN_META } from "../lib/chains";
import { V9ControlCapabilitySchema, V9ControlCapSemanticsSchema, V9ClaimImpairmentSchema, V9EconomicLossScopeSchema } from "./safety-score-v9-fact-input-primitives";

const Text = z.string().trim().min(1);
const Deployment = Text.refine((value) => normalizeDeploymentId(value) !== "", "Expected chain-qualified deployment").transform(normalizeDeploymentId);
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

export const V9ControlExecutionScopeSchema = z.object({
  controllerDeployment: Deployment,
  reviewedAt: z.string().date(), observedAt: z.string().date(), expiresAt: z.string().date(), reviewer: Text,
  confidence: z.enum(["verified", "partial", "unknown"]),
  sources: z.array(z.object({ label: Text, url: z.string().url() }).strict()).min(1),
  pin: Pin,
  observedState: Pin,
  inventory: z.enum(["complete", "partial", "unresolved"]),
  closure: z.object({ entrypoints: z.boolean(), mutableTargets: z.boolean(), delegateAndFallback: z.boolean(), permissions: z.boolean(), upgrades: z.boolean(), bypasses: z.boolean(), liabilityInventory: z.boolean() }).strict(),
  paths: z.array(z.object({
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
  }).strict()).min(1),
  extensions: z.object({ exhaustive: z.boolean(), paginationEnd: Text.nullable(), sourceRuntimeCorrespondence: z.boolean(), entries: z.array(z.object({ deployment: Deployment, runtimeIdentity: Text, kind: z.enum(["module", "guard", "module-guard", "fallback-handler"]), pathRefs: z.array(Text), mutableReachClosed: z.boolean() }).strict()) }).strict().optional(),
}).strict().superRefine((scope, ctx) => {
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
export type V9ModuleImpact = z.output<typeof V9ExactControlPolicySchema>["moduleImpactStates"][number];
