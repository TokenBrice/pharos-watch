import type { MintBurnConservationRecord } from "@shared/types/status";
import type { MintBurnContractConfig, MintBurnEventDef } from "./mint-burn-contracts";
import type { AlchemyLogEntry } from "./alchemy-logs";
import { readDataWord, type SubrequestBudget } from "./evm-logs";
import type { MintBurnRow } from "./mint-burn-pipeline/types";
import { mintBurnConfigKey } from "./mint-burn-pipeline/sync-state";
import { decimalNumberFromBigInt } from "./bigint";
import { fetchEvmRpcBatchDetailed, type EvmRpcBatchCall } from "./evm-rpc";
import { getCaches } from "./db-cache";
import { buildInClause, D1_SAFE_IN_CLAUSE_BIND_LIMIT } from "./d1-primitives";
import { throwIfAborted } from "./abort";
import { runWithOverloadRetry } from "./d1-overload-retry";
import conservationRuntimeLookup from "./mint-burn-conservation-runtime.generated.json";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO = `0x${"0".repeat(64)}`;
const WORD = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_WORD = /^0x0{24}[0-9a-fA-F]{40}$/;
const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const SELECTOR = /^0x[0-9a-f]{8}$/;
const TOTAL_SUPPLY_SELECTOR = "0x18160ddd";
// TetherToken.deprecated() — when true the configured address forwards totalSupply() to upgradedAddress.
const DEPRECATED_SELECTOR = "0x0e136b19";
const UINT128_MAX = (1n << 128n) - 1n;
// Guard-event signatures consumed by the reviewed alternative conservation laws.
const YIELD_DISTRIBUTION_SIGNATURE = "YieldDistribution(address,uint256,uint256)";
const TOTAL_SUPPLY_UPDATED_HIGHRES_SIGNATURE = "TotalSupplyUpdatedHighres(uint256,uint256,uint256)";
const TOTAL_SUPPLY_UPDATED_LEGACY_SIGNATURE = "TotalSupplyUpdated(uint256,uint256,uint256)";
const BONUS_MULTIPLIER_SIGNATURE = "BonusMultiplier(uint256)";
const UPGRADED_SIGNATURE = "Upgraded(address)";
// Conservation event defs extend the config's MintBurnEventDef vocabulary with law-only roles:
// the sidecar owns them, they never reach row parsing, and only the audit consumes them.
export type ConservationAmountEncoding =
  | "transfer-value"
  | "first-data-uint256"
  | "nth-data-uint256"
  | "data-minus-data-uint256";

export interface ConservationEventDef {
  signature: string;
  topicHash: string;
  /** Required for role "sum". */
  direction?: "mint" | "burn";
  /**
   * "sum" (default) contributes the decoded amount to the mint/burn totals; "guard" is
   * shape-validated only and consumed by the reviewed invariant's guards (rebase pairing,
   * saturation, multiplier replay, proxy upgrades).
   */
  role?: "sum" | "guard";
  amountEncoding?: ConservationAmountEncoding;
  dataSlot?: number;
  /** Second data slot for amountEncoding "data-minus-data-uint256" (subtracted from dataSlot). */
  secondDataSlot?: number;
  filterTopic?: {
    index: number;
    value: string;
  };
  /** Expected topics.length; defaults to 3 (the Transfer convention). Non-indexed events use 1. */
  topicArity?: number;
  /** Emitter override; defaults to the configured token address (e.g. the OUSD vault). */
  emitter?: string;
}

/** A pinned boundary read an invariant's guards depend on, declared by the reviewed sidecar entry. */
export interface ConservationBoundaryView {
  name: string;
  address: string;
  call:
    | { kind: "eth_call"; selector: string }
    | { kind: "eth_getStorageAt"; slot: string };
  /** Pinned expected value (0x-hex word or address); a mismatch at either boundary fails the audit closed. */
  expect?: string;
}

/** Runtime parameters of a reviewed alternative conservation law. */
export interface ConservationInvariantParams {
  /** eth_call data selector for the audited supply view; default totalSupply(). */
  supplySelector?: string;
  /** Extra pinned reads at both boundary hashes. */
  boundaryViews?: ConservationBoundaryView[];
}

/**
 * One entry of the generated runtime lookup (`mint-burn-conservation-runtime.generated.json`):
 * the sidecar entry reduced to identity, disposition, reason, and law parameters. The Worker
 * bundles only this shape; `scripts/maintenance/generate-mint-burn-conservation-runtime.ts`
 * owns the projection and byte format, and `conservationOnlyEvents`/`invariantParams` pass
 * through verbatim so the reviewed alternative laws keep their parameters.
 */
export interface MintBurnConservationRuntimeEntry {
  chainId: string;
  stablecoinId: string;
  address: string;
  decimals: number;
  disposition: "admitted" | "unsupported";
  unsupportedReason?: string | null;
  eventSet?: "transfer" | "config-events";
  invariant?: string;
  conservationOnlyEvents?: ConservationEventDef[];
  requiresNotDeprecated?: boolean;
  invariantParams?: ConservationInvariantParams;
}

export interface MintBurnConservationRuntimeLookup {
  version: 1;
  entries: MintBurnConservationRuntimeEntry[];
}

// Reviewed-identity evidence sidecar: worker/src/lib/mint-burn-conservation-reviewed.json.
// One entry per config identity (chain, stablecoin id, lowercase address, decimals) with the
// reviewer's identity evidence and audited windows. Structural rules are enforced by tests and
// by the admission CLI; only they import the sidecar. The Worker runtime imports the small
// generated lookup mint-burn-conservation-runtime.generated.json (registered generated
// artifact, projected from the sidecar) so the evidence never reaches the isolate bundle.
export interface ReviewedConservationWindow {
  fromBlock: number;
  fromBlockHash: string;
  fromTimestamp: number;
  toBlock: number;
  toBlockHash: string;
  toTimestamp: number;
  mintRaw: string;
  burnRaw: string;
  supplyDeltaRaw: string;
  residualRaw: string;
  logCount: number;
  journalSha256: string;
}

export interface ReviewedConservationExternalMatch {
  source: string;
  value: string;
  [field: string]: unknown;
}

export interface ReviewedConservationIdentity {
  sourceVerified: boolean;
  externalMatches?: ReviewedConservationExternalMatch[];
  onChain?: { decimals?: number; [field: string]: unknown };
  proxy?: { implementationSourceVerified?: boolean; [field: string]: unknown };
  [field: string]: unknown;
}

export interface ReviewedConservationEntry extends MintBurnConservationRuntimeEntry {
  identity?: ReviewedConservationIdentity;
  supplyPaths?: unknown[];
  unpairedPaths?: unknown[];
  totalSupplyView?: { isStoredSum?: boolean; [field: string]: unknown };
  zeroRecipientTransferReverts?: boolean | null;
  zeroRecipientTransferBurns?: boolean | null;
  identityIssue?: string | null;
  notes?: string | null;
  windows?: ReviewedConservationWindow[];
  reviewedAt?: string;
  reviewer?: string;
}

export interface MintBurnConservationEligibility {
  supported: boolean;
  reason?: string;
}

/** Resolves the runtime conservation law for a config; defaults to the generated lookup. */
export type MintBurnConservationLawResolver =
  (config: MintBurnContractConfig) => MintBurnConservationRuntimeEntry | undefined;

