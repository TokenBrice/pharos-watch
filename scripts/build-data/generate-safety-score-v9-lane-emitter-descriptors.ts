#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CHAIN_META } from "../../shared/types/chain-identity";
import { normalizeDeploymentId } from "../../shared/types/deployment-id";
import {
  V9_LANE_ADMIN_EVENT_FAMILY_VALUES,
  type V9LaneAdminEventFamily,
} from "../../shared/types/safety-score-v9-incidents";
import { isRecord } from "../../shared/lib/type-guards";
import { compareText } from "../../shared/lib/safety-score-v9/primitives";
import { syncGeneratedArtifacts } from "../lib/generated-artifacts";
import { parseStrictCliArgs } from "../lib/cli-args.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const OUTPUT_PATH = "shared/data/safety-score-v9/lane-emitter-descriptors-v1.generated.json";
const INVENTORY_PATH = "shared/data/safety-score-v9/lane-screening-emitter-inventory-v1.json";

/**
 * The only runtime-identity text admitted as a certificate expectation.
 *
 * IR-3a hashes DECODED EVM runtime bytes. Every other identity form authored in
 * the reviewed corpus either declares another domain (`sha256:rpc-hex-text`,
 * `sha256-rpc-code-text`, `eth_getCode-text`), uses another function
 * (`keccak256:`), names a different contract, or leaves the domain unstated
 * (`sha256:<hex>`). The unstated form is genuinely mixed: spot checks reproduce
 * some reviewed digests from the decoded bytes and others from the `0x` hex
 * TEXT, so admitting it would fail roughly half of the lanes as
 * `code-hash-mismatch`. The inventory therefore records exactly one admitted
 * form.
 */
export const LANE_EMITTER_DECODED_RUNTIME_IDENTITY_PATTERN = /^sha256-decoded-runtime-bytes:([0-9a-f]{64})$/;

/** OP-IR §5c: the per-chain floor for a lane screening window. */
export const LANE_EMITTER_MINIMUM_LOOKBACK_BLOCKS = 50_000;

export type LaneEmitterRecordKind = "bridge-control" | "mint-control";

/** Why a reviewed EVM bridge route has no screening descriptor. */
export type LaneNoReviewedEmitterReason =
  | "no-reviewed-inventory"
  | "invalid-inventory-lane"
  | "contributor-mismatch"
  | "contributor-without-emitter"
  | "emitter-pin-not-decoded"
  | "emitter-abi-basis-unverified"
  | "emitter-abi-events-empty"
  | "abi-not-covered"
  | "lookback-below-floor";

export type LaneEmitterAbiBasisKind = "verified-source" | "same-runtime-code" | "same-verified-type";

export const LANE_EMITTER_ABI_BASIS_KINDS: readonly LaneEmitterAbiBasisKind[] = [
  "verified-source",
  "same-runtime-code",
  "same-verified-type",
];

export interface LaneControlRecord {
  recordKind: LaneEmitterRecordKind;
  assetId: string;
  controlId: string;
  /** Bridge controls govern route deployments; mint controls have no route. */
  routeRefs: readonly string[];
  controllerChain: string | null;
  controllerAddress: string | null;
  runtimeIdentity: string | null;
}

export interface LaneEmitterInputs {
  records: readonly LaneControlRecord[];
  sidecars: { riskReview: number; mintAuthority: number };
  inventory: LaneScreeningEmitterInventory;
}

export interface LaneEmitterAbiBasis {
  kind: LaneEmitterAbiBasisKind;
  chain: string;
  address: `0x${string}`;
  runtimeIdentity: string;
  verifiedSourceUrl: string;
}

export interface LaneEmitterInventoryEntry {
  address: `0x${string}`;
  chain: string;
  role: "route-deployment" | "governed-contract";
  label: string;
  runtimeIdentity: string;
  observedBlock: number;
  observedAt: string;
  abiBasis: LaneEmitterAbiBasis;
  adminEvents: readonly string[];
  sources: readonly { label: string; url: string }[];
}

export interface LaneContributorMapping {
  controlId: string;
  emitterAddresses: readonly `0x${string}`[];
}

export interface LaneScreeningInventoryRecord {
  subjectDeploymentKey: string;
  assetIds: readonly string[];
  rail: string;
  contributors: readonly LaneContributorMapping[];
  emitters: readonly LaneEmitterInventoryEntry[];
}

