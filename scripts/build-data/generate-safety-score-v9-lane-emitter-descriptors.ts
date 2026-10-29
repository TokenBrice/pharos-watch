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

/**
 * The only runtime-identity text admitted as a certificate expectation.
 *
 * IR-3a hashes DECODED EVM runtime bytes. Every other identity form authored in
 * the reviewed corpus either declares another domain (`sha256:rpc-hex-text`,
 * `sha256-rpc-code-text`, `eth_getCode-text`), uses another function
 * (`keccak256:`), names a different contract, or leaves the domain unstated
 * (`sha256:<hex>`). The unstated form is genuinely mixed: spot checks reproduce
 * some reviewed digests from the decoded bytes and others from the `0x` hex
 * TEXT, so the generator records those lanes as `no-reviewed-emitter` instead of
 * guessing a domain that would fail every certificate as `code-hash-mismatch`.
 */
export const LANE_EMITTER_DECODED_RUNTIME_IDENTITY_PATTERN = /^sha256-decoded-runtime-bytes:([0-9a-f]{64})$/;

/**
 * Bootstrap window for a lane with no certificate yet: ~30 days at Ethereum's
 * 12 s block time, 22 log pages at the 10 000-block default span and therefore
 * inside IR-3a's 32-page certificate budget. Freshness is judged from the
 * newest window's end, so a longer first window adds history, not admission.
 */
export const LANE_EMITTER_BOOTSTRAP_LOOKBACK_BLOCKS = 216_000;

export type LaneEmitterRecordKind = "bridge-control" | "mint-control";

export type LaneNoReviewedEmitterReason =
  | "missing-runtime-identity"
  | "partial-emitter-runtime-identity"
  | "emitter-controller-unsupported-chain"
  | "runtime-identity-binds-other-address"
  | "runtime-identity-text-encoded"
  | "runtime-identity-non-sha256"
  | "runtime-identity-without-sha256"
  | "runtime-identity-domain-unlabelled"
  | "runtime-identity-hash-conflict";

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
}

export interface LaneEmitter {
  address: `0x${string}`;
  expectedRuntimeCodeSha256: string;
  families: readonly V9LaneAdminEventFamily[];
}

/** Structurally usable as IR-3c's `LaneScreeningDescriptor`. */
export interface LaneScreeningDescriptor {
  subjectDeploymentKey: string;
  emitters: readonly LaneEmitter[];
  lookbackBlocks: number;
  provenance: {
    assetIds: readonly string[];
    controlIds: readonly string[];
    pins: readonly { emitterAddress: string; recordKind: LaneEmitterRecordKind; assetId: string; controlId: string }[];
  };
}

export interface LaneNoReviewedEmitter {
  subjectDeploymentKey: string;
  reason: LaneNoReviewedEmitterReason;
  assetIds: readonly string[];
  controlIds: readonly string[];
  unpinnedControlIds: readonly string[];
  reviewedRuntimeIdentities?: readonly string[];
}

export interface LaneEmitterDescriptorsArtifact {
  schemaVersion: 1;
  policy: {
    laneIdentity: "bridge-route-deployment";
    runtimeHashConvention: "sha256-decoded-runtime-bytes";
    runtimeIdentityAdmission: string;
    bootstrapLookbackBlocks: number;
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
  };
  descriptors: readonly LaneScreeningDescriptor[];
  noReviewedEmitter: readonly LaneNoReviewedEmitter[];
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
  "runtime-identity-hash-conflict": 0,
  "runtime-identity-text-encoded": 1,
  "runtime-identity-non-sha256": 2,
  "runtime-identity-domain-unlabelled": 3,
  "runtime-identity-binds-other-address": 4,
  "runtime-identity-without-sha256": 5,
  "emitter-controller-unsupported-chain": 6,
  "partial-emitter-runtime-identity": 7,
  "missing-runtime-identity": 8,
};

type RuntimeIdentityParse =
  | { state: "decoded"; sha256: string }
  | { state: "unusable"; reason: LaneNoReviewedEmitterReason };