const UNREVIEWED_REASON = "unreviewed-contract-or-event-semantics";
const UNSUPPORTED_REASON_LITERALS: Readonly<Record<string, true>> = {
  "rebasing-supply-without-events": true,
  "total-supply-override": true,
  "deprecated-upgrade-forwarding": true,
  "unverified-implementation-source": true,
};
const UNSUPPORTED_REASON_PREFIXES: readonly string[] = [
  "unpaired-supply-path:",
  "zero-address-transfer-without-supply-change:",
];

export function isMintBurnConservationUnsupportedReason(reason: unknown): reason is string {
  return typeof reason === "string" && (UNSUPPORTED_REASON_LITERALS[reason] === true ||
    UNSUPPORTED_REASON_PREFIXES.some((prefix) => reason.startsWith(prefix)));
}

export function reviewedConservationIdentityKey(chainId: string, stablecoinId: string, address: string, decimals: number): string {
  return `${chainId}\u0000${stablecoinId}\u0000${address.toLowerCase()}\u0000${decimals}`;
}

function buildReviewedConservationIndex(entries: readonly MintBurnConservationRuntimeEntry[]):
  ReadonlyMap<string, MintBurnConservationRuntimeEntry> {
  const index = new Map<string, MintBurnConservationRuntimeEntry>();
  for (const entry of entries) {
    index.set(reviewedConservationIdentityKey(entry.chainId, entry.stablecoinId, entry.address, entry.decimals), entry);
  }
  return index;
}

// One lookup map built at import; no structural validation happens at load time. The JSON
// module's inferred literal type is intentionally narrowed once here (tests and the admission
// CLI own structural validation of the evidence sidecar the lookup is projected from).
const REVIEWED_CONSERVATION_INDEX: ReadonlyMap<string, MintBurnConservationRuntimeEntry> =
  buildReviewedConservationIndex(
    (conservationRuntimeLookup as MintBurnConservationRuntimeLookup).entries);

function canonicalTransferPairSupported(config: MintBurnContractConfig): boolean {
  return config.events.length === 2 && ["mint", "burn"].every((direction) =>
    config.events.filter((event) => event.direction === direction &&
      event.signature === "Transfer(address,address,uint256)" && event.topicHash.toLowerCase() === TRANSFER &&
      event.amountEncoding === "transfer-value" && event.dataSlot == null && event.counterpartyEncoding == null &&
      event.filterTopic?.index === (direction === "mint" ? 1 : 2) && event.filterTopic.value.toLowerCase() === ZERO).length === 1);
}

/**
 * Eligibility for one config against one reviewed law (or no entry). `admitted` additionally
 * requires the config's event shape to match the reviewed law: the canonical zero-address
 * Transfer pair with the `transfer-zero-address` adapter for Transfer-based laws (including
 * the reviewed alternative invariants), or `custom-events` with summed mint and burn defs for
 * `eventSet: "config-events"`; `unsupported` returns the entry's specific reviewed reason.
 */
export function resolveMintBurnConservationEligibility(entry: MintBurnConservationRuntimeEntry | undefined,
  config: MintBurnContractConfig): MintBurnConservationEligibility {
  if (!entry) return { supported: false, reason: UNREVIEWED_REASON };
  if (entry.disposition === "unsupported") {
    return { supported: false, reason: entry.unsupportedReason ?? UNREVIEWED_REASON };
  }
  if (entry.eventSet === "config-events") {
    const summed = [...config.events, ...(entry.conservationOnlyEvents ?? []).filter((def) => (def.role ?? "sum") !== "guard")];
    return config.adapterKind === "custom-events" && config.events.length > 0 &&
      config.events.every((def) => WORD.test(def.topicHash) && def.amountEncoding !== undefined &&
        Number.isSafeInteger(def.topicArity) &&
        (def.amountEncoding !== "nth-data-uint256" || Number.isSafeInteger(def.dataSlot))) &&
      ["mint", "burn"].every((direction) => summed.some((def) => def.direction === direction))
      ? { supported: true } : { supported: false, reason: UNREVIEWED_REASON };
  }
  return entry.eventSet === "transfer" && canonicalTransferPairSupported(config) && config.adapterKind === "transfer-zero-address"
    ? { supported: true } : { supported: false, reason: UNREVIEWED_REASON };
}

export function getMintBurnConservationRuntimeEntry(config: MintBurnContractConfig): MintBurnConservationRuntimeEntry | undefined {
  return REVIEWED_CONSERVATION_INDEX.get(
    reviewedConservationIdentityKey(config.chain.chainId, config.stablecoinId, config.contractAddress, config.decimals));
}

export function getMintBurnConservationEligibility(config: MintBurnContractConfig): MintBurnConservationEligibility {
  return resolveMintBurnConservationEligibility(getMintBurnConservationRuntimeEntry(config), config);
}

/** Sidecar conservation-only event defs for an eligible config; empty otherwise. */
export function conservationOnlyEventDefsFor(config: MintBurnContractConfig): ConservationEventDef[] {
  const entry = getMintBurnConservationRuntimeEntry(config);
  return entry?.disposition === "admitted" && resolveMintBurnConservationEligibility(entry, config).supported
    ? entry.conservationOnlyEvents ?? [] : [];
}

function isPassingReviewedConservationWindow(window: unknown): boolean {
  if (typeof window !== "object" || window === null) return false;
  if (!("residualRaw" in window) || !("mintRaw" in window) || !("burnRaw" in window) ||
    !("supplyDeltaRaw" in window) || !("fromBlockHash" in window) || !("toBlockHash" in window)) return false;
  const { residualRaw, mintRaw, burnRaw, supplyDeltaRaw, fromBlockHash, toBlockHash } =
    window as Record<"residualRaw" | "mintRaw" | "burnRaw" | "supplyDeltaRaw" | "fromBlockHash" | "toBlockHash", unknown>;
  if (residualRaw !== "0" || typeof mintRaw !== "string" || typeof burnRaw !== "string" ||
    typeof supplyDeltaRaw !== "string" || typeof fromBlockHash !== "string" ||
    typeof toBlockHash !== "string" || fromBlockHash === toBlockHash) return false;
  try {
    return BigInt(mintRaw) - BigInt(burnRaw) === BigInt(supplyDeltaRaw);
  } catch {
    return false;
  }
}

/**
 * Section-3 structural rules for one reviewed sidecar entry. Returns one message per
 * violated rule; an empty array means the entry is structurally valid.
 */