export interface LaneScreeningEmitterInventory {
  schemaVersion: 1;
  reviewedAt: string;
  policy: Record<string, unknown>;
  lookbackBlocksByChain: Readonly<Record<string, number>>;
  lanes: readonly LaneScreeningInventoryRecord[];
}

/** Structurally usable as IR-3c's `LaneScreeningDescriptor`. */
export interface LaneEmitter {
  address: `0x${string}`;
  expectedRuntimeCodeSha256: string;
  families: readonly V9LaneAdminEventFamily[];
}

export interface LaneScreeningDescriptor {
  subjectDeploymentKey: string;
  emitters: readonly LaneEmitter[];
  lookbackBlocks: number;
  provenance: {
    assetIds: readonly string[];
    controlIds: readonly string[];
    rail: string;
    reviewedAt: string;
    contributors: readonly { controlId: string; emitterAddresses: readonly string[] }[];
    emitters: readonly {
      address: string;
      role: LaneEmitterInventoryEntry["role"];
      label: string;
      chain: string;
      observedBlock: number;
      observedAt: string;
      abiBasis: LaneEmitterAbiBasis;
    }[];
  };
}

export interface LaneNoReviewedEmitter {
  subjectDeploymentKey: string;
  reason: LaneNoReviewedEmitterReason;
  assetIds: readonly string[];
  controlIds: readonly string[];
  unpinnedControlIds?: readonly string[];
  uncoveredEvents?: readonly string[];
}

export interface LaneEmitterPilotLane {
  subjectDeploymentKey: string;
  assetIds: readonly string[];
  rail: string;
  lookbackBlocks: number | null;
  admission: { admitted: boolean; reason: LaneNoReviewedEmitterReason | null };
  contributors: readonly { controlId: string; emitterAddresses: readonly string[] }[];
  emitters: readonly {
    address: string;
    chain: string;
    role: LaneEmitterInventoryEntry["role"];
    label: string;
    observedBlock: number;
    observedAt: string;
    runtimeIdentity: string;
    abiBasis: LaneEmitterAbiBasis;
    adminEvents: readonly string[];
    screenedFamilies: readonly string[];
    unscreenedEvents: readonly string[];
  }[];
  uncoveredEvents: readonly string[];
}

export interface LaneEmitterDescriptorsArtifact {
  schemaVersion: 1;
  policy: {
    laneIdentity: "bridge-route-deployment";
    runtimeHashConvention: "sha256-decoded-runtime-bytes";
    runtimeIdentityAdmission: string;
    lookbackFloorBlocks: number;
    families: readonly V9LaneAdminEventFamily[];
    notes: readonly string[];
  };
  summary: {
    lanes: number;
    covered: number;
    noReviewedEmitter: number;
    noReviewedEmitterByReason: Readonly<Record<LaneNoReviewedEmitterReason, number>>;
    lanesNonEvm: number;
    controls: {
      bridge: { total: number; withoutController: number };
      mint: { total: number; withoutController: number };
      routeRefs: { total: number; nonEvm: number; malformed: number };
    };
    sidecars: { riskReview: number; mintAuthority: number };
    inventory: {
      reviewedAt: string;
      pilotLanes: number;
      pilotEmitters: number;
      admittedLanes: number;
      uncoveredEvents: readonly string[];
    };
  };
  descriptors: readonly LaneScreeningDescriptor[];
  noReviewedEmitter: readonly LaneNoReviewedEmitter[];
  pilot: readonly LaneEmitterPilotLane[];
}

const RECORD_SOURCES = [
  {
    recordKind: "bridge-control",
    directory: "shared/data/stablecoins/domains/risk-review",
    profileField: "bridgeRouteRisk",
    chainField: "controllerChain",
    addressField: "controllerAddress",
  },
  {
    recordKind: "mint-control",
    directory: "shared/data/stablecoins/domains/mint-authority",
    profileField: "mintAuthority",
    chainField: "chain",
    addressField: "address",
  },
] as const satisfies readonly {
  recordKind: LaneEmitterRecordKind;
  directory: string;
  profileField: string;
  chainField: string;
  addressField: string;
}[];