const TEXT_DOMAIN_MARKERS = ["rpc-hex-text", "rpc-code-text", "getcode-text"] as const;
const EVM_ADDRESS_PATTERN = /\b0x[0-9a-f]{40}\b/gu;

/** Whether some 64-hex run survives after removing named EVM addresses. */
function hasLoneSha256Digest(text: string): boolean {
  return text.replaceAll(EVM_ADDRESS_PATTERN, "").split(/[^0-9a-f]+/u).some((part) => part.length === 64);
}

/** Classify one authored `pin.runtimeIdentity` against the control's controller address. */
export function parseRuntimeIdentity(runtimeIdentity: string | null, controllerAddress: string): RuntimeIdentityParse {
  if (runtimeIdentity === null) return { state: "unusable", reason: "missing-runtime-identity" };
  const text = runtimeIdentity.trim();
  if (text === "") return { state: "unusable", reason: "missing-runtime-identity" };
  const lower = text.toLowerCase();

  const decoded = LANE_EMITTER_DECODED_RUNTIME_IDENTITY_PATTERN.exec(text);
  if (decoded) return { state: "decoded", sha256: decoded[1]! };

  if (TEXT_DOMAIN_MARKERS.some((marker) => lower.includes(marker))) {
    return { state: "unusable", reason: "runtime-identity-text-encoded" };
  }
  if (lower.includes("keccak256")) return { state: "unusable", reason: "runtime-identity-non-sha256" };

  // A leading bare `sha256:` is the controller's own digest in the legacy
  // unlabelled domain; an `implementation` address after it does not change that.
  const bareIndex = lower.startsWith("proxy sha256:")
    ? lower.indexOf("sha256:")
    : lower.startsWith("sha256:")
      ? 0
      : -1;
  if (bareIndex >= 0) {
    const digest = lower.slice(bareIndex + "sha256:".length).split(";", 1)[0]!.trim();
    if (/^[0-9a-f]{64}$/u.test(digest)) return { state: "unusable", reason: "runtime-identity-domain-unlabelled" };
  }

  const addresses = [...lower.matchAll(EVM_ADDRESS_PATTERN)].map((match) => match[0]);
  if (addresses.length > 0 && addresses.every((address) => address !== controllerAddress)) {
    return { state: "unusable", reason: "runtime-identity-binds-other-address" };
  }
  // A digest that no admitted form claims still cannot become an expectation.
  if (hasLoneSha256Digest(lower)) return { state: "unusable", reason: "runtime-identity-domain-unlabelled" };
  return { state: "unusable", reason: "runtime-identity-without-sha256" };
}

function sortedValues(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareText);
}

function stringField(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
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

  return { records, sidecars };
}

interface EmitterPin {
  /** Normalized controller deployment key. */
  deploymentKey: string;
  address: string;
  hashes: Set<string>;
  identities: Set<string>;
  reasons: Set<LaneNoReviewedEmitterReason>;
  pinnedSources: { recordKind: LaneEmitterRecordKind; assetId: string; controlId: string }[];
}