export function validateReviewedConservationEntry(entry: ReviewedConservationEntry): string[] {
  const label = `${entry.chainId}/${entry.stablecoinId}/${entry.address}/${entry.decimals}`;
  if (entry.disposition !== "admitted" && entry.disposition !== "unsupported") {
    return [`${label}: disposition must be "admitted" or "unsupported"`];
  }
  if (!/^0x[0-9a-f]{40}$/.test(entry.address)) return [`${label}: address must be a lowercase 0x-hex value`];
  if (!Number.isSafeInteger(entry.decimals) || entry.decimals < 0) return [`${label}: decimals must be a non-negative integer`];
  if (entry.disposition === "unsupported") {
    return isMintBurnConservationUnsupportedReason(entry.unsupportedReason)
      ? [] : [`${label}: unsupported requires a reason from the fixed vocabulary`];
  }
  const problems: string[] = [];
  const notes = typeof entry.notes === "string" ? entry.notes : "";
  if (entry.identity?.sourceVerified !== true && !notes.startsWith("source-exception:")) {
    problems.push(`${label}: admitted requires identity.sourceVerified or a notes exception starting "source-exception:"`);
  }
  const externalMatch = Array.isArray(entry.identity?.externalMatches) && entry.identity.externalMatches.some((match) =>
    typeof match?.value === "string" && match.value.toLowerCase() === entry.address);
  const identityIssue = typeof entry.identityIssue === "string" ? entry.identityIssue : "";
  if (!externalMatch && !identityIssue.startsWith("no-external-match:")) {
    problems.push(`${label}: admitted requires an externalMatches value equal to the address or an identityIssue starting "no-external-match:"`);
  }
  if (entry.identity?.onChain?.decimals !== entry.decimals) problems.push(`${label}: identity.onChain.decimals must equal the entry decimals`);
  if (!Array.isArray(entry.unpairedPaths) || entry.unpairedPaths.length > 0) {
    problems.push(`${label}: admitted requires unpairedPaths to be empty`);
  }
  // The shares law audits the stored totalShares view, so totalSupply() being computed is expected.
  if (entry.totalSupplyView?.isStoredSum !== true && entry.invariant !== "usdo-bonus-multiplier-shares") {
    problems.push(`${label}: admitted requires totalSupplyView.isStoredSum to be true`);
  }
  // The zero-address Transfer pairing rule only governs laws that sum Transfer events.
  if (entry.eventSet !== "config-events" && entry.zeroRecipientTransferReverts === false && entry.zeroRecipientTransferBurns !== true) {
    problems.push(`${label}: admitted requires zeroRecipientTransferReverts !== false or zeroRecipientTransferBurns true`);
  }
  problems.push(...validateReviewedConservationLaw(entry, label));
  if (!Array.isArray(entry.windows) || !entry.windows.some(isPassingReviewedConservationWindow)) {
    problems.push(`${label}: admitted requires at least one window with residualRaw "0", mintRaw - burnRaw === supplyDeltaRaw and distinct boundary hashes`);
  }
  return problems;
}

const CONSERVATION_AMOUNT_ENCODINGS: Readonly<Record<string, true>> = {
  "transfer-value": true,
  "first-data-uint256": true,
  "nth-data-uint256": true,
  "data-minus-data-uint256": true,
};
const CONSERVATION_INVARIANTS: Readonly<Record<string, true>> = {
  "transfer-supply": true,
  "transfer-plus-vault-yield": true,
  "usdo-bonus-multiplier-shares": true,
};

/**
 * Structural rules for the runtime law fields of one sidecar entry (eventSet, invariant,
 * conservationOnlyEvents, requiresNotDeprecated, invariantParams).
 */
function validateReviewedConservationLaw(entry: MintBurnConservationRuntimeEntry, label: string): string[] {
  const problems: string[] = [];
  if (entry.eventSet != null && entry.eventSet !== "transfer" && entry.eventSet !== "config-events") {
    problems.push(`${label}: eventSet must be "transfer" or "config-events"`);
  }
  if (entry.invariant != null && CONSERVATION_INVARIANTS[entry.invariant] !== true) {
    problems.push(`${label}: invariant must be "transfer-supply", "transfer-plus-vault-yield" or "usdo-bonus-multiplier-shares"`);
  }
  if (entry.requiresNotDeprecated != null && typeof entry.requiresNotDeprecated !== "boolean") {
    problems.push(`${label}: requiresNotDeprecated must be a boolean`);
  }
  if ((entry.invariant === "transfer-plus-vault-yield" || entry.invariant === "usdo-bonus-multiplier-shares") &&
    entry.eventSet != null && entry.eventSet !== "transfer") {
    problems.push(`${label}: invariant ${entry.invariant} requires eventSet "transfer"`);
  }
  if (entry.invariant === "transfer-plus-vault-yield" &&
    !(entry.conservationOnlyEvents ?? []).some((def) => (def.role ?? "sum") === "sum" && def.emitter)) {
    problems.push(`${label}: invariant transfer-plus-vault-yield requires a summed conservationOnlyEvents def with an emitter address`);
  }
  if (entry.invariant === "usdo-bonus-multiplier-shares" &&
    !(entry.conservationOnlyEvents ?? []).some((def) => def.signature === BONUS_MULTIPLIER_SIGNATURE && def.role === "guard")) {
    problems.push(`${label}: invariant usdo-bonus-multiplier-shares requires a guard def ${BONUS_MULTIPLIER_SIGNATURE}`);
  }
  const defs = entry.conservationOnlyEvents ?? [];
  if (!Array.isArray(defs)) {
    problems.push(`${label}: conservationOnlyEvents must be an array`);
  } else {
    const seenEmitterTopics = new Set<string>();
    for (const def of defs) {
      const defLabel = `${label}: conservationOnlyEvents ${typeof def?.signature === "string" ? def.signature : "<unnamed>"}`;
      if (typeof def !== "object" || def === null) {
        problems.push(`${defLabel}: must be an object`);
        continue;
      }
      if (typeof def.signature !== "string" || def.signature.length === 0) problems.push(`${defLabel}: signature must be a non-empty string`);
      if (!WORD.test(def.topicHash ?? "")) problems.push(`${defLabel}: topicHash must be a lowercase 0x-hex topic`);
      if (def.emitter != null && !/^0x[0-9a-f]{40}$/.test(def.emitter)) problems.push(`${defLabel}: emitter must be a lowercase 0x-hex address`);
      const role = def.role ?? "sum";
      if (role !== "sum" && role !== "guard") problems.push(`${defLabel}: role must be "sum" or "guard"`);
      if (role === "sum") {
        if (def.direction !== "mint" && def.direction !== "burn") problems.push(`${defLabel}: sum defs require direction "mint" or "burn"`);
        if (typeof def.amountEncoding !== "string" || CONSERVATION_AMOUNT_ENCODINGS[def.amountEncoding] !== true) {
          problems.push(`${defLabel}: sum defs require an amountEncoding "transfer-value", "first-data-uint256", "nth-data-uint256" or "data-minus-data-uint256"`);
        }
        if (def.amountEncoding === "nth-data-uint256" && !Number.isSafeInteger(def.dataSlot)) {
          problems.push(`${defLabel}: nth-data-uint256 requires a non-negative integer dataSlot`);
        }
        if (def.amountEncoding === "data-minus-data-uint256" &&
          (!Number.isSafeInteger(def.dataSlot) || !Number.isSafeInteger(def.secondDataSlot))) {
          problems.push(`${defLabel}: data-minus-data-uint256 requires non-negative integer dataSlot and secondDataSlot`);
        }
      }
      const arity = def.topicArity ?? 3;
      if (!Number.isSafeInteger(arity) || arity < 1 || arity > 4) problems.push(`${defLabel}: topicArity must be an integer between 1 and 4`);
      if (def.filterTopic != null && (!Number.isSafeInteger(def.filterTopic.index) || def.filterTopic.index < 1 ||
        def.filterTopic.index >= arity || !WORD.test(def.filterTopic.value))) {
        problems.push(`${defLabel}: filterTopic must reference an indexed topic slot with a 0x-hex word value`);
      }
      const emitterTopic = `${(def.emitter ?? entry.address).toLowerCase()}\u0000${(def.topicHash ?? "").toLowerCase()}`;
      if (WORD.test(def.topicHash ?? "") && seenEmitterTopics.has(emitterTopic)) {
        problems.push(`${defLabel}: duplicates a previous emitter+topicHash pair`);
      }
      seenEmitterTopics.add(emitterTopic);
    }
  }
  const params = entry.invariantParams;
  if (params != null && typeof params !== "object") {
    problems.push(`${label}: invariantParams must be an object`);
  } else if (params != null) {
    if (params.supplySelector != null && !SELECTOR.test(params.supplySelector)) {
      problems.push(`${label}: invariantParams.supplySelector must be a 0x-hex 4-byte selector`);
    }
    const views = params.boundaryViews;
    if (views != null && !Array.isArray(views)) {
      problems.push(`${label}: invariantParams.boundaryViews must be an array`);
    } else if (Array.isArray(views)) {
      const names = new Set<string>();
      for (const view of views) {
        const viewLabel = `${label}: invariantParams.boundaryViews ${typeof view?.name === "string" ? view.name : "<unnamed>"}`;
        if (typeof view !== "object" || view === null || typeof view.name !== "string" || view.name.length === 0) {
          problems.push(`${viewLabel}: must be an object with a non-empty name`);
          continue;
        }
        if (names.has(view.name)) problems.push(`${viewLabel}: duplicate view name`);
        names.add(view.name);
        if (!/^0x[0-9a-f]{40}$/.test(view.address ?? "")) problems.push(`${viewLabel}: address must be a lowercase 0x-hex address`);
        const call = view.call;
        if (call?.kind === "eth_call") {
          if (!SELECTOR.test(call.selector ?? "")) problems.push(`${viewLabel}: eth_call selector must be 0x-hex 4 bytes`);
        } else if (call?.kind === "eth_getStorageAt") {
          if (!WORD.test(call.slot ?? "")) problems.push(`${viewLabel}: eth_getStorageAt slot must be a 0x-hex word`);
        } else {
          problems.push(`${viewLabel}: call must be an eth_call selector or an eth_getStorageAt slot`);
        }
        if (view.expect != null && !/^0x[0-9a-f]{1,64}$/.test(view.expect)) {
          problems.push(`${viewLabel}: expect must be a 0x-hex value`);
        }
      }
    }
  }
  return problems;
}

