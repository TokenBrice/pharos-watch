import type { StablecoinMeta } from "@shared/types";
import {
  MINT_AUTHORITY_CONFIDENCE_VALUES,
  MINT_AUTHORITY_CONTROL_ROLE_VALUES,
  MINT_AUTHORITY_DIRECT_MINT_ABILITY_VALUES,
  MINT_AUTHORITY_MINT_PATH_VALUES,
  MINT_AUTHORITY_MODULES_OR_GUARDS_STATUS_VALUES,
  MINT_AUTHORITY_POSTURE_VALUES,
  MINT_AUTHORITY_TYPE_VALUES,
} from "@shared/types/core";
import type { MintAuthorityClientSummary } from "@shared/types/stablecoin-client-meta";
import { isRecord, numberValue, stringValue } from "@shared/lib/type-guards";

type MintAuthorityClientControlSummary = NonNullable<MintAuthorityClientSummary["controls"]>[number];
type MintAuthorityClientSourceSummary = NonNullable<MintAuthorityClientSummary["sources"]>[number];

/**
 * Validates a string against an enum's allowlist before narrowing it. The
 * source profile is Zod-validated at build time, but a future schema migration
 * or malformed static asset could otherwise let an out-of-range enum string
 * flow into MAS scoring and display without any runtime error. Returns null on
 * an unrecognized value so callers can fail safe (drop the field/projection).
 */
function enumValue<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  return value != null && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

function canRaiseCapValue(value: unknown): MintAuthorityClientControlSummary["canRaiseCap"] | null {
  return value === true || value === false || value === "unknown" ? value : null;
}

function stringListValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => stringValue(item)).filter((item): item is string => item != null && item.length > 0);
}

function appendSources(target: MintAuthorityClientSourceSummary[], sources: unknown, seenUrls: Set<string>) {
  if (!Array.isArray(sources)) return;

  for (const source of sources) {
    if (!isRecord(source)) continue;
    const label = stringValue(source.label);
    const url = stringValue(source.url);
    if (!label || !url || seenUrls.has(url)) continue;
    seenUrls.add(url);
    target.push({ label, url });
  }
}

function buildKeyCustodyAttestation(
  value: unknown,
): MintAuthorityClientControlSummary["keyCustodyAttestation"] | undefined {
  if (!isRecord(value)) return undefined;
  const kind = stringValue(value.kind);
  if (kind !== "mpc" && kind !== "hsm") return undefined;
  const sources: MintAuthorityClientSourceSummary[] = [];
  appendSources(sources, value.sources, new Set());
  if (sources.length === 0) return undefined;
  return { kind, sources };
}

function buildMintIncidents(value: unknown): MintAuthorityClientSummary["mintIncidents"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const incidents: NonNullable<MintAuthorityClientSummary["mintIncidents"]> = [];
  for (const incident of value) {
    if (!isRecord(incident)) continue;
    const date = stringValue(incident.date);
    const summary = stringValue(incident.summary);
    const status = incident.status === "active" || incident.status === "resolved" ? incident.status : null;
    const resolvedAt = stringValue(incident.resolvedAt);
    if (!date || !summary || !status) continue;
    const sources: MintAuthorityClientSourceSummary[] = [];
    appendSources(sources, incident.sources, new Set());
    if (sources.length === 0) continue;
    incidents.push({ date, status, ...(resolvedAt ? { resolvedAt } : {}), summary, sources });
  }
  return incidents.length > 0 ? incidents : undefined;
}