interface LaneContributor {
  assetId: string;
  controlId: string;
  controllerDeploymentKey: string | null;
  controllerChain: string | null;
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

/**
 * Derive one descriptor per reviewed EVM bridge lane (route deployment).
 *
 * IR-1c closure compares `certificate.subjectDeploymentKey` with the compiled
 * bridge control's `deploymentKey`, i.e. the route deployment, so the lane key is
 * the authored `routeRefs[]` entry and a controller is only an emitter. A lane is
 * admitted only when EVERY contributing control's controller has a single
 * reviewed decoded-bytes pin; otherwise the certificate would silently skip a
 * contributor and the lane is listed as `no-reviewed-emitter`.
 */
export function deriveLaneEmitterDescriptors(input: LaneEmitterInputs): LaneEmitterDescriptorsArtifact {
  const pins = new Map<string, EmitterPin>();
  const lanes = new Map<string, LaneAccumulator>();
  const summaryControls = {
    bridge: { total: 0, withoutController: 0 },
    mint: { total: 0, withoutController: 0 },
    routeRefs: { total: 0, nonEvm: 0, malformed: 0 },
  };
  let lanesNonEvm = 0;
  const nonEvmLaneKeys = new Set<string>();

  for (const record of input.records) {
    const isBridge = record.recordKind === "bridge-control";
    summaryControls[isBridge ? "bridge" : "mint"].total += 1;
    const chain = evmChain(record.controllerChain);
    const controllerAddress = record.controllerAddress;
    if (record.controllerChain === null || controllerAddress === null) {
      summaryControls[isBridge ? "bridge" : "mint"].withoutController += 1;
    } else if (chain !== null) {
      const deploymentKey = normalizeDeploymentId(`${chain}:${controllerAddress}`);
      if (deploymentKey !== "") {
        const pin = pins.get(deploymentKey) ?? {
          deploymentKey,
          address: deploymentKey.slice(deploymentKey.indexOf(":") + 1),
          hashes: new Set<string>(),
          identities: new Set<string>(),
          reasons: new Set<LaneNoReviewedEmitterReason>(),
          pinnedSources: [],
        };
        pins.set(deploymentKey, pin);
        if (record.runtimeIdentity !== null) pin.identities.add(record.runtimeIdentity);
        const parsed = parseRuntimeIdentity(record.runtimeIdentity, pin.address);
        if (parsed.state === "decoded") {
          pin.hashes.add(parsed.sha256);
          pin.pinnedSources.push({
            recordKind: record.recordKind,
            assetId: record.assetId,
            controlId: record.controlId,
          });
        } else {
          pin.reasons.add(parsed.reason);
        }
      }
    }

    if (!isBridge) continue;
    for (const routeRef of record.routeRefs) {
      summaryControls.routeRefs.total += 1;
      const normalizedChain = routeRef.includes(":") ? routeRef.slice(0, routeRef.indexOf(":")) : "";
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
        chain: normalizedChain.trim().toLowerCase(),
        contributors: [],
      };
      lanes.set(subjectDeploymentKey, lane);
      lane.contributors.push({
        assetId: record.assetId,
        controlId: record.controlId,
        controllerChain: record.controllerChain,
        controllerDeploymentKey: record.controllerAddress === null
          ? null
          : normalizeDeploymentId(`${(record.controllerChain ?? "").trim().toLowerCase()}:${record.controllerAddress}`),
      });
    }
  }

  const descriptors: LaneScreeningDescriptor[] = [];
  const noReviewedEmitter: LaneNoReviewedEmitter[] = [];
  const byReason = new Map<LaneNoReviewedEmitterReason, number>();