export function mintBurnConservationCacheKey(config: MintBurnContractConfig): string {
  return `mint-burn:conservation:${mintBurnConfigKey(config)}`;
}

export function mintBurnConservationFingerprint(config: MintBurnContractConfig): string {
  const base = [1, config.stablecoinId, config.chain.chainId, config.contractAddress.toLowerCase(),
    config.decimals, config.adapterKind, config.startBlock, config.dustThreshold,
    config.events.map((event) => {
      const tuple = [event.signature, event.topicHash.toLowerCase(), event.direction,
        event.amountEncoding, event.dataSlot ?? null, event.filterTopic?.index ?? null,
        event.filterTopic?.value.toLowerCase() ?? null, event.counterpartyEncoding ?? null];
      // topicArity joins only when declared so plain Transfer configs keep the exact prior bytes.
      return event.topicArity != null ? [...tuple, event.topicArity] : tuple;
    })];
  // Reviewer-law parameters join the fingerprint only when present, so the plain Transfer law's
  // fingerprint stays byte-identical for existing entries and cached proof is not invalidated.
  const entry = REVIEWED_CONSERVATION_INDEX.get(
    reviewedConservationIdentityKey(config.chain.chainId, config.stablecoinId, config.contractAddress, config.decimals));
  const law: unknown[] = [];
  if (entry?.eventSet != null && entry.eventSet !== "transfer") law.push(["eventSet", entry.eventSet]);
  if (entry?.invariant != null && entry.invariant !== "transfer-supply") law.push(["invariant", entry.invariant]);
  if (entry?.requiresNotDeprecated === true) law.push(["requiresNotDeprecated", true]);
  if (entry?.conservationOnlyEvents?.length) law.push(["conservationOnlyEvents", entry.conservationOnlyEvents.map((def) => [
    def.signature, def.topicHash.toLowerCase(), def.role ?? "sum", def.direction ?? null, def.amountEncoding ?? null,
    def.dataSlot ?? null, def.secondDataSlot ?? null, def.topicArity ?? null,
    def.filterTopic?.index ?? null, def.filterTopic?.value.toLowerCase() ?? null,
    def.emitter?.toLowerCase() ?? null])]);
  if (entry?.invariantParams != null) law.push(["invariantParams", entry.invariantParams]);
  return JSON.stringify(law.length === 0 ? base : [...base, law]);
}

export async function readMintBurnConservationRecords(db: D1Database, configs: MintBurnContractConfig[]): Promise<Map<string, unknown>> {
  const values = new Map<string, unknown>();
  const keys = [...new Set(configs.map(mintBurnConservationCacheKey))];
  for (let offset = 0; offset < keys.length; offset += D1_SAFE_IN_CLAUSE_BIND_LIMIT) {
    const rows = await getCaches(db, keys.slice(offset, offset + D1_SAFE_IN_CLAUSE_BIND_LIMIT));
    for (const [key, row] of rows) {
      try { values.set(key, JSON.parse(row.value)); } catch { /* Invalid records remain unverified. */ }
    }
  }
  return values;
}

type ConfigLogs = Array<{ eventDef: MintBurnEventDef; logs: AlchemyLogEntry[] }>;
export type ConservationLogBatch = { eventDef: ConservationEventDef; logs: AlchemyLogEntry[] };

export interface ConservationRawEvent {
  log: AlchemyLogEntry;
  eventDef: ConservationEventDef;
  direction: "mint" | "burn";
  raw: bigint;
}

export interface ConservationGuardEvent {
  eventDef: ConservationEventDef;
  log: AlchemyLogEntry;
}

function quantity(value: unknown): number {
  if (typeof value !== "string" || !QUANTITY.test(value)) throw new Error("invalid-rpc-quantity");
  const parsed = Number(BigInt(value));
  if (!Number.isSafeInteger(parsed)) throw new Error("unsafe-rpc-quantity");
  return parsed;
}

/**
 * Decodes one summed def's amount. Data must be whole 32-byte words — exactly as many as the
 * encoding addresses, so trailing or partial words stay invalid. "data-minus-data-uint256"
 * subtracts the second word from the first and requires the difference to be strictly positive
 * (the reviewed vault law: YieldDistribution._yield > _fee).
 */
function conservationAmount(eventDef: ConservationEventDef, log: AlchemyLogEntry): bigint {
  const encoding = eventDef.amountEncoding ?? "transfer-value";
  const words = encoding === "nth-data-uint256" ? (eventDef.dataSlot ?? 0) + 1
    : encoding === "data-minus-data-uint256" ? Math.max(eventDef.dataSlot ?? 0, eventDef.secondDataSlot ?? 0) + 1 : 1;
  const data = log.data.slice(2);
  if (data.length !== words * 64 || !/^[0-9a-fA-F]*$/.test(data)) throw new Error("invalid-raw-log");
  if (encoding === "data-minus-data-uint256") {
    const gross = readDataWord(log.data, eventDef.dataSlot ?? 0);
    const fee = readDataWord(log.data, eventDef.secondDataSlot ?? 0);
    if (gross === null || fee === null || BigInt(gross) <= BigInt(fee)) throw new Error("invalid-raw-log");
    return BigInt(gross) - BigInt(fee);
  }
  const word = readDataWord(log.data, encoding === "nth-data-uint256" ? eventDef.dataSlot ?? 0 : 0);
  if (word === null) throw new Error("invalid-raw-log");
  return BigInt(word);
}