function buildControlSummary(value: unknown): MintAuthorityClientControlSummary | null {
  if (!isRecord(value)) return null;

  const label = stringValue(value.label);
  const role = enumValue(stringValue(value.role), MINT_AUTHORITY_CONTROL_ROLE_VALUES);
  const authorityType = enumValue(stringValue(value.authorityType), MINT_AUTHORITY_TYPE_VALUES);
  const directMintAbility = enumValue(stringValue(value.directMintAbility), MINT_AUTHORITY_DIRECT_MINT_ABILITY_VALUES);
  if (!label || !role || !authorityType || !directMintAbility) return null;

  // Mint-authority metadata is Zod-validated during the stablecoin-data build;
  // this client projection re-validates enum fields against their allowlists so
  // an out-of-range value (e.g. from a future schema drift) is dropped rather
  // than silently exposed.
  const summary: MintAuthorityClientControlSummary = {
    label,
    role,
    authorityType,
    directMintAbility,
  };

  const chain = stringValue(value.chain);
  const address = stringValue(value.address);
  const threshold = numberValue(value.threshold);
  const signerCount = numberValue(value.signerCount);
  const timelockDelaySec = numberValue(value.timelockDelaySec);
  const capDescription = stringValue(value.capDescription);
  const canRaiseCap = canRaiseCapValue(value.canRaiseCap);
  const modulesOrGuardsStatus = enumValue(
    stringValue(value.modulesOrGuardsStatus),
    MINT_AUTHORITY_MODULES_OR_GUARDS_STATUS_VALUES,
  );
  const keyCustodyAttestation = buildKeyCustodyAttestation(value.keyCustodyAttestation);

  if (chain) summary.chain = chain;
  if (address) summary.address = address;
  if (threshold != null) summary.threshold = threshold;
  if (signerCount != null) summary.signerCount = signerCount;
  if (timelockDelaySec != null) summary.timelockDelaySec = timelockDelaySec;
  if (capDescription) summary.capDescription = capDescription;
  if (canRaiseCap != null) summary.canRaiseCap = canRaiseCap;
  if (modulesOrGuardsStatus) {
    summary.modulesOrGuardsStatus = modulesOrGuardsStatus;
  }
  if (keyCustodyAttestation) summary.keyCustodyAttestation = keyCustodyAttestation;

  return summary;
}

export function projectMintAuthorityClientSummary(coin: StablecoinMeta): MintAuthorityClientSummary | null {
  const profile = isRecord(coin.mintAuthority) ? coin.mintAuthority : null;
  if (!profile) return null;

  const mintPath = enumValue(stringValue(profile.mintPath), MINT_AUTHORITY_MINT_PATH_VALUES);
  const authorityPosture = enumValue(stringValue(profile.authorityPosture), MINT_AUTHORITY_POSTURE_VALUES);
  const confidence = enumValue(stringValue(profile.confidence), MINT_AUTHORITY_CONFIDENCE_VALUES);
  const summaryText = stringValue(profile.summary);
  if (!mintPath || !authorityPosture || !confidence || !summaryText) return null;

  // The source profile is build-validated; these enum fields feed the MAS score,
  // so they are re-validated against their allowlists before narrowing — an
  // unrecognized value drops the projection rather than flowing into scoring.
  const summary: MintAuthorityClientSummary = {
    mintPath,
    authorityPosture,
    confidence,
    summary: summaryText,
  };

  const inheritedFrom = stringValue(profile.inheritedFrom);
  if (inheritedFrom) summary.inheritedFrom = inheritedFrom;
  const mintIncidents = buildMintIncidents(profile.mintIncidents);
  if (mintIncidents) summary.mintIncidents = mintIncidents;

  const controls = Array.isArray(profile.controls)
    ? profile.controls
        .map(buildControlSummary)
        .filter((control): control is MintAuthorityClientControlSummary => control !== null)
    : [];
  if (controls.length > 0) summary.controls = controls;

  const sources: MintAuthorityClientSourceSummary[] = [];
  const seenUrls = new Set<string>();
  const review = isRecord(profile.review) ? profile.review : null;
  appendSources(sources, review?.sources, seenUrls);
  const reviewedAt = stringValue(review?.reviewedAt);
  if (reviewedAt) summary.reviewedAt = reviewedAt;
  const sourceFreeRationale = stringValue(review?.sourceFreeRationale);
  if (sourceFreeRationale) summary.sourceFreeRationale = sourceFreeRationale;
  const unresolvedQuestions = stringListValue(review?.unresolvedQuestions);
  if (unresolvedQuestions.length > 0) summary.unresolvedQuestions = unresolvedQuestions;
  for (const incident of mintIncidents ?? []) {
    appendSources(sources, incident.sources, seenUrls);
  }
  appendSources(sources, profile.sources, seenUrls);
  for (const control of Array.isArray(profile.controls) ? profile.controls : []) {
    if (!isRecord(control)) continue;
    appendSources(sources, control.sources, seenUrls);
    const custodyAttestation = isRecord(control.keyCustodyAttestation) ? control.keyCustodyAttestation : null;
    appendSources(sources, custodyAttestation?.sources, seenUrls);
  }
  if (sources.length > 0) summary.sources = sources;

  return summary;
}