  for (const key of [...lanes.keys()].sort(compareText)) {
    const lane = lanes.get(key)!;
    const pinned: { key: string; address: string; hash: string; pinnedSources: EmitterPin["pinnedSources"] }[] = [];
    const unpinned: { contributor: LaneContributor; reason: LaneNoReviewedEmitterReason }[] = [];

    for (const contributor of lane.contributors) {
      const deploymentKey = contributor.controllerDeploymentKey;
      if (deploymentKey === null || deploymentKey.endsWith(":")) {
        unpinned.push({ contributor, reason: "missing-runtime-identity" });
        continue;
      }
      const pin = pins.get(deploymentKey);
      const pinChain = deploymentKey.slice(0, deploymentKey.indexOf(":"));
      if (pin === undefined || CHAIN_META[pinChain]?.type !== "evm") {
        unpinned.push({
          contributor,
          reason: pin === undefined ? "missing-runtime-identity" : "emitter-controller-unsupported-chain",
        });
        continue;
      }
      if (pin.hashes.size > 1) {
        unpinned.push({ contributor, reason: "runtime-identity-hash-conflict" });
        continue;
      }
      const hash = [...pin.hashes][0];
      if (hash === undefined) {
        unpinned.push({ contributor, reason: strongestReason(pin.reasons) });
        continue;
      }
      pinned.push({ key: deploymentKey, address: pin.address, hash, pinnedSources: pin.pinnedSources });
    }

    if (unpinned.length === 0) {
      const byAddress = new Map(pinned.map((row) => [row.address, row]));
      descriptors.push({
        subjectDeploymentKey: lane.subjectDeploymentKey,
        emitters: [...byAddress.values()].sort((left, right) => compareText(left.address, right.address)).map((row) => ({
          address: row.address as `0x${string}`,
          expectedRuntimeCodeSha256: row.hash,
          families: [...V9_LANE_ADMIN_EVENT_FAMILY_VALUES],
        })),
        lookbackBlocks: LANE_EMITTER_BOOTSTRAP_LOOKBACK_BLOCKS,
        provenance: {
          assetIds: sortedValues(lane.contributors.map((contributor) => contributor.assetId)),
          controlIds: sortedValues(lane.contributors.map((contributor) => contributor.controlId)),
          pins: pinned
            .flatMap((row) => row.pinnedSources.map((source) => ({ emitterAddress: row.address, ...source })))
            .sort((left, right) => compareText(left.emitterAddress, right.emitterAddress)
              || compareText(`${left.recordKind}:${left.assetId}:${left.controlId}`, `${right.recordKind}:${right.assetId}:${right.controlId}`)),
        },
      });
      continue;
    }

    const reason = unpinned.some((row) => row.reason === "runtime-identity-hash-conflict")
      ? "runtime-identity-hash-conflict"
      : pinned.length > 0
        ? "partial-emitter-runtime-identity"
        : strongestReason(new Set(unpinned.map((row) => row.reason)));
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
    const reviewedRuntimeIdentities = sortedValues(
      lane.contributors.flatMap((contributor) => {
        const pin = contributor.controllerDeploymentKey === null ? undefined : pins.get(contributor.controllerDeploymentKey);
        return pin === undefined ? [] : [...pin.identities];
      }),
    );
    noReviewedEmitter.push({
      subjectDeploymentKey: lane.subjectDeploymentKey,
      reason,
      assetIds: sortedValues(lane.contributors.map((contributor) => contributor.assetId)),
      controlIds: sortedValues(lane.contributors.map((contributor) => contributor.controlId)),
      unpinnedControlIds: sortedValues(unpinned.map((row) => row.contributor.controlId)),
      ...(reviewedRuntimeIdentities.length > 0 ? { reviewedRuntimeIdentities } : {}),
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
      bootstrapLookbackBlocks: LANE_EMITTER_BOOTSTRAP_LOOKBACK_BLOCKS,
      families: [...V9_LANE_ADMIN_EVENT_FAMILY_VALUES],
      notes: [
        "subjectDeploymentKey is the reviewed bridge route deployment (`chain:contractAddress`), because IR-1c closure compares certificate.subjectDeploymentKey with the compiled bridge control's deploymentKey; the controller is an emitter, never the lane.",
        "A lane is admitted only when every contributing control's EVM controller has exactly one reviewed runtime pin in the decoded-bytes domain. A partial emitter set would let the certificate certify a lane while skipping an unscreened contributor.",
        "Emitter families are the frozen admin-event screening scope (every family in V9_LANE_ADMIN_EVENT_FAMILY_VALUES), not a per-contract emission inventory: the certificate's screened topics are the union of emitter families, and declaring fewer would make an honest log fail closed as malformed-read.",
        "Only `sha256-decoded-runtime-bytes:<hex>` pins are admitted. Bare `sha256:<hex>` and `*rpc-*-text` pins are not: the unstated domain is mixed in the reviewed corpus (spot checks reproduce some from decoded bytes, others from the 0x hex TEXT) and a wrong-domain pin fails every certificate as code-hash-mismatch.",
        "Shared provider emitters (EndpointV2/ULN302) are not admitted: no reviewed runtime pin exists for them and the screener has no OApp subject filter yet (OP-R0 note 12), so adding them would only fail lanes closed as material-event.",
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
    },
    descriptors,
    noReviewedEmitter,
  };
}

function strongestReason(reasons: ReadonlySet<LaneNoReviewedEmitterReason>): LaneNoReviewedEmitterReason {
  let strongest: LaneNoReviewedEmitterReason = "missing-runtime-identity";
  for (const reason of reasons) {
    if (REASON_PRIORITY[reason] < REASON_PRIORITY[strongest]) strongest = reason;
  }
  return strongest;
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