/**
 * Validates and collects the raw conservation events of every batch (config event defs plus
 * sidecar conservation-only defs). Summed defs yield signed amount events; guard defs
 * (role "guard") yield their validated logs for the invariant's guards without contributing to
 * the totals. Zero amounts are skipped: they contribute nothing and some reviewed paths emit
 * them legitimately (DestroyedBlackFunds with a zero balance).
 */
export function collectConservationRawEvents(config: MintBurnContractConfig,
  batches: readonly ConservationLogBatch[], fromBlock: number, toBlock: number) {
  const seen = new Map<string, string>();
  const blockHashes = new Map<number, string>();
  const events: ConservationRawEvent[] = [];
  const guardEvents: ConservationGuardEvent[] = [];
  for (const { eventDef, logs } of batches) {
    const arity = eventDef.topicArity ?? 3;
    const topic0 = eventDef.topicHash.toLowerCase();
    const emitter = (eventDef.emitter ?? config.contractAddress).toLowerCase();
    // Address-topic validation and the ambiguity check only apply to Transfer-shaped defs.
    const transferShaped = arity === 3 && topic0 === TRANSFER;
    const guard = eventDef.role === "guard";
    for (const log of logs) {
      const block = quantity(log.blockNumber);
      quantity(log.transactionIndex);
      const index = quantity(log.logIndex);
      const data = log.data.slice(2);
      if (log.removed !== false || log.address.toLowerCase() !== emitter ||
        block <= fromBlock || block > toBlock || !WORD.test(log.blockHash) || log.blockHash === ZERO ||
        !WORD.test(log.transactionHash) || log.transactionHash === ZERO ||
        data.length % 64 !== 0 || !/^[0-9a-fA-F]*$/.test(data) ||
        log.topics.length !== arity || log.topics[0].toLowerCase() !== topic0) throw new Error("invalid-raw-log");
      if (eventDef.filterTopic != null && (eventDef.filterTopic.index < 1 || eventDef.filterTopic.index >= arity ||
        log.topics[eventDef.filterTopic.index]?.toLowerCase() !== eventDef.filterTopic.value.toLowerCase())) throw new Error("invalid-raw-log");
      if (transferShaped && (!ADDRESS_WORD.test(log.topics[1]!) || !ADDRESS_WORD.test(log.topics[2]!))) throw new Error("invalid-raw-log");
      const hash = log.blockHash.toLowerCase();
      if (blockHashes.has(block) && blockHashes.get(block) !== hash) throw new Error("inconsistent-log-block-hash");
      blockHashes.set(block, hash);
      const key = `${log.transactionHash.toLowerCase()}:${index}`;
      const identity = JSON.stringify([block, hash, quantity(log.transactionIndex), log.topics.map((topic) => topic.toLowerCase()), log.data.toLowerCase()]);
      if (seen.has(key)) {
        if (seen.get(key) !== identity) throw new Error("conflicting-duplicate-log");
        continue;
      }
      seen.set(key, identity);
      if (guard) {
        guardEvents.push({ eventDef, log });
        continue;
      }
      const raw = conservationAmount(eventDef, log);
      if (raw === 0n) continue;
      // A positive zero-to-zero transfer is ambiguous to the persisted row identity.
      if (transferShaped && log.topics[1]!.toLowerCase() === ZERO && log.topics[2]!.toLowerCase() === ZERO) throw new Error("ambiguous-zero-transfer");
      events.push({ log, eventDef, direction: eventDef.direction!, raw });
    }
  }
  return { events, blockHashes, guardEvents };
}

export function validateMintBurnParsedConservation(config: MintBurnContractConfig, batches: ConfigLogs,
  fromBlock: number, toBlock: number, rows: MintBurnRow[]): void {
  const expected = collectConservationRawEvents(config, batches, fromBlock - 1, toBlock).events
    .filter(({ raw }) => decimalNumberFromBigInt(raw, config.decimals) >= config.dustThreshold);
  if (rows.length !== expected.length) throw new Error("parsed-event-count-mismatch");
  const actual = new Map(rows.map((row) => [row.id, row]));
  if (actual.size !== rows.length) throw new Error("duplicate-parsed-event");
  for (const { log, direction, raw } of expected) {
    const row = actual.get(`${config.chain.chainId}-${log.transactionHash}-${quantity(log.logIndex)}`);
    if (!row || row.direction !== direction || row.amount !== decimalNumberFromBigInt(raw, config.decimals)) {
      throw new Error("parsed-event-amount-or-identity-mismatch");
    }
  }
}

export const MINT_BURN_CONSERVATION_RPC_BATCH_MAX = 100;
export const MINT_BURN_CONSERVATION_CHUNK_TIMEOUT_MS = 15_000;
export const MINT_BURN_CONSERVATION_PREPASS_MAX_MS = 45_000;

export interface ConservationBoundaryRequest {
  key: string;
  config: MintBurnContractConfig;
  fromBlock: number;
  toBlock: number;
}

export interface ConservationBoundaryViewValues {
  from: Readonly<Record<string, string>>;
  to: Readonly<Record<string, string>>;
}

export type ConservationBoundaryEvidence =
  | { status: "ready"; fromBlockHash: string; toBlockHash: string; fromTimestamp: number; toTimestamp: number;
      fromSupplyRaw: string; toSupplyRaw: string;
      /** Present when the entry sets requiresNotDeprecated: TetherToken.deprecated() at both boundaries. */
      deprecated?: { from: boolean; to: boolean };
      /** Present when the entry's invariantParams declare boundaryViews: pinned values at both boundaries. */
      views?: ConservationBoundaryViewValues }
  | { status: "unavailable"; reason: string };

const AUDIT_REASONS: Readonly<Record<string, true>> = {
  "invalid-rpc-quantity": true, "unsafe-rpc-quantity": true, "invalid-raw-log": true, "inconsistent-log-block-hash": true,
  "conflicting-duplicate-log": true, "ambiguous-zero-transfer": true, "audit-budget-or-deadline": true, "audit-rpc-unavailable": true,
  "incomplete-log-range": true, "invalid-audit-range": true, "invalid-boundary-header": true, "invalid-boundary-time": true,
  "closing-log-hash-mismatch": true, "invalid-total-supply-word": true, "boundary-reorg": true, "boundary-evidence-missing": true,
  "invalid-invariant-view": true, "invariant-view-missing": true,
};

function auditReason(error: unknown): string {
  return error instanceof Error && AUDIT_REASONS[error.message] === true ? error.message : "audit-unavailable";
}

function validAuditRange(fromBlock: number, toBlock: number): boolean {
  return Number.isSafeInteger(fromBlock) && fromBlock >= 1 && Number.isSafeInteger(toBlock) && toBlock >= fromBlock;
}