const REASON_PRIORITY: Readonly<Record<LaneNoReviewedEmitterReason, number>> = {
  "invalid-inventory-lane": 0,
  "contributor-mismatch": 1,
  "contributor-without-emitter": 2,
  "emitter-pin-not-decoded": 3,
  "emitter-abi-basis-unverified": 4,
  "emitter-abi-events-empty": 5,
  "lookback-below-floor": 6,
  "abi-not-covered": 7,
  "no-reviewed-inventory": 8,
};

const EVM_ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/u;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;

function sortedValues(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareText);
}

function stringField(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function parsedDecodedRuntimeIdentity(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = LANE_EMITTER_DECODED_RUNTIME_IDENTITY_PATTERN.exec(value.trim());
  return match?.[1] ?? null;
}

function readAbiBasis(value: unknown): LaneEmitterAbiBasis | null {
  if (!isRecord(value)) return null;
  const kind = stringField(value, "kind");
  if (kind === null || !(LANE_EMITTER_ABI_BASIS_KINDS as readonly string[]).includes(kind)) return null;
  const chain = stringField(value, "chain");
  const address = stringField(value, "address");
  const runtimeIdentity = stringField(value, "runtimeIdentity");
  const verifiedSourceUrl = stringField(value, "verifiedSourceUrl");
  if (chain === null || address === null || !EVM_ADDRESS_PATTERN.test(address.toLowerCase())) return null;
  if (runtimeIdentity === null || parsedDecodedRuntimeIdentity(runtimeIdentity) === null) return null;
  if (verifiedSourceUrl === null || !/^https:\/\//u.test(verifiedSourceUrl)) return null;
  return {
    kind: kind as LaneEmitterAbiBasisKind,
    chain: chain.toLowerCase(),
    address: address.toLowerCase() as `0x${string}`,
    runtimeIdentity,
    verifiedSourceUrl,
  };
}

function readInventoryEmitter(value: unknown): LaneEmitterInventoryEntry | null {
  if (!isRecord(value)) return null;
  const address = stringField(value, "address");
  const chain = stringField(value, "chain");
  const role = stringField(value, "role");
  const label = stringField(value, "label");
  const runtimeIdentity = stringField(value, "runtimeIdentity");
  const observedBlock = typeof value.observedBlock === "number" && Number.isSafeInteger(value.observedBlock) && value.observedBlock >= 0 ? value.observedBlock : null;
  const observedAt = stringField(value, "observedAt");
  const abiBasis = readAbiBasis(value.abiBasis);
  const adminEvents = Array.isArray(value.adminEvents)
    ? value.adminEvents.filter((event): event is string => typeof event === "string" && event.trim() !== "")
    : [];
  const sources = Array.isArray(value.sources)
    ? value.sources.flatMap((source) => {
      if (!isRecord(source)) return [];
      const sourceLabel = stringField(source, "label");
      const url = stringField(source, "url");
      return sourceLabel === null || url === null ? [] : [{ label: sourceLabel, url }];
    })
    : [];
  if (address === null || chain === null || role === null || label === null) return null;
  if (role !== "route-deployment" && role !== "governed-contract") return null;
  if (!EVM_ADDRESS_PATTERN.test(address.toLowerCase())) return null;
  if (runtimeIdentity === null || parsedDecodedRuntimeIdentity(runtimeIdentity) === null) return null;
  if (observedBlock === null || observedAt === null || !ISO_INSTANT_PATTERN.test(observedAt)) return null;
  if (abiBasis === null || sources.length === 0) return null;
  return {
    address: address.toLowerCase() as `0x${string}`,
    chain: chain.toLowerCase(),
    role,
    label,
    runtimeIdentity,
    observedBlock,
    observedAt,
    abiBasis,
    adminEvents,
    sources,
  };
}

/**
 * Read the reviewed pilot emitter inventory. The inventory is authored evidence
 * (OP-IR §5c), never derived at runtime: it names the lane's emitters, the pin
 * read for each one, the verified-ABI basis and the emitter's admin events, and
 * which contributor control each emitter serves.
 */
export function loadLaneScreeningEmitterInventory(root: string): LaneScreeningEmitterInventory {
  const raw = JSON.parse(readFileSync(resolve(root, INVENTORY_PATH), "utf8")) as unknown;
  if (!isRecord(raw) || raw.schemaVersion !== 1) throw new Error("Lane screening emitter inventory has an unsupported schemaVersion");
  const reviewedAt = stringField(raw, "reviewedAt");
  if (reviewedAt === null) throw new Error("Lane screening emitter inventory has no reviewedAt");
  const lookbackSource = isRecord(raw.lookbackBlocksByChain) ? raw.lookbackBlocksByChain : {};
  const lookbackBlocksByChain: Record<string, number> = {};
  for (const [chain, value] of Object.entries(lookbackSource)) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Lane screening inventory lookback for ${chain} is not a positive integer`);
    }
    lookbackBlocksByChain[chain.toLowerCase()] = value;
  }
  const lanes: LaneScreeningInventoryRecord[] = [];
  for (const entry of Array.isArray(raw.lanes) ? raw.lanes : []) {
    if (!isRecord(entry)) throw new Error("Lane screening inventory lane is not an object");
    const subject = stringField(entry, "subjectDeploymentKey");
    const rail = stringField(entry, "rail");
    if (subject === null || normalizeDeploymentId(subject) === "") {
      throw new Error("Lane screening inventory lane has no normalized subjectDeploymentKey");
    }
    if (rail === null) throw new Error(`Lane screening inventory lane ${subject} has no rail`);
    const assetIds = Array.isArray(entry.assetIds)
      ? entry.assetIds.filter((id): id is string => typeof id === "string" && id.trim() !== "")
      : [];
    if (assetIds.length === 0) throw new Error(`Lane screening inventory lane ${subject} has no assetIds`);
    const emitters = (Array.isArray(entry.emitters) ? entry.emitters : []).map((value) => {
      const emitter = readInventoryEmitter(value);
      if (emitter === null) throw new Error(`Lane screening inventory emitter in ${subject} is malformed`);
      return emitter;
    });
    if (emitters.length === 0) throw new Error(`Lane screening inventory lane ${subject} has no emitters`);
    const contributors: LaneContributorMapping[] = [];
    for (const value of Array.isArray(entry.contributors) ? entry.contributors : []) {
      if (!isRecord(value)) throw new Error(`Lane screening inventory contributor in ${subject} is not an object`);
      const controlId = stringField(value, "controlId");
      if (controlId === null) throw new Error(`Lane screening inventory contributor in ${subject} has no controlId`);
      const emitterAddresses = (Array.isArray(value.emitterAddresses) ? value.emitterAddresses : [])
        .filter((address): address is string => typeof address === "string")
        .map((address) => address.toLowerCase());
      if (emitterAddresses.length === 0 || emitterAddresses.some((address) => !EVM_ADDRESS_PATTERN.test(address))) {
        throw new Error(`Lane screening inventory contributor ${controlId} has no valid emitterAddresses`);
      }
      contributors.push({ controlId, emitterAddresses: emitterAddresses as `0x${string}`[] });
    }
    if (contributors.length === 0) throw new Error(`Lane screening inventory lane ${subject} has no contributors`);
    lanes.push({
      subjectDeploymentKey: normalizeDeploymentId(subject),
      assetIds: sortedValues(assetIds),
      rail,
      contributors,
      emitters,
    });
  }
  return {
    schemaVersion: 1,
    reviewedAt,
    policy: isRecord(raw.policy) ? raw.policy : {},
    lookbackBlocksByChain,
    lanes,
  };
}

interface LaneContributor {
  assetId: string;
  controlId: string;
  controllerChain: string | null;
  controllerAddress: string | null;
}

interface LaneAccumulator {
  subjectDeploymentKey: string;
  chain: string;
  contributors: LaneContributor[];
}

function evmChain(chain: string | null): string | null {
  if (chain === null) return null;
  const normalized = chain.trim().toLowerCase();
  return CHAIN_META[normalized]?.type === "evm" ? normalized : null;
}

interface LaneAdmission {
  descriptor: LaneScreeningDescriptor | null;
  reason: LaneNoReviewedEmitterReason | null;
  unpinnedControlIds: string[];
  uncoveredEvents: string[];
  pilot: LaneEmitterPilotLane;
}

function strongestReason(reasons: ReadonlySet<LaneNoReviewedEmitterReason>): LaneNoReviewedEmitterReason {
  let strongest: LaneNoReviewedEmitterReason = "no-reviewed-inventory";
  for (const reason of reasons) {
    if (REASON_PRIORITY[reason] < REASON_PRIORITY[strongest]) strongest = reason;
  }
  return strongest;
}

function admitInventoryLane(input: {
  lane: LaneAccumulator;
  record: LaneScreeningInventoryRecord;
  inventory: LaneScreeningEmitterInventory;
}): LaneAdmission {
  const { lane, record, inventory } = input;
  const reviewedControlIds = sortedValues(lane.contributors.map((contributor) => contributor.controlId));
  const mappedControlIds = sortedValues(record.contributors.map((contributor) => contributor.controlId));
  const reasons = new Set<LaneNoReviewedEmitterReason>();
  const uncoveredEvents = new Set<string>();
  const unpinnedControlIds = new Set<string>();

  const subjectChain = lane.chain;
  const emitterAddresses = record.emitters.map((emitter) => emitter.address.toLowerCase());
  const emitterByAddress = new Map(record.emitters.map((emitter) => [emitter.address.toLowerCase(), emitter]));

  if (reviewedControlIds.join("\u0000") !== mappedControlIds.join("\u0000")) {
    reasons.add("contributor-mismatch");
    for (const controlId of reviewedControlIds) {
      if (!mappedControlIds.includes(controlId)) unpinnedControlIds.add(controlId);
    }
  }

  const mappedCoverage = new Set<string>();
  for (const contributor of record.contributors) {
    if (contributor.emitterAddresses.length === 0
      || contributor.emitterAddresses.some((address) => !emitterByAddress.has(address.toLowerCase()))) {
      reasons.add("contributor-without-emitter");
      unpinnedControlIds.add(contributor.controlId);
      continue;
    }
    for (const address of contributor.emitterAddresses) mappedCoverage.add(address.toLowerCase());
  }

  const emitters: LaneEmitter[] = [];
  for (const emitter of record.emitters) {
    if (emitter.chain !== subjectChain) {
      reasons.add("invalid-inventory-lane");
      continue;
    }
    if (parsedDecodedRuntimeIdentity(emitter.runtimeIdentity) === null) {
      reasons.add("emitter-pin-not-decoded");
      continue;
    }
    if (emitter.abiBasis === null) {
      reasons.add("emitter-abi-basis-unverified");
      continue;
    }
    const events = sortedValues(emitter.adminEvents);
    if (events.length === 0) {
      reasons.add("emitter-abi-events-empty");
      continue;
    }
    const screened: V9LaneAdminEventFamily[] = [];
    for (const event of events) {
      if ((V9_LANE_ADMIN_EVENT_FAMILY_VALUES as readonly string[]).includes(event)) {
        screened.push(event as V9LaneAdminEventFamily);
      } else {
        reasons.add("abi-not-covered");
        uncoveredEvents.add(event);
      }
    }
    emitters.push({
      address: emitter.address,
      expectedRuntimeCodeSha256: parsedDecodedRuntimeIdentity(emitter.runtimeIdentity)!,
      families: screened,
    });
  }
  if (new Set(emitterAddresses).size !== emitterAddresses.length) reasons.add("invalid-inventory-lane");

  const lookbackBlocks = inventory.lookbackBlocksByChain[subjectChain] ?? null;
  if (lookbackBlocks === null || lookbackBlocks < LANE_EMITTER_MINIMUM_LOOKBACK_BLOCKS) {
    reasons.add("lookback-below-floor");
  }

  const reason = reasons.size === 0 ? null : strongestReason(reasons);
  const descriptor: LaneScreeningDescriptor | null = reason === null
    ? {
      subjectDeploymentKey: lane.subjectDeploymentKey,
      emitters: [...emitters].sort((left, right) => compareText(left.address, right.address)),
      lookbackBlocks: lookbackBlocks!,
      provenance: {
        assetIds: sortedValues(lane.contributors.map((contributor) => contributor.assetId)),
        controlIds: reviewedControlIds,
        rail: record.rail,
        reviewedAt: inventory.reviewedAt,
        contributors: [...record.contributors]
          .sort((left, right) => compareText(left.controlId, right.controlId))
          .map((contributor) => ({
            controlId: contributor.controlId,
            emitterAddresses: sortedValues(contributor.emitterAddresses.map((address) => address.toLowerCase())),
          })),
        emitters: [...record.emitters]
          .sort((left, right) => compareText(left.address, right.address))
          .map((emitter) => ({
            address: emitter.address,
            role: emitter.role,
            label: emitter.label,
            chain: emitter.chain,
            observedBlock: emitter.observedBlock,
            observedAt: emitter.observedAt,
            abiBasis: emitter.abiBasis,
          })),
      },
    }
    : null;

  return {
    descriptor,
    reason,
    unpinnedControlIds: sortedValues(unpinnedControlIds),
    uncoveredEvents: sortedValues(uncoveredEvents),
    pilot: {
      subjectDeploymentKey: lane.subjectDeploymentKey,
      assetIds: sortedValues(record.assetIds),
      rail: record.rail,
      lookbackBlocks,
      admission: { admitted: descriptor !== null, reason },
      contributors: [...record.contributors]
        .sort((left, right) => compareText(left.controlId, right.controlId))
        .map((contributor) => ({
          controlId: contributor.controlId,
          emitterAddresses: sortedValues(contributor.emitterAddresses.map((address) => address.toLowerCase())),
        })),
      emitters: [...record.emitters]
        .sort((left, right) => compareText(left.address, right.address))
        .map((emitter) => {
          const screened = sortedValues(emitter.adminEvents.filter(event =>
            (V9_LANE_ADMIN_EVENT_FAMILY_VALUES as readonly string[]).includes(event)));
          return {
            address: emitter.address,
            chain: emitter.chain,
            role: emitter.role,
            label: emitter.label,
            observedBlock: emitter.observedBlock,
            observedAt: emitter.observedAt,
            runtimeIdentity: emitter.runtimeIdentity,
            abiBasis: emitter.abiBasis,
            adminEvents: sortedValues(emitter.adminEvents),
            screenedFamilies: screened,
            unscreenedEvents: sortedValues(emitter.adminEvents.filter(event =>
              !(V9_LANE_ADMIN_EVENT_FAMILY_VALUES as readonly string[]).includes(event))),
          };
        }),
      uncoveredEvents: sortedValues(uncoveredEvents),
    },
  };
}

/**
 * Derive one descriptor per reviewed EVM bridge lane (route deployment) from the
 * reviewed emitter inventory (OP-IR §5c).
 *
 * Lane identity is the authored route id. A lane is admitted only when the
 * inventory maps every reviewed contributor to at least one emitter, every
 * emitter has a decoded-runtime pin and an ABI basis, and every admin event of
 * that ABI is in the frozen vocabulary. A partial emitter set or an uncovered
 * admin event would let a clean certificate assert absence for an unscreened
 * surface, so those lanes are listed as `no-reviewed-emitter` with the exact
 * missing pieces. Lanes with no inventory record are listed too, so the catalog
 * states the whole reviewed universe.
 */
export function deriveLaneEmitterDescriptors(input: LaneEmitterInputs): LaneEmitterDescriptorsArtifact {
  const lanes = new Map<string, LaneAccumulator>();
  const summaryControls = {
    bridge: { total: 0, withoutController: 0 },
    mint: { total: 0, withoutController: 0 },
    routeRefs: { total: 0, nonEvm: 0, malformed: 0 },
  };
  const nonEvmLaneKeys = new Set<string>();

  for (const record of input.records) {
    const isBridge = record.recordKind === "bridge-control";
    summaryControls[isBridge ? "bridge" : "mint"].total += 1;
    if (record.controllerChain === null || record.controllerAddress === null) {
      summaryControls[isBridge ? "bridge" : "mint"].withoutController += 1;
    }
    if (!isBridge) continue;
    for (const routeRef of record.routeRefs) {
      summaryControls.routeRefs.total += 1;
      const normalizedChain = routeRef.includes(":") ? routeRef.slice(0, routeRef.indexOf(":")).trim().toLowerCase() : "";
      if (evmChain(normalizedChain) === null) {
        summaryControls.routeRefs.nonEvm += 1;
        nonEvmLaneKeys.add(normalizeDeploymentId(routeRef) || routeRef);
        continue;
      }
      const subjectDeploymentKey = normalizeDeploymentId(routeRef);
      if (subjectDeploymentKey === "") {
        summaryControls.routeRefs.malformed += 1;
        continue;
      }
      const lane = lanes.get(subjectDeploymentKey) ?? {
        subjectDeploymentKey,
        chain: normalizedChain,
        contributors: [],
      };
      lanes.set(subjectDeploymentKey, lane);
      lane.contributors.push({
        assetId: record.assetId,
        controlId: record.controlId,
        controllerChain: record.controllerChain,
        controllerAddress: record.controllerAddress,
      });
    }
  }

  const inventoryBySubject = new Map(input.inventory.lanes.map((record) => [record.subjectDeploymentKey, record]));
  const descriptors: LaneScreeningDescriptor[] = [];
  const noReviewedEmitter: LaneNoReviewedEmitter[] = [];
  const pilot: LaneEmitterPilotLane[] = [];
  const byReason = new Map<LaneNoReviewedEmitterReason, number>();
  const uncoveredFamilies = new Set<string>();

  for (const inventorySubject of inventoryBySubject.keys()) {
    if (!lanes.has(inventorySubject)) {
      byReason.set("invalid-inventory-lane", (byReason.get("invalid-inventory-lane") ?? 0) + 1);
    }
  }

  for (const key of [...lanes.keys()].sort(compareText)) {
    const lane = lanes.get(key)!;
    const record = inventoryBySubject.get(key);
    if (record === undefined) {
      byReason.set("no-reviewed-inventory", (byReason.get("no-reviewed-inventory") ?? 0) + 1);
      noReviewedEmitter.push({
        subjectDeploymentKey: key,
        reason: "no-reviewed-inventory",
        assetIds: sortedValues(lane.contributors.map((contributor) => contributor.assetId)),
        controlIds: sortedValues(lane.contributors.map((contributor) => contributor.controlId)),
      });
      continue;
    }

    const admission = admitInventoryLane({ lane, record, inventory: input.inventory });
    pilot.push(admission.pilot);
    for (const event of admission.uncoveredEvents) uncoveredFamilies.add(event);
    if (admission.descriptor !== null) {
      descriptors.push(admission.descriptor);
      continue;
    }
    const reason = admission.reason ?? "invalid-inventory-lane";
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
    noReviewedEmitter.push({
      subjectDeploymentKey: key,
      reason,
      assetIds: sortedValues(lane.contributors.map((contributor) => contributor.assetId)),
      controlIds: sortedValues(lane.contributors.map((contributor) => contributor.controlId)),
      ...(admission.unpinnedControlIds.length === 0 ? {} : { unpinnedControlIds: admission.unpinnedControlIds }),
      ...(admission.uncoveredEvents.length === 0 ? {} : { uncoveredEvents: admission.uncoveredEvents }),
    });
  }

  const byReasonRecord = Object.fromEntries(
    (Object.keys(REASON_PRIORITY) as LaneNoReviewedEmitterReason[])
      .sort(compareText)
      .map((reason) => [reason, byReason.get(reason) ?? 0]),
  ) as Record<LaneNoReviewedEmitterReason, number>;

  return {
    schemaVersion: 1,
    policy: {
      laneIdentity: "bridge-route-deployment",
      runtimeHashConvention: "sha256-decoded-runtime-bytes",
      runtimeIdentityAdmission: "sha256-decoded-runtime-bytes:<64 lowercase hex>",
      lookbackFloorBlocks: LANE_EMITTER_MINIMUM_LOOKBACK_BLOCKS,
      families: [...V9_LANE_ADMIN_EVENT_FAMILY_VALUES],
      notes: [
        "subjectDeploymentKey is the reviewed bridge route id, because IR-1c closure compares certificate.subjectDeploymentKey with the compiled bridge control's deploymentKey; a controller is an emitter, never the lane.",
        "Emitters are the contracts that emit the lane's admin events: the route deployment plus every contributor's governed contract. Holder Safes and EOAs are not emitters. Each contributor is mapped to at least one emitter in the inventory and in each descriptor's provenance.",
        "A lane is admitted only when every reviewed contributor is mapped and every emitter's reviewed ABI admin events are in the frozen vocabulary. Declared families are exactly those events, so a family is never screened on a contract that cannot emit it and an uncovered admin surface can never yield a clean certificate (R1/R2). Lanes that fail carry a machine reason and the exact uncovered events.",
        "Runtime pins are sha256 of decoded runtime bytes read with eth_getCode at the recorded pinned block. Proxy addresses are the emitters because their implementation's logs are emitted at the proxy; the reviewed ABI is the implementation ABI.",
        "Cross-chain ABI reuse is explicit: `same-runtime-code` requires identical proxy and implementation runtime hashes, `same-verified-type` requires the same verified contract type and byte length with chain-specific immutables, and `verified-source` names a verification on the emitter's own chain.",
        "Shared provider emitters (EndpointV2/ULN302, CCIP Router/RMN) are not admitted: no reviewed runtime pin exists for them and the screener has no OApp subject filter yet (OP-R0 note 12), so adding them would only fail lanes closed as material-event.",
      ],
    },
    summary: {
      lanes: lanes.size,
      covered: descriptors.length,
      noReviewedEmitter: noReviewedEmitter.length,
      noReviewedEmitterByReason: byReasonRecord,
      lanesNonEvm: nonEvmLaneKeys.size,
      controls: summaryControls,
      sidecars: input.sidecars,
      inventory: {
        reviewedAt: input.inventory.reviewedAt,
        pilotLanes: input.inventory.lanes.length,
        pilotEmitters: input.inventory.lanes.reduce((total, record) => total + record.emitters.length, 0),
        admittedLanes: descriptors.length,
        uncoveredEvents: sortedValues(uncoveredFamilies),
      },
    },
    descriptors,
    noReviewedEmitter,
    pilot: pilot.sort((left, right) => compareText(left.subjectDeploymentKey, right.subjectDeploymentKey)),
  };
}

/** Read every reviewed bridge/mint control; bridge controls also carry their route refs. */
export function loadLaneControlRecords(root: string): LaneEmitterInputs {
  const records: LaneControlRecord[] = [];
  const sidecars = { riskReview: 0, mintAuthority: 0 };

  for (const source of RECORD_SOURCES) {
    const directory = resolve(root, source.directory);
    const files = readdirSync(directory).filter((name) => name.endsWith(".json")).sort(compareText);
    if (source.recordKind === "bridge-control") sidecars.riskReview = files.length;
    else sidecars.mintAuthority = files.length;

    for (const file of files) {
      const sidecar = JSON.parse(readFileSync(resolve(directory, file), "utf8")) as unknown;
      if (!isRecord(sidecar)) continue;
      const assetId = stringField(sidecar, "id") ?? file.slice(0, -".json".length);
      const profile = sidecar[source.profileField];
      if (!isRecord(profile) || !Array.isArray(profile.controls)) continue;

      for (const control of profile.controls) {
        if (!isRecord(control)) continue;
        const scope = isRecord(control.executionScope)
          ? control.executionScope
          : isRecord(control.weightedQuorum)
            ? control.weightedQuorum
            : null;
        const pin = scope !== null && isRecord(scope.pin) ? scope.pin : null;
        records.push({
          recordKind: source.recordKind,
          assetId,
          controlId: stringField(control, "id") ?? stringField(control, "label")
            ?? stringField(control, "role") ?? "unidentified-control",
          routeRefs: source.recordKind === "bridge-control" && Array.isArray(control.routeRefs)
            ? control.routeRefs.filter((ref): ref is string => typeof ref === "string" && ref.trim() !== "")
            : [],
          controllerChain: stringField(control, source.chainField),
          controllerAddress: stringField(control, source.addressField),
          runtimeIdentity: pin === null ? null : stringField(pin, "runtimeIdentity"),
        });
      }
    }
  }

  return { records, sidecars, inventory: loadLaneScreeningEmitterInventory(root) };
}

export function buildLaneEmitterDescriptors(root: string): LaneEmitterDescriptorsArtifact {
  return deriveLaneEmitterDescriptors(loadLaneControlRecords(root));
}

export function runCli(argv = process.argv.slice(2)): void {
  const { values } = parseStrictCliArgs(argv, { options: { check: { type: "boolean" } } });
  const artifact = buildLaneEmitterDescriptors(ROOT);
  syncGeneratedArtifacts({
    artifacts: [{ path: resolve(ROOT, OUTPUT_PATH), contents: `${JSON.stringify(artifact)}\n` }],
    check: values.check === true,
    staleMessage: "Safety Score V9 lane emitter descriptors are stale.",
    currentMessage: "Safety Score V9 lane emitter descriptors are current",
    writtenMessage: "Generated Safety Score V9 lane emitter descriptors",
  });
}

if (isDirectRun(import.meta.url, process.argv[1])) runCli();