export async function fetchConservationBoundaries(input: {
  requests: ConservationBoundaryRequest[];
  rpcUrlByChain: ReadonlyMap<string, string>;
  budget: SubrequestBudget;
  checkedAt: number;
  signal?: AbortSignal;
  deadlineMs?: number;
  maxBatchCalls?: number;
  /** Overrides the committed-sidecar law lookup; production callers omit it. */
  lawFor?: MintBurnConservationLawResolver;
}): Promise<Map<string, ConservationBoundaryEvidence>> {
  const { budget, signal, deadlineMs } = input;
  const lawFor = input.lawFor ?? getMintBurnConservationRuntimeEntry;
  const maxBatchCalls = input.maxBatchCalls ?? MINT_BURN_CONSERVATION_RPC_BATCH_MAX;
  if (!Number.isSafeInteger(maxBatchCalls) || maxBatchCalls < 1) throw new Error("invalid-conservation-batch-size");
  throwIfAborted(signal);
  const evidence = new Map<string, ConservationBoundaryEvidence>();
  const groups = new Map<string, ConservationBoundaryRequest[]>();
  for (const request of input.requests) {
    if (!resolveMintBurnConservationEligibility(lawFor(request.config), request.config).supported) continue;
    if (!validAuditRange(request.fromBlock, request.toBlock)) {
      evidence.set(request.key, { status: "unavailable", reason: "invalid-audit-range" });
      continue;
    }
    const chainId = request.config.chain.chainId;
    const group = groups.get(chainId);
    if (group) group.push(request);
    else groups.set(chainId, [request]);
  }

  type BoundaryCall = { call: EvmRpcBatchCall; keys: string[]; accept: (value: unknown) => void };
  const fail = (keys: string[], reason: string) => {
    for (const key of keys) {
      if (!evidence.has(key)) evidence.set(key, { status: "unavailable", reason });
    }
  };
  async function phase(rpcUrl: string, calls: BoundaryCall[]): Promise<void> {
    const pending = calls.filter(({ keys }) => keys.some((key) => !evidence.has(key)));
    for (let offset = 0; offset < pending.length; offset += maxBatchCalls) {
      throwIfAborted(signal);
      const chunk = pending.slice(offset, offset + maxBatchCalls)
        .filter(({ keys }) => keys.some((key) => !evidence.has(key)));
      if (chunk.length === 0) continue;
      const now = Date.now();
      if (budget.count >= budget.limit || (deadlineMs != null && now >= deadlineMs)) {
        for (const { keys } of chunk) fail(keys, "audit-budget-or-deadline");
        continue;
      }
      budget.count++;
      let result;
      try {
        result = await fetchEvmRpcBatchDetailed(undefined, chunk.map(({ call }) => call), {
          extraRpcUrls: [rpcUrl], signal, maxRetries: 0,
          timeoutMs: Math.max(1, Math.min(MINT_BURN_CONSERVATION_CHUNK_TIMEOUT_MS, (deadlineMs ?? Infinity) - now)),
        });
      } catch {
        throwIfAborted(signal);
        result = null;
      }
      throwIfAborted(signal);
      const errors = new Set(result?.errors.map(({ index }) => index));
      for (let index = 0; index < chunk.length; index++) {
        const { keys, accept } = chunk[index];
        if (!result || errors.has(index)) {
          fail(keys, "audit-rpc-unavailable");
          continue;
        }
        try { accept(result.results[index]); } catch (error) { fail(keys, auditReason(error)); }
      }
    }
  }

  for (const [chainId, requests] of groups) {
    throwIfAborted(signal);
    const rpcUrl = input.rpcUrlByChain.get(chainId);
    if (!rpcUrl) {
      fail(requests.map(({ key }) => key), "audit-rpc-unavailable");
      continue;
    }
    const dependents = new Map<number, string[]>();
    for (const request of requests) {
      for (const block of [request.fromBlock - 1, request.toBlock]) {
        const keys = dependents.get(block);
        if (keys) keys.push(request.key);
        else dependents.set(block, [request.key]);
      }
    }
    const headers = new Map<number, { hash: string; timestamp: number }>();
    const headerCalls = [...dependents].map(([block, keys]) => ({
      block,
      call: { method: "eth_getBlockByNumber", params: [`0x${block.toString(16)}`, false] },
      keys,
      accept(value: unknown) {
        const header = value as { number?: unknown; hash?: unknown; timestamp?: unknown } | null;
        if (!header || quantity(header.number) !== block || typeof header.hash !== "string" ||
          !WORD.test(header.hash) || header.hash === ZERO) throw new Error("invalid-boundary-header");
        headers.set(block, { hash: header.hash.toLowerCase(), timestamp: quantity(header.timestamp) });
      },
    }));
    await phase(rpcUrl, headerCalls);
    const supplies = new Map<string, string[]>();
    const deprecatedByRequest = new Map<string, boolean[]>();
    const viewsByRequest = new Map<string, { from: Record<string, string>; to: Record<string, string> }>();
    const supplyCalls: BoundaryCall[] = [];
    for (const request of requests) {
      if (evidence.has(request.key)) continue;
      const from = headers.get(request.fromBlock - 1)!;
      const to = headers.get(request.toBlock)!;
      if (from.hash === to.hash || from.timestamp <= 0 || from.timestamp > to.timestamp || to.timestamp > input.checkedAt) {
        fail([request.key], "invalid-boundary-time");
        continue;
      }
      const entry = lawFor(request.config);
      const selector = entry?.invariantParams?.supplySelector ?? TOTAL_SUPPLY_SELECTOR;
      if (!SELECTOR.test(selector)) {
        fail([request.key], "invalid-invariant-view");
        continue;
      }
      const values: string[] = [];
      supplies.set(request.key, values);
      for (const [index, header] of [from, to].entries()) {
        supplyCalls.push({
          call: { method: "eth_call", params: [
            { to: request.config.contractAddress, data: selector },
            { blockHash: header.hash, requireCanonical: true },
          ] },
          keys: [request.key],
          accept(value) {
            if (typeof value !== "string" || !WORD.test(value)) throw new Error("invalid-total-supply-word");
            values[index] = BigInt(value).toString();
          },
        });
      }
      if (entry?.requiresNotDeprecated === true) {
        const flags: boolean[] = [];
        deprecatedByRequest.set(request.key, flags);
        for (const [index, header] of [from, to].entries()) {
          supplyCalls.push({
            call: { method: "eth_call", params: [
              { to: request.config.contractAddress, data: DEPRECATED_SELECTOR },
              { blockHash: header.hash, requireCanonical: true },
            ] },
            keys: [request.key],
            accept(value) {
              if (typeof value !== "string" || !WORD.test(value)) throw new Error("invalid-invariant-view");
              flags[index] = BigInt(value) !== 0n;
            },
          });
        }
      }
      const boundaryViews = entry?.invariantParams?.boundaryViews ?? [];
      if (boundaryViews.length > 0) {
        const names = new Set<string>();
        let malformed = false;
        for (const view of boundaryViews) {
          if (typeof view?.name !== "string" || names.has(view.name) || !/^0x[0-9a-f]{40}$/.test(view.address ?? "") ||
            (view.call?.kind === "eth_call" ? !SELECTOR.test(view.call.selector ?? "")
              : view.call?.kind === "eth_getStorageAt" ? !WORD.test(view.call.slot ?? "") : true)) {
            malformed = true;
            break;
          }
          names.add(view.name);
        }
        if (malformed) {
          fail([request.key], "invalid-invariant-view");
          continue;
        }
        const store = { from: {} as Record<string, string>, to: {} as Record<string, string> };
        viewsByRequest.set(request.key, store);
        for (const view of boundaryViews) {
          for (const [index, header] of [from, to].entries()) {
            supplyCalls.push({
              call: view.call.kind === "eth_call"
                ? { method: "eth_call", params: [{ to: view.address, data: view.call.selector }, { blockHash: header.hash, requireCanonical: true }] }
                : { method: "eth_getStorageAt", params: [view.address, view.call.slot, { blockHash: header.hash, requireCanonical: true }] },
              keys: [request.key],
              accept(value) {
                if (typeof value !== "string" || !WORD.test(value)) throw new Error("invalid-invariant-view");
                (index === 0 ? store.from : store.to)[view.name] = value.toLowerCase();
              },
            });
          }
        }
      }
    }
    await phase(rpcUrl, supplyCalls);
    await phase(rpcUrl, headerCalls.map(({ block, call, keys }) => ({
      call, keys,
      accept(value) {
        const original = headers.get(block)!;
        const header = value as { hash?: string; number?: unknown; timestamp?: unknown } | null;
        try {
          if (!header || header.hash?.toLowerCase() !== original.hash || quantity(header.number) !== block ||
            quantity(header.timestamp) !== original.timestamp) throw new Error("boundary-reorg");
        } catch { throw new Error("boundary-reorg"); }
      },
    })));
    for (const request of requests) {
      if (evidence.has(request.key)) continue;
      const from = headers.get(request.fromBlock - 1)!;
      const to = headers.get(request.toBlock)!;
      const values = supplies.get(request.key)!;
      const deprecated = deprecatedByRequest.get(request.key);
      const views = viewsByRequest.get(request.key);
      evidence.set(request.key, { status: "ready", fromBlockHash: from.hash, toBlockHash: to.hash,
        fromTimestamp: from.timestamp, toTimestamp: to.timestamp, fromSupplyRaw: values[0], toSupplyRaw: values[1],
        ...(deprecated ? { deprecated: { from: deprecated[0] === true, to: deprecated[1] === true } } : {}),
        ...(views ? { views } : {}) });
    }
  }
  return evidence;
}

export function completeMintBurnConservationAudit(input: {
  config: MintBurnContractConfig; logs: ConfigLogs; conservationLogs?: readonly ConservationLogBatch[];
  fromBlock: number; toBlock: number; checkedAt: number;
  complete: boolean; boundary: ConservationBoundaryEvidence | undefined;
  /** Overrides the committed-sidecar law lookup; production callers omit it. */
  lawFor?: MintBurnConservationLawResolver;
}): MintBurnConservationRecord {
  const { config, fromBlock, toBlock, checkedAt, boundary } = input;
  const entry = (input.lawFor ?? getMintBurnConservationRuntimeEntry)(config);
  const eligibility = resolveMintBurnConservationEligibility(entry, config);
  const record: MintBurnConservationRecord = {
    version: 1, key: mintBurnConservationCacheKey(config), configFingerprint: mintBurnConservationFingerprint(config),
    stablecoinId: config.stablecoinId, chainId: config.chain.chainId, address: config.contractAddress.toLowerCase(),
    decimals: config.decimals, checkedAt, status: eligibility.supported ? "unavailable" : "unsupported",
    fromBlock: fromBlock - 1, toBlock,
  };
  if (!eligibility.supported) return { ...record, reason: eligibility.reason };
  try {
    if (!input.complete) throw new Error("incomplete-log-range");
    if (!validAuditRange(fromBlock, toBlock)) throw new Error("invalid-audit-range");
    if (!boundary) throw new Error("boundary-evidence-missing");
    if (boundary.status === "unavailable") return { ...record, reason: boundary.reason };
    if (entry?.requiresNotDeprecated === true) {
      // TetherToken forwards totalSupply() to upgradedAddress once deprecated; conservation
      // against this address's own logs would be vacuous.
      if (!boundary.deprecated) throw new Error("invariant-view-missing");
      if (boundary.deprecated.from || boundary.deprecated.to) {
        return { ...record, status: "unsupported", reason: "deprecated-upgrade-forwarding" };
      }
    }
    const boundaryViews = entry?.invariantParams?.boundaryViews ?? [];
    if (boundaryViews.some(({ expect }) => expect != null)) {
      if (!boundary.views) throw new Error("invariant-view-missing");
      for (const view of boundaryViews) {
        if (view.expect == null) continue;
        const from = boundary.views.from[view.name];
        const to = boundary.views.to[view.name];
        if (from == null || to == null || !WORD.test(from) || !WORD.test(to) || !/^0x[0-9a-f]{1,64}$/.test(view.expect)) {
          throw new Error("invariant-view-missing");
        }
        if (BigInt(from) !== BigInt(view.expect) || BigInt(to) !== BigInt(view.expect)) {
          // Pinned token↔vault / implementation identity no longer holds at a boundary.
          return { ...record, reason: "invariant-view-mismatch" };
        }
      }
    }
    const batches: ConservationLogBatch[] = [...input.logs, ...(input.conservationLogs ?? [])];
    const raw = collectConservationRawEvents(config, batches, fromBlock - 1, toBlock);
    if (raw.blockHashes.has(toBlock) && raw.blockHashes.get(toBlock) !== boundary.toBlockHash) throw new Error("closing-log-hash-mismatch");
    if (raw.guardEvents.some(({ eventDef }) => eventDef.signature === UPGRADED_SIGNATURE)) {
      return { ...record, reason: "proxy-upgraded-in-range" };
    }
    const invariant = entry?.invariant ?? "transfer-supply";
    if (invariant === "usdo-bonus-multiplier-shares") return completeUsdoSharesAudit(record, raw, boundary, boundaryViews);
    if (invariant === "transfer-plus-vault-yield") {
      const guardFailure = ousdVaultYieldGuardFailure(raw);
      if (guardFailure) return { ...record, reason: guardFailure };
    }
    let mint = 0n;
    let burn = 0n;
    for (const event of raw.events) { if (event.direction === "mint") mint += event.raw; else burn += event.raw; }
    const delta = BigInt(boundary.toSupplyRaw) - BigInt(boundary.fromSupplyRaw);
    const residual = mint - burn - delta;
    return { ...record, status: residual === 0n ? "ok" : "mismatch", fromBlockHash: boundary.fromBlockHash,
      toBlockHash: boundary.toBlockHash, fromTimestamp: boundary.fromTimestamp, toTimestamp: boundary.toTimestamp,
      mintRaw: mint.toString(), burnRaw: burn.toString(), supplyDeltaRaw: delta.toString(), residualRaw: residual.toString(),
      logCount: raw.events.length, ...(residual !== 0n ? { reason: "raw-transfer-supply-mismatch" } : {}) };
  } catch (error) {
    return { ...record, reason: auditReason(error) };
  }
}

/**
 * OUSD vault-yield guards: reject legacy low-resolution rebase events, rebase supply
 * saturation (TotalSupplyUpdatedHighres.newSupply == uint128.max) and any vault
 * YieldDistribution without a subsequent token rebase checkpoint in the same transaction.
 */
function ousdVaultYieldGuardFailure(raw: { events: readonly ConservationRawEvent[]; guardEvents: readonly ConservationGuardEvent[] }): string | null {
  for (const { eventDef } of raw.guardEvents) {
    if (eventDef.signature === TOTAL_SUPPLY_UPDATED_LEGACY_SIGNATURE) return "legacy-total-supply-updated-encountered";
  }
  const checkpoints = raw.guardEvents
    .filter(({ eventDef }) => eventDef.signature === TOTAL_SUPPLY_UPDATED_HIGHRES_SIGNATURE)
    .map(({ log }) => ({ transaction: log.transactionHash.toLowerCase(), index: quantity(log.logIndex), log }));
  for (const { log } of checkpoints) {
    const newSupply = readDataWord(log.data, 0);
    if (newSupply !== null && BigInt(newSupply) === UINT128_MAX) return "rebase-supply-saturation";
  }
  for (const event of raw.events) {
    if (event.eventDef.signature !== YIELD_DISTRIBUTION_SIGNATURE) continue;
    const index = quantity(event.log.logIndex);
    if (!checkpoints.some(({ transaction, index: checkpointIndex }) =>
      transaction === event.log.transactionHash.toLowerCase() && checkpointIndex > index)) {
      return "vault-yield-rebase-pairing-failed";
    }
  }
  return null;
}

/**
 * USDO shares law: seed the bonus multiplier from the pinned opening view, replace it with each
 * BonusMultiplier event in (blockNumber, logIndex) order, convert every zero-address Transfer
 * amount A to floor(A*1e18/M) at the multiplier effective at that event, and require
 * Σq_mint − Σq_burn == totalShares(to) − totalShares(from) exactly. Fails closed when the
 * replayed multiplier or the totalSupply == floor(S*M/1e18) identity does not hold at a
 * boundary. Record arithmetic fields are raw shares.
 */
function completeUsdoSharesAudit(record: MintBurnConservationRecord,
  raw: { events: readonly ConservationRawEvent[]; guardEvents: readonly ConservationGuardEvent[] },
  boundary: Extract<ConservationBoundaryEvidence, { status: "ready" }>,
  boundaryViews: readonly ConservationBoundaryView[]): MintBurnConservationRecord {
  const views = boundary.views;
  const multiplierView = boundaryViews.find(({ name }) => name === "bonusMultiplier");
  const supplyView = boundaryViews.find(({ name }) => name === "totalSupply");
  if (!views || !multiplierView || !supplyView) throw new Error("invariant-view-missing");
  const openingMultiplierHex = views.from[multiplierView.name];
  const closingMultiplierHex = views.to[multiplierView.name];
  const openingSupplyHex = views.from[supplyView.name];
  const closingSupplyHex = views.to[supplyView.name];
  if (!WORD.test(openingMultiplierHex ?? "") || !WORD.test(closingMultiplierHex ?? "") ||
    !WORD.test(openingSupplyHex ?? "") || !WORD.test(closingSupplyHex ?? "")) throw new Error("invariant-view-missing");
  const SCALE = 10n ** 18n;
  const openingMultiplier = BigInt(openingMultiplierHex);
  if (openingMultiplier <= 0n) throw new Error("invalid-invariant-view");
  let multiplier = openingMultiplier;
  const stream = [
    ...raw.events.map((event) => ({ multiplierEvent: false as const, block: quantity(event.log.blockNumber),
      index: quantity(event.log.logIndex), event })),
    ...raw.guardEvents
      .filter(({ eventDef }) => eventDef.signature === BONUS_MULTIPLIER_SIGNATURE)
      .map(({ log }) => ({ multiplierEvent: true as const, block: quantity(log.blockNumber),
        index: quantity(log.logIndex), log })),
  ].sort((a, b) => a.block - b.block || a.index - b.index);
  let mint = 0n;
  let burn = 0n;
  for (const item of stream) {
    if (item.multiplierEvent) {
      const value = item.log.topics[1];
      if (!WORD.test(value ?? "")) throw new Error("invalid-raw-log");
      multiplier = BigInt(value);
      if (multiplier <= 0n) throw new Error("invalid-invariant-view");
    } else {
      const shares = (item.event.raw * SCALE) / multiplier;
      if (item.event.direction === "mint") mint += shares;
      else burn += shares;
    }
  }
  if (multiplier !== BigInt(closingMultiplierHex)) return { ...record, reason: "multiplier-replay-mismatch" };
  const delta = BigInt(boundary.toSupplyRaw) - BigInt(boundary.fromSupplyRaw);
  if ((BigInt(boundary.fromSupplyRaw) * openingMultiplier) / SCALE !== BigInt(openingSupplyHex) ||
    (BigInt(boundary.toSupplyRaw) * multiplier) / SCALE !== BigInt(closingSupplyHex)) {
    return { ...record, reason: "totalSupply-view-mismatch" };
  }
  const residual = mint - burn - delta;
  return { ...record, status: residual === 0n ? "ok" : "mismatch", fromBlockHash: boundary.fromBlockHash,
    toBlockHash: boundary.toBlockHash, fromTimestamp: boundary.fromTimestamp, toTimestamp: boundary.toTimestamp,
    mintRaw: mint.toString(), burnRaw: burn.toString(), supplyDeltaRaw: delta.toString(), residualRaw: residual.toString(),
    logCount: raw.events.length, units: "raw-shares", ...(residual !== 0n ? { reason: "raw-transfer-supply-mismatch" } : {}) };
}

export async function verifyPersistedMintBurnConservation(db: D1Database, rows: MintBurnRow[],
  signal?: AbortSignal, deadlineMs?: number): Promise<"ok" | "deadline" | "mismatch"> {
  const fields = ["id", "stablecoin_id", "chain_id", "direction", "amount", "block_number", "timestamp"] as const;
  for (let offset = 0; offset < rows.length; offset += D1_SAFE_IN_CLAUSE_BIND_LIMIT) {
    throwIfAborted(signal);
    if (deadlineMs != null && Date.now() >= deadlineMs) return "deadline";
    const expected = rows.slice(offset, offset + D1_SAFE_IN_CLAUSE_BIND_LIMIT);
    const clause = buildInClause(expected.map((row) => row.id));
    const result = await db.prepare(`SELECT id, stablecoin_id, chain_id, direction, amount, block_number, timestamp
      FROM mint_burn_events WHERE id IN (${clause.sql})`).bind(...clause.binds).all<MintBurnRow>();
    throwIfAborted(signal);
    const actual = new Map((result.results ?? []).map((row) => [row.id, row]));
    if (actual.size !== expected.length || expected.some((row) => fields.some((field) => actual.get(row.id)?.[field] !== row[field]))) return "mismatch";
  }
  if (deadlineMs != null && Date.now() >= deadlineMs) return "deadline";
  return "ok";
}

export async function persistMintBurnConservation(db: D1Database, record: MintBurnConservationRecord, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  // Atomic monotonic write: an unavailable retry cannot erase an unresolved verified mismatch.
  await runWithOverloadRetry(() => db.prepare(`INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    WHERE cache.updated_at <= excluded.updated_at AND NOT COALESCE((
      json_extract(CASE WHEN json_valid(cache.value) THEN cache.value ELSE '{}' END, '$.status') = 'mismatch'
      AND json_extract(CASE WHEN json_valid(cache.value) THEN cache.value ELSE '{}' END, '$.configFingerprint') = json_extract(excluded.value, '$.configFingerprint')
      AND (json_extract(excluded.value, '$.status') IN ('unavailable', 'unsupported')
        OR (json_extract(excluded.value, '$.status') IN ('ok', 'mismatch') AND NOT (
          json_extract(excluded.value, '$.fromBlock') <= json_extract(CASE WHEN json_valid(cache.value) THEN cache.value ELSE '{}' END, '$.fromBlock')
          AND json_extract(excluded.value, '$.toBlock') >= json_extract(CASE WHEN json_valid(cache.value) THEN cache.value ELSE '{}' END, '$.toBlock'))))
    ), 0)`)
    .bind(record.key, JSON.stringify(record), record.checkedAt).run(), 3, signal);
  throwIfAborted(signal);
}
